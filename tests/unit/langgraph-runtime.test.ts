import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentModelInput } from '../../app/adapters/agent-model.js';
import { managerAgent } from '../../app/agents/manager/index.js';
import { hazeOpsAgent } from '../../app/agents/hazeops/index.js';
import { evidenceCriticAgent } from '../../app/agents/evidence-critic/index.js';
import type {
  ManagerAction,
  ManagerContext,
} from '../../app/contracts/manager.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import type { AgentAction } from '../../app/orchestration/contracts.js';
import {
  ExecutionRegistry,
  type AssignmentDefinition,
  type AssignmentOutput,
  type ToolDefinition,
} from '../../app/orchestration/ports.js';
import { localTaskIdentity, TaskRuntime } from '../../app/tasks/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

const output = (): AssignmentOutput => ({
  status: 'completed',
  summary: 'The bounded verification assignment completed.',
  support: 'supported',
  uncertainty: [],
  outputs: [],
});

const definition: AssignmentDefinition = {
  id: 'test.specialist',
  version: '1',
  capability: 'test',
  agent: 'HazeOps',
  instructions: 'Perform the admitted bounded verification assignment.',
  tools: [],
};

const plan = (count = 1): ManagerAction => ({
  type: 'apply_plan',
  assignments: Array.from({ length: count }, (_, index) => ({
    key: `branch-${index}`,
    definition_id: definition.id,
    brief: `Independent branch ${index}.`,
    depends_on: [],
    input: { index },
  })),
  retain_assignment_ids: [],
  reason: 'Execute independent registered assignments.',
});

const finish = (): ManagerAction => ({
  type: 'finalize',
  answer: 'The bounded assignments completed.',
  work_products: [],
  sources: [],
  uncertainty: [],
  unfinished: [],
});

const awaitBranches = (context: ManagerContext): ManagerAction =>
  context.assignments.every((assignment) => assignment.status === 'completed')
    ? finish()
    : { type: 'wait', reason: 'Wait for the independent assignments.' };

async function fixture(options: {
  manager: (context: ManagerContext) => ManagerAction | Promise<ManagerAction>;
  definitions: AssignmentDefinition[];
  tools?: ToolDefinition[];
  specialist?: (input: AgentModelInput) => AgentAction | Promise<AgentAction>;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-langgraph-runtime-'));
  const registry = new ExecutionRegistry()
    .registerAgent(managerAgent)
    .registerAgent(hazeOpsAgent)
    .registerAgent(evidenceCriticAgent)
    .registerCapability({
      card: {
        id: 'test',
        version: '1',
        purpose: 'Runtime reliability verification.',
        work_products: ['assignment.summary'],
        required_tools: (options.tools ?? []).map((tool) => tool.id),
        roles: ['HazeOps', 'EvidenceCritic'],
        readiness: 'implemented',
        limitations: [],
      },
      matches: () => true,
      assignments: () => [],
    });
  for (const item of options.definitions) registry.registerAssignment(item);
  for (const tool of options.tools ?? []) registry.registerTool(tool);
  const model = {
    selection: { provider: 'scripted', model: 'graph-reliability' },
    async complete(input: AgentModelInput) {
      if (input.role !== 'Manager') {
        if (!options.specialist)
          throw new Error('Unexpected specialist model call.');
        return JSON.stringify(await options.specialist(input));
      }
      const context = input.context as ManagerContext;
      return JSON.stringify({
        id: randomUUID(),
        run_id: context.run_id,
        generation: context.generation,
        objective_revision: context.objective_revision,
        plan_revision: context.plan_revision,
        event_cursor: context.event_cursor,
        explanation: 'A bounded scripted runtime verification decision.',
        references: [],
        ...(!context.interpretation
          ? {
              interpretation: {
                scope: context.request.objective,
                deliverables: ['Complete the admitted branches.'],
                assumptions: [],
                intended_use: 'Runtime verification.',
                stopping_conditions: ['Every branch has a durable result.'],
              },
            }
          : {}),
        action: await options.manager(context),
      });
    },
  };
  const settings = {
    stateDirectory: directory,
    registry,
    mode: 'live' as const,
    model,
  };
  let runtime = new TaskRuntime(settings);
  cleanup.push(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get runtime() {
      return runtime;
    },
    settings,
    admit: () =>
      runtime.admit(
        {
          schema_version: 'haze.task.request.v3',
          objective: 'Verify independently checkpointed specialist execution.',
        },
        randomUUID(),
      ).task_id,
    restart: async () => {
      await runtime.close();
      runtime = new TaskRuntime(settings);
      return runtime;
    },
  };
}

async function until(
  runtime: TaskRuntime,
  id: string,
  condition: (task: TaskRecord) => boolean,
) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const task = runtime.store.read(id, localTaskIdentity);
    if (condition(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Expected runtime state not reached: ${JSON.stringify(runtime.store.read(id, localTaskIdentity))}`,
  );
}

function expectation(task: TaskRecord) {
  return {
    expected_run_id: task.current_run_id,
    expected_generation: task.generation,
    expected_objective_revision: task.objective_revision,
    expected_state_revision: task.state_revision,
  };
}

describe('LangGraph runtime acceptance', () => {
  it('completes both specialist graphs while the Manager model decision remains blocked', async () => {
    const blocked = deferred<void>();
    const decision = deferred<ManagerAction>();
    const specialist = deferred<void>();
    let decisions = 0;
    const test = await fixture({
      definitions: [
        {
          ...definition,
          execute: async (services) => {
            if ((services.input as { index: number }).index === 1)
              await specialist.promise;
            return output();
          },
        },
      ],
      manager: (context) => {
        decisions++;
        if (!context.assignments.length) return plan(2);
        if (
          context.assignments.some(
            (assignment) => assignment.status !== 'completed',
          )
        ) {
          blocked.resolve();
          return decision.promise;
        }
        return finish();
      },
    });
    const id = test.admit();
    await blocked.promise;
    specialist.resolve();
    await until(test.runtime, id, (task) =>
      task.assignments
        .filter((item) => item.role !== 'Manager')
        .every((item) => item.status === 'completed'),
    );
    expect(decisions).toBe(2);
    const specialistNodes = test.runtime.store
      .events(id, localTaskIdentity)
      .events.filter(
        (event) => event.type === 'graph_node' && event.assignment_id,
      )
      .map((event) => (event.data as { node: string }).node);
    expect(
      specialistNodes.filter((node) => node === 'completion'),
    ).toHaveLength(2);
    expect(specialistNodes).toContain('deterministic');
    const checkpoints = new DatabaseSync(
      join(test.settings.stateDirectory, 'execution-checkpoints-v1.sqlite'),
      { readOnly: true },
    );
    try {
      const threads = checkpoints
        .prepare('SELECT DISTINCT thread_id, checkpoint_ns FROM checkpoints')
        .all() as { thread_id: string; checkpoint_ns: string }[];
      expect(threads).toHaveLength(3);
      expect(threads.every((thread) => thread.checkpoint_ns === '')).toBe(true);
      expect(
        threads.filter((thread) => thread.thread_id.includes('specialist.v1')),
      ).toHaveLength(2);
    } finally {
      checkpoints.close();
    }
    decision.resolve({
      type: 'wait',
      reason: 'Rehydrate the newly completed branches.',
    });
    const complete = await until(test.runtime, id, (task) =>
      ['completed', 'failed'].includes(task.status),
    );
    expect(complete.status, complete.error?.message).toBe('completed');
  });

  it('enforces two globally shared specialist slots across two active tasks', async () => {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    let active = 0;
    let maximum = 0;
    const startedTasks = new Set<string>();
    const test = await fixture({
      definitions: [
        {
          ...definition,
          execute: async (services) => {
            active++;
            maximum = Math.max(maximum, active);
            startedTasks.add(services.context.taskId);
            const gate = deferred<void>();
            gates.push(gate);
            await gate.promise;
            active--;
            return output();
          },
        },
      ],
      manager: (context) =>
        context.assignments.length ? awaitBranches(context) : plan(2),
    });
    const first = test.admit();
    const second = test.admit();
    await until(test.runtime, first, () => gates.length === 2);
    expect(active).toBe(2);
    for (let index = 0; index < 4; index++) {
      await until(test.runtime, first, () => gates[index] !== undefined);
      gates[index]!.resolve();
    }
    for (const id of [first, second]) {
      const complete = await until(test.runtime, id, (task) =>
        ['completed', 'failed'].includes(task.status),
      );
      expect(complete.status, complete.error?.message).toBe('completed');
    }
    expect(maximum).toBe(2);
    expect(startedTasks).toEqual(new Set([first, second]));
    expect(active).toBe(0);
  });

  it('rejects a second owner and allows a new owner only after bounded close', async () => {
    const test = await fixture({
      definitions: [definition],
      manager: () => finish(),
    });
    let competing: TaskRuntime | undefined;
    try {
      expect(() => {
        competing = new TaskRuntime(test.settings);
      }).toThrow('runtime owner');
    } finally {
      await competing?.close();
    }
    await test.restart();
    const id = test.admit();
    const complete = await until(test.runtime, id, (task) =>
      ['completed', 'failed'].includes(task.status),
    );
    expect(complete.status, complete.error?.message).toBe('completed');
  });

  it('preserves a human wait across restart and resumes without repeating the specialist question', async () => {
    let specialistCalls = 0;
    const test = await fixture({
      definitions: [definition],
      specialist: () =>
        ++specialistCalls === 1
          ? {
              id: 'source-question',
              type: 'question',
              prompt: 'Which source is authorized?',
            }
          : {
              id: 'source-answer',
              type: 'finish',
              summary: 'The authorized response is complete.',
              support: 'supported',
              uncertainty: [],
              outputs: [],
            },
      manager: (context) => {
        if (!context.assignments.length) return plan();
        if (context.assignments.every((item) => item.status === 'completed'))
          return finish();
        if (
          !context.corrections.length &&
          context.assignments.some((item) => item.status === 'waiting')
        )
          return { type: 'question', prompt: 'Which source is authorized?' };
        return {
          type: 'wait',
          reason: 'Wait for the bounded specialist response.',
        };
      },
    });
    const id = test.admit();
    const waiting = await until(
      test.runtime,
      id,
      (task) => task.status === 'waiting',
    );
    expect(specialistCalls).toBe(1);
    expect(
      waiting.assignments
        .filter((item) => item.role !== 'Manager')
        .every((item) => !item.lease_token),
    ).toBe(true);
    await test.restart();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const restarted = test.runtime.store.read(id, localTaskIdentity);
    expect(restarted.status).toBe('waiting');
    expect(specialistCalls).toBe(1);
    test.runtime.update(
      id,
      {
        schema_version: 'haze.task.update.v3',
        ...expectation(restarted),
        kind: 'clarification',
        question_id: restarted.questions[0]!.id,
        passage:
          'The admitted source is authorized; finish the bounded response.',
      },
      randomUUID(),
    );
    const complete = await until(test.runtime, id, (task) =>
      ['completed', 'failed'].includes(task.status),
    );
    expect(complete.status, complete.error?.message).toBe('completed');
    expect(specialistCalls).toBe(2);
    expect(complete.questions).toHaveLength(1);
    expect(complete.questions[0]?.status).toBe('answered');
  });

  it('restores peer waits after restart, releases capacity and delivers one authorized message', async () => {
    let receiverId = '';
    const calls = { HazeOps: 0, EvidenceCritic: 0 };
    const test = await fixture({
      definitions: [
        definition,
        { ...definition, id: 'test.peer', agent: 'EvidenceCritic' },
      ],
      specialist: (input) => {
        const role = input.role as keyof typeof calls;
        const call = ++calls[role];
        if (call === 1) return { id: `${role}-initial-wait`, type: 'wait' };
        if (role === 'EvidenceCritic' && call === 2)
          return {
            id: 'peer-reply',
            type: 'message',
            recipient: receiverId,
            purpose: 'scoped verification',
            text: 'The authorized peer evidence is available.',
          };
        if (
          role === 'HazeOps' &&
          !(input.context as { inbox: unknown[] }).inbox.length
        )
          return { id: `receiver-wait-${call}`, type: 'wait' };
        return {
          id: `${role}-finish`,
          type: 'finish',
          summary: 'The purpose-bound exchange completed.',
          support: 'supported',
          uncertainty: [],
          outputs: [],
        };
      },
      manager: (context) => {
        if (!context.assignments.length)
          return {
            type: 'apply_plan',
            assignments: [
              {
                key: 'receiver',
                definition_id: definition.id,
                brief: 'Receive the authorized peer message.',
                depends_on: [],
              },
              {
                key: 'sender',
                definition_id: 'test.peer',
                brief: 'Send the authorized peer message after continuation.',
                depends_on: [],
              },
            ],
            retain_assignment_ids: [],
            reason: 'Admit the two purpose-bound peers.',
          };
        if (!context.peer_grants.length) {
          const [receiver, sender] = context.assignments;
          return {
            type: 'coordinate',
            participants: [
              { assignment_id: receiver!.id, revision: receiver!.revision },
              { assignment_id: sender!.id, revision: sender!.revision },
            ],
            purpose: 'scoped verification',
          };
        }
        return awaitBranches(context);
      },
    });
    const id = test.admit();
    const waiting = await until(
      test.runtime,
      id,
      (task) => task.status === 'waiting',
    );
    receiverId = waiting.assignments.find(
      (item) => item.role === 'HazeOps',
    )!.id;
    expect(calls).toEqual({ HazeOps: 1, EvidenceCritic: 1 });
    expect(waiting.assignments.every((item) => !item.lease_token)).toBe(true);
    await test.restart();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const restarted = test.runtime.store.read(id, localTaskIdentity);
    expect(restarted.status).toBe('waiting');
    expect(calls).toEqual({ HazeOps: 1, EvidenceCritic: 1 });
    test.runtime.control(
      id,
      {
        schema_version: 'haze.task.control.v3',
        ...expectation(restarted),
        action: 'resume',
      },
      randomUUID(),
    );
    const complete = await until(test.runtime, id, (task) =>
      ['completed', 'failed', 'paused'].includes(task.status),
    );
    expect(complete.status, complete.error?.message).toBe('completed');
    expect(calls.EvidenceCritic).toBe(3);
    expect(calls.HazeOps).toBeGreaterThanOrEqual(2);
    expect(calls.HazeOps).toBeLessThanOrEqual(3);
    const channel = test.runtime.store.peerChannelForRun(
      complete.current_run_id,
    )!;
    expect(
      test.runtime.store.peerMessages(
        id,
        localTaskIdentity,
        channel.id,
        receiverId,
      ),
    ).toHaveLength(1);
    const waitingActions = test.runtime.store
      .actions(id, localTaskIdentity)
      .filter((action) => action.action_id.endsWith('-initial-wait'));
    expect(waitingActions).toHaveLength(2);
  });

  for (const action of ['pause', 'cancel', 'revoke', 'correction'] as const) {
    it(`fences ${action} before aborting an uncooperative specialist tool and retains its late receipt historically`, async () => {
      const late = deferred<{ value: number }>();
      let toolCalls = 0;
      let attemptedSaves = 0;
      const tool: ToolDefinition = {
        id: 'test.ignores-cancellation',
        version: '1',
        description: 'A controlled test adapter that ignores its AbortSignal.',
        mode: 'live',
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({ value: z.number() }),
        execute: () => {
          toolCalls++;
          return late.promise;
        },
      };
      const test = await fixture({
        tools: [tool],
        definitions: [
          {
            ...definition,
            tools: [tool.id],
            execute: async (services) => {
              const result = await services.tool(tool.id, {});
              attemptedSaves++;
              const artifact = services.save('test.late-response', result);
              return { ...output(), outputs: [artifact] };
            },
          },
        ],
        manager: (context) =>
          context.assignments.length ? awaitBranches(context) : plan(),
      });
      const id = test.admit();
      await until(test.runtime, id, () => toolCalls === 1);
      const before = test.runtime.store.read(id, localTaskIdentity);
      const receipt =
        action === 'correction'
          ? test.runtime.update(
              id,
              {
                schema_version: 'haze.task.update.v3',
                ...expectation(before),
                kind: 'correction',
                passage:
                  'Replace the affected branch; the pending response is obsolete.',
                affected_assignment_ids: before.assignments
                  .filter((item) => item.role !== 'Manager')
                  .map((item) => item.id),
              },
              randomUUID(),
            )
          : test.runtime.control(
              id,
              {
                schema_version: 'haze.task.control.v3',
                ...expectation(before),
                action,
                ...(action === 'revoke' ? { revoked_tools: [tool.id] } : {}),
              },
              randomUUID(),
            );
      expect(receipt.remote_termination_confirmed).toBe(false);
      const fenced = test.runtime.store.read(id, localTaskIdentity);
      expect(fenced.generation).toBeGreaterThan(before.generation);
      expect(fenced.status).toBe(action === 'cancel' ? 'cancelled' : 'paused');
      expect(fenced.usage.tool_calls).toBe(1);
      expect(
        test.runtime.store
          .attempts(id, localTaskIdentity)
          .filter((attempt) => attempt.kind === 'tool'),
      ).toMatchObject([{ status: 'unknown', accepted: false }]);
      await until(test.runtime, id, () => test.runtime.activeCount === 0);
      late.resolve({ value: 99 });
      await until(test.runtime, id, () =>
        test.runtime.store
          .attempts(id, localTaskIdentity)
          .some(
            (attempt) =>
              attempt.kind === 'tool' && attempt.output !== undefined,
          ),
      );
      const after = test.runtime.store.read(id, localTaskIdentity);
      expect(after.status).toBe(fenced.status);
      expect(after.generation).toBe(fenced.generation);
      expect(after.usage.tool_calls).toBe(1);
      expect(after.result).toBeUndefined();
      expect(after.artifacts.filter((artifact) => artifact.current)).toEqual(
        [],
      );
      expect(
        after.assignments
          .filter((item) => item.role !== 'Manager')
          .flatMap((item) => item.outputs),
      ).toEqual([]);
      expect(toolCalls).toBe(1);
      expect(attemptedSaves).toBe(0);
      expect(
        test.runtime.store
          .attempts(id, localTaskIdentity)
          .filter((attempt) => attempt.kind === 'tool'),
      ).toMatchObject([{ accepted: false, output: { value: 99 } }]);
      if (action === 'revoke')
        expect(after.permissions.tools).not.toContain(tool.id);
    });
  }
});
