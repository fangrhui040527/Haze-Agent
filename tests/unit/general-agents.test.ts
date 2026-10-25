import { describe, expect, it } from 'vitest';
import { hazeOpsAgent } from '../../app/agents/hazeops/index.js';
import { workerShieldAgent } from '../../app/agents/workershield/index.js';
import { evidenceCriticAgent } from '../../app/agents/evidence-critic/index.js';
import { managerAgent } from '../../app/agents/manager/index.js';
import type { AgentExecutionServices } from '../../app/orchestration/ports.js';

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
describe('executable agent modules', () => {
  for (const agent of [hazeOpsAgent, workerShieldAgent, evidenceCriticAgent]) {
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
