import { randomUUID } from 'node:crypto';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { z } from 'zod';
import { openSqliteCheckpointer } from '../checkpoints/sqlite.js';
import { canonicalJson, parseContractJson } from '../contracts/json.js';
import { TaskError, type TaskIdentity } from '../tasks/contracts.js';
import type { TaskStore } from '../tasks/store.js';
import {
  orchestrationRequestSchema,
  orchestrationResultSchema,
  capabilityCardSchema,
  reviewRecordSchema,
  type ReviewRecord,
  type ArtifactRef,
  type Assignment,
  type OrchestrationArtifact,
  type OrchestrationRequest,
  type OrchestrationRole,
  type OrchestrationTask,
} from './contracts.js';
import {
  createLivePorts,
  IntegrationPortError,
  validateEnrichmentResult,
  validateModelCompletion,
  validateModelInput,
  runWithExecutionContext,
  type ExecutionContext,
  type IntegrationPorts,
} from './ports.js';
import {
  analyzePm25,
  criticVerdictSchema,
  framePm25Scope,
  independentlyCheckPm25,
  managerPlanSchema,
  pm25Capability,
  roleInstructions,
  specialistTextSchema,
  synthesisSchema,
  validateCapture,
} from './pm25.js';
import {
  EvidenceSourceError,
  type EvidenceCapture,
} from '../tasks/evidence.js';
import { OrchestrationStore } from './store.js';

type Profile = {
  deadlineMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxArtifacts: number;
  maxModelInputBytes: number;
};
export const orchestrationScaffoldProfile: Readonly<Profile> = Object.freeze({
  deadlineMs: 300_000,
  maxModelCalls: 5,
  maxToolCalls: 6,
  maxArtifacts: 16,
  maxModelInputBytes: 16_384,
});
const activeStatus = (status: string) => ['queued', 'running'].includes(status);
const ref = (artifact: OrchestrationArtifact): ArtifactRef => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});

/** A process-wide pool shared by all tasks handled by this runtime. Waiting consumes no specialist slot. */
class SpecialistPool {
  private count = 0;
  private readonly queue: (() => void)[] = [];
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.count >= 2)
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          const index = this.queue.indexOf(ready);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new Error('execution_aborted'));
        };
        this.queue.push(ready);
        signal.addEventListener('abort', abort, { once: true });
      });
    signal.throwIfAborted();
    this.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count--;
      this.queue.shift()?.();
    };
  }
}

export class OrchestrationRuntime {
  readonly store: OrchestrationStore;
  readonly ports: IntegrationPorts;
  private readonly profile: Profile;
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly pool = new SpecialistPool();
  private closed = false;
  private checkpointHandle:
    ReturnType<typeof openSqliteCheckpointer> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly options: {
      taskStore: TaskStore;
      stateDirectory: string;
      env?: NodeJS.ProcessEnv;
      ports?: IntegrationPorts;
      profile?: Partial<Profile>;
      otherActiveTasks?: () => number;
    },
  ) {
    this.store = new OrchestrationStore(
      options.taskStore.db,
      (input, identity) => {
        const artifact = options.taskStore.artifact(input.id, identity);
        if (
          artifact.version !== input.version ||
          artifact.sha256 !== input.sha256
        )
          throw new TaskError(
            409,
            'context_version_mismatch',
            'Context must identify an exact accessible artifact.',
          );
      },
    );
    this.ports = options.ports ?? createLivePorts(options.env ?? process.env);
    const ids = [
      this.ports.nightshift.id,
      this.ports.zetaris.id,
      this.ports.hmem.id,
      this.ports.world.id,
    ];
    if (
      ids.some(
        (id) => typeof id !== 'string' || !id.trim() || id.length > 200,
      ) ||
      new Set(ids).size !== ids.length
    )
      throw new Error(
        'Each component port requires a distinct bounded identifier.',
      );
    if (
      ![this.ports.nightshift.mode, this.ports.zetaris.mode].every((mode) =>
        ['live', 'fixture'].includes(mode),
      )
    )
      throw new Error(
        'Model and evidence ports require an explicit live or fixture mode.',
      );
    this.profile = { ...orchestrationScaffoldProfile, ...options.profile };
    for (const value of Object.values(this.profile))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(
          'Orchestration resource limits must be positive integers.',
        );
  }
  get activeCount() {
    return this.active.size;
  }
  private artifact(input: ArtifactRef, identity: TaskIdentity) {
    try {
      return this.store.artifact(input.id, identity, input);
    } catch (error) {
      if (!(error instanceof TaskError) || error.code !== 'artifact_not_found')
        throw error;
      const artifact = this.options.taskStore.artifact(input.id, identity);
      if (
        artifact.version !== input.version ||
        artifact.sha256 !== input.sha256
      )
        throw new TaskError(
          409,
          'context_version_mismatch',
          'Context must identify an exact accessible artifact.',
        );
      return artifact;
    }
  }
  admit(value: unknown, key: string, identity: TaskIdentity) {
    if (this.closed)
      throw new TaskError(
        503,
        'runtime_closed',
        'The task runtime is stopping.',
      );
    const parsed = orchestrationRequestSchema.safeParse(value);
    if (!parsed.success)
      throw new TaskError(
        400,
        'invalid_task_request',
        'Send haze.task.request.v2 with an objective and optional exact context, constraints and deliverables.',
      );
    const request = parsed.data;
    const scope = framePm25Scope(request);
    for (const input of request.context_refs) this.artifact(input, identity);
    const now = new Date().toISOString();
    const mode =
      this.ports.nightshift.mode === 'fixture' ||
      this.ports.zetaris.mode === 'fixture'
        ? 'fixture'
        : 'live';
    const task: OrchestrationTask = {
      schema_version: 'haze.task.v2',
      id: randomUUID(),
      objective_revision: 1,
      generation: 1,
      original_request: request,
      scope,
      identity,
      status: 'queued',
      mode,
      permissions: {
        tools: [
          this.ports.zetaris.id,
          'pm25.compute',
          'pm25.check',
          this.ports.hmem.id,
          this.ports.world.id,
        ],
        effects: [],
      },
      limits: {
        deadline: new Date(Date.now() + this.profile.deadlineMs).toISOString(),
        max_model_calls: this.profile.maxModelCalls,
        max_tool_calls: this.profile.maxToolCalls,
        max_artifacts: this.profile.maxArtifacts,
        max_model_input_bytes: this.profile.maxModelInputBytes,
        max_model_output_tokens: 700,
      },
      usage: { model_calls: 0, tool_calls: 0, artifacts: 0 },
      created_at: now,
      updated_at: now,
      assignments: [],
    };
    const admitted = this.store.admit(task, key, value);
    if (!admitted.reused) {
      if (this.active.size + (this.options.otherActiveTasks?.() ?? 0) >= 2) {
        this.store.stop(
          task,
          'failed',
          'capacity_exhausted',
          'Two active task slots are already occupied. Submit a new request when capacity is available.',
        );
      } else {
        const controller = new AbortController();
        const promise = Promise.resolve()
          .then(() => this.execute(task, controller))
          .finally(() => this.active.delete(task.id));
        this.active.set(task.id, { controller, promise });
      }
    }
    return {
      task_id: admitted.task.id,
      status_url: `/api/tasks/${admitted.task.id}`,
      events_url: `/api/tasks/${admitted.task.id}/events`,
      reused: admitted.reused,
    };
  }
  cancel(id: string, identity: TaskIdentity, key: string) {
    const result = this.store.cancel(id, identity, key);
    if (result.status === 'cancelled')
      this.active.get(id)?.controller.abort('cancelled');
    return result;
  }
  private createAssignment(
    task: OrchestrationTask,
    role: OrchestrationRole,
    brief: string,
    tools: string[],
    inputs: ArtifactRef[] = [],
    dependencies: string[] = [],
  ): Assignment {
    const assignment: Assignment = {
      id: randomUUID(),
      task_id: task.id,
      role,
      definition_version: '1',
      capability: 'pm25-evidence-summary',
      objective_revision: task.objective_revision,
      generation: task.generation,
      brief,
      inputs,
      dependencies,
      tools,
      deadline: task.limits.deadline,
      max_model_calls: 1,
      status: 'queued',
      usage: { model_calls: 0, tool_calls: 0 },
      outputs: [],
      assumptions: [],
      gaps: [],
    };
    task.assignments.push(assignment);
    this.store.transition(
      task,
      'assignment_admitted',
      'Manager',
      `Admitted ${role} with versioned inputs and bounded tools.`,
      { role, definition_version: '1' },
      assignment.id,
    );
    return assignment;
  }
  private context(
    task: OrchestrationTask,
    assignment: Assignment,
    signal: AbortSignal,
  ): ExecutionContext {
    this.store.assertActive(task);
    signal.throwIfAborted();
    if (
      assignment.generation !== task.generation ||
      assignment.objective_revision !== task.objective_revision
    )
      throw new TaskError(
        409,
        'stale_assignment',
        'Assignment no longer matches the task revision.',
      );
    for (const input of assignment.inputs) this.artifact(input, task.identity);
    return Object.freeze({
      taskId: task.id,
      assignmentId: assignment.id,
      objectiveRevision: task.objective_revision,
      generation: task.generation,
      identity: Object.freeze({ ...task.identity }),
      deadline: task.limits.deadline,
      signal,
      modelLimits: Object.freeze({
        maxInputBytes: task.limits.max_model_input_bytes,
        maxOutputTokens: task.limits.max_model_output_tokens,
      }),
    });
  }
  private start(task: OrchestrationTask, assignment: Assignment) {
    assignment.status = 'running';
    this.store.transition(
      task,
      'assignment_started',
      assignment.role,
      `Executing ${assignment.role} in a separate bounded context.`,
      undefined,
      assignment.id,
    );
  }
  private finish(task: OrchestrationTask, assignment: Assignment) {
    assignment.status = 'completed';
    this.store.transition(
      task,
      'assignment_completed',
      assignment.role,
      `${assignment.role} returned versioned work products.`,
      { outputs: assignment.outputs },
      assignment.id,
    );
  }
  private async tool<T>(
    task: OrchestrationTask,
    assignment: Assignment,
    id: string,
    signal: AbortSignal,
    operation: (ctx: ExecutionContext) => Promise<T>,
  ): Promise<T> {
    const context = this.context(task, assignment, signal);
    if (
      !assignment.tools.includes(id) ||
      !task.permissions.tools.includes(id) ||
      task.permissions.effects.length
    )
      throw new TaskError(
        403,
        'tool_denied',
        'This assignment has no grant for that tool.',
      );
    if (task.usage.tool_calls >= task.limits.max_tool_calls)
      throw new TaskError(
        422,
        'tool_budget',
        'The aggregate tool budget is exhausted.',
      );
    task.usage.tool_calls++;
    assignment.usage.tool_calls++;
    this.store.transition(
      task,
      'tool_started',
      assignment.role,
      'Charged the admitted tool attempt before execution.',
      { tool: id, attempt: task.usage.tool_calls },
      assignment.id,
    );
    const output = await runWithExecutionContext(context, () =>
      operation(context),
    );
    this.context(task, assignment, signal);
    this.store.transition(
      task,
      'tool_completed',
      assignment.role,
      'The admitted tool returned.',
      { tool: id },
      assignment.id,
    );
    return output;
  }
  private async model<T>(
    task: OrchestrationTask,
    assignment: Assignment,
    phase: keyof typeof roleInstructions,
    content: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ) {
    const context = this.context(task, assignment, signal);
    const modelContext = {
      phase,
      objective: task.original_request.objective,
      constraints: task.original_request.constraints,
      desired_deliverables: task.original_request.desired_deliverables,
      brief: assignment.brief,
      material: content,
    };
    if (
      Buffer.byteLength(JSON.stringify(modelContext), 'utf8') >
      task.limits.max_model_input_bytes
    )
      throw new TaskError(
        422,
        'model_context_limit',
        'The model context exceeds its byte limit; no silent truncation was performed.',
      );
    const input = {
      role: assignment.role,
      instruction: roleInstructions[phase],
      context: modelContext,
    };
    validateModelInput(input, context.modelLimits);
    if (
      task.usage.model_calls >= task.limits.max_model_calls ||
      assignment.usage.model_calls >= assignment.max_model_calls
    )
      throw new TaskError(
        422,
        'model_budget',
        'The aggregate or assignment model budget is exhausted.',
      );
    task.usage.model_calls++;
    assignment.usage.model_calls++;
    this.store.transition(
      task,
      'model_started',
      assignment.role,
      'Charged a bounded model turn before execution.',
      { executor: this.ports.nightshift.id, phase, max_output_tokens: 700 },
      assignment.id,
    );
    const rawCompletion = await runWithExecutionContext(context, () =>
      this.ports.nightshift.execute(structuredClone(input), context),
    );
    const completion = validateModelCompletion(
      rawCompletion,
      context.modelLimits,
    );
    this.context(task, assignment, signal);
    const artifact = this.store.saveArtifact(
      task,
      assignment,
      'model-turn',
      {
        phase,
        executor: this.ports.nightshift.id,
        configured_route: this.ports.nightshift.selection ?? null,
        mode: task.mode,
        text: completion.text,
        receipt: completion.receipt,
      },
      assignment.inputs,
    );
    const parsed = schema.safeParse(parseContractJson(completion.text));
    if (!parsed.success)
      throw new TaskError(
        502,
        'invalid_model_output',
        'The model did not return the bounded output required for this role. No retry was made.',
      );
    this.store.transition(
      task,
      'model_completed',
      assignment.role,
      'Saved the actual model output and returned receipt.',
      { artifact_id: artifact.id, receipt: completion.receipt, phase },
      assignment.id,
    );
    return { data: parsed.data, receipt: completion.receipt, artifact };
  }
  private async execute(task: OrchestrationTask, controller: AbortController) {
    const signal = controller.signal;
    const timer = setTimeout(
      () => controller.abort('deadline'),
      Math.max(1, Date.parse(task.limits.deadline) - Date.now()),
    );
    let current: Assignment | undefined;
    try {
      task.status = 'running';
      this.store.transition(
        task,
        'task_started',
        'Manager',
        'Started the bounded orchestration evidence workflow.',
      );
      if (
        task.limits.max_model_calls < 5 ||
        task.limits.max_tool_calls < 5 ||
        task.limits.max_artifacts < 9
      )
        throw new TaskError(
          422,
          'insufficient_reservation',
          'This capability requires capacity for planning, three specialists, independent checks and synthesis.',
        );
      const planAssignment = this.createAssignment(
        task,
        'Manager',
        'Select the registered PM2.5 capability and its bounded evidence, analysis and review assignments. Preserve all original constraints.',
        [this.ports.hmem.id, this.ports.world.id],
      );
      current = planAssignment;
      this.start(task, planAssignment);
      const enrichment: unknown[] = [];
      const state = Annotation.Root({
        taskId: Annotation<string>(),
        generation: Annotation<number>(),
        artifactIds: Annotation<string[]>({
          reducer: (_prior, next) => next,
          default: () => [],
        }),
      });
      let evidence: OrchestrationArtifact,
        analysisArtifact: OrchestrationArtifact,
        reviewArtifact: OrchestrationArtifact;
      let capture: EvidenceCapture;
      let analysis: ReturnType<typeof analyzePm25>;
      let haze: Assignment, worker: Assignment, critic: Assignment;
      let review: ReviewRecord;
      const checkpoint = (step: string) => {
        this.store.assertActive(task);
        signal.throwIfAborted();
        this.store.transition(
          task,
          'workflow_step',
          'Runtime',
          `Completed ${step}.`,
        );
        return {
          artifactIds: task.assignments.flatMap((a) =>
            a.outputs.map((o) => o.id),
          ),
        };
      };
      const graph = new StateGraph(state)
        .addNode('optional_context', async () => {
          for (const [id, operation] of [
            [
              this.ports.hmem.id,
              (ctx: ExecutionContext) =>
                this.ports.hmem.recall(task.original_request.objective, ctx),
            ],
            [
              this.ports.world.id,
              (ctx: ExecutionContext) =>
                this.ports.world.readSnapshot(
                  task.original_request.objective,
                  ctx,
                ),
            ],
          ] as const) {
            try {
              const rawResult = await this.tool(
                task,
                planAssignment,
                id,
                signal,
                operation,
              );
              const result = validateEnrichmentResult(rawResult);
              if (result.status === 'available') {
                const artifact = this.store.saveArtifact(
                  task,
                  planAssignment,
                  'optional-context',
                  { port: id, ...result },
                );
                planAssignment.inputs.push(ref(artifact));
                const text = canonicalJson({
                  content: result.content,
                  limitations: result.limitations,
                });
                enrichment.push({
                  artifact_ref: ref(artifact),
                  ref: result.ref,
                  excerpt: text.slice(0, 1024),
                  excerpt_omitted: text.length > 1024,
                  original_characters: text.length,
                });
              } else
                this.store.transition(
                  task,
                  'optional_unavailable',
                  'Manager',
                  result.reason,
                  { port: id },
                  planAssignment.id,
                );
            } catch (error) {
              this.context(task, planAssignment, signal);
              if (error instanceof TaskError) throw error;
              this.store.transition(
                task,
                'optional_unavailable',
                'Manager',
                'Optional enrichment failed validation or was unavailable; no replacement was invented.',
                { port: id },
                planAssignment.id,
              );
            }
          }
          return checkpoint('optional context');
        })
        .addNode('plan', async () => {
          current = planAssignment;
          const context = task.original_request.context_refs.map((input) => ({
            ref: input,
            content: this.artifact(input, task.identity).content,
          }));
          planAssignment.inputs.push(...task.original_request.context_refs);
          const plan = await this.model(
            task,
            planAssignment,
            'ManagerPlan',
            {
              capabilities: [capabilityCardSchema.parse(pm25Capability)],
              scope: task.scope,
              context,
              enrichment,
            },
            managerPlanSchema,
            signal,
          );
          const roles = plan.data.roles;
          if (roles.join(',') !== 'HazeOps,WorkerShield,EvidenceCritic')
            throw new TaskError(
              422,
              'invalid_plan',
              'The PM2.5 capability requires evidence, analysis and independent review in dependency order.',
            );
          this.finish(task, planAssignment);
          haze = this.createAssignment(
            task,
            'HazeOps',
            'Retrieve the exact requested PM2.5 evidence and identify provenance, coverage limitations and gaps.',
            [this.ports.zetaris.id],
            [],
            [planAssignment.id],
          );
          worker = this.createAssignment(
            task,
            'WorkerShield',
            'Calculate PM2.5 sample coverage and range reproducibly; explain modeled instantaneous values without health or causal claims.',
            ['pm25.compute'],
            [],
            [haze.id],
          );
          critic = this.createAssignment(
            task,
            'EvidenceCritic',
            'Independently check exact source selections, recompute numerical results and review the producer claims. Do not review your own work.',
            ['pm25.check'],
            [],
            [worker.id],
          );
          return checkpoint('planning');
        })
        .addNode('retrieve', async () => {
          current = haze;
          const release = await this.pool.acquire(signal);
          try {
            this.start(task, haze);
            const retrieved = await this.tool(
              task,
              haze,
              this.ports.zetaris.id,
              signal,
              (ctx) =>
                this.ports.zetaris.retrieve(structuredClone(task.scope), ctx),
            );
            capture = structuredClone(retrieved);
            validateCapture(capture, task.scope, this.ports.zetaris.id);
            evidence = this.store.saveArtifact(
              task,
              haze,
              'evidence-capture',
              capture,
            );
          } finally {
            release();
          }
          return checkpoint('evidence retrieval');
        })
        .addNode('evidence_interpretation', async () => {
          current = haze;
          haze.inputs = [ref(evidence)];
          const release = await this.pool.acquire(signal);
          try {
            await this.model(
              task,
              haze,
              'HazeOps',
              {
                evidence_ref: ref(evidence),
                source: capture.source,
                scope: task.scope,
                kind: capture.kind,
                units: capture.units,
                temporal_support: capture.temporal_support,
                issued_at: capture.issued_at,
                row_count: capture.rows.length,
                preview: capture.rows.slice(0, 8),
                truncated: capture.selection.truncated,
                limitations: capture.limitations,
              },
              specialistTextSchema,
              signal,
            );
            haze.gaps = [...capture.limitations];
            this.finish(task, haze);
          } finally {
            release();
          }
          return checkpoint('evidence interpretation');
        })
        .addNode('calculate', async () => {
          current = worker;
          worker.inputs = [ref(evidence)];
          const release = await this.pool.acquire(signal);
          try {
            this.start(task, worker);
            analysis = await this.tool(
              task,
              worker,
              'pm25.compute',
              signal,
              () => Promise.resolve(analyzePm25(capture, task.scope)),
            );
            analysisArtifact = this.store.saveArtifact(
              task,
              worker,
              'coverage-analysis',
              analysis,
              [ref(evidence)],
            );
          } finally {
            release();
          }
          return checkpoint('deterministic analysis');
        })
        .addNode('analysis_explanation', async () => {
          current = worker;
          worker.inputs = [ref(evidence), ref(analysisArtifact)];
          const release = await this.pool.acquire(signal);
          try {
            await this.model(
              task,
              worker,
              'WorkerShield',
              { analysis_ref: ref(analysisArtifact), analysis },
              specialistTextSchema,
              signal,
            );
            worker.assumptions = analysis.assumptions;
            worker.gaps = analysis.unresolved_gaps;
            this.finish(task, worker);
          } finally {
            release();
          }
          return checkpoint('analysis explanation');
        })
        .addNode('independent_checks', async () => {
          current = critic;
          critic.inputs = [ref(evidence), ref(analysisArtifact)];
          const release = await this.pool.acquire(signal);
          try {
            this.start(task, critic);
            const exactCapture = this.store.artifact(
              evidence.id,
              task.identity,
              ref(evidence),
            ).content;
            const exactAnalysis = this.store.artifact(
              analysisArtifact.id,
              task.identity,
              ref(analysisArtifact),
            ).content;
            const checks = await this.tool(
              task,
              critic,
              'pm25.check',
              signal,
              () =>
                Promise.resolve(
                  independentlyCheckPm25(
                    exactCapture,
                    exactAnalysis,
                    task.scope,
                  ),
                ),
            );
            reviewArtifact = this.store.saveArtifact(
              task,
              critic,
              'independent-numerical-check',
              checks,
              critic.inputs,
            );
          } finally {
            release();
          }
          return checkpoint('independent deterministic checks');
        })
        .addNode('review', async () => {
          current = critic;
          const release = await this.pool.acquire(signal);
          try {
            const checks = this.store.artifact(reviewArtifact.id, task.identity)
              .content as ReturnType<typeof independentlyCheckPm25>;
            const producerTurns = [haze, worker]
              .flatMap((a) => a.outputs)
              .map((input) =>
                this.store.artifact(input.id, task.identity, input),
              )
              .filter((a) => a.kind === 'model-turn')
              .map((a) => ({ ref: ref(a), content: a.content }));
            critic.inputs = [
              ref(evidence),
              ref(analysisArtifact),
              ref(reviewArtifact),
              ...producerTurns.map((a) => a.ref),
            ];
            const response = await this.model(
              task,
              critic,
              'EvidenceCritic',
              {
                scope: task.scope,
                analysis,
                checks,
                producerTurns,
                source_preview: capture.rows.slice(0, 8),
                source_limitations: capture.limitations,
              },
              criticVerdictSchema,
              signal,
            );
            review = reviewRecordSchema.parse({
              schema_version: 'haze.review.v1',
              reviewer_assignment_id: critic.id,
              reviewed_artifacts: critic.inputs,
              checks: checks.checks,
              ...response.data,
              verdict: checks.valid ? response.data.verdict : 'rejected',
              limitations: [
                ...checks.limitations,
                ...response.data.limitations,
                'Model review does not establish scientific qualification or complete prose entailment.',
              ],
            });
            reviewArtifact = this.store.saveArtifact(
              task,
              critic,
              'independent-review',
              review,
              [...critic.inputs, ref(response.artifact)],
            );
            critic.gaps = review.limitations;
            this.finish(task, critic);
          } finally {
            release();
          }
          return checkpoint('independent model review');
        })
        .addNode('synthesize', async () => {
          current = this.createAssignment(
            task,
            'Manager',
            'Answer the original request using current supported artifacts and the independent review. Withhold rejected material and preserve caveats.',
            [],
            [ref(evidence), ref(analysisArtifact), ref(reviewArtifact)],
            [critic.id],
          );
          this.start(task, current);
          const rejected = review.verdict === 'rejected';
          const synthesis = await this.model(
            task,
            current,
            'ManagerSynthesis',
            {
              scope: task.scope,
              analysis: rejected ? null : analysis,
              review,
              allowed_findings: rejected ? [] : analysis.findings,
              required_citation: 'E1',
            },
            synthesisSchema,
            signal,
          );
          if (
            !synthesis.data.answer.includes('[E1]') ||
            /\[E(?!1\])\d+\]/.test(synthesis.data.answer)
          )
            throw new TaskError(
              502,
              'invalid_citations',
              'The synthesis must cite the exact E1 selection.',
            );
          // Rejection uses a controlled gap statement; synthesis text cannot override the verdict.
          const answer = rejected
            ? 'The retrieved selection [E1] could not support the proposed analysis after independent checking. Rejected claims are withheld; see the review findings and limitations.'
            : synthesis.data.answer;
          const receipt = synthesis.receipt;
          task.result = orchestrationResultSchema.parse({
            schema_version: 'haze.task.result.v2',
            completion: rejected
              ? 'blocked'
              : review.verdict === 'needs_review' ||
                  analysis.coverage.status !== 'available'
                ? 'partial'
                : 'full',
            answer,
            findings: rejected ? [] : analysis.findings,
            citations: [
              {
                id: 'E1',
                artifact_id: evidence.id,
                sha256: evidence.sha256,
                url: `/api/tasks/${task.id}/artifacts/${evidence.id}`,
                label: `Exact ${capture.location} PM2.5 selection`,
                selection: capture.selection,
              },
            ],
            coverage: rejected ? null : analysis.coverage,
            assumptions: rejected ? [] : analysis.assumptions,
            unresolved_gaps: [...analysis.unresolved_gaps, ...review.findings],
            review: {
              status: review.verdict,
              scope:
                'Independent numerical recomputation and separate model inspection of exact producer artifacts; informational use only.',
              limitations: review.limitations,
              artifact_id: reviewArtifact.id,
            },
            provenance: {
              mode: task.mode,
              source: capture.source,
              retrieved_at: capture.retrieved_at,
              model: {
                provider:
                  this.ports.nightshift.selection?.provider ??
                  this.ports.nightshift.id,
                model: this.ports.nightshift.selection?.model ?? 'unknown',
                calls: task.usage.model_calls,
                max_output_tokens: 700,
                usage:
                  receipt.input_tokens === null &&
                  receipt.output_tokens === null
                    ? 'not_reported_by_adapter'
                    : 'reported_by_provider',
                receipt,
              },
              tool_calls: task.usage.tool_calls,
              method: 'haze.pm25.coverage.v1',
            },
          });
          this.finish(task, current);
          task.status = 'completed';
          this.store.transition(
            task,
            'task_completed',
            'Manager',
            'Delivered the informational result with exact sources and explicit review limits.',
          );
          return {
            artifactIds: task.assignments.flatMap((a) =>
              a.outputs.map((o) => o.id),
            ),
          };
        })
        .addEdge(START, 'optional_context')
        .addEdge('optional_context', 'plan')
        .addEdge('plan', 'retrieve')
        .addEdge('retrieve', 'evidence_interpretation')
        .addEdge('evidence_interpretation', 'calculate')
        .addEdge('calculate', 'analysis_explanation')
        .addEdge('analysis_explanation', 'independent_checks')
        .addEdge('independent_checks', 'review')
        .addEdge('review', 'synthesize')
        .addEdge('synthesize', END);
      // Keep existing checkpoint paths/thread IDs readable across the source module rename.
      this.checkpointHandle ??= openSqliteCheckpointer(
        `${this.options.stateDirectory}/hybrid-checkpoints-v1`,
      );
      const handle = await this.checkpointHandle;
      const workflow = graph.compile({ checkpointer: handle.checkpointer });
      await workflow.invoke(
        { taskId: task.id, generation: task.generation, artifactIds: [] },
        {
          configurable: {
            thread_id: `hybrid-v1:${task.id}:${task.generation}`,
          },
          durability: 'sync',
          recursionLimit: 30,
        },
      );
    } catch (error) {
      const saved = this.store.read(task.id, task.identity);
      if (activeStatus(saved.status)) {
        const expired =
          signal.reason === 'deadline' ||
          Date.now() >= Date.parse(task.limits.deadline) ||
          (error instanceof TaskError && error.code === 'deadline') ||
          (error instanceof IntegrationPortError &&
            error.code === 'deadline_exceeded');
        if (expired && !signal.aborted) controller.abort('deadline');
        const code = signal.aborted
          ? signal.reason === 'deadline'
            ? 'deadline'
            : 'execution_aborted'
          : error instanceof TaskError ||
              error instanceof EvidenceSourceError ||
              error instanceof IntegrationPortError
            ? error.code
            : 'execution_failed';
        const message =
          error instanceof TaskError ||
          error instanceof EvidenceSourceError ||
          error instanceof IntegrationPortError
            ? error.message
            : 'The admitted model, tool or role failed. Prior artifacts and charged attempts remain; no fallback or retry was performed.';
        if (current) {
          current.status = expired ? 'timed_out' : 'failed';
          current.error = { code, message };
          // Preserve the failing assignment state without accepting new output.
          try {
            this.store.transition(
              task,
              'assignment_failed',
              current.role,
              message,
              { code },
              current.id,
            );
          } catch {
            /* A cancellation/deadline may already fence this writer. */
          }
        }
        this.store.stop(saved, expired ? 'timed_out' : 'failed', code, message);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const [id, execution] of this.active) {
        const row = this.options.taskStore.db
          .prepare('SELECT body FROM hybrid_tasks WHERE id=?')
          .get(id) as { body: string };
        const task = JSON.parse(row.body) as OrchestrationTask;
        this.store.stop(
          this.store.read(id, task.identity),
          'failed',
          'restart_interrupted',
          'The runtime stopped. Artifacts and charged attempts remain; no automatic replay will occur.',
        );
        execution.controller.abort('shutdown');
      }
      await Promise.allSettled([...this.active.values()].map((x) => x.promise));
      if (this.checkpointHandle) (await this.checkpointHandle).close();
    })();
    return this.closing;
  }
}

export type { OrchestrationRequest };
