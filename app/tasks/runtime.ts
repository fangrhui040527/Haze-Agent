import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  resolveAgentModel,
  type AgentModel,
  type AgentModelCompletion,
  type AgentModelReceipt,
} from '../adapters/agent-model.js';
import { openSqliteCheckpointer } from '../checkpoints/sqlite.js';
import { parseContractJson } from '../contracts/json.js';
import {
  artifactImportSchema,
  boundedJsonSchema,
  type Artifact,
  type ArtifactRef,
} from '../contracts/artifacts.js';
import { taskControlSchema, taskUpdateSchema } from '../contracts/controls.js';
import {
  TaskError,
  taskRequestSchema,
  taskResultSchema,
  type Assignment,
  type ResourceLimits,
  type TaskIdentity,
  type TaskRecord,
  type TaskRequest,
  type TaskResult,
} from '../contracts/tasks.js';
import {
  agentActionSchema,
  assignmentOutputSchema,
  managerPlanSchema,
} from '../orchestration/contracts.js';
import {
  createTaskBoundaryGraph,
  validateAssignmentPlan,
} from '../orchestration/runtime.js';
import {
  boundedExecution,
  type AssignmentOutput,
  type AssignmentServices,
  type ExecutionMode,
  type ExecutionRegistry,
  type ToolContext,
} from '../orchestration/ports.js';
import { TaskStore, type WorldProjectionRecordInput } from './store.js';

export const localTaskIdentity: TaskIdentity = {
  principal: 'local-user',
  workspace: 'local-workspace',
};
export interface TaskRuntimeOptions {
  stateDirectory: string;
  registry: ExecutionRegistry;
  mode?: ExecutionMode;
  model?: AgentModel;
  env?: NodeJS.ProcessEnv;
  limits?: Partial<ResourceLimits>;
}
const exact = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const json = (value: unknown) => boundedJsonSchema.parse(value);
const outcomeUnknown = (
  error: unknown,
): error is Error & { outcome: 'unknown' } =>
  error instanceof Error && 'outcome' in error && error.outcome === 'unknown';
const leaseOf = (assignment: Assignment) => ({
  generation: assignment.generation,
  assignment_revision: assignment.revision,
  lease_token: assignment.lease_token!,
});
const synthesisSchema = z.strictObject({
  answer: z.string().min(1).max(20000),
  uncertainty: z.array(z.string().min(1).max(4096)).max(64).optional(),
});

export class TaskRuntime {
  readonly store: TaskStore;
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly pending = new Set<string>();
  private readonly checkpoints: ReturnType<typeof openSqliteCheckpointer>;
  private model: AgentModel | undefined;
  private closed = false;
  constructor(private readonly options: TaskRuntimeOptions) {
    this.store = new TaskStore(options.stateDirectory);
    this.model = options.model;
    this.store.configureDefinitions({
      agents: Object.fromEntries(
        [...options.registry.agents].map(([id, value]) => [id, value.version]),
      ),
      capabilities: {
        'core.manager': '3',
        ...Object.fromEntries(
          [...options.registry.capabilities].map(([id, value]) => [
            id,
            value.card.version,
          ]),
        ),
      },
      tools: [...options.registry.tools.keys()],
      assignments: {
        'core.manager.plan': {
          version: '3',
          capability: 'core.manager',
          role: 'Manager',
          tools: [],
        },
        'core.manager.synthesis': {
          version: '3',
          capability: 'core.manager',
          role: 'Manager',
          tools: [],
        },
        ...Object.fromEntries(
          [...options.registry.definitions].map(([id, value]) => [
            id,
            {
              version: value.version,
              capability: value.capability,
              role: value.agent,
              tools: value.tools,
            },
          ]),
        ),
      },
    });
    this.checkpoints = openSqliteCheckpointer(options.stateDirectory);
    for (const task of this.store.listRecoverableTasks())
      queueMicrotask(() => this.schedule(task.id));
  }
  get activeCount() {
    return this.active.size;
  }
  capabilities(identity: TaskIdentity = localTaskIdentity) {
    if (
      identity.principal !== localTaskIdentity.principal ||
      identity.workspace !== localTaskIdentity.workspace
    )
      throw new TaskError(
        403,
        'local_identity_required',
        'Capability metadata is limited to the local application identity.',
      );
    return [...this.options.registry.capabilities.values()].map((value) =>
      structuredClone(value.card),
    );
  }
  admit(
    value: unknown,
    key: string,
    identity: TaskIdentity = localTaskIdentity,
  ) {
    if (this.closed)
      throw new TaskError(
        503,
        'runtime_closed',
        'The task runtime is stopping.',
      );
    const parsed = taskRequestSchema.safeParse(value);
    if (!parsed.success)
      throw new TaskError(
        400,
        'invalid_task_request',
        'Send haze.task.request.v3 with an objective and optional scope, exact context references, constraints and deliverables. v1/v2 have been retired.',
      );
    const request = parsed.data;
    const investigation = [...this.options.registry.capabilities.values()].some(
      (capability) =>
        capability.card.id !== 'evidence-synthesis' &&
        capability.matches(request),
    );
    const maximums = investigation
      ? {
          max_model_calls: 20,
          max_tool_calls: 20,
          max_assignments: 16,
          max_artifacts: 64,
        }
      : {
          max_model_calls: 6,
          max_tool_calls: 6,
          max_assignments: 6,
          max_artifacts: 16,
        };
    const admitted = this.store.admit(request, identity, key, {
      mode: this.options.mode ?? 'live',
      limits: {
        ...maximums,
        deadline: new Date(
          Date.now() + (investigation ? 300000 : 90000),
        ).toISOString(),
        max_model_input_bytes: 16384,
        max_model_output_tokens: 1200,
        reserved_model_calls: 2,
        ...this.options.limits,
      },
      tools: [...this.options.registry.tools.values()]
        .filter((tool) => tool.mode === (this.options.mode ?? 'live'))
        .map((tool) => tool.id),
    });
    if (!admitted.reused) this.schedule(admitted.task.id);
    return {
      task_id: admitted.task.id,
      status_url: `/api/tasks/${admitted.task.id}`,
      events_url: `/api/tasks/${admitted.task.id}/events`,
      reused: admitted.reused,
    };
  }
  importArtifact(
    value: unknown,
    key: string,
    identity: TaskIdentity = localTaskIdentity,
  ) {
    const parsed = artifactImportSchema.safeParse(value);
    if (!parsed.success)
      throw new TaskError(
        400,
        'invalid_artifact_import',
        'Send a strict haze.artifact.import.v3 source import.',
      );
    return this.store.importArtifact(parsed.data, identity, key).artifact;
  }
  update(
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity = localTaskIdentity,
  ) {
    const parsed = taskUpdateSchema.safeParse(value);
    if (!parsed.success)
      throw new TaskError(
        400,
        'invalid_update',
        'Send a strict haze.task.update.v3 mutation with current revisions.',
      );
    const before = this.store.read(id, identity);
    const receipt = this.store.update(id, identity, key, parsed.data);
    const after = this.store.read(id, identity);
    if (
      before.generation !== after.generation ||
      before.objective_revision !== after.objective_revision ||
      before.current_run_id !== after.current_run_id
    ) {
      this.active.get(id)?.controller.abort('objective_revised');
      this.schedule(id);
    }
    return receipt;
  }
  control(
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity = localTaskIdentity,
  ) {
    const parsed = taskControlSchema.safeParse(value);
    if (!parsed.success)
      throw new TaskError(
        400,
        'invalid_control',
        'Send a strict haze.task.control.v3 mutation with current run and state revisions.',
      );
    const before = this.store.read(id, identity);
    const receipt = this.store.control(id, identity, key, parsed.data);
    const after = this.store.read(id, identity);
    if (
      before.generation !== after.generation ||
      before.objective_revision !== after.objective_revision ||
      before.current_run_id !== after.current_run_id
    ) {
      this.active.get(id)?.controller.abort(parsed.data.action);
      if (['resume', 'continue'].includes(parsed.data.action))
        this.schedule(id);
    }
    return receipt;
  }
  private schedule(id: string) {
    if (this.closed) return;
    if (this.active.has(id)) {
      this.pending.add(id);
      return;
    }
    const controller = new AbortController();
    const lease = this.store.read(id, localTaskIdentity);
    const promise = Promise.resolve()
      .then(() => this.execute(id, controller))
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.closed) return;
        const current = this.store.read(id, localTaskIdentity);
        if (
          current.current_run_id !== lease.current_run_id ||
          current.generation !== lease.generation ||
          current.objective_revision !== lease.objective_revision
        )
          return;
        if (!['queued', 'running'].includes(current.status)) return;
        this.store.stop(
          id,
          Date.now() >= Date.parse(current.limits.deadline)
            ? 'timed_out'
            : 'failed',
          error instanceof TaskError ? error.code : 'execution_failed',
          error instanceof Error
            ? error.message.slice(0, 4000)
            : 'Execution failed.',
          {
            run_id: lease.current_run_id,
            generation: lease.generation,
            objective_revision: lease.objective_revision,
          },
        );
      })
      .finally(() => {
        this.active.delete(id);
        if (this.pending.delete(id)) this.schedule(id);
      });
    this.active.set(id, { controller, promise });
  }
  private current(id: string, generation: number, objectiveRevision: number) {
    const task = this.store.read(id, localTaskIdentity);
    if (
      task.generation !== generation ||
      task.objective_revision !== objectiveRevision ||
      !['queued', 'running'].includes(task.status)
    )
      throw new TaskError(
        409,
        'execution_fenced',
        'Execution lease is no longer current.',
      );
    if (Date.now() >= Date.parse(task.limits.deadline))
      throw new TaskError(
        408,
        'deadline_exceeded',
        'The admitted deadline has expired. Continue explicitly with a new bounded run.',
      );
    return task;
  }
  private request(task: TaskRecord): TaskRequest {
    const scope =
      [...task.corrections]
        .reverse()
        .find((correction) => correction.scope !== undefined)?.scope ??
      task.original_request.scope;
    return {
      ...task.original_request,
      objective: [
        task.original_request.objective,
        ...task.corrections.map(
          (correction) => `${correction.kind}: ${correction.passage}`,
        ),
      ].join('\n'),
      ...(scope !== undefined ? { scope } : {}),
    };
  }
  private contextRefs(task: TaskRecord): ArtifactRef[] {
    return [
      ...new Map(
        [
          ...task.original_request.context_refs,
          ...task.corrections.flatMap(
            (correction) => correction.context_refs ?? [],
          ),
        ].map((ref) => [ref.id, ref]),
      ).values(),
    ];
  }
  private inbox(task: TaskRecord, assignmentId: string) {
    const channel = this.store.peerChannelForRun(task.current_run_id);
    if (
      !channel ||
      !channel.participants.some(
        (participant) => participant.assignment_id === assignmentId,
      )
    )
      return [];
    return this.store.peerMessages(
      task.id,
      task.identity,
      channel.id,
      assignmentId,
    );
  }
  private async boundary(task: TaskRecord) {
    const refs = {
      taskId: task.id,
      runId: task.current_run_id,
      generation: task.generation,
      objectiveRevision: task.objective_revision,
      assignmentIds: task.assignments
        .filter((item) => item.run_id === task.current_run_id)
        .map((item) => item.id),
      actionIds: [] as string[],
      artifactIds: task.artifacts
        .filter((item) => item.current)
        .map((item) => item.artifact.id),
    };
    this.store.saveCheckpoint(
      task.id,
      task.current_run_id,
      task.generation,
      json(refs),
    );
    const checkpoint = await this.checkpoints;
    await createTaskBoundaryGraph(checkpoint.checkpointer).invoke(refs, {
      configurable: {
        thread_id: `${task.id}:${task.current_run_id}:${task.generation}`,
      },
    });
  }
  private async execute(
    id: string,
    controller: AbortController,
  ): Promise<void> {
    let task = this.store.read(id, localTaskIdentity);
    if (!['queued', 'running'].includes(task.status)) return;
    const generation = task.generation,
      revision = task.objective_revision;
    if (task.objective_revision > 1) {
      for (const ref of this.contextRefs(task))
        this.store.recordApplicability(
          id,
          task.identity,
          ref,
          true,
          'Manager revalidated source hash, access and applicability against revised objective.',
          'Manager',
        );
      const correction = [...task.corrections]
        .reverse()
        .find((item) => item.scope !== undefined);
      const request = {
        ...this.request(task),
        ...(correction ? { objective: correction.passage } : {}),
      };
      for (const assignment of task.assignments.filter(
        (item) => item.run_id === task.current_run_id,
      )) {
        if (assignment.status === 'completed')
          for (const ref of assignment.outputs)
            this.store.recordApplicability(
              id,
              task.identity,
              ref,
              true,
              'Manager explicitly checked unaffected branch applicability after correction.',
              'Manager',
            );
        if (
          assignment.status === 'queued' &&
          assignment.revision > 1 &&
          assignment.acknowledged_revision !== assignment.revision
        ) {
          const capability = this.options.registry.capabilities.get(
            assignment.capability,
          );
          const plan = capability
            ?.assignments(request)
            .find((item) => item.definition_id === assignment.definition_id);
          if (plan)
            this.store.reviseAssignmentInput(
              id,
              assignment.id,
              generation,
              json(plan.input ?? null),
            );
        }
      }
      task = this.store.read(id, localTaskIdentity);
    }
    const validAssignments = () =>
      this.store
        .read(id, localTaskIdentity)
        .assignments.filter(
          (assignment) =>
            assignment.run_id === task.current_run_id &&
            assignment.objective_revision === revision &&
            assignment.status !== 'stale',
        );
    let work = validAssignments();
    if (work.some((assignment) => assignment.role !== 'Manager')) {
      for (const assignment of work.filter(
        (item) =>
          item.definition_id === 'core.manager.plan' &&
          item.status === 'queued',
      )) {
        const leased = this.store.acquireAssignment(id, assignment.id);
        if (leased) {
          const actionId = `rebrief-${leased.revision}`;
          this.store.recordAction(
            id,
            leased.id,
            actionId,
            json({
              source: 'registered-capability-template',
              objective_revision: revision,
            }),
            json({ id: actionId, type: 'acknowledge-revised-plan' }),
            leaseOf(leased),
          );
          this.store.dispatchAction(id, leased.id, actionId, leaseOf(leased));
          this.store.completeAssignment(id, leased.id, generation, {
            status: 'completed',
            support: 'supported',
            usability: 'usable',
          });
        }
      }
    }
    if (!work.some((assignment) => assignment.role !== 'Manager')) {
      const manager =
        work.find(
          (assignment) =>
            assignment.definition_id === 'core.manager.plan' &&
            ['queued', 'paused'].includes(assignment.status),
        ) ??
        this.store.createAssignments(id, task.current_run_id, revision, [
          {
            definition_id: 'core.manager.plan',
            role: 'Manager',
            capability: 'core.manager',
            definition_version: '3',
            brief:
              'Select a bounded execution path from registered capability cards.',
            tools: [],
            max_model_calls: task.limits.max_model_calls,
          },
        ])[0]!;
      const leased = this.store.acquireAssignment(id, manager.id);
      if (!leased) return;
      const request = this.request(task);
      const available = [...this.options.registry.capabilities.values()].filter(
        (capability) =>
          capability.card.required_tools.every((tool) =>
            task.permissions.tools.includes(tool),
          ),
      );
      const selected = available.find((capability) =>
        capability.matches(request),
      );
      const fixture = {
        id: randomUUID(),
        type: 'delegate' as const,
        capability: selected?.card.id ?? '',
        assignments: selected?.assignments(request) ?? [],
      };
      const response =
        task.mode === 'fixture'
          ? { text: JSON.stringify(fixture), receipt: null }
          : await this.modelTurn(
              task,
              leased,
              {
                purpose: 'plan',
                request,
                sources: this.contextRefs(task).map((ref, index) => ({
                  citation: `S${index + 1}`,
                  artifact: this.readExact(task, ref),
                })),
                capabilities: available.map((capability) => ({
                  card: capability.card,
                  template: capability.assignments(request),
                })),
                definitions: [...this.options.registry.definitions.values()]
                  .filter(
                    (definition) =>
                      available.some(
                        (capability) =>
                          capability.card.id === definition.capability,
                      ) &&
                      definition.tools.every((tool) =>
                        task.permissions.tools.includes(tool),
                      ),
                  )
                  .map(
                    ({
                      id: definition_id,
                      capability,
                      agent,
                      version,
                      tools,
                      instructions,
                    }) => ({
                      definition_id,
                      capability,
                      agent,
                      version,
                      tools,
                      instructions,
                    }),
                  ),
                action_schema:
                  'Return {id,type:"delegate",capability,assignments:[{key,definition_id,brief,depends_on,input?}]} or {id,type:"question",prompt} or {id,type:"respond",answer,uncertainty}. You may choose any valid registered DAG, not just a template.',
              },
              controller.signal,
            );
      const decoded = parseContractJson(response.text);
      const plan = managerPlanSchema.parse(
        this.options.registry.agents
          .get('Manager')
          ?.schemas?.plan?.parse(decoded) ?? decoded,
      );
      const plannedAction = this.store.recordAction(
        id,
        leased.id,
        plan.id,
        json(response),
        json(plan),
        leaseOf(leased),
      );
      if (
        !plannedAction.dispatched &&
        plannedAction.generation !== leased.generation
      )
        this.store.adoptAction(id, leased.id, plan.id, leaseOf(leased));
      if (!this.store.dispatchAction(id, leased.id, plan.id, leaseOf(leased)))
        throw new TaskError(
          409,
          'duplicate_action',
          'This validated action has already been dispatched.',
        );
      this.current(id, generation, revision);
      if (plan.type === 'question') {
        this.store.completeAssignment(id, leased.id, generation, {
          status: 'waiting',
          support: 'gap',
        });
        this.store.askQuestion(id, leased.id, plan.prompt);
        await this.boundary(this.store.read(id, localTaskIdentity));
        return;
      }
      if (plan.type === 'respond') {
        this.store.completeAssignment(id, leased.id, generation, {
          status: 'completed',
          support: 'supported',
          usability: 'usable',
        });
        const directSources = this.contextRefs(task).map((ref, index) => {
          const source = this.readExact(task, ref);
          return {
            id: `S${index + 1}`,
            artifact: exact(source),
            label: source.filename ?? source.kind,
            url: `/api/artifacts/${source.id}`,
          };
        });
        if (
          (directSources.length &&
            !directSources.some((source) =>
              plan.answer.includes(`[${source.id}]`),
            )) ||
          [...plan.answer.matchAll(/\[([A-Za-z]+\d+)\]/g)].some(
            (match) => !directSources.some((source) => source.id === match[1]),
          )
        )
          throw new TaskError(
            502,
            'invalid_citation',
            'A source-backed direct response must cite supplied exact sources.',
          );
        const directTask = this.store.read(id, localTaskIdentity);
        const result = this.result(
          directTask,
          plan.answer,
          [],
          directSources,
          plan.uncertainty,
        );
        this.store.saveResult(
          id,
          task.current_run_id,
          generation,
          result,
          this.worldModelProjections(directTask, result),
        );
        return;
      }
      if (
        !available.some((capability) => capability.card.id === plan.capability)
      )
        throw new TaskError(
          403,
          'capability_denied',
          'The Manager selected an unavailable capability.',
        );
      validateAssignmentPlan(
        plan.assignments,
        this.options.registry,
        new Set(available.map((capability) => capability.card.id)),
        new Set(task.permissions.tools),
      );
      const ids = new Map(
        plan.assignments.map((item) => [item.key, randomUUID()]),
      );
      const definitions = plan.assignments.map((item) => {
        const definition = this.options.registry.definitions.get(
          item.definition_id,
        )!;
        return {
          id: ids.get(item.key)!,
          definition_id: definition.id,
          role: definition.agent,
          capability: definition.capability,
          definition_version: definition.version,
          brief: item.brief,
          dependencies: item.depends_on.map((key) => ids.get(key)!),
          tools: definition.tools,
          inputs: this.contextRefs(task),
          input: json(item.input ?? null),
          max_model_calls: 4,
        };
      });
      this.store.createAssignments(
        id,
        task.current_run_id,
        revision,
        definitions,
      );
      this.store.completeAssignment(id, leased.id, generation, {
        status: 'completed',
        support: 'supported',
        usability: 'usable',
      });
      await this.boundary(this.store.read(id, localTaskIdentity));
    }
    while (!controller.signal.aborted) {
      task = this.current(id, generation, revision);
      work = validAssignments().filter(
        (assignment) => assignment.role !== 'Manager',
      );
      for (const assignment of work)
        if (
          assignment.status === 'waiting' &&
          this.inbox(task, assignment.id).length > 0
        )
          this.store.wakeAssignment(id, assignment.id);
      work = validAssignments().filter(
        (assignment) => assignment.role !== 'Manager',
      );
      if (work.some((assignment) => assignment.status === 'failed'))
        throw new TaskError(
          502,
          'assignment_failed',
          'An admitted branch failed. Accepted evidence and receipts remain available.',
        );
      if (work.every((assignment) => assignment.status === 'completed')) break;
      const ready = work.filter(
        (assignment) =>
          assignment.status === 'queued' &&
          assignment.dependencies.every((dependency) =>
            work.some(
              (item) => item.id === dependency && item.status === 'completed',
            ),
          ),
      );
      if (!ready.length) {
        await this.boundary(task);
        return;
      }
      const leased = ready
        .map((assignment) => this.store.acquireAssignment(id, assignment.id))
        .filter((assignment): assignment is Assignment => assignment !== null);
      if (!leased.length) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      await Promise.all(
        leased.map((assignment) =>
          this.executeAssignment(task, assignment, controller.signal),
        ),
      );
      await this.boundary(this.store.read(id, localTaskIdentity));
    }
    controller.signal.throwIfAborted();
    task = this.current(id, generation, revision);
    work = validAssignments().filter(
      (assignment) => assignment.role !== 'Manager',
    );
    const accepted = work.filter(
      (assignment) =>
        assignment.status === 'completed' && assignment.usability === 'usable',
    );
    const outputRefs = accepted.flatMap((assignment) => assignment.outputs);
    const artifacts = outputRefs.map((ref) => this.readExact(task, ref));
    const rejected = artifacts.some(
      (artifact) =>
        artifact.kind === 'review' &&
        typeof artifact.content === 'object' &&
        artifact.content !== null &&
        'valid' in artifact.content &&
        artifact.content.valid === false,
    );
    if (rejected)
      throw new TaskError(
        422,
        'review_rejected',
        'The independent checker rejected material; it was excluded from synthesis.',
      );
    const summaries = artifacts
      .filter((artifact) => artifact.kind === 'assignment.summary')
      .map((artifact) => artifact.content as unknown as AssignmentOutput);
    const sources = [
      ...this.contextRefs(task).map((ref) => this.readExact(task, ref)),
      ...artifacts.filter(
        (artifact) =>
          artifact.kind.endsWith('.capture') ||
          ['external_source', 'synthetic_fixture', 'user_supplied'].includes(
            artifact.evidence_origin ?? '',
          ),
      ),
    ];
    let sourceIndex = 0,
      captureIndex = 0;
    const citations = sources.map((artifact) => ({
      id:
        artifact.producer.kind === 'user' || artifact.kind === 'source.import'
          ? `S${++sourceIndex}`
          : `E${++captureIndex}`,
      artifact: exact(artifact),
      label: artifact.filename ?? artifact.kind,
      url: `/api/artifacts/${artifact.id}`,
    }));
    const uncertainty = [
      ...new Set(summaries.flatMap((summary) => summary.uncertainty)),
    ].slice(0, 64);
    const manager =
      validAssignments().find(
        (assignment) =>
          assignment.definition_id === 'core.manager.synthesis' &&
          ['queued', 'paused'].includes(assignment.status),
      ) ??
      this.store.createAssignments(id, task.current_run_id, revision, [
        {
          definition_id: 'core.manager.synthesis',
          role: 'Manager',
          capability: 'core.manager',
          definition_version: '3',
          brief: 'Synthesize accepted reviewed work into a general result.',
          tools: [],
          max_model_calls: task.limits.max_model_calls,
          dependencies: work.map((assignment) => assignment.id),
        },
      ])[0]!;
    const leased = this.store.acquireAssignment(id, manager.id);
    if (!leased) return;
    let answer: string;
    let synthesisResponse: unknown;
    if (task.mode === 'fixture') {
      answer =
        summaries.map((summary) => summary.summary).join('\n\n') +
        (citations.length
          ? `\n\nSources: ${citations.map((citation) => `[${citation.id}]`).join(', ')}.`
          : '');
      synthesisResponse = { text: JSON.stringify({ answer }), receipt: null };
    } else {
      const response = await this.modelTurn(
        task,
        leased,
        {
          purpose: 'synthesis',
          objective: this.request(task).objective,
          summaries,
          citations,
          uncertainty,
          instruction:
            'Return strict JSON {"answer":"source-backed prose"}. Cite only supplied citation IDs. Preserve gaps, modeled/source semantics and review limitations. Do not manufacture missing evidence.',
        },
        controller.signal,
      );
      const decoded = parseContractJson(response.text);
      const synthesis = synthesisSchema.parse(
        this.options.registry.agents
          .get('Manager')
          ?.schemas?.synthesis?.parse(decoded) ?? decoded,
      );
      answer = synthesis.answer;
      uncertainty.push(
        ...(synthesis.uncertainty ?? []).filter(
          (item) => !uncertainty.includes(item),
        ),
      );
      uncertainty.splice(64);
      synthesisResponse = response;
    }
    const cited = [...answer.matchAll(/\[([A-Za-z]+\d+)\]/g)].map(
      (match) => match[1],
    );
    if (
      cited.some((id) => !citations.some((citation) => citation.id === id)) ||
      (citations.length > 0 && cited.length === 0)
    )
      throw new TaskError(
        502,
        'invalid_citation',
        'Synthesis must cite only exact accepted source references.',
      );
    const finalActionId = `publish-${
      this.store
        .attempts(id, task.identity)
        .filter(
          (attempt) => attempt.assignment_id === leased.id && attempt.accepted,
        )
        .at(-1)?.id ?? generation
    }`;
    const publishedAction = this.store.recordAction(
      id,
      leased.id,
      finalActionId,
      json(synthesisResponse),
      json({ id: finalActionId, type: 'publish-result', answer }),
      leaseOf(leased),
    );
    if (
      !publishedAction.dispatched &&
      publishedAction.generation !== leased.generation
    )
      this.store.adoptAction(id, leased.id, finalActionId, leaseOf(leased));
    if (
      !this.store.dispatchAction(id, leased.id, finalActionId, leaseOf(leased))
    )
      throw new TaskError(
        409,
        'duplicate_action',
        'The final result action was already dispatched.',
      );
    this.store.completeAssignment(id, leased.id, generation, {
      status: 'completed',
      support: 'supported',
      usability: 'usable',
    });
    const fresh = this.current(id, generation, revision);
    const result = this.result(
      fresh,
      answer,
      artifacts
        .filter(
          (artifact) =>
            artifact.kind !== 'assignment.summary' &&
            !accepted.some(
              (assignment) =>
                assignment.role === 'EvidenceCritic' &&
                assignment.id === artifact.assignment_id,
            ),
        )
        .map(exact),
      citations,
      uncertainty,
    );
    this.store.saveResult(
      id,
      task.current_run_id,
      generation,
      result,
      this.worldModelProjections(fresh, result),
    );
    await this.boundary(this.store.read(id, localTaskIdentity));
  }
  private readExact(task: TaskRecord, ref: ArtifactRef): Artifact {
    const artifact = this.store.artifact(ref.id, task.identity);
    if (artifact.version !== ref.version || artifact.sha256 !== ref.sha256)
      throw new TaskError(
        409,
        'artifact_version_mismatch',
        'An exact input artifact changed.',
      );
    return structuredClone(artifact);
  }
  private async modelTurn(
    task: TaskRecord,
    assignment: Assignment,
    context: unknown,
    signal: AbortSignal,
  ) {
    this.current(task.id, task.generation, task.objective_revision);
    const agent = this.options.registry.agents.get(assignment.role)!;
    if (agent.version !== assignment.agent_version)
      throw new TaskError(
        409,
        'agent_version_changed',
        'The exact admitted agent definition version is unavailable.',
      );
    const recordedActions = this.store
      .actions(task.id, task.identity)
      .filter(
        (action) =>
          action.assignment_id === assignment.id &&
          action.assignment_revision === assignment.revision,
      );
    const pending = recordedActions.find((action) => !action.dispatched);
    if (
      pending &&
      typeof pending.response === 'object' &&
      pending.response !== null &&
      'text' in pending.response &&
      typeof pending.response.text === 'string'
    )
      return pending.response as unknown as AgentModelCompletion;
    const unconsumed = this.store
      .attempts(task.id, task.identity)
      .filter(
        (attempt) =>
          attempt.assignment_id === assignment.id &&
          attempt.assignment_revision === assignment.revision &&
          attempt.accepted &&
          attempt.kind === 'model' &&
          typeof attempt.output === 'string',
      )
      .reverse()
      .find(
        (attempt) =>
          !recordedActions.some(
            (action) =>
              typeof action.response === 'object' &&
              action.response !== null &&
              'text' in action.response &&
              action.response.text === attempt.output,
          ),
      );
    if (unconsumed)
      return {
        text: unconsumed.output as string,
        receipt: (unconsumed.receipt ?? {
          response_model: null,
          response_id: null,
          input_tokens: null,
          output_tokens: null,
        }) as unknown as AgentModelReceipt,
      };
    const purpose =
      typeof context === 'object' && context !== null && 'purpose' in context
        ? context.purpose
        : undefined;
    const actionSchema =
      agent.schemas?.[
        purpose === 'plan'
          ? 'plan'
          : purpose === 'synthesis'
            ? 'synthesis'
            : 'specialist'
      ] ??
      (purpose === 'plan'
        ? managerPlanSchema
        : purpose === 'synthesis'
          ? synthesisSchema
          : agentActionSchema);
    const input = {
      role: assignment.role,
      instruction: `${agent.instructions} Return a JSON object matching required_json_schema, without code fences. All uncertainty fields are JSON arrays, including []. A source-backed direct response must cite the supplied exact citation IDs, for example {"id":"response-1","type":"respond","answer":"Source-backed explanation [S1].","uncertainty":[]}.`,
      context: {
        ...(typeof context === 'object' && context !== null
          ? context
          : { input: context }),
        required_json_schema: z.toJSONSchema(actionSchema, {
          unrepresentable: 'any',
        }),
      },
      max_output_tokens: task.limits.max_model_output_tokens,
      json_mode: true,
    };
    if (
      Buffer.byteLength(JSON.stringify(input), 'utf8') >
      task.limits.max_model_input_bytes
    )
      throw new TaskError(
        422,
        'model_input_budget',
        'The bounded model context exceeds its admitted input limit.',
      );
    const attempt = this.store.chargeAttempt(
      task.id,
      assignment.id,
      'model',
      json({ max_output_tokens: input.max_output_tokens }),
      leaseOf(assignment),
    );
    this.model ??= resolveAgentModel(this.options.env ?? process.env);
    try {
      const model = this.model;
      const remote = Promise.resolve()
        .then(async () => {
          this.current(task.id, task.generation, task.objective_revision);
          return model.completeWithReceipt
            ? model.completeWithReceipt(structuredClone(input), signal)
            : {
                text: await model.complete(structuredClone(input), signal),
                receipt: {
                  response_model: null,
                  response_id: null,
                  input_tokens: null,
                  output_tokens: null,
                },
              };
        })
        .then((completion) => {
          if (
            completion.receipt.output_tokens !== null &&
            completion.receipt.output_tokens > input.max_output_tokens
          )
            throw new TaskError(
              502,
              'invalid_model_receipt',
              'Provider exceeded the admitted output-token limit.',
            );
          // The receipt is recorded even if cancellation has already won the local race.
          if (!this.closed)
            this.store.completeAttempt(task.id, attempt.id, {
              output: json(completion.text),
              receipt: json(completion.receipt),
            });
          return completion;
        });
      const completion = await boundedExecution(
        { signal, deadline: task.limits.deadline },
        () => remote,
      );
      if (
        completion.receipt.output_tokens !== null &&
        completion.receipt.output_tokens > input.max_output_tokens
      )
        throw new TaskError(
          502,
          'invalid_model_receipt',
          'Provider exceeded the admitted output-token limit.',
        );
      const receipt = this.store.completeAttempt(task.id, attempt.id, {
        output: json(completion.text),
        receipt: json(completion.receipt),
      });
      if (!receipt.accepted)
        throw new TaskError(
          409,
          'late_receipt',
          'Late model output was retained historically but cannot be accepted.',
        );
      this.current(task.id, task.generation, task.objective_revision);
      return completion;
    } catch (error) {
      if (outcomeUnknown(error)) {
        this.store.interruptUnknown(
          task.id,
          attempt.id,
          json({ outcome: 'unknown', message: error.message }),
          leaseOf(assignment),
        );
        const active = this.active.get(task.id);
        if (active?.controller.signal === signal)
          active.controller.abort('unknown_remote_outcome');
      } else if (!signal.aborted)
        this.store.completeAttempt(task.id, attempt.id, {
          error: error instanceof Error ? error.message : 'Model failed.',
        });
      throw error;
    }
  }
  private async executeAssignment(
    task: TaskRecord,
    assignment: Assignment,
    signal: AbortSignal,
  ) {
    const definition = this.options.registry.definitions.get(
      assignment.definition_id,
    );
    if (
      !definition ||
      definition.version !== assignment.definition_version ||
      this.options.registry.agents.get(assignment.role)?.version !==
        assignment.agent_version ||
      this.options.registry.capabilities.get(assignment.capability)?.card
        .version !== assignment.capability_version
    )
      throw new TaskError(
        409,
        'definition_changed',
        'The exact registered assignment version is unavailable.',
      );
    const inputs = assignment.inputs.map((ref) => this.readExact(task, ref));
    let pendingQuestion: string | undefined;
    let activeActionId: string | undefined;
    const context: ToolContext = {
      taskId: task.id,
      runId: task.current_run_id,
      assignmentId: assignment.id,
      objectiveRevision: assignment.objective_revision,
      generation: assignment.generation,
      identity: structuredClone(task.identity),
      deadline: assignment.deadline,
      signal,
      inputs,
      outputs: assignment.outputs,
      peers: task.assignments
        .filter(
          (item) =>
            item.run_id === task.current_run_id &&
            item.objective_revision === task.objective_revision &&
            item.id !== assignment.id,
        )
        .map(({ id, definition_id, revision }) => ({
          id,
          definition_id,
          revision,
        })),
    };
    const services: AssignmentServices = {
      context,
      input: structuredClone(assignment.input ?? null),
      inbox: () => this.inbox(task, assignment.id),
      read: (ref) => {
        this.current(task.id, task.generation, task.objective_revision);
        const own = [...assignment.inputs, ...assignment.outputs].some(
          (item) =>
            item.id === ref.id &&
            item.sha256 === ref.sha256 &&
            item.version === ref.version,
        );
        const shared = this.inbox(task, assignment.id).some((message) => {
          try {
            const content = parseContractJson(message.text) as {
              artifact?: ArtifactRef;
            };
            return (
              content.artifact?.id === ref.id &&
              content.artifact.version === ref.version &&
              content.artifact.sha256 === ref.sha256
            );
          } catch {
            return false;
          }
        });
        if (!own && !shared)
          throw new TaskError(
            403,
            'artifact_read_denied',
            'Artifact was not pinned or explicitly shared with this assignment.',
          );
        const artifact = this.readExact(task, ref);
        if (!own && shared) {
          this.store.pinAssignmentInput(
            task.id,
            assignment.id,
            assignment.generation,
            ref,
          );
          assignment.inputs.push(exact(ref));
          context.inputs.push(structuredClone(artifact));
        }
        return artifact;
      },
      tool: async (id, input) => {
        const fresh = this.current(
          task.id,
          task.generation,
          task.objective_revision,
        );
        const tool = this.options.registry.tools.get(id);
        if (
          !tool ||
          tool.mode !== task.mode ||
          !assignment.tools.includes(id) ||
          !fresh.permissions.tools.includes(id)
        )
          throw new TaskError(
            403,
            'tool_denied',
            'Current task grants do not permit this tool.',
          );
        const parsed = tool.inputSchema.parse(structuredClone(input));
        const attempt = this.store.chargeAttempt(
          task.id,
          assignment.id,
          'tool',
          json({
            tool: id,
            version: tool.version,
            mode: tool.mode,
            input: parsed,
            ...(activeActionId ? { action_id: activeActionId } : {}),
          }),
          leaseOf(assignment),
        );
        try {
          const remote = Promise.resolve()
            .then(() =>
              tool.execute(structuredClone(parsed), {
                ...context,
                identity: structuredClone(context.identity),
                inputs: structuredClone(context.inputs),
              }),
            )
            .then((value) => {
              const output = tool.outputSchema.parse(value);
              if (!this.closed)
                this.store.completeAttempt(task.id, attempt.id, {
                  output: json(output),
                });
              return output;
            });
          const output = await boundedExecution(context, () => remote);
          const receipt = this.store.completeAttempt(task.id, attempt.id, {
            output: json(output),
          });
          if (!receipt.accepted)
            throw new TaskError(
              409,
              'late_receipt',
              'Late tool output was retained historically and excluded.',
            );
          this.current(task.id, task.generation, task.objective_revision);
          return structuredClone(output);
        } catch (error) {
          if (outcomeUnknown(error)) {
            this.store.interruptUnknown(
              task.id,
              attempt.id,
              json({ outcome: 'unknown', message: error.message }),
              leaseOf(assignment),
            );
            const active = this.active.get(task.id);
            if (active?.controller.signal === signal)
              active.controller.abort('unknown_remote_outcome');
          } else if (!signal.aborted)
            this.store.completeAttempt(task.id, attempt.id, {
              error: error instanceof Error ? error.message : 'Tool failed.',
            });
          throw error;
        }
      },
      save: (kind, content, metadata) => {
        this.current(task.id, task.generation, task.objective_revision);
        return this.store.saveArtifact(task.id, task.identity, {
          kind,
          content: json(content),
          producer: { kind: 'assignment', id: assignment.id },
          dependencies: assignment.inputs,
          generation: assignment.generation,
          assignment_revision: assignment.revision,
          evidence_origin: metadata?.evidence_origin ?? 'derived',
        });
      },
      question: (prompt) => {
        pendingQuestion = prompt;
      },
      message: (recipient, purpose, text) => {
        const channel =
          this.store.peerChannelForRun(task.current_run_id) ??
          this.store.openPeerChannel(task.id, task.current_run_id, purpose, [
            assignment.id,
            recipient,
          ]);
        this.store.sendPeerMessage(
          task.id,
          channel.id,
          assignment.id,
          recipient,
          text,
          randomUUID(),
        );
      },
    };
    try {
      const rawOutput = definition.execute
        ? await definition.execute(services)
        : await this.localLoop(task, assignment, services, signal, (id) => {
            activeActionId = id;
          });
      const output = assignmentOutputSchema.parse({
        ...rawOutput,
        outputs: rawOutput.outputs.map(exact),
      });
      signal.throwIfAborted();
      this.current(task.id, task.generation, task.objective_revision);
      if (output.status !== 'completed') {
        this.store.completeAssignment(
          task.id,
          assignment.id,
          assignment.generation,
          {
            status: 'waiting',
            support: output.support,
            gaps: output.uncertainty,
          },
        );
        if (output.status === 'waiting_human')
          this.store.askQuestion(
            task.id,
            assignment.id,
            pendingQuestion ?? output.summary,
          );
        return;
      }
      const summary = services.save('assignment.summary', output);
      this.store.completeAssignment(
        task.id,
        assignment.id,
        assignment.generation,
        {
          status: 'completed',
          outputs: [...output.outputs.map(exact), exact(summary)],
          gaps: output.uncertainty,
          support: output.support,
          usability: 'usable',
        },
      );
    } catch (error) {
      if (!signal.aborted)
        this.store.completeAssignment(
          task.id,
          assignment.id,
          assignment.generation,
          {
            status: 'failed',
            error: {
              code: 'assignment_failed',
              message:
                error instanceof Error
                  ? error.message.slice(0, 4000)
                  : 'Assignment failed.',
            },
          },
        );
      throw error;
    }
  }
  private async localLoop(
    task: TaskRecord,
    assignment: Assignment,
    services: AssignmentServices,
    signal: AbortSignal,
    onAction: (id: string) => void,
  ): Promise<AssignmentOutput> {
    const agent = this.options.registry.agents.get(assignment.role)!;
    if (!agent.execute)
      throw new TaskError(
        422,
        'agent_executor_missing',
        'The registered agent has no executable local loop.',
      );
    const definition = this.options.registry.definitions.get(
      assignment.definition_id,
    )!;
    const history = this.store
      .attempts(task.id, task.identity)
      .filter(
        (attempt) =>
          attempt.assignment_id === assignment.id &&
          attempt.generation === assignment.generation &&
          attempt.assignment_revision === assignment.revision &&
          attempt.objective_revision === assignment.objective_revision &&
          attempt.accepted &&
          attempt.output !== undefined,
      )
      .map((attempt) => ({
        kind: attempt.kind,
        details: attempt.details,
        output: attempt.output,
      }));
    return agent.execute({
      ...services,
      brief: assignment.brief,
      instructions: definition.instructions,
      maxTurns: Math.max(
        0,
        assignment.max_model_calls -
          assignment.usage.model_calls +
          this.store
            .actions(task.id, task.identity)
            .filter(
              (action) =>
                action.assignment_id === assignment.id &&
                action.assignment_revision === assignment.revision &&
                !action.dispatched,
            ).length,
      ),
      history,
      toolCards: assignment.tools
        .filter((id) => task.permissions.tools.includes(id))
        .map((id) => ({
          id,
          description: this.options.registry.tools.get(id)?.description,
          input_schema: z.toJSONSchema(
            this.options.registry.tools.get(id)!.inputSchema,
            { unrepresentable: 'any' },
          ),
        })),
      model: (context) => this.modelTurn(task, assignment, context, signal),
      accept: (response, action) => {
        onAction(action.id);
        const record = this.store.recordAction(
          task.id,
          assignment.id,
          action.id,
          json(response),
          json(action),
          leaseOf(assignment),
        );
        if (!record.dispatched && record.generation !== assignment.generation)
          this.store.adoptAction(
            task.id,
            assignment.id,
            action.id,
            leaseOf(assignment),
          );
        return this.store.dispatchAction(
          task.id,
          assignment.id,
          action.id,
          leaseOf(assignment),
        );
      },
    });
  }
  private result(
    task: TaskRecord,
    answer: string,
    products: ArtifactRef[],
    sources: TaskResult['sources'],
    uncertainty: string[],
  ): TaskResult {
    const reviewer = task.assignments.find(
      (assignment) =>
        assignment.role === 'EvidenceCritic' &&
        assignment.objective_revision === task.objective_revision &&
        assignment.status === 'completed',
    );
    const partial = task.assignments.some(
      (assignment) =>
        assignment.objective_revision === task.objective_revision &&
        ['partial', 'gap'].includes(assignment.support),
    );
    return taskResultSchema.parse({
      schema_version: 'haze.task.result.v3',
      answer,
      completion: partial ? 'partial' : 'full',
      work_products: products,
      sources,
      covered_scope: this.request(task).scope ?? {
        objective: this.request(task).objective,
      },
      uncertainty,
      review: {
        status: reviewer
          ? reviewer.support === 'supported'
            ? 'supported'
            : reviewer.usability === 'rejected'
              ? 'rejected'
              : 'needs_review'
          : 'not_required',
        ...(reviewer
          ? {
              reviewer_assignment_id: reviewer.id,
              ...(reviewer.outputs.find(
                (ref) =>
                  this.store.artifact(ref.id, task.identity).kind !==
                  'assignment.summary',
              )
                ? {
                    artifact: reviewer.outputs.find(
                      (ref) =>
                        this.store.artifact(ref.id, task.identity).kind !==
                        'assignment.summary',
                    ),
                  }
                : {}),
            }
          : {}),
        scope:
          reviewer?.support === 'supported'
            ? 'Independent registered checks of retained source/calculation artifacts.'
            : reviewer
              ? 'Independent review did not establish support for the available material.'
              : 'Direct informational response; independent review not required.',
        limitations: [
          'Citation/calculation checks do not mechanically prove all prose or scientific validity.',
        ],
      },
      currency: 'current',
      next_requirements: partial ? uncertainty.slice(0, 8) : [],
      provenance: {
        mode: task.mode,
        model_calls: task.usage.model_calls,
        tool_calls: task.usage.tool_calls,
        capabilities: [
          ...new Set(
            task.assignments
              .filter(
                (assignment) =>
                  assignment.objective_revision === task.objective_revision &&
                  assignment.capability !== 'core.manager',
              )
              .map((assignment) => assignment.capability),
          ),
        ].map((id) => ({
          id,
          version:
            task.assignments.find((assignment) => assignment.capability === id)
              ?.capability_version ??
            this.options.registry.capabilities.get(id)!.card.version,
        })),
        receipts: this.store
          .attempts(task.id, task.identity)
          .filter((attempt) => attempt.run_id === task.current_run_id)
          .map((attempt) =>
            json({
              id: attempt.id,
              kind: attempt.kind,
              status: attempt.status,
              accepted: attempt.accepted,
              details: attempt.details,
              ...(attempt.receipt !== undefined
                ? { receipt: attempt.receipt }
                : {}),
            }),
          ),
      },
    });
  }
  private worldModelProjections(
    task: TaskRecord,
    result: TaskResult,
  ): WorldProjectionRecordInput[] {
    const references = new Map<string, ArtifactRef>();
    const addReference = (ref: ArtifactRef) => {
      references.set(`${ref.id}:${ref.version}:${ref.sha256}`, exact(ref));
    };
    for (const ref of task.original_request.context_refs) addReference(ref);
    for (const assignment of task.assignments)
      if (
        assignment.run_id === task.current_run_id &&
        assignment.objective_revision === task.objective_revision
      ) {
        for (const ref of [...assignment.inputs, ...assignment.outputs])
          addReference(ref);
      }
    for (const ref of [
      ...result.work_products,
      ...result.sources.map((source) => source.artifact),
      ...(result.review.artifact ? [result.review.artifact] : []),
    ])
      addReference(ref);

    const artifacts = [...references.values()].map((ref) =>
      this.readExact(task, ref),
    );
    const projections: WorldProjectionRecordInput[] = [];
    for (const capabilityId of new Set(
      task.assignments
        .filter(
          (assignment) =>
            assignment.run_id === task.current_run_id &&
            assignment.objective_revision === task.objective_revision &&
            assignment.capability !== 'core.manager',
        )
        .map((assignment) => assignment.capability),
    )) {
      const adapter =
        this.options.registry.capabilities.get(capabilityId)?.worldModel;
      if (!adapter) continue;
      for (const record of adapter.extract({
        request: this.request(task),
        artifacts,
      })) {
        for (const evidence of record.evidence)
          if (
            !references.has(
              `${evidence.id}:${evidence.version}:${evidence.sha256}`,
            )
          )
            throw new TaskError(
              422,
              'invalid_world_projection',
              'Capability projection references evidence outside the task inputs and outputs.',
            );
        projections.push({
          capability_id: capabilityId,
          kind: record.kind,
          external_id: record.external_id,
          payload: json(record.payload),
          evidence: record.evidence.map(exact),
          ...(record.relationships === undefined
            ? {}
            : { relationships: record.relationships }),
        });
      }
    }
    return projections;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.active.values())
      entry.controller.abort('runtime_closed');
    await Promise.allSettled(
      [...this.active.values()].map((entry) => entry.promise),
    );
    (await this.checkpoints).close();
    this.store.close();
  }
}
