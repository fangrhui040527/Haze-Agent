import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createModelCacheBindings,
  managerModelCacheNormalizer,
} from '../../app/orchestration/model-cache-bindings.js';
import {
  artifactSchema,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import type { AgentModelInput } from '../../app/adapters/agent-model.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = ({ id, version, sha256 }: ArtifactRef) => ({
  id,
  version,
  sha256,
});
function caseInput(
  eventCursor: number,
  hiddenValue = 'unchanged',
  observedAt = '2026-10-01T00:00:00Z',
  objective: (run: string) => string = () => 'Analyze the supplied samples.',
  retrievedAt?: string,
  scope?: (run: string, source: ArtifactRef) => unknown,
) {
  const run = randomUUID(),
    taskId = randomUUID(),
    assignment = randomUUID();
  const identity = { principal: 'test-user', workspace: 'test-workspace' };
  const sourceContent = {
    samples: [1, null, 3],
    observed_at: observedAt,
    hidden: hiddenValue,
  };
  const source = artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: hash(sourceContent),
    identity,
    kind: 'source.import',
    producer: { kind: 'user', id: 'test-user' },
    created_at: new Date().toISOString(),
    dependencies: [],
    content: sourceContent,
    filename: 'input.json',
    evidence_origin: 'user_supplied',
    original_byte_sha256: hash(sourceContent),
  });
  const content = {
    original: exact(source),
    sum: 4,
    reviewer: { assignment_id: assignment },
    ...(retrievedAt
      ? {
          evidence_origin: 'synthetic_fixture',
          selection: { backend: 'sample-file' },
          retrieved_at: retrievedAt,
          rows: [{ issued_at: observedAt, ingested_at: observedAt }],
        }
      : {}),
  };
  const product = artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: hash(content),
    identity,
    kind: retrievedAt ? 'pm25.capture' : 'test.analysis',
    producer: { kind: 'assignment', id: assignment },
    assignment_id: assignment,
    assignment_revision: 1,
    objective_revision: 1,
    task_id: taskId,
    run_id: run,
    created_at: new Date().toISOString(),
    dependencies: [exact(source)],
    content,
    evidence_origin: retrievedAt ? 'synthetic_fixture' : 'derived',
  });
  const task = {
    id: taskId,
    current_run_id: run,
    identity,
    mode: 'live' as const,
    permissions: { tools: ['test.calculate'], effects: [] },
    assignments: [
      {
        id: assignment,
        definition_id: 'test.analyze',
        role: 'WorkerShield' as const,
        objective_revision: 1,
        revision: 1,
      },
    ],
    artifacts: [{ artifact: exact(source) }, { artifact: exact(product) }],
  };
  const context = {
    purpose: 'decision',
    decision_id: `${run}:1:1:${eventCursor}:2`,
    run_id: run,
    generation: 1,
    objective_revision: 1,
    plan_revision: 1,
    event_cursor: eventCursor,
    request: {
      objective: objective(run),
      context_refs: [exact(source)],
      ...(scope ? { scope: scope(run, exact(source)) } : {}),
    },
    resources: {
      limits: {
        deadline: new Date(Date.now() + eventCursor * 1000).toISOString(),
        max_model_calls: 10,
      },
      usage: { model_calls: 2, tool_calls: 1 },
    },
    assignments: [
      {
        id: assignment,
        definition_id: 'test.analyze',
        status: 'completed',
        revision: 1,
      },
    ],
    artifacts: [
      {
        ref: exact(source),
        kind: source.kind,
        current: true,
        excerpt: '{"samples":',
        truncated: true,
      },
      {
        ref: exact(product),
        kind: product.kind,
        current: true,
        assignment_id: assignment,
        excerpt: JSON.stringify(content),
        truncated: false,
      },
    ],
    events: [
      {
        cursor: eventCursor,
        type: 'assignment_completed',
        assignment_id: assignment,
      },
    ],
    context_status: {
      bytes: eventCursor,
      truncated: true,
      omitted_artifacts: 0,
    },
  };
  const artifacts = new Map(
    [source, product].map((artifact) => [artifact.id, artifact]),
  );
  const input: AgentModelInput = {
    role: 'Manager',
    instruction: 'Choose a justified next action.',
    context,
    json_mode: true,
    max_output_tokens: 1200,
    output_schema: { choices: [exact(product)] },
    cache_context: createModelCacheBindings(context, task, (ref) => {
      const artifact = artifacts.get(ref.id);
      if (!artifact) throw new Error('Unknown artifact.');
      return artifact;
    }),
  };
  return { input, context, product, source };
}

describe('full-evidence Manager cache bindings', () => {
  it('ignores review event deduplication keys but retains their actual verdict', () => {
    const first = caseInput(1);
    const second = caseInput(1);
    const event = (key: string, verdict = 'supported') => ({
      cursor: 1,
      type: 'artifact_reviewed',
      data: { review_key: key, verdict },
    });
    Object.assign(first.context, { events: [event('a'.repeat(64))] });
    Object.assign(second.context, { events: [event('b'.repeat(64))] });
    expect(managerModelCacheNormalizer.project(first.input).input).toEqual(
      managerModelCacheNormalizer.project(second.input).input,
    );
    Object.assign(second.context, {
      events: [event('b'.repeat(64), 'rejected')],
    });
    expect(managerModelCacheNormalizer.project(first.input).input).not.toEqual(
      managerModelCacheNormalizer.project(second.input).input,
    );
  });
  it('binds an excerpt cut inside a derived reference hash using its complete evidence digest', () => {
    const first = caseInput(1);
    const second = caseInput(1);
    for (const item of [first, second])
      Object.assign(item.context.artifacts[1]!, {
        excerpt: `{"artifact":{"sha256":"${item.product.sha256.slice(0, 17)}`,
        truncated: true,
      });
    expect(managerModelCacheNormalizer.project(first.input).input).toEqual(
      managerModelCacheNormalizer.project(second.input).input,
    );
    const changed = caseInput(1, 'changed raw evidence');
    Object.assign(changed.context.artifacts[1]!, {
      excerpt: `{"artifact":{"sha256":"${changed.product.sha256.slice(0, 17)}`,
      truncated: true,
    });
    expect(managerModelCacheNormalizer.project(first.input).input).not.toEqual(
      managerModelCacheNormalizer.project(changed.input).input,
    );
  });
  it('preserves literal scope strings while normalizing only typed scope references', () => {
    const literal = caseInput(
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      (run) => ({ note: run }),
    );
    const placeholder = caseInput(
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({ note: '__haze_run_current__' }),
    );
    expect(
      managerModelCacheNormalizer.project(literal.input).input,
    ).not.toEqual(managerModelCacheNormalizer.project(placeholder.input).input);
    const first = caseInput(
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      (_run, source) => ({ source }),
    );
    const second = caseInput(
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      (_run, source) => ({ source }),
    );
    expect(managerModelCacheNormalizer.project(first.input).input).toEqual(
      managerModelCacheNormalizer.project(second.input).input,
    );
  });
  it('rebinds synthetic file read times while preserving source issuance and ingestion times', () => {
    const first = caseInput(
      10,
      'unchanged',
      '2026-10-01T00:00:00Z',
      undefined,
      '2026-10-28T01:00:00Z',
    );
    const second = caseInput(
      80,
      'unchanged',
      '2026-10-01T00:00:00Z',
      undefined,
      '2026-10-28T02:00:00Z',
    );
    const from = managerModelCacheNormalizer.project(first.input);
    const to = managerModelCacheNormalizer.project(second.input);
    expect(from.input).toEqual(to.input);
    expect(
      to.decodeOutput(
        from.encodeOutput(
          JSON.stringify({ retrieved_at: '2026-10-28T01:00:00Z' }),
        ),
      ),
    ).toBe(JSON.stringify({ retrieved_at: '2026-10-28T02:00:00Z' }));
    expect(
      managerModelCacheNormalizer.project(
        caseInput(
          80,
          'unchanged',
          '2026-10-02T00:00:00Z',
          undefined,
          '2026-10-28T02:00:00Z',
        ).input,
      ).input,
    ).not.toEqual(from.input);
  });
  it('does not collapse literal user text into host-identity placeholders', () => {
    const first = caseInput(
      10,
      'unchanged',
      '2026-10-01T00:00:00Z',
      (run) => `Inspect the literal identifier ${run}.`,
    );
    const second = caseInput(
      80,
      'unchanged',
      '2026-10-01T00:00:00Z',
      () => 'Inspect the literal identifier __haze_run_current__.',
    );
    const projectedFirst = managerModelCacheNormalizer.project(
      first.input,
    ).input;
    const projectedSecond = managerModelCacheNormalizer.project(
      second.input,
    ).input;
    expect(projectedFirst.context).toEqual(projectedSecond.context);
    expect(projectedFirst).not.toEqual(projectedSecond);
  });
  it('matches across host identities/deadlines while rebinding exact current artifact hashes and checkpoint cursor', () => {
    const first = caseInput(10),
      second = caseInput(80);
    expect(first.product.sha256).not.toBe(second.product.sha256);
    const original = structuredClone(first.input);
    const from = managerModelCacheNormalizer.project(first.input),
      to = managerModelCacheNormalizer.project(second.input);
    expect(from.input).toEqual(to.input);
    const text = JSON.stringify({
      id: first.context.decision_id,
      run_id: first.context.run_id,
      generation: 1,
      objective_revision: 1,
      plan_revision: 1,
      event_cursor: first.context.event_cursor,
      references: [exact(first.source)],
      action: {
        type: 'finalize',
        answer: 'The computed sum is 4.',
        work_products: [exact(first.product)],
        sources: [exact(first.source)],
        uncertainty: [],
        unfinished: [],
      },
    });
    const rebound: unknown = JSON.parse(
      to.decodeOutput(from.encodeOutput(text)),
    );
    expect(rebound).toMatchObject({
      id: second.context.decision_id,
      run_id: second.context.run_id,
      event_cursor: second.context.event_cursor,
      action: {
        work_products: [exact(second.product)],
        sources: [exact(second.source)],
      },
    });
    expect(first.input).toEqual(original);
  });
  it('changes the cache key for raw data outside a truncated excerpt or a changed source timestamp', () => {
    const base = managerModelCacheNormalizer.project(caseInput(10).input).input;
    expect(
      managerModelCacheNormalizer.project(
        caseInput(10, 'changed-hidden-input').input,
      ).input,
    ).not.toEqual(base);
    expect(
      managerModelCacheNormalizer.project(
        caseInput(10, 'unchanged', '2026-10-02T00:00:00Z').input,
      ).input,
    ).not.toEqual(base);
  });
  it('does not repair a model-proposed wrong checkpoint cursor', () => {
    const first = caseInput(10),
      second = caseInput(80);
    const from = managerModelCacheNormalizer.project(first.input),
      to = managerModelCacheNormalizer.project(second.input);
    const encoded = from.encodeOutput(JSON.stringify({ event_cursor: 999 }));
    expect(JSON.parse(to.decodeOutput(encoded)) as unknown).toEqual({
      event_cursor: 999,
    });
  });
});
