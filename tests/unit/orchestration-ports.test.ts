import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentModel } from '../../app/adapters/agent-model.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  assertEnrichmentConformance,
  assertNightShiftConformance,
  assertZetarisConformance,
} from '../../app/orchestration/conformance.js';
import {
  createFixtureCapture,
  createFixturePorts,
} from '../../app/orchestration/fixtures.js';
import {
  createLivePorts,
  createNightShiftPort,
  createUnavailableHMemPort,
  createZetarisPort,
  validateEnrichmentResult,
  validateModelCompletion,
  type ExecutionContext,
  type NightShiftPort,
} from '../../app/orchestration/ports.js';

const input = {
  role: 'HazeOps',
  instruction: 'Interpret only the supplied evidence.',
  context: { source: 'fixture' },
};
const scope = {
  location: 'Klang',
  period: { start: '2026-10-24T00:00:00Z', end: '2026-10-25T00:00:00Z' },
};
const unknownReceipt = {
  response_model: null,
  response_id: null,
  input_tokens: null,
  output_tokens: null,
};

function context(signal = new AbortController().signal): ExecutionContext {
  return {
    taskId: 'task-1',
    assignmentId: 'assignment-1',
    objectiveRevision: 1,
    generation: 1,
    identity: { principal: 'test-user', workspace: 'test-workspace' },
    deadline: new Date(Date.now() + 10_000).toISOString(),
    signal,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('orchestration integration ports', () => {
  it('resolves live configuration only when the component is invoked', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const ports = createLivePorts({ HAZE_PROVIDER: 'offline' });
    expect(ports.nightshift.mode).toBe('live');
    expect(ports.zetaris.mode).toBe('live');
    await expect(ports.nightshift.execute(input, context())).rejects.toThrow(
      'offline mode',
    );
    await expect(ports.zetaris.retrieve(scope, context())).rejects.toThrow(
      'ZETARIS_API_KEY',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains provider-returned provenance from the one actual completion', async () => {
    const receipt = {
      response_model: 'returned-revision',
      response_id: 'returned-response',
      input_tokens: 0,
      output_tokens: 19,
    };
    const completeWithReceipt = vi
      .fn()
      .mockResolvedValue({ text: 'Evidence interpretation.', receipt });
    const complete = vi.fn();
    const model: AgentModel = {
      selection: { provider: 'configured-provider', model: 'configured-alias' },
      complete,
      completeWithReceipt,
    };
    await expect(
      createNightShiftPort(model).execute(input, context()),
    ).resolves.toEqual({
      text: 'Evidence interpretation.',
      receipt,
    });
    expect(completeWithReceipt).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps unavailable receipt fields null instead of inferring the configured route', async () => {
    const model: AgentModel = {
      selection: { provider: 'configured-provider', model: 'configured-alias' },
      complete: () => Promise.resolve('Evidence interpretation.'),
    };
    const completion = await createNightShiftPort(model).execute(
      input,
      context(),
    );
    expect(completion.receipt).toEqual(unknownReceipt);
    expect(createNightShiftPort(model).selection).toEqual(model.selection);
    expect(JSON.stringify(completion.receipt)).not.toContain(
      'configured-alias',
    );
  });

  it('rejects malformed model metadata without converting it into measured usage', () => {
    expect(() =>
      validateModelCompletion({
        text: 'Evidence interpretation.',
        receipt: { ...unknownReceipt, input_tokens: -1 },
      }),
    ).toThrow('invalid response metadata');
  });

  it('exposes a lazily resolved configured route separately from returned metadata', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        model: 'actual-returned-revision',
        id: 'actual-response-id',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Evidence interpretation.' },
          },
        ],
      }),
    );
    const ports = createLivePorts({
      HAZE_PROVIDER: 'openai-compatible',
      HAZE_MODEL: 'configured-alias',
      HAZE_PROVIDER_BASE_URL: 'https://example.invalid/v1',
      HAZE_PROVIDER_API_KEY: 'test-secret',
    });
    expect(ports.nightshift.selection).toBeUndefined();
    const completion = await ports.nightshift.execute(input, context());
    expect(ports.nightshift.selection).toEqual({
      provider: 'openai-compatible',
      model: 'configured-alias',
    });
    expect(completion.receipt.response_model).toBe('actual-returned-revision');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('checks input bounds before invoking a model and requires a supported legacy output cap', async () => {
    const complete = vi.fn().mockResolvedValue('Evidence interpretation.');
    const port = createNightShiftPort({
      selection: { provider: 'test', model: 'test' },
      complete,
    });
    await expect(
      port.execute(input, {
        ...context(),
        modelLimits: { maxInputBytes: 1, maxOutputTokens: 700 },
      }),
    ).rejects.toThrow('byte limit');
    await expect(
      port.execute(input, {
        ...context(),
        modelLimits: { maxInputBytes: 16000, maxOutputTokens: 699 },
      }),
    ).rejects.toThrow('cannot honor a smaller per-turn cap');
    await expect(
      port.execute(input, {
        ...context(),
        modelLimits: { maxInputBytes: 16000, maxOutputTokens: 0 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_context' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('passes per-turn limits to fixtures and rejects reported output beyond the token grant', async () => {
    const execute = vi.fn().mockResolvedValue({
      text: 'Synthetic result.',
      receipt: { ...unknownReceipt, output_tokens: 8 },
    });
    const ports = createFixturePorts({ execute });
    const modelLimits = { maxInputBytes: 16000, maxOutputTokens: 7 };
    await expect(
      ports.nightshift.execute(input, { ...context(), modelLimits }),
    ).rejects.toThrow('token limit');
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ modelLimits });
    expect(ports.nightshift.selection).toEqual({
      provider: 'fixture',
      model: 'fixture-nightshift',
    });
  });

  it('never starts already cancelled work or forwards private abort reasons', async () => {
    const complete = vi.fn();
    const port = createNightShiftPort({
      selection: { provider: 'test', model: 'test' },
      complete,
    });
    const controller = new AbortController();
    controller.abort(new Error('private-cancellation-reason'));
    await expect(
      port.execute(input, context(controller.signal)),
    ).rejects.toMatchObject({
      code: 'cancelled',
      message: 'Component execution was cancelled.',
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects cancellation even if the component ignores its abort signal', async () => {
    let receivedSignal: AbortSignal | undefined;
    const port = createNightShiftPort({
      selection: { provider: 'test', model: 'test' },
      complete: async (_input, signal) => {
        receivedSignal = signal;
        return new Promise<string>(() => undefined);
      },
    });
    const controller = new AbortController();
    const pending = port.execute(input, context(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('enforces the assignment deadline on an unresponsive component', async () => {
    vi.useFakeTimers();
    const port = createNightShiftPort({
      selection: { provider: 'test', model: 'test' },
      complete: async () => new Promise<string>(() => undefined),
    });
    const pending = port.execute(input, {
      ...context(),
      deadline: new Date(Date.now() + 10).toISOString(),
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves exact evidence and rejects source identity substitution', async () => {
    const capture = createFixtureCapture(scope);
    const retrieve = vi.fn().mockResolvedValue(capture);
    const port = createZetarisPort({ id: capture.source, retrieve });
    await expect(port.retrieve(scope, context())).resolves.toBe(capture);
    expect(retrieve).toHaveBeenCalledTimes(1);
    const substituted = createZetarisPort({ id: 'other-source', retrieve });
    await expect(substituted.retrieve(scope, context())).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('requires versioned content integrity for memory and World Model snapshots', () => {
    const content = { entity: 'town', revision: 7 };
    const result = {
      status: 'available' as const,
      ref: { id: 'snapshot-7', version: '7', sha256: contractHash(content) },
      content,
      limitations: [],
    };
    expect(validateEnrichmentResult(result)).toEqual(result);
    expect(() =>
      validateEnrichmentResult({ ...result, content: { entity: 'different' } }),
    ).toThrow('snapshot hash');
    expect(() =>
      validateEnrichmentResult({
        ...result,
        ref: { ...result.ref, version: '' },
      }),
    ).toThrow('versioned reference');
  });

  it('bounds enrichment UTF-8 bytes before hashing or persisting content', () => {
    const content = { text: '界'.repeat(22_000) };
    expect(() =>
      validateEnrichmentResult({
        status: 'available',
        ref: { id: 'oversized-snapshot', version: '1', sha256: 'a'.repeat(64) },
        content,
        limitations: [],
      }),
    ).toThrow('65536-byte limit');
  });

  it('returns only the agreed enrichment fields rather than persisting adapter metadata', () => {
    const content = { lesson: 'bounded reusable context' };
    const available = {
      status: 'available' as const,
      ref: {
        id: 'record-1',
        version: '1',
        sha256: contractHash(content),
        privateMetadata: 'omit-reference-extra',
      },
      content,
      limitations: ['Context only.'],
      privateMetadata: 'omit-response-extra',
    };
    const validated = validateEnrichmentResult(available);
    expect(validated).toEqual({
      status: 'available',
      ref: { id: 'record-1', version: '1', sha256: contractHash(content) },
      content,
      limitations: ['Context only.'],
    });
    expect(JSON.stringify(validated)).not.toContain('omit-');
    const unavailable = {
      status: 'unavailable' as const,
      reason: 'Adapter unavailable.',
      privateMetadata: 'omit-unavailable-extra',
    };
    expect(validateEnrichmentResult(unavailable)).toEqual({
      status: 'unavailable',
      reason: 'Adapter unavailable.',
    });
  });

  it('reports optional enrichment unavailable and leaves reviewed capture disabled', async () => {
    const ports = createLivePorts({});
    await expect(
      ports.hmem.recall('eligible lessons', context()),
    ).resolves.toMatchObject({ status: 'unavailable' });
    await expect(
      ports.world.readSnapshot('Klang', context()),
    ).resolves.toMatchObject({ status: 'unavailable' });
    const ref = { id: 'review', version: '1', sha256: 'a'.repeat(64) };
    await expect(
      createUnavailableHMemPort().captureReviewedLesson(
        { content: 'lesson', evidenceRefs: [ref], reviewRef: ref },
        context(),
      ),
    ).resolves.toMatchObject({ status: 'disabled' });
  });

  it('keeps fixtures explicit and retains raw-row linkage without network access', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const ports = createFixturePorts({
      execute: () =>
        Promise.resolve({
          text: 'Synthetic fixture response.',
          receipt: unknownReceipt,
        }),
    });
    expect(ports.nightshift.mode).toBe('fixture');
    expect(ports.zetaris.mode).toBe('fixture');
    const capture = await ports.zetaris.retrieve(scope, context());
    const raw: unknown = JSON.parse(capture.raw);
    expect(raw).toHaveProperty('data');
    expect(Array.isArray((raw as { data: unknown }).data)).toBe(true);
    expect(capture.rows).toHaveLength(24);
    expect(capture.selection.selected_raw_row_indices).toEqual(
      Array.from({ length: 24 }, (_value, index) => index),
    );
    expect(capture.limitations.join(' ')).toContain('Synthetic');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('runs reusable conformance checks for explicit fixture adapters', async () => {
    const ports = createFixturePorts({
      execute: () =>
        Promise.resolve({
          text: 'Synthetic fixture response.',
          receipt: unknownReceipt,
        }),
    });
    await assertNightShiftConformance(ports.nightshift, input, context());
    await assertZetarisConformance(ports.zetaris, scope, context());
    await assertEnrichmentConformance(ports.hmem, 'query', context());
    await assertEnrichmentConformance(ports.world, 'query', context());
  });

  it('fails conformance when a component returns successful pre-cancelled work', async () => {
    const port: NightShiftPort = {
      id: 'broken-fixture',
      mode: 'fixture',
      execute: () =>
        Promise.resolve({
          text: 'Ignored cancellation.',
          receipt: unknownReceipt,
        }),
    };
    await expect(
      assertNightShiftConformance(port, input, context()),
    ).rejects.toThrow('pre-cancelled work');
  });
});
