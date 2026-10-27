import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { hazeOpsAgent } from '../../app/agents/hazeops/index.js';
import { workerShieldAgent } from '../../app/agents/workershield/index.js';
import { evidenceCriticAgent } from '../../app/agents/evidence-critic/index.js';
import { managerAgent } from '../../app/agents/manager/index.js';
import { damageAccountantAgent } from '../../app/agents/damage-accountant/index.js';
import type { Artifact } from '../../app/contracts/artifacts.js';
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
import { externalWaitActionSchema } from '../../app/contracts/external-waits.js';

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

interface Saved {
  kind: string;
  content: unknown;
  origin?: string | undefined;
}

function services(actions: unknown[], toolOutput: unknown = { value: 42 }) {
  const accepted: string[] = [],
    tools: string[] = [],
    questions: string[] = [],
    rejected: string[] = [],
    messages: { recipient: string; text: string }[] = [],
    saved: Saved[] = [];
  let version = 0;
  const api: AgentExecutionServices = {
    brief: 'Answer only from admitted evidence.',
    instructions: 'Use granted tools.',
    maxTurns: 6,
    history: [],
    toolCards: [],
    input: { location: 'Klang' },
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
      peers: [{ id: 'peer-1', definition_id: 'pm25.analyze', revision: 1 }],
    },
    model: () => {
      const next = actions.shift();
      return Promise.resolve({
        // A raw string stands for text a provider actually returned, so a
        // malformed response can be exercised verbatim.
        text: typeof next === 'string' ? next : JSON.stringify(next),
        receipt: {
          response_model: null,
          response_id: null,
          input_tokens: null,
          output_tokens: null,
        },
      });
    },
    accept: (_response, action) => {
      accepted.push(action.id);
      return true;
    },
    reject: (_response, reason) => {
      rejected.push(reason);
    },
    tool: (id) => {
      tools.push(id);
      return Promise.resolve(toolOutput);
    },
    save: (kind, content, metadata) => {
      saved.push({ kind, content, origin: metadata?.evidence_origin });
      version += 1;
      return {
        id: `artifact-${version}`,
        version,
        sha256: `sha-${version}`,
      } as unknown as Artifact;
    },
    question: (prompt) => {
      questions.push(prompt);
    },
    message: (recipient, _purpose, text) => {
      messages.push({ recipient, text });
    },
    inbox: () => [],
    read: () => {
      throw new Error('No read expected.');
    },
  };
  return { api, accepted, tools, questions, rejected, messages, saved };
}

const specialists = [hazeOpsAgent, workerShieldAgent, evidenceCriticAgent];

describe('external specialist wait topology', () => {
  // This simulated remote job has already been acknowledged by the host.
  const acknowledgedJobs = () => [
    {
      job_id: 'b39045f5-852c-4f7f-8fa0-0752a5ac08f2',
      remote_acknowledged: true as const,
    },
  ];
  const action = {
    id: 'park-local-job',
    type: 'external_wait' as const,
    schema_version: 'haze.external.wait.action.v1' as const,
    dependencies: [
      { job_id: 'b39045f5-852c-4f7f-8fa0-0752a5ac08f2', required: true },
    ],
  };
  it('commits external effects once before a pure interrupt and resumes only its cursor', async () => {
    const test = services([
      action,
      {
        id: 'done',
        type: 'finish',
        summary: 'The delivered candidate needs independent review.',
        support: 'partial',
        uncertainty: ['Candidate is not accepted evidence.'],
        outputs: [],
      },
    ]);
    test.api.acknowledgedJobs = acknowledgedJobs;
    const saver = new MemorySaver();
    const external: unknown[] = [];
    const nodes: string[] = [];
    let ordinaryParks = 0;
    const hooks: SpecialistGraphHooks = {
      services: () => test.api,
      cursor: () => '17',
      parkExternal: (value, cursor, key) =>
        external.push({ value, cursor, key }),
      park: () => {
        ordinaryParks++;
      },
      complete: () => {},
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
    expect(external).toEqual([
      { value: action, cursor: '17', key: 'turn:0:external-park' },
    ]);
    expect(ordinaryParks).toBe(0);
    expect(test.accepted).toEqual(['park-local-job']);
    expect(
      nodes.filter((node) => node === 'prepare_external_wait'),
    ).toHaveLength(1);
    expect(nodes).not.toContain('wait');
    await expect(run('18')).rejects.toThrow('wait cursor');
    expect((await run('17')).output?.status).toBe('completed');
    expect(external).toHaveLength(1);
    expect(test.accepted).toEqual(['park-local-job', 'done']);
  });

  it('reuses the stable effect key after a crash before the interrupt checkpoint', async () => {
    const test = services([action]);
    test.api.acknowledgedJobs = acknowledgedJobs;
    const saver = new MemorySaver();
    const receipts = new Set<string>();
    const calls: string[] = [];
    let first = true;
    const hooks: SpecialistGraphHooks = {
      services: () => test.api,
      cursor: () => '4',
      park: () => {},
      complete: () => {},
      parkExternal: (_action, _cursor, key) => {
        calls.push(key);
        receipts.add(key);
        if (first) {
          first = false;
          throw new Error('crash after wait commit');
        }
      },
    };
    const run = () =>
      invokeSpecialistGraph(
        createSpecialistGraph(saver, hooks),
        identity(test.api),
        {
          signal: test.api.context.signal,
        },
      );
    await expect(run()).rejects.toThrow('crash after wait commit');
    expect((await run()).output?.status).toBe('waiting_peer');
    expect(calls).toEqual(['turn:0:external-park', 'turn:0:external-park']);
    expect(receipts.size).toBe(1);
    expect(test.accepted).toEqual(['park-local-job']);
  });

  it('refuses an external wait when the host has not granted a controlled effect service', async () => {
    const test = services([action]);
    test.api.acknowledgedJobs = acknowledgedJobs;
    const graph = createSpecialistGraph(new MemorySaver(), {
      services: () => test.api,
      park: () => {
        throw new Error('ordinary park must not run');
      },
      complete: () => {},
    });
    await expect(
      invokeSpecialistGraph(graph, identity(test.api), {
        signal: test.api.context.signal,
      }),
    ).rejects.toThrow('controlled external-wait service');
  });

  it('bounds exact unique local handles and required flags without accepting remote endpoints', () => {
    expect(externalWaitActionSchema.safeParse(action).success).toBe(true);
    for (const invalid of [
      { ...action, dependencies: [] },
      {
        ...action,
        dependencies: Array.from({ length: 5 }, () => action.dependencies[0]),
      },
      {
        ...action,
        dependencies: [...action.dependencies, ...action.dependencies],
      },
      {
        ...action,
        dependencies: [
          { job_id: 'https://remote.invalid/job', required: true },
        ],
      },
      { ...action, dependencies: [{ job_id: action.dependencies[0]!.job_id }] },
      { ...action, credentials: 'untrusted-token' },
    ])
      expect(externalWaitActionSchema.safeParse(invalid).success).toBe(false);
  });

  it('fences a specialist.v1 checkpoint instead of interpreting it under external-wait semantics', async () => {
    const test = services([{ id: 'wait', type: 'wait' }]);
    const saver = new MemorySaver();
    const graph = createSpecialistGraph(saver, {
      services: () => test.api,
      park: () => {},
      complete: () => {},
    });
    await invokeSpecialistGraph(graph, identity(test.api), {
      signal: test.api.context.signal,
    });
    const config = {
      configurable: { thread_id: specialistThreadId(identity(test.api)) },
    };
    const tuple = (await saver.getTuple(config))!;
    await saver.put(
      tuple.config,
      {
        ...tuple.checkpoint,
        channel_values: {
          ...tuple.checkpoint.channel_values,
          topology: 'specialist.v1',
        },
      },
      tuple.metadata!,
    );
    await expect(graph.getState(config)).rejects.toThrow(
      'explicit linked continuation',
    );
    expect(test.accepted).toEqual(['wait']);
  });
});

describe('agent role contracts', () => {
  it('gives every role a distinct, non-boilerplate definition', () => {
    const texts = [...specialists, managerAgent].map(
      (agent) => agent.instructions,
    );
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text.length).toBeGreaterThan(400);
  });

  it('binds HazeOps to retrieval and to tool-sourced numbers', () => {
    const text = hazeOpsAgent.instructions;
    expect(text).toMatch(/retrieval/i);
    expect(text).toMatch(/registered deterministic method/i);
    expect(text).toMatch(/ask one question/i);
    // Retrieval does not judge or review its own evidence.
    expect(text).toMatch(/do not analyse it, judge it or review it/i);
  });

  it('binds WorkerShield to downgrading rather than blocking', () => {
    const text = workerShieldAgent.instructions;
    expect(text).toMatch(/you do not block delivery/i);
    expect(text).toMatch(/downgrade/i);
    expect(text).toMatch(/never infer observations from model output/i);
    expect(text).toMatch(/health, exposure and operational decisions/i);
  });

  it('binds EvidenceCritic to method-sourced verdicts and no self-approval', () => {
    const text = evidenceCriticAgent.instructions;
    expect(text).toMatch(/cannot approve anything you produced yourself/i);
    expect(text).toMatch(/registered checking method/i);
    expect(text).toMatch(/never certify figures you merely read/i);
    expect(text).toMatch(/scientific review, which you never perform/i);
  });

  // The Manager's own instruction guarantees are asserted by its owner's
  // tests; this file covers the three specialists. Only the distinctness and
  // length check above still spans every role.
});

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
      test.api.toolCards = [{ id: 'registered.lookup' }];
      const output = await executeAgent(agent, test.api);
      expect(test.accepted).toEqual(['retrieve', 'finish']);
      expect(test.tools).toEqual(['registered.lookup']);
      expect(output.support).toBe('partial');
    });
  }

  it('persists the exact tool output, never model-authored evidence', async () => {
    const capture = { rows: [{ value: 29.8 }], raw: 'exact response text' };
    const test = services(
      [
        {
          id: 'call',
          type: 'tool',
          tool: 'zetaris-smokeledger-pm25',
          input: { location: 'Klang' },
        },
        {
          id: 'keep',
          type: 'save_tool_result',
          kind: 'pm25.capture',
          tool_action_id: 'call',
        },
        {
          id: 'done',
          type: 'finish',
          summary: 'Retained the exact selection.',
          support: 'partial',
          uncertainty: [
            'The retained selection has not been independently checked.',
          ],
          outputs: [],
        },
      ],
      capture,
    );
    test.api.toolCards = [
      { id: 'zetaris-smokeledger-pm25', output_artifact_kind: 'pm25.capture' },
    ];
    test.api.artifactKinds = ['pm25.capture'];
    await executeAgent(hazeOpsAgent, test.api);
    expect(test.saved).toEqual([{ kind: 'pm25.capture', content: capture }]);
    // The retained content is the provider response, not a retyping of it.
    expect(test.saved[0]!.content).toBe(capture);
  });

  it('files a retrieved selection as external, not as derived work', async () => {
    const live = { evidence_origin: 'modeled', rows: [{ value: 29.8 }] };
    const fixture = { evidence_origin: 'synthetic_fixture', rows: [] };
    for (const [output, expected] of [
      [live, 'external_source'],
      [fixture, 'synthetic_fixture'],
    ] as const) {
      const test = services(
        [
          { id: 'call', type: 'tool', tool: 'src', input: {} },
          {
            id: 'keep',
            type: 'save_tool_result',
            kind: 'pm25.capture',
            tool_action_id: 'call',
          },
          {
            id: 'done',
            type: 'finish',
            summary: 'Retained.',
            support: 'partial',
            uncertainty: [
              'Provenance labeling does not establish evidence validity.',
            ],
            outputs: [],
          },
        ],
        output,
      );
      test.api.toolCards = [
        { id: 'src', output_artifact_kind: 'pm25.capture' },
      ];
      test.api.artifactKinds = ['pm25.capture'];
      await executeAgent(hazeOpsAgent, test.api);
      expect(test.saved[0]?.origin).toBe(expected);
    }
  });

  it('refuses to persist a tool result that was never dispatched', async () => {
    const action = {
      id: 'keep',
      type: 'save_tool_result',
      kind: 'pm25.capture',
      tool_action_id: 'never-called',
    };
    const test = services([
      action,
      { ...action, id: 'keep-correction-1' },
      { ...action, id: 'keep-correction-2' },
    ]);
    test.api.artifactKinds = ['pm25.capture'];
    // The contextual schema now refuses this before the save node is entered.
    // Three fresh proposals exhaust the existing correction allowance.
    await expect(executeAgent(hazeOpsAgent, test.api)).rejects.toThrow(
      'Action save_tool_result is not granted',
    );
    expect(test.rejected).toHaveLength(3);
    expect(test.accepted).toEqual([]);
    expect(test.saved).toEqual([]);
  });

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
    test.api.toolCards = [{ id: 'registered.lookup' }];
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
  it('addresses a peer by its named instance id', async () => {
    const test = services([
      {
        id: 'verdict',
        type: 'message',
        recipient: 'peer-1',
        purpose: 'numerical-check',
        text: 'Independent checks completed.',
      },
      {
        id: 'done',
        type: 'finish',
        summary: 'Review recorded.',
        support: 'supported',
        uncertainty: [],
        outputs: [],
      },
    ]);
    await executeAgent(evidenceCriticAgent, test.api);
    expect(test.messages).toEqual([
      { recipient: 'peer-1', text: 'Independent checks completed.' },
    ]);
  });

  it('consumes a rejected response and corrects itself on the next turn', async () => {
    const test = services([
      '{"id":"dup","type":"wait","id":"dup"}',
      {
        id: 'done',
        type: 'finish',
        summary: 'Corrected after the refusal.',
        support: 'partial',
        uncertainty: ['Independent evidence review remains incomplete.'],
        outputs: [],
      },
    ]);
    const output = await executeAgent(hazeOpsAgent, test.api);
    // Consuming the response is what stops the runtime replaying it.
    expect(test.rejected).toHaveLength(1);
    expect(test.rejected[0]).toContain('duplicate_json_key');
    expect(test.accepted).toEqual(['done']);
    expect(output.summary).toBe('Corrected after the refusal.');
  });

  it('stops after the correction budget without dispatching anything', async () => {
    const malformed = '{"id":"x","type":"wait","id":"x"}';
    const test = services([malformed, malformed, malformed]);
    await expect(executeAgent(hazeOpsAgent, test.api)).rejects.toThrow(
      'duplicate_json_key',
    );
    expect(test.rejected).toHaveLength(3);
    expect(test.accepted).toEqual([]);
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
    test.api.toolCards = [{ id: 'lookup' }];
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
        uncertainty: ['Peer clarification is not independent evidence review.'],
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
          uncertainty: [
            'Controlled receipts do not establish evidence support.',
          ],
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
        uncertainty: ['Independent source verification remains incomplete.'],
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
      uncertainty: ['The late result was cancelled before acceptance.'],
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
