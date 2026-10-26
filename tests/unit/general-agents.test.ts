import { describe, expect, it } from 'vitest';
import { hazeOpsAgent } from '../../app/agents/hazeops/index.js';
import { workerShieldAgent } from '../../app/agents/workershield/index.js';
import { evidenceCriticAgent } from '../../app/agents/evidence-critic/index.js';
import { managerAgent } from '../../app/agents/manager/index.js';
import type { Artifact } from '../../app/contracts/artifacts.js';
import type { AgentExecutionServices } from '../../app/orchestration/ports.js';

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

  it('requires the Manager to cite a supplied id and reject finding labels', () => {
    const text = managerAgent.instructions;
    expect(text).toMatch(/at least one of the supplied citation ids/i);
    expect(text).toMatch(/finding labels such as F1 are not citation ids/i);
    expect(text).toMatch(/only you may create assignments/i);
  });
});

describe('bounded specialist loop', () => {
  for (const agent of specialists) {
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
      const output = await agent.execute!(test.api);
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
          uncertainty: [],
          outputs: [],
        },
      ],
      capture,
    );
    await hazeOpsAgent.execute!(test.api);
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
            uncertainty: [],
            outputs: [],
          },
        ],
        output,
      );
      await hazeOpsAgent.execute!(test.api);
      expect(test.saved[0]?.origin).toBe(expected);
    }
  });

  it('refuses to persist a tool result that was never dispatched', async () => {
    const test = services([
      {
        id: 'keep',
        type: 'save_tool_result',
        kind: 'pm25.capture',
        tool_action_id: 'never-called',
      },
    ]);
    await expect(hazeOpsAgent.execute!(test.api)).rejects.toThrow(
      'No dispatched tool action produced that result.',
    );
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
    await expect(hazeOpsAgent.execute!(test.api)).rejects.toThrow();
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
    expect((await hazeOpsAgent.execute!(test.api)).status).toBe(
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
    await evidenceCriticAgent.execute!(test.api);
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
        uncertainty: [],
        outputs: [],
      },
    ]);
    const output = await hazeOpsAgent.execute!(test.api);
    // Consuming the response is what stops the runtime replaying it.
    expect(test.rejected).toHaveLength(1);
    expect(test.rejected[0]).toContain('duplicate_json_key');
    expect(test.accepted).toEqual(['done']);
    expect(output.summary).toBe('Corrected after the refusal.');
  });

  it('stops after the correction budget without dispatching anything', async () => {
    const malformed = '{"id":"x","type":"wait","id":"x"}';
    const test = services([malformed, malformed, malformed]);
    await expect(hazeOpsAgent.execute!(test.api)).rejects.toThrow(
      'duplicate_json_key',
    );
    expect(test.rejected).toHaveLength(3);
    expect(test.accepted).toEqual([]);
  });

  it('enforces local turn limits and Manager strict response validation', async () => {
    const test = services([
      { id: 'one', type: 'tool', tool: 'lookup', input: {} },
    ]);
    test.api.maxTurns = 1;
    await expect(hazeOpsAgent.execute!(test.api)).rejects.toThrow(
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
