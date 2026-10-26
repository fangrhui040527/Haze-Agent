import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { hazeOpsAgent } from '../../app/agents/hazeops/index.js';
import { workerShieldAgent } from '../../app/agents/workershield/index.js';
import { evidenceCriticAgent } from '../../app/agents/evidence-critic/index.js';
import { managerAgent } from '../../app/agents/manager/index.js';
import { damageAccountantAgent } from '../../app/agents/damage-accountant/index.js';
import type {
  AgentDefinition,
  AgentExecutionServices,
  AssignmentOutput,
} from '../../app/orchestration/ports.js';
import {
  createSpecialistGraph,
  invokeSpecialistGraph,
  specialistThreadId,
  type SpecialistGraphHooks,
  type SpecialistGraphIdentity,
} from '../../app/orchestration/specialist-graph.js';
import type { agentActionSchema } from '../../app/orchestration/contracts.js';

function identity(api: AgentExecutionServices): SpecialistGraphIdentity {
  const {
    taskId,
    runId,
    generation,
    objectiveRevision,
    assignmentId,
    assignmentRevision,
  } = api.context;
  return {
    taskId,
    runId,
    generation,
    objectiveRevision,
    assignmentId,
    assignmentRevision,
  };
}

async function executeAgent(
  agent: AgentDefinition,
  api: AgentExecutionServices,
) {
  expect('execute' in agent).toBe(false);
  const graph = createSpecialistGraph(new MemorySaver(), {
    services: () => api,
    schema: agent.schemas?.specialist as typeof agentActionSchema,
    park: () => {},
    complete: () => {},
  });
  const result = await invokeSpecialistGraph(graph, api.context, {
    signal: api.context.signal,
  });
  return result.output!;
}

function services(actions: unknown[]) {
  const accepted: string[] = [],
    tools: string[] = [],
    questions: string[] = [];
  const api: AgentExecutionServices = {
    brief: 'Answer only from admitted evidence.',
    instructions: 'Use granted tools.',
    maxTurns: 3,
    history: [],
    toolCards: [],
    input: null,
    context: {
      taskId: 'task',
      runId: 'run',
      assignmentId: 'assignment',
      assignmentRevision: 1,
      objectiveRevision: 1,
      generation: 1,
      identity: { principal: 'local-user', workspace: 'local-workspace' },
      deadline: new Date(Date.now() + 10000).toISOString(),
      signal: new AbortController().signal,
      inputs: [],
      outputs: [],
      peers: [],
    },
    model: () =>
      Promise.resolve({
        text: JSON.stringify(actions.shift()),
        receipt: {
          response_model: null,
          response_id: null,
          input_tokens: null,
          output_tokens: null,
        },
      }),
    accept: (_response, action) => {
      accepted.push(action.id);
      return true;
    },
    tool: (id) => {
      tools.push(id);
      return Promise.resolve({ value: 42 });
    },
    save: () => {
      throw new Error('No save action expected.');
    },
    question: (prompt) => {
      questions.push(prompt);
    },
    message: () => {
      throw new Error('No message expected.');
    },
    inbox: () => [],
    read: () => {
      throw new Error('No read expected.');
    },
  };
  return { api, accepted, tools, questions };
}
describe('declarative agents executed by the specialist graph', () => {
  for (const agent of [
    hazeOpsAgent,
    workerShieldAgent,
    evidenceCriticAgent,
    damageAccountantAgent,
  ]) {
    it(`${agent.id} validates and persists each action before calling controlled tools`, async () => {
      const test = services([
        {
          id: 'retrieve',
          type: 'tool',
          tool: 'registered.lookup',
          input: { query: 'admitted' },
        },
        {
          id: 'finish',
          type: 'finish',
          summary: 'Available evidence supports the bounded statement.',
          support: 'partial',
          uncertainty: ['Independent observation evidence is unavailable.'],
          outputs: [],
        },
      ]);
      const output = await executeAgent(agent, test.api);
      expect(test.accepted).toEqual(['retrieve', 'finish']);
      expect(test.tools).toEqual(['registered.lookup']);
      expect(output.support).toBe('partial');
    });
  }
  it('rejects executable payload fields before any tool dispatch', async () => {
    const test = services([
      {
        id: 'bad',
        type: 'tool',
        tool: 'registered.lookup',
        input: {},
        sql: 'SELECT * FROM arbitrary',
      },
    ]);
    await expect(executeAgent(hazeOpsAgent, test.api)).rejects.toThrow();
    expect(test.tools).toEqual([]);
    expect(test.accepted).toEqual([]);
  });
  it('persists one question and yields without further model turns', async () => {
    const test = services([
      {
        id: 'question',
        type: 'question',
        prompt: 'Which source should support this explanation?',
      },
      { id: 'unused', type: 'wait' },
    ]);
    expect((await executeAgent(hazeOpsAgent, test.api)).status).toBe(
      'waiting_human',
    );
    expect(test.accepted).toEqual(['question']);
    expect(test.questions).toHaveLength(1);
  });
  it('escalates a missing dependency to the Manager and yields with retained outputs', async () => {
    const test = services([
      {
        id: 'escalate',
        type: 'escalate',
        reason: 'missing_dependency',
        message: 'The required selection artifact is missing.',
      },
      { id: 'unused', type: 'wait' },
    ]);
    const escalations: string[] = [];
    test.api.escalate = (reason, message) =>
      escalations.push(`${reason}: ${message}`);
    const output = await executeAgent(hazeOpsAgent, test.api);
    expect(escalations).toEqual([
      'missing_dependency: The required selection artifact is missing.',
    ]);
    expect(output.status).toBe('waiting_peer');
    expect(test.accepted).toEqual(['escalate']);
    expect(test.tools).toEqual([]);
  });
  it('enforces local turn limits and Manager strict response validation', async () => {
    const test = services([
      { id: 'one', type: 'tool', tool: 'lookup', input: {} },
    ]);
    test.api.maxTurns = 1;
    await expect(executeAgent(hazeOpsAgent, test.api)).rejects.toThrow(
      'bounded local turns',
    );
    expect(() =>
      managerAgent.schemas!.plan!.parse({
        id: 'bad',
        type: 'respond',
        answer: 'A claim.',
        uncertainty: 'None',
      }),
    ).toThrow();
    expect(
      managerAgent.schemas!.synthesis!.parse({
        answer: 'A qualified answer.',
        uncertainty: ['No observations available.'],
      }),
    ).toMatchObject({ uncertainty: ['No observations available.'] });
  });
});

describe('independent specialist graph recovery', () => {
  it('replays only the pure wait node until a matching cursor resumes a reconstructed graph', async () => {
    const test = services([
      { id: 'wait', type: 'wait' },
      {
        id: 'done',
        type: 'finish',
        summary: 'Peer reply received.',
        support: 'partial',
        uncertainty: [],
        outputs: [],
      },
    ]);
    const saver = new MemorySaver();
    const nodes: string[] = [];
    let parked = 0;
    let completed = 0;
    let rehydrations = 0;
    const hooks: SpecialistGraphHooks = {
      services: (key) => {
        if (key.endsWith(':hydrate')) rehydrations++;
        return test.api;
      },
      cursor: () => 'events:7',
      park: (_output, cursor) => {
        expect(cursor).toBe('events:7');
        parked++;
      },
      complete: () => {
        completed++;
      },
      trace: (node) => nodes.push(node),
    };
    const run = (resumeCursor?: string) =>
      invokeSpecialistGraph(
        createSpecialistGraph(saver, hooks),
        identity(test.api),
        {
          signal: test.api.context.signal,
          ...(resumeCursor ? { resumeCursor } : {}),
        },
      );
    expect((await run()).output?.status).toBe('waiting_peer');
    expect((await run()).output?.status).toBe('waiting_peer');
    expect(test.accepted).toEqual(['wait']);
    expect(parked).toBe(1);
    expect(completed).toBe(0);
    await expect(run('events:8')).rejects.toThrow('wait cursor');
    expect(test.accepted).toEqual(['wait']);
    expect((await run('events:7')).output?.status).toBe('completed');
    expect(test.accepted).toEqual(['wait', 'done']);
    expect(rehydrations).toBe(2);
    expect(parked).toBe(1);
    expect(completed).toBe(1);
    expect(nodes).toEqual([
      'hydrate',
      'context',
      'model',
      'validate',
      'peer_wait',
      'prepare_wait',
      'hydrate',
      'context',
      'model',
      'validate',
      'finish',
      'completion',
    ]);
  });

  it('uses stable keys for every nested deterministic call and never retries a failed node automatically', async () => {
    const test = services([]);
    const saver = new MemorySaver();
    const keys: string[] = [];
    const receipts = new Map<string, unknown>();
    let failAfterReceipt = true;
    let effects = 0;
    const hooks: SpecialistGraphHooks = {
      services: (key) => ({
        ...test.api,
        tool: () => {
          keys.push(key);
          if (receipts.has(key)) return Promise.resolve(receipts.get(key));
          effects++;
          const result = { value: 42 };
          receipts.set(key, result);
          if (failAfterReceipt) {
            failAfterReceipt = false;
            throw new Error('crash after durable receipt');
          }
          return Promise.resolve(result);
        },
      }),
      execute: async (api) => {
        await api.tool('registered.lookup', {});
        await api.tool('registered.lookup', {});
        return {
          status: 'completed',
          summary: 'Two controlled operations completed.',
          support: 'partial',
          uncertainty: [],
          outputs: [
            {
              id: '980df35c-7f64-41d1-841b-f5e1c8189270',
              version: 1,
              sha256: 'a'.repeat(64),
              content:
                'Existing deterministic definitions can return full artifacts.',
            },
          ],
        };
      },
      park: () => {},
      complete: () => {},
    };
    const run = () =>
      invokeSpecialistGraph(
        createSpecialistGraph(saver, hooks),
        identity(test.api),
        {
          signal: test.api.context.signal,
        },
      );
    await expect(run()).rejects.toThrow('crash after durable receipt');
    expect(effects).toBe(1);
    expect(keys).toEqual(['deterministic:0:tool:0']);
    const completed = (await run()).output;
    expect(completed?.status).toBe('completed');
    expect(completed?.outputs).toEqual([
      {
        id: '980df35c-7f64-41d1-841b-f5e1c8189270',
        version: 1,
        sha256: 'a'.repeat(64),
      },
    ]);
    expect(effects).toBe(2);
    expect(keys).toEqual([
      'deterministic:0:tool:0',
      'deterministic:0:tool:0',
      'deterministic:0:tool:1',
    ]);
  });

  it('rejects stale authority before a model or deterministic operation can dispatch', async () => {
    const test = services([{ id: 'wait', type: 'wait' }]);
    const admitted = identity(test.api);
    test.api.context.generation++;
    const graph = createSpecialistGraph(new MemorySaver(), {
      services: () => test.api,
      park: () => {},
      complete: () => {},
    });
    await expect(
      invokeSpecialistGraph(graph, admitted, {
        signal: test.api.context.signal,
      }),
    ).rejects.toThrow('current execution authority');
    expect(test.accepted).toEqual([]);
  });

  it('reconstructs an explicitly resumed wait in a fresh generation without replaying the old question', async () => {
    const test = services([
      { id: 'ask', type: 'question', prompt: 'Which source is authorized?' },
      {
        id: 'finish',
        type: 'finish',
        summary: 'The authorized answer is now available.',
        support: 'partial',
        uncertainty: [],
        outputs: [],
      },
    ]);
    const saver = new MemorySaver();
    let parks = 0;
    const graph = createSpecialistGraph(saver, {
      services: () => test.api,
      park: () => {
        parks++;
      },
      complete: () => {},
    });
    const previous = await invokeSpecialistGraph(graph, test.api.context, {
      signal: test.api.context.signal,
    });
    expect(previous.output?.status).toBe('waiting_human');
    test.api.context.generation++;
    const resumed = await invokeSpecialistGraph(graph, test.api.context, {
      signal: test.api.context.signal,
      initialState: {
        turn: previous.turn + 1,
        history: previous.history,
        turnLimit: test.api.maxTurns,
      },
    });
    expect(resumed.output?.status).toBe('completed');
    expect(test.accepted).toEqual(['ask', 'finish']);
    expect(test.questions).toEqual(['Which source is authorized?']);
    expect(parks).toBe(1);
  });

  it('bounds deterministic implementations that ignore cancellation and prevents late service effects', async () => {
    const test = services([]);
    const controller = new AbortController();
    test.api.context.signal = controller.signal;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish!: (output: AssignmentOutput) => void;
    const remote = new Promise<AssignmentOutput>((resolve) => {
      finish = resolve;
    });
    let lateSaveRejected = false;
    let completed = 0;
    let saveDispatches = 0;
    test.api.save = () => {
      saveDispatches++;
      throw new Error('A late save reached the application boundary.');
    };
    const graph = createSpecialistGraph(new MemorySaver(), {
      services: () => test.api,
      execute: async (api) => {
        start();
        const output = await remote;
        try {
          api.save('forbidden.late', {});
        } catch {
          lateSaveRejected = true;
        }
        return output;
      },
      park: () => {},
      complete: () => {
        completed++;
      },
    });
    const running = invokeSpecialistGraph(graph, test.api.context, {
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error('fenced cancellation'));
    await expect(running).rejects.toThrow();
    expect(completed).toBe(0);
    finish({
      status: 'completed',
      summary: 'Late result.',
      support: 'partial',
      uncertainty: [],
      outputs: [],
    });
    await remote;
    expect(lateSaveRejected).toBe(true);
    expect(saveDispatches).toBe(0);
    expect(completed).toBe(0);
  });

  it('isolates generations and revisions and rejects incompatible completed checkpoint topologies', async () => {
    const test = services([{ id: 'wait', type: 'wait' }]);
    const admitted = identity(test.api);
    expect(specialistThreadId(admitted)).not.toBe(
      specialistThreadId({ ...admitted, generation: 2 }),
    );
    expect(specialistThreadId(admitted)).not.toBe(
      specialistThreadId({ ...admitted, assignmentRevision: 2 }),
    );
    const saver = new MemorySaver();
    const graph = createSpecialistGraph(saver, {
      services: () => test.api,
      park: () => {},
      complete: () => {},
    });
    await invokeSpecialistGraph(graph, admitted, {
      signal: test.api.context.signal,
    });
    const config = {
      configurable: { thread_id: specialistThreadId(admitted) },
    };
    const tuple = (await saver.getTuple(config))!;
    await saver.put(
      tuple.config,
      {
        ...tuple.checkpoint,
        channel_values: {
          ...tuple.checkpoint.channel_values,
          topology: 'retired.v0',
        },
      },
      tuple.metadata!,
    );
    await expect(graph.getState(config)).rejects.toThrow('topology');
  });
});
