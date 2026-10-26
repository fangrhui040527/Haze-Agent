import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managerAgent } from '../../app/agents/manager/index.js';
import type {
  AgentModel,
  AgentModelCompletion,
} from '../../app/adapters/agent-model.js';
import type {
  ManagerAction,
  ManagerContext,
} from '../../app/contracts/manager.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import { ExecutionRegistry } from '../../app/orchestration/ports.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

interface ChatSession {
  history: { role: string; text: string }[];
  send(text: string, options?: { correction?: boolean }): TaskRecord;
  snapshot(): TaskRecord | null;
  wait(signal?: AbortSignal): Promise<TaskRecord>;
  reset(): void;
  report(): {
    isolation: { passed: boolean; specialist_model_calls: number };
  }[];
}
const sessionUrl = new URL(
  '../../scripts/manager-chat-session.mjs',
  import.meta.url,
).href;
const sandboxUrl = new URL('../../scripts/manager-sandbox.mjs', import.meta.url)
  .href;
const supportUrl = new URL(
  '../../scripts/manager-evaluation-support.mjs',
  import.meta.url,
).href;
const { ManagerChatSession, managerOnlyModel } = (await import(sessionUrl)) as {
  ManagerChatSession: new (
    runtime: TaskRuntime,
    identity: typeof localTaskIdentity,
    registry: ExecutionRegistry,
  ) => ChatSession;
  managerOnlyModel: (model: AgentModel) => AgentModel;
};
const { createManagerSandboxRegistry } = (await import(sandboxUrl)) as {
  createManagerSandboxRegistry: (options: {
    ExecutionRegistry: typeof ExecutionRegistry;
    managerAgent: typeof managerAgent;
  }) => ExecutionRegistry;
};
const { restrictManagerEvaluationTools } = (await import(supportUrl)) as {
  restrictManagerEvaluationTools: (registry: ExecutionRegistry) => string[];
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const finish = (
  context: ManagerContext,
  answer = 'A bounded answer.',
): ManagerAction => ({
  type: 'finalize',
  answer: context.request.context_refs.length ? `${answer} [S1]` : answer,
  work_products: context.artifacts
    .filter((a) => a.current && a.kind === 'evaluation.finding')
    .map((a) => a.ref),
  sources: context.artifacts
    .filter((a) => a.current && a.kind === 'source.import')
    .map((a) => a.ref),
  uncertainty: [],
  unfinished: [],
});
async function setup(script: (context: ManagerContext) => ManagerAction) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-manager-chat-'));
  const contexts: ManagerContext[] = [];
  const registry = createManagerSandboxRegistry({
    ExecutionRegistry,
    managerAgent,
  });
  const runtime = new TaskRuntime({
    stateDirectory: directory,
    registry,
    mode: 'live',
    model: managerOnlyModel({
      selection: { provider: 'scripted', model: 'chat-behavior-test' },
      complete(input) {
        const context = input.context as ManagerContext;
        contexts.push(context);
        return Promise.resolve(
          JSON.stringify({
            id: randomUUID(),
            run_id: context.run_id,
            generation: context.generation,
            objective_revision: context.objective_revision,
            plan_revision: context.plan_revision,
            event_cursor: context.event_cursor,
            explanation: 'Test this exact chat checkpoint.',
            references: [],
            action: script(context),
          }),
        );
      },
    }),
  });
  restrictManagerEvaluationTools(registry);
  cleanups.push(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime,
    contexts,
    session: new ManagerChatSession(runtime, localTaskIdentity, registry),
  };
}

describe('interactive isolated Manager chat', () => {
  it('carries a completed response into follow-up dialogue without treating it as source evidence', async () => {
    const { session, contexts } = await setup((context) =>
      finish(context, 'The codeword is Jade.'),
    );
    const first = session.send('Remember that my codeword is Jade.');
    expect((await session.wait()).status).toBe('completed');
    const second = session.send('What codeword did I give you?');
    expect(second.id).not.toBe(first.id);
    const followup = await session.wait();
    expect(followup.error).toBeUndefined();
    expect(followup.status).toBe('completed');
    expect(contexts.at(-1)!.request.context_refs).toEqual([]);
    expect(contexts.at(-1)!.request.scope).toMatchObject({
      conversation_context: {
        turns: [
          { role: 'User', text: 'Remember that my codeword is Jade.' },
          { role: 'Manager', text: 'The codeword is Jade.' },
        ],
      },
    });
    expect(followup.result?.sources).toEqual([]);
    expect(followup.result?.work_products).toEqual([]);
    expect(session.report().every((entry) => entry.isolation.passed)).toBe(
      true,
    );
    expect(
      session
        .report()
        .every((entry) => entry.isolation.specialist_model_calls === 0),
    ).toBe(true);
  });

  it('answers a Manager clarification on the same task with current revision fences', async () => {
    const { session, contexts } = await setup((context) =>
      context.corrections.length
        ? finish(context, 'The report identifies missing intervals.')
        : { type: 'question', prompt: 'Which report should I summarize?' },
    );
    const first = session.send('Summarize my report.');
    const waiting = await session.wait();
    expect(waiting.status).toBe('waiting');
    const question = waiting.questions.find((q) => q.status === 'open')!;
    const reply = session.send(
      'The report says the dataset has missing intervals.',
    );
    expect(reply.id).toBe(first.id);
    const completed = await session.wait();
    expect(completed.status).toBe('completed');
    expect(completed.objective_revision).toBe(2);
    expect(completed.questions.find((q) => q.id === question.id)?.status).toBe(
      'answered',
    );
    expect(contexts.at(-1)!.corrections[0]?.kind).toBe('clarification');
  });

  it('rejects oversized prior dialogue before starting a task instead of silently dropping it', async () => {
    const { session, contexts } = await setup((context) => finish(context));
    session.history.push({ role: 'Manager', text: 'x'.repeat(4097) });
    expect(() => session.send('Continue the conversation.')).toThrow(
      'input budget',
    );
    expect(session.snapshot()).toBeNull();
    expect(contexts).toEqual([]);
  });

  it('executes only synthetic specialists for a manually entered planning request', async () => {
    const { session } = await setup((context) => {
      if (!context.assignments.length)
        return {
          type: 'apply_plan',
          assignments: [
            {
              key: 'one',
              definition_id: 'eval.produce',
              brief: 'Retain a synthetic finding.',
              depends_on: [],
            },
          ],
          retain_assignment_ids: [],
          reason: 'Run the registered synthetic method.',
        };
      if (
        context.assignments.some((a) =>
          ['queued', 'running'].includes(a.status),
        )
      )
        return { type: 'wait', reason: 'Wait for the synthetic result.' };
      return finish(context);
    });
    session.send('Run eval.produce once and summarize the synthetic finding.');
    const completed = await session.wait();
    expect(completed.status).toBe('completed');
    expect(
      completed.assignments
        .filter((a) => a.role !== 'Manager')
        .map((a) => a.definition_id),
    ).toEqual(['eval.produce']);
    expect(session.report()[0]?.isolation).toMatchObject({
      passed: true,
      specialist_model_calls: 0,
    });
  });

  it('resets conversation context and cancels a task waiting for clarification', async () => {
    const { session, runtime } = await setup(() => ({
      type: 'question',
      prompt: 'Which report?',
    }));
    const first = session.send('Summarize the report.');
    await session.wait();
    session.reset();
    expect(runtime.store.read(first.id, localTaskIdentity).status).toBe(
      'cancelled',
    );
    expect(session.history).toEqual([]);
    const next = session.send('A new independent request.');
    expect(next.id).not.toBe(first.id);
    expect(next.original_request.context_refs).toEqual([]);
  });

  it('preserves model failures and requires an explicit new task instead of retrying', async () => {
    const { session, contexts } = await setup(() => {
      throw new Error('provider failed');
    });
    session.send('Explain evidence gaps.');
    expect((await session.wait()).status).toBe('failed');
    const calls = contexts.length;
    expect(() => session.send('Try again')).toThrow('Use /new');
    expect(contexts).toHaveLength(calls);
  });

  it('blocks specialist requests before forwarding either provider completion API', async () => {
    const receipt: AgentModelCompletion = {
      text: '{}',
      receipt: {
        response_model: null,
        response_id: null,
        input_tokens: null,
        output_tokens: null,
      },
    };
    const complete = vi.fn(() => Promise.resolve('{}'));
    const completeWithReceipt = vi.fn(() => Promise.resolve(receipt));
    const guarded = managerOnlyModel({
      selection: { provider: 'test', model: 'test' },
      complete,
      completeWithReceipt,
    });
    const signal = new AbortController().signal;
    const input = { role: 'HazeOps', instruction: 'Do work.', context: {} };
    expect(() => guarded.complete(input, signal)).toThrow('refused');
    expect(() => guarded.completeWithReceipt!(input, signal)).toThrow(
      'refused',
    );
    expect(complete).not.toHaveBeenCalled();
    expect(completeWithReceipt).not.toHaveBeenCalled();
    await expect(
      guarded.completeWithReceipt!({ ...input, role: 'Manager' }, signal),
    ).resolves.toBe(receipt);
  });

  it('shows interactive help without a provider or compiled application', () => {
    const script = fileURLToPath(
      new URL('../../scripts/chat-manager.mjs', import.meta.url),
    );
    const result = spawnSync(process.execPath, [script, '--help'], {
      encoding: 'utf8',
      env: {},
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('/correct TEXT');
    expect(result.stdout).toContain('Only the Manager calls the real model.');
  });
});
