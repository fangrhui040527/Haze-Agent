import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { managerAgent } from '../../app/agents/manager/index.js';
import { AgentModelResponseError } from '../../app/adapters/agent-model.js';
import type {
  ManagerAction,
  ManagerContext,
} from '../../app/contracts/manager.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import type { ArtifactRef } from '../../app/contracts/artifacts.js';
import {
  artifactRefSchema,
  boundedJsonSchema,
} from '../../app/contracts/artifacts.js';
import {
  ExecutionRegistry,
  type AssignmentDefinition,
} from '../../app/orchestration/ports.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import { TaskStore } from '../../app/tasks/store.js';
import { managerDecisionSchema } from '../../app/contracts/manager.js';
import { validateArtifactClosure } from '../../app/orchestration/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const plan = (
  definition = 'test.produce',
  brief = 'Produce the requested findings.',
): ManagerAction => ({
  type: 'apply_plan',
  assignments: [
    { key: 'work', definition_id: definition, brief, depends_on: [] },
  ],
  retain_assignment_ids: [],
  reason: 'Admit the registered bounded work.',
});
const finish = (
  context: ManagerContext,
  products = context.artifacts
    .filter((a) => a.current && a.kind === 'test.finding')
    .map((a) => a.ref),
): ManagerAction => ({
  type: 'finalize',
  answer: 'The retained findings support this answer.',
  work_products: products,
  sources: [],
  uncertainty: [],
  unfinished: [],
});
const producer: AssignmentDefinition = {
  id: 'test.produce',
  version: '1',
  capability: 'test',
  agent: 'HazeOps',
  tools: [],
  instructions: 'Produce an immutable finding.',
  execute(services) {
    const artifact = services.save('test.finding', { value: 7 });
    return {
      status: 'completed',
      summary: 'A supported finding.',
      support: 'supported',
      uncertainty: [],
      outputs: [artifact],
    };
  },
};

async function setup(
  script: (context: ManagerContext) => ManagerAction | Promise<ManagerAction>,
  options: {
    definitions?: AssignmentDefinition[];
    configure?: (registry: ExecutionRegistry) => void;
  } = {},
) {
  const registry = new ExecutionRegistry()
    .registerAgent(managerAgent)
    .registerAgent({
      id: 'HazeOps',
      version: '1',
      instructions: 'Registered specialist.',
    })
    .registerAgent({
      id: 'EvidenceCritic',
      version: '1',
      instructions: 'Registered independent reviewer.',
    })
    .registerCapability({
      card: {
        id: 'test',
        version: '1',
        purpose: 'Exercise controlled Manager execution.',
        work_products: ['test.finding'],
        required_tools: [],
        roles: ['HazeOps', 'EvidenceCritic'],
        readiness: 'implemented',
        limitations: [],
      },
      matches: () => true,
      assignments: () => [],
    });
  for (const definition of options.definitions ?? [producer])
    registry.registerAssignment(definition);
  options.configure?.(registry);
  const directory = await mkdtemp(join(tmpdir(), 'haze-manager-runtime-'));
  const contexts: ManagerContext[] = [];
  const instance = new TaskRuntime({
    stateDirectory: directory,
    registry,
    mode: 'live',
    model: {
      selection: { provider: 'scripted', model: 'manager-invariant' },
      async complete(input) {
        expect(input.output_schema).toBeTypeOf('object');
        expect(JSON.stringify(input.output_schema)).not.toContain(
          '"propertyNames"',
        );
        expect(input.context).not.toHaveProperty('required_json_schema');
        const context = input.context as ManagerContext;
        for (const assignment of context.assignments)
          expect(registry.agents.has(assignment.role)).toBe(true);
        contexts.push(context);
        return JSON.stringify({
          id: randomUUID(),
          run_id: context.run_id,
          generation: context.generation,
          objective_revision: context.objective_revision,
          plan_revision: context.plan_revision,
          event_cursor: context.event_cursor,
          explanation: 'The scripted decision addresses this exact checkpoint.',
          references: [],
          ...(!context.interpretation
            ? {
                interpretation: {
                  scope: context.request.objective,
                  deliverables: ['Supported findings.'],
                  assumptions: [],
                  intended_use: 'Runtime verification.',
                  stopping_conditions: [
                    'Retain supported findings or expose unfinished work.',
                  ],
                },
              }
            : {}),
          action: await script(context),
        });
      },
    },
  });
  cleanups.push(async () => {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  });
  const admitted = instance.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective: 'Exercise the registered testing capability.',
    },
    randomUUID(),
  );
  return { instance, id: admitted.task_id, contexts };
}
async function until(
  instance: TaskRuntime,
  id: string,
  predicate: (task: TaskRecord) => boolean,
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = instance.store.read(id, localTaskIdentity);
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(JSON.stringify(instance.store.read(id, localTaskIdentity)));
}
const terminal = (task: TaskRecord) =>
  ['completed', 'failed', 'paused'].includes(task.status);

describe('persistent Manager supervision', () => {
  it('retains a failed Manager generation receipt without accepting partial synthesis', async () => {
    const { instance, id } = await setup(() => {
      throw new AgentModelResponseError(
        'Incomplete generation.',
        {
          response_id: 'failed-response',
          response_model: 'configured-model',
          input_tokens: 23,
          output_tokens: 1200,
        },
        '{"partial":',
      );
    });
    const task = await until(instance, id, terminal);
    expect(task.status).toBe('failed');
    expect(task.result).toBeUndefined();
    expect(task.usage.model_calls).toBe(1);
    expect(instance.store.attempts(id, localTaskIdentity)[0]).toMatchObject({
      status: 'failed',
      accepted: false,
      output: '{"partial":',
      receipt: {
        response_id: 'failed-response',
        input_tokens: 23,
        output_tokens: 1200,
      },
    });
  });
  it('recovers a persisted lookup receipt before decision dispatch without another model or tool charge', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'haze-manager-lookup-recovery-'),
    );
    const store = new TaskStore(directory);
    store.configureDefinitions({
      agents: { Manager: managerAgent.version },
      capabilities: { 'core.manager': '4' },
      tools: ['test.lookup'],
      assignments: {
        'core.manager.coordinator': {
          version: '4',
          capability: 'core.manager',
          role: 'Manager',
          tools: ['test.lookup'],
        },
      },
    });
    const admitted = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Read the bounded source.',
        context_refs: [],
        constraints: [],
        desired_deliverables: [],
      },
      localTaskIdentity,
      'recover-lookup',
      { mode: 'live', tools: ['test.lookup'] },
    );
    const coordinator = store.ensureManager(
      admitted.task.id,
      admitted.task.current_run_id,
      {
        definition_id: 'core.manager.coordinator',
        definition_version: '4',
        role: 'Manager',
        capability: 'core.manager',
        brief: 'Read and synthesize the bounded source.',
        tools: ['test.lookup'],
        max_model_calls: 6,
      },
    );
    store.acquireAssignment(admitted.task.id, coordinator.id);
    const decision = managerDecisionSchema.parse({
      id: 'retained-lookup-decision',
      run_id: admitted.task.current_run_id,
      generation: admitted.task.generation,
      objective_revision: 1,
      plan_revision: 0,
      event_cursor: Math.max(
        ...store
          .pendingManagerEvents(admitted.task.id, localTaskIdentity)
          .map((event) => event.cursor),
      ),
      explanation: 'Read the granted bounded source before final synthesis.',
      references: [],
      interpretation: {
        scope: 'Read the bounded source.',
        deliverables: ['A source-backed answer.'],
        assumptions: [],
        intended_use: 'Informational answer.',
        stopping_conditions: ['Retain the known source result.'],
      },
      action: { type: 'lookup', tool: 'test.lookup', input: {} },
    });
    const response = {
      text: JSON.stringify(decision),
      receipt: {
        response_model: 'retained-model',
        response_id: 'retained-response',
        input_tokens: 10,
        output_tokens: 20,
      },
    };
    const modelAttempt = store.chargeAttempt(
      admitted.task.id,
      coordinator.id,
      'model',
    );
    store.completeAttempt(admitted.task.id, modelAttempt.id, {
      output: response.text,
      receipt: response.receipt,
    });
    store.recordAction(
      admitted.task.id,
      coordinator.id,
      decision.id,
      response,
      boundedJsonSchema.parse(decision),
    );
    const lookupAttempt = store.chargeAttempt(
      admitted.task.id,
      coordinator.id,
      'tool',
      {
        tool: 'test.lookup',
        version: '1',
        mode: 'live',
        input: {},
        manager_decision_id: decision.id,
        manager_plan_revision: 0,
      },
    );
    store.completeAttempt(admitted.task.id, lookupAttempt.id, {
      output: { value: 7 },
    });
    store.close();
    let reads = 0,
      modelCalls = 0;
    const registry = new ExecutionRegistry()
      .registerAgent(managerAgent)
      .registerTool({
        id: 'test.lookup',
        version: '1',
        description: 'A granted bounded read.',
        mode: 'live',
        manager_read_only: true,
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({ value: z.number() }),
        execute() {
          reads++;
          return Promise.resolve({ value: 999 });
        },
      });
    const instance = new TaskRuntime({
      stateDirectory: directory,
      registry,
      mode: 'live',
      model: {
        selection: { provider: 'scripted', model: 'recovered-synthesis' },
        complete(input) {
          modelCalls++;
          const context = input.context as ManagerContext;
          const source = context.artifacts.find(
            (artifact) => artifact.kind === 'manager.lookup',
          )!;
          return Promise.resolve(
            JSON.stringify({
              id: randomUUID(),
              run_id: context.run_id,
              generation: context.generation,
              objective_revision: context.objective_revision,
              plan_revision: context.plan_revision,
              event_cursor: context.event_cursor,
              explanation: 'Synthesize the recovered exact source result.',
              references: [source.ref],
              action: {
                type: 'finalize',
                answer: 'The retained source value is 7 [E1].',
                work_products: [],
                sources: [source.ref],
                uncertainty: [],
                unfinished: [],
              },
            }),
          );
        },
      },
    });
    cleanups.push(async () => {
      await instance.close();
      await rm(directory, { recursive: true, force: true });
    });
    const task = await until(instance, admitted.task.id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(reads).toBe(0);
    expect(modelCalls).toBe(1);
    expect(task.usage).toMatchObject({
      model_calls: 2,
      tool_calls: 1,
      assignments: 1,
    });
    const recovered = task.manager?.decisions.find(
      (entry) => entry.decision.recovery_of === decision.id,
    )?.decision;
    expect(recovered?.action).toEqual(decision.action);
    expect(recovered?.id).not.toBe(decision.id);
    const original = instance.store
      .actions(task.id, localTaskIdentity)
      .find((action) => action.action_id === decision.id)!;
    expect(original.action).toEqual(decision);
    expect(original.dispatched).toBe(true);
    const artifact = instance.store.artifact(
      task.result!.sources[0]!.artifact.id,
      localTaskIdentity,
    );
    expect(artifact.content).toEqual({
      tool: 'test.lookup',
      result: { value: 7 },
    });
  });
  it('returns known read-only lookup failures to the Manager with their charged attempt', async () => {
    const { instance, id, contexts } = await setup(
      (context) =>
        context.artifacts.some((artifact) => artifact.kind === 'manager.lookup')
          ? {
              type: 'finalize',
              answer: 'The requested source is unavailable.',
              work_products: [],
              sources: [],
              uncertainty: ['The source rejected the read.'],
              unfinished: ['Obtain the unavailable source.'],
            }
          : { type: 'lookup', tool: 'test.unavailable', input: {} },
      {
        configure(registry) {
          registry.registerTool({
            id: 'test.unavailable',
            version: '1',
            description: 'An unavailable bounded read.',
            mode: 'live',
            manager_read_only: true,
            inputSchema: z.strictObject({}),
            outputSchema: z.strictObject({}),
            execute() {
              return Promise.reject(
                new Error('Source unavailable under the current grant.'),
              );
            },
          });
        },
      },
    );
    const task = await until(instance, id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.result?.completion).toBe('blocked');
    expect(task.usage.tool_calls).toBe(1);
    expect(
      contexts.some((context) =>
        context.events.some(
          (event) =>
            event.type === 'specialist_escalated' &&
            event.message.includes('Source unavailable'),
        ),
      ),
    ).toBe(true);
    expect(
      instance.store
        .attempts(id, localTaskIdentity)
        .find((attempt) => attempt.kind === 'tool')?.status,
    ).toBe('failed');
  });
  it('reuses unaffected work only after a recorded inspection and applicability decision', async () => {
    const retainedState: { id: string; ref?: ArtifactRef } = { id: '' };
    const { instance, id } = await setup((context) => {
      if (context.objective_revision === 1) {
        if (!context.assignments.length)
          return {
            type: 'apply_plan',
            assignments: [
              {
                key: 'affected',
                definition_id: 'test.produce',
                brief: 'The affected branch.',
                depends_on: [],
              },
              {
                key: 'unaffected',
                definition_id: 'test.produce',
                brief: 'The unaffected branch.',
                depends_on: [],
              },
            ],
            retain_assignment_ids: [],
            reason: 'Admit two independently scoped branches.',
          };
        return finish(context);
      }
      const retainedRef = retainedState.ref;
      if (!retainedRef)
        throw new Error('The retained artifact has not been selected.');
      if (
        !context.inspections.some(
          (inspection) => inspection.artifact.id === retainedRef.id,
        )
      )
        return { type: 'inspect', artifacts: [retainedRef] };
      if (
        !context.artifacts.some(
          (artifact) => artifact.ref.id === retainedRef.id && artifact.current,
        )
      )
        return {
          type: 'applicability',
          artifact: retainedRef,
          applicable: true,
          reason:
            'Inspected unaffected work remains relevant to the unchanged branch under the exact correction.',
        };
      if (context.plan_objective_revision !== context.objective_revision)
        return {
          type: 'apply_plan',
          assignments: [
            {
              key: 'repaired',
              definition_id: 'test.produce',
              brief: 'Reproduce the affected branch under the correction.',
              depends_on: [],
            },
          ],
          retain_assignment_ids: [retainedState.id],
          reason:
            'Retain inspected unaffected work and replace the affected branch.',
        };
      return finish(context);
    });
    const before = await until(instance, id, terminal);
    expect(before.status, before.error?.message).toBe('completed');
    const retained = before.assignments.find(
      (assignment) => assignment.brief === 'The unaffected branch.',
    )!;
    retainedState.id = retained.id;
    const retainedRef = retained.outputs.find(
      (ref) =>
        instance.store.artifact(ref.id, localTaskIdentity).kind ===
        'test.finding',
    )!;
    retainedState.ref = retainedRef;
    const affected = before.assignments.find(
      (assignment) => assignment.brief === 'The affected branch.',
    )!;
    instance.update(
      id,
      {
        schema_version: 'haze.task.update.v3',
        expected_objective_revision: before.objective_revision,
        expected_run_id: before.current_run_id,
        expected_generation: before.generation,
        expected_state_revision: before.state_revision,
        kind: 'correction',
        passage:
          'Change only the affected branch; the other deliverable remains in scope.',
        affected_assignment_ids: [affected.id],
      },
      'correct-one-branch',
    );
    const held = instance.store.read(id, localTaskIdentity);
    expect(
      held.artifacts.find(
        (entry) =>
          entry.objective_revision === 2 &&
          entry.artifact.id === retainedRef.id,
      )?.current,
    ).toBe(false);
    instance.control(
      id,
      {
        schema_version: 'haze.task.control.v3',
        expected_objective_revision: held.objective_revision,
        expected_run_id: held.current_run_id,
        expected_generation: held.generation,
        expected_state_revision: held.state_revision,
        action: 'resume',
      },
      'resume-one-branch',
    );
    const after = await until(
      instance,
      id,
      (task) => task.objective_revision === 2 && terminal(task),
    );
    expect(after.status, after.error?.message).toBe('completed');
    expect(after.result?.completion).toBe('full');
    expect(
      after.result?.work_products.some((ref) => ref.id === retainedRef.id),
    ).toBe(true);
    expect(
      after.assignments.find((assignment) => assignment.id === retainedState.id)
        ?.revision,
    ).toBe(retained.revision);
    expect(
      after.artifacts.find(
        (entry) =>
          entry.objective_revision === 2 &&
          entry.artifact.id === retainedRef.id,
      )?.reason,
    ).toContain('Inspected unaffected');
    expect(
      after.manager?.inspections.some(
        (inspection) => inspection.artifact.id === retainedRef.id,
      ),
    ).toBe(true);
    expect(after.usage.assignments).toBe(4);
  });
  it('continues an unrelated specialist while a Manager checkpoint is awaiting its decision', async () => {
    let releaseSlow: (() => void) | undefined;
    let releaseDecision: ((action: ManagerAction) => void) | undefined;
    const parallel = {
      ...producer,
      async execute(
        services: Parameters<NonNullable<AssignmentDefinition['execute']>>[0],
      ) {
        if ((services.input as { slow?: boolean }).slow)
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
        const artifact = services.save('test.finding', {
          slow: (services.input as { slow?: boolean }).slow ?? false,
        });
        return {
          status: 'completed' as const,
          summary: 'An independent branch completed.',
          support: 'supported' as const,
          uncertainty: [],
          outputs: [artifact],
        };
      },
    };
    const { instance, id, contexts } = await setup(
      (context) => {
        if (!context.assignments.length)
          return {
            type: 'apply_plan',
            assignments: [
              {
                key: 'fast',
                definition_id: 'test.produce',
                brief: 'Independent fast branch.',
                depends_on: [],
                input: { slow: false },
              },
              {
                key: 'slow',
                definition_id: 'test.produce',
                brief: 'Independent slow branch.',
                depends_on: [],
                input: { slow: true },
              },
            ],
            retain_assignment_ids: [],
            reason: 'Run two independent bounded branches.',
          };
        if (context.assignments.some((a) => a.status === 'running'))
          return new Promise<ManagerAction>((resolve) => {
            releaseDecision = resolve;
          });
        return finish(context);
      },
      { definitions: [parallel] },
    );
    await until(
      instance,
      id,
      (task) =>
        task.assignments.some(
          (a) => a.status === 'completed' && a.role !== 'Manager',
        ) && contexts.length === 2,
    );
    expect(releaseSlow).toBeTypeOf('function');
    releaseSlow!();
    await until(instance, id, (task) =>
      task.assignments
        .filter((a) => a.role !== 'Manager')
        .every((a) => a.status === 'completed'),
    );
    expect(contexts).toHaveLength(2);
    releaseDecision!({
      type: 'wait',
      reason: 'Both branches can now be assessed together.',
    });
    const task = await until(instance, id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.result?.work_products).toHaveLength(2);
    expect(task.result?.completion).toBe('full');
  });
  it('fences a corrected Manager model call, preserves its late receipt and requires explicit resume for the unknown attempt', async () => {
    let release: ((action: ManagerAction) => void) | undefined;
    const { instance, id, contexts } = await setup((context) =>
      context.objective_revision === 1
        ? new Promise<ManagerAction>((resolve) => {
            release = resolve;
          })
        : finish(context, []),
    );
    const running = await until(
      instance,
      id,
      (task) => task.usage.model_calls === 1,
    );
    instance.update(
      id,
      {
        schema_version: 'haze.task.update.v3',
        expected_objective_revision: running.objective_revision,
        expected_run_id: running.current_run_id,
        expected_generation: running.generation,
        expected_state_revision: running.state_revision,
        kind: 'correction',
        passage: 'Use the corrected objective and withhold the old answer.',
        affected_assignment_ids: running.assignments.map((a) => a.id),
      },
      'correct-running-model',
    );
    const paused = await until(
      instance,
      id,
      (task) => task.status === 'paused',
    );
    expect(paused.usage.model_calls).toBe(1);
    instance.control(
      id,
      {
        schema_version: 'haze.task.control.v3',
        expected_objective_revision: paused.objective_revision,
        expected_run_id: paused.current_run_id,
        expected_generation: paused.generation,
        expected_state_revision: paused.state_revision,
        action: 'resume',
      },
      'resume-corrected-model',
    );
    const complete = await until(instance, id, terminal);
    expect(complete.status, complete.error?.message).toBe('completed');
    release!({
      type: 'finalize',
      answer: 'An obsolete answer.',
      work_products: [],
      sources: [],
      uncertainty: [],
      unfinished: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      instance.store.read(id, localTaskIdentity).result?.answer,
    ).not.toContain('obsolete');
    expect(instance.store.attempts(id, localTaskIdentity)[0]?.accepted).toBe(
      false,
    );
    expect(complete.usage.model_calls).toBe(2);
    expect(contexts[1]?.corrections[0]?.passage).toContain(
      'corrected objective',
    );
  });
  it('coalesces material outputs, uses one coordinator and performs no calls during a stable wait', async () => {
    const waiting = {
      ...producer,
      execute() {
        return {
          status: 'waiting_peer' as const,
          summary: 'Awaiting scoped evidence.',
          support: 'partial' as const,
          uncertainty: ['Evidence has not arrived.'],
          outputs: [],
        };
      },
    };
    const { instance, id, contexts } = await setup(
      (context) =>
        context.assignments.length
          ? { type: 'wait', reason: 'Wait for new evidence.' }
          : plan(),
      { definitions: [waiting] },
    );
    await until(
      instance,
      id,
      (task) => task.manager?.decisions.at(-1)?.decision.action.type === 'wait',
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(contexts).toHaveLength(2);
    expect(
      instance.store
        .read(id, localTaskIdentity)
        .assignments.filter((a) => a.role === 'Manager'),
    ).toHaveLength(1);
  });
  it('returns known failures to the Manager and retains a repaired plan without historical downgrade', async () => {
    const failing = {
      ...producer,
      id: 'test.fail',
      execute() {
        throw new Error('The initial method is unavailable.');
      },
    };
    const { instance, id, contexts } = await setup(
      (context) => {
        if (!context.assignments.length) return plan('test.fail');
        if (context.assignments.some((a) => a.status === 'failed'))
          return plan(
            'test.produce',
            'Use the authorized alternative after the unavailable-method failure.',
          );
        return finish(context);
      },
      { definitions: [failing, producer] },
    );
    const task = await until(instance, id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.result?.completion).toBe('full');
    expect(
      contexts.some((c) =>
        c.events.some((e) => e.type === 'assignment_failed'),
      ),
    ).toBe(true);
    expect(task.manager?.plans).toHaveLength(2);
    expect(task.assignments.filter((a) => a.role === 'Manager')).toHaveLength(
      1,
    );
  });
  it('rejects unchanged failed work rather than spending another specialist attempt', async () => {
    let executions = 0;
    const failing = {
      ...producer,
      execute() {
        executions++;
        throw new Error('A cause must be addressed.');
      },
    };
    const { instance, id } = await setup(() => plan(), {
      definitions: [failing],
    });
    const task = await until(instance, id, terminal);
    expect(task.status).toBe('failed');
    expect(task.error?.code).toMatch(/no_progress/);
    expect(executions).toBe(1);
  });
  it('does not claim full completion when final selection omits produced deliverables', async () => {
    const { instance, id } = await setup((context) =>
      context.assignments.length ? finish(context, []) : plan(),
    );
    const task = await until(instance, id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.result?.completion).toBe('blocked');
    expect(task.result?.next_requirements.join(' ')).toContain('not included');
  });
  it('rejects fabricated final references and never substitutes fixture synthesis', async () => {
    const { instance, id } = await setup((context) => ({
      ...finish(context),
      work_products: [{ id: randomUUID(), version: 1, sha256: 'a'.repeat(64) }],
    }));
    const task = await until(instance, id, terminal);
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('artifact_not_found');
    expect(task.result).toBeUndefined();
    expect(task.usage.model_calls).toBe(1);
  });
  it.each(['needs_review', 'rejected', 'supported'] as const)(
    'enforces %s component review beneath a supported final manifest',
    async (componentVerdict) => {
      const output = (artifact: ArtifactRef) => ({
        status: 'completed' as const,
        summary: 'Registered manifest work completed.',
        support: 'supported' as const,
        uncertainty: [],
        outputs: [artifact],
      });
      const { instance, id } = await setup(
        (context) => {
          if (!context.assignments.length)
            return {
              type: 'apply_plan',
              assignments: [
                {
                  key: 'component',
                  definition_id: producer.id,
                  brief: 'Produce the numerical component.',
                  depends_on: [],
                },
                {
                  key: 'partition',
                  definition_id: 'test.partition',
                  brief: 'Pin the component in a partition manifest.',
                  depends_on: ['component'],
                },
                {
                  key: 'manifest',
                  definition_id: 'test.manifest',
                  brief: 'Pin the partition in the publication manifest.',
                  depends_on: ['partition'],
                },
                {
                  key: 'review',
                  definition_id: 'test.review',
                  brief: 'Independently review the pinned exact outputs.',
                  depends_on: ['component', 'partition', 'manifest'],
                },
              ],
              retain_assignment_ids: [],
              reason: 'Exercise review enforcement through a nested manifest.',
            };
          if (context.assignments.some((item) => item.status !== 'completed'))
            return {
              type: 'wait',
              reason: 'Wait for the bounded production and review assignments.',
            };
          return finish(
            context,
            context.artifacts
              .filter((item) => item.current && item.kind === 'test.manifest')
              .map((item) => item.ref),
          );
        },
        {
          definitions: [
            producer,
            ...['partition', 'manifest'].map((kind) => ({
              ...producer,
              id: `test.${kind}`,
              execute(
                services: Parameters<
                  NonNullable<AssignmentDefinition['execute']>
                >[0],
              ) {
                return output(
                  services.save(`test.${kind}`, {
                    components: services.context.inputs.map(
                      ({ id, version, sha256 }) => ({ id, version, sha256 }),
                    ),
                  }),
                );
              },
            })),
            {
              ...producer,
              id: 'test.review',
              agent: 'EvidenceCritic',
              execute(services) {
                const products = services.context.inputs.filter((item) =>
                  ['test.manifest', 'test.finding'].includes(item.kind),
                );
                const reviews = products.flatMap((artifact) => {
                  if (
                    artifact.kind === 'test.finding' &&
                    componentVerdict === 'needs_review'
                  )
                    return [];
                  return [
                    services.save('test.review', {
                      verdict:
                        artifact.kind === 'test.finding'
                          ? componentVerdict
                          : 'supported',
                      artifacts: [
                        {
                          id: artifact.id,
                          version: artifact.version,
                          sha256: artifact.sha256,
                        },
                      ],
                      limitations: [],
                    }),
                  ];
                });
                return {
                  ...output(reviews[0]!),
                  outputs: reviews,
                };
              },
            },
          ],
          configure(registry) {
            const capability = registry.capabilities.get('test')!;
            registry.capabilities.set('test', {
              ...capability,
              review_requirements: ['test.finding', 'test.manifest'].map(
                (artifact_kind) => ({
                  artifact_kind,
                  review_definition_id: 'test.review',
                }),
              ),
              normalizeReview(artifact) {
                if (artifact.kind !== 'test.review') return undefined;
                return z
                  .strictObject({
                    verdict: z.enum(['supported', 'rejected', 'needs_review']),
                    artifacts: z.array(artifactRefSchema),
                    limitations: z.array(z.string()),
                  })
                  .parse(artifact.content);
              },
            });
          },
        },
      );
      const task = await until(instance, id, terminal);
      if (componentVerdict !== 'supported') {
        expect(task.status, task.error?.message).toBe('failed');
        expect(task.error?.code).toBe('independent_review_required');
        expect(task.result).toBeUndefined();
        return;
      }
      expect(task.status, task.error?.message).toBe('completed');
      expect(task.result?.completion).toBe('full');
      expect(task.result?.work_products).toHaveLength(1);
      expect(task.result?.review.checks).toHaveLength(2);
      expect(
        task.result?.review.checks?.every(
          (item) => item.verdict === 'supported',
        ),
      ).toBe(true);

      const artifacts = [
        ...new Set(task.artifacts.map((entry) => entry.artifact.id)),
      ].map((artifactId) =>
        instance.store.artifact(artifactId, localTaskIdentity),
      );
      const selected = task.result!.work_products;
      const read = (ref: ArtifactRef) =>
        artifacts.find((item) => item.id === ref.id)!;
      const registry = new ExecutionRegistry();
      const finding = artifacts.find((item) => item.kind === 'test.finding')!;
      // Version/hash validation and applicability must hold even two hops below
      // the selected manifest; an ID-only coverage walk cannot establish them.
      for (const change of [
        { version: finding.version + 1 },
        { sha256: '0'.repeat(64) },
      ]) {
        const invalid = artifacts.map((item) =>
          item.id === finding.id ? { ...item, ...change } : item,
        );
        expect(() =>
          validateArtifactClosure(task, registry, invalid, selected, (ref) =>
            invalid.find((item) => item.id === ref.id)!,
          ),
        ).toThrow('An exact final artifact dependency changed.');
      }
      const held = structuredClone(task);
      held.artifacts.find(
        (entry) => entry.artifact.id === finding.id,
      )!.current = false;
      expect(() =>
        validateArtifactClosure(held, registry, artifacts, selected, read),
      ).toThrow(
        'Final artifacts and their dependencies require current objective applicability.',
      );
    },
  );
  it('charges only explicitly read-only Manager lookups and refuses specialist-only tools', async () => {
    let calls = 0;
    const { instance, id } = await setup(
      (context) =>
        context.artifacts.some((a) => a.kind === 'manager.lookup')
          ? finish(context, [])
          : { type: 'lookup', tool: 'test.lookup', input: {} },
      {
        configure(registry) {
          registry.registerTool({
            id: 'test.lookup',
            version: '1',
            description: 'Bounded read.',
            mode: 'live',
            manager_read_only: true,
            inputSchema: z.strictObject({}),
            outputSchema: z.strictObject({ value: z.number() }),
            execute() {
              calls++;
              return Promise.resolve({ value: 7 });
            },
          });
        },
      },
    );
    const task = await until(instance, id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.usage.tool_calls).toBe(1);
    expect(calls).toBe(1);
    const denied = await setup(
      () => ({ type: 'lookup', tool: 'test.private', input: {} }),
      {
        configure(registry) {
          registry.registerTool({
            id: 'test.private',
            version: '1',
            description: 'Specialist-only read.',
            mode: 'live',
            inputSchema: z.strictObject({}),
            outputSchema: z.strictObject({}),
            execute() {
              return Promise.reject(new Error('Must not run.'));
            },
          });
        },
      },
    );
    const failure = await until(denied.instance, denied.id, terminal);
    expect(failure.error?.code).toBe('tool_denied');
    expect(failure.usage.tool_calls).toBe(0);
  });
});
