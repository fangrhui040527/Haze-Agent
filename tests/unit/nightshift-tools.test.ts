import { describe, expect, it } from 'vitest';
import {
  createNightshiftTools,
  NIGHTSHIFT_TOOL_IDS,
  nightshiftSubmitToolSchema,
  nightshiftResultToolSchema,
  nightshiftCancelToolSchema,
  nightshiftToolOutputSchema,
} from '../../app/tasks/nightshift-tools.js';
import type { ToolContext } from '../../app/orchestration/ports.js';

const id = '21b49d1c-a97d-421d-b516-dfd59fb6ed96';
const ref = { id, version: 1, sha256: 'a'.repeat(64) };
const submit = {
  schema_version: 'haze.nightshift.tool.submit.v1',
  chain_id: id,
  expected_chain_revision: 1,
  purpose: 'evidence_linked_draft',
  prompt: 'Draft alternatives using only the exact source references.',
  input_refs: [ref],
};

describe('bounded specialist Nightshift tool contracts', () => {
  it('registers only explicit specialist tools and cannot perform effects without a controlled host', async () => {
    const tools = createNightshiftTools('fixture');
    expect(tools.map((tool) => tool.id)).toEqual(NIGHTSHIFT_TOOL_IDS);
    expect(tools.every((tool) => !tool.manager_read_only)).toBe(true);
    await expect(
      Promise.resolve().then(() =>
        tools[0]!.execute(submit, {} as ToolContext),
      ),
    ).rejects.toThrow('controlled runtime operation boundary');
  });
  it('requires evidence refs and typed allowed purposes while rejecting arbitrary authority and executable fields', () => {
    expect(nightshiftSubmitToolSchema.parse(submit)).toMatchObject({
      privacy: 'local-only',
      max_spend_usd: 0,
      n: 4,
    });
    for (const invalid of [
      { ...submit, input_refs: [] },
      { ...submit, purpose: 'retrieve_sources' },
      { ...submit, purpose: 'calculate_numbers' },
      { ...submit, prompt: 'x'.repeat(12001) },
      { ...submit, max_spend_usd: 1 },
      { ...submit, privacy: 'cloud' },
      { ...submit, command: 'arbitrary executable' },
      { ...submit, endpoint: 'https://remote.invalid' },
      { ...submit, principal: 'another-user' },
      { ...submit, generation: 2 },
      { ...submit, token: 'secret' },
    ])
      expect(nightshiftSubmitToolSchema.safeParse(invalid).success).toBe(false);
  });
  it('requires a reason for explicit dependency resolution and exact local handles', () => {
    const result = {
      schema_version: 'haze.nightshift.tool.result.v1',
      job_id: id,
    };
    expect(nightshiftResultToolSchema.safeParse(result).success).toBe(true);
    expect(
      nightshiftResultToolSchema.safeParse({
        ...result,
        decision: 'supported_failure',
      }).success,
    ).toBe(false);
    expect(
      nightshiftResultToolSchema.safeParse({
        ...result,
        decision: 'supported_failure',
        reason:
          'The external job failed; replan with the registered source capability.',
      }).success,
    ).toBe(true);
    expect(
      nightshiftResultToolSchema.safeParse({ ...result, job_id: 'job_native' })
        .success,
    ).toBe(false);
    expect(
      nightshiftCancelToolSchema.safeParse({
        schema_version: 'haze.nightshift.tool.cancel.v1',
        job_id: id,
        expected_job_revision: 1,
        expected_chain_revision: 1,
      }).success,
    ).toBe(true);
    expect(
      nightshiftCancelToolSchema.safeParse({
        schema_version: 'haze.nightshift.tool.cancel.v1',
        job_id: id,
      }).success,
    ).toBe(false);
  });
  it('routes the exact typed request and trusted context to an injected host and preserves unreviewed output', async () => {
    const context = { taskId: id } as ToolContext;
    const output = nightshiftToolOutputSchema.parse({
      schema_version: 'haze.nightshift.tool.output.v1',
      job_id: id,
      chain_id: id,
      chain_revision: 1,
      job_revision: 2,
      execution_state: 'completed',
      remote_acknowledged: true,
      candidate: ref,
      output: '<untrusted candidate>',
      requires_independent_review: true,
      stop_reason: null,
    });
    const calls: unknown[] = [];
    const tools = createNightshiftTools('fixture', (tool, input, trusted) => {
      calls.push({ tool, input, trusted });
      return Promise.resolve(output);
    });
    expect(await tools[0]!.execute(submit, context)).toEqual(output);
    expect(calls).toEqual([
      { tool: 'nightshift.submit', input: submit, trusted: context },
    ]);
    expect(
      nightshiftToolOutputSchema.safeParse({
        ...output,
        requires_independent_review: false,
      }).success,
    ).toBe(false);
    expect(
      nightshiftToolOutputSchema.safeParse({
        ...output,
        output: 'x'.repeat(65537),
      }).success,
    ).toBe(false);
  });
});
