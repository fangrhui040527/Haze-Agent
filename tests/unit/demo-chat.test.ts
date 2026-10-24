import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateContract } from '../../app/contracts/index.js';
import {
  demoChatAcceptedSchema,
  demoChatResponseSchema,
  demoChatSampleSchema,
} from '../../app/demo/chat-contract.js';
import { createDemoChatHarness } from '../../app/demo/chat-harness.js';
import {
  createDemoChatHandler,
  DEMO_CHAT_BODY_LIMIT,
} from '../../app/demo/chat-http.js';

describe('fictional crew scheduling boundary', () => {
  const harness = createDemoChatHarness({ maxRuns: 2 });

  it('recomputes §23 schedules, keeps shared activity IDs, and never permits publication', () => {
    const beforeRun = Date.now();
    const { request } = harness.sample();
    expect(() => validateContract('run', request)).toThrow(
      'demo_reference_requires_historical_harness',
    );
    const accepted = harness.run({
      ...request,
      input: {
        ...request.input,
        query:
          'Use the fictional Klang sample. This wording must not change any scheduling facts.',
      },
    });
    const response = harness.read(accepted.run_id);
    expect(response.result.run_id).toBe(accepted.run_id);
    expect(
      Date.parse(response.result.timing.started_at!),
    ).toBeGreaterThanOrEqual(beforeRun);
    expect(
      Date.parse(response.result.execution.finished_at!),
    ).toBeLessThanOrEqual(Date.now());
    expect(response.result.timing.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(response.result.decision_ref.bundle_ref).toEqual(
      request.input.bundle_ref,
    );
    expect(response.result.result.quantified?.nominal).toMatchObject({
      baseline: 440,
      candidate: 340,
      absolute_gain: 100,
    });
    expect(response.result.result.selected_plan_ref?.id).toContain(
      'less-disruption',
    );
    expect(response.result.result.comparison_plan_ref).toBeNull();
    expect(response.plans.map((plan) => plan.plan_id)).toEqual([
      'baseline',
      'less-disruption',
      'lower-proxy',
    ]);
    expect(
      response.plans.every(
        (plan) =>
          plan.assignments.length === 3 &&
          new Set(plan.assignments.map((assignment) => assignment.activity_id))
            .size === 3,
      ),
    ).toBe(true);
    expect(
      response.planning.activities.every(
        (activity) => activity.worker_ids.length === 2,
      ),
    ).toBe(true);
    expect(response.planning.assessment.start).toBe(
      '2026-10-25T08:00:00+08:00',
    );
    expect(response.result.result).toMatchObject({
      publication_status: 'publication_disabled',
      recommendation_eligible: false,
      review_status: 'pending',
    });
    response.plans[0]!.assignments[0]!.start = 'wrong';
    expect(harness.read(accepted.run_id).plans[0]!.assignments[0]!.start).toBe(
      '2026-10-25T08:00:00+08:00',
    );
  });

  it('rejects malformed, modified and previous-session references before producing a run', () => {
    const { request } = harness.sample();
    expect(() =>
      harness.run({ ...request, schema_version: 'haze.run.v1' }),
    ).toThrow('haze.run.v2');
    expect(() =>
      harness.run({
        ...request,
        input: {
          ...request.input,
          bundle_ref: { ...request.input.bundle_ref, sha256: '0'.repeat(64) },
        },
      }),
    ).toThrow('exact bundle reference');
    expect(() =>
      harness.run({ ...request, programme_id: 'another-programme' }),
    ).toThrow('exact bundle reference');
    expect(() => createDemoChatHarness().run(request)).toThrow(
      'exact bundle reference',
    );
    expect(() =>
      harness.run({ schema_version: 'haze.input_draft.v2', state: 'draft' }),
    ).toThrow('haze.run.v2');
  });

  it('retains an unquantified baseline for missing coverage and bounds immutable run storage', () => {
    const first = harness.run(harness.sample().request);
    const missing = harness.run(harness.sample('missing-evidence').request);
    const response = harness.read(missing.run_id);
    expect(response.result.result).toMatchObject({
      decision_outcome: 'insufficient_evidence',
      selected_plan_ref: null,
      comparison_plan_ref: null,
      quantified: null,
    });
    expect(response.result.evidence.gaps).not.toHaveLength(0);
    expect(response.plans).toHaveLength(1);
    expect(response.plans[0]!.ref).toEqual(response.planning.baseline.ref);
    const third = harness.run(harness.sample().request);
    expect(third.run_id).not.toBe(first.run_id);
    expect(() => harness.read(first.run_id)).toThrow('expired or is unknown');
    expect(harness.read(missing.run_id)).toEqual(response);
  });

  it('refuses mismatched or missing displayed plan artifacts', () => {
    const response = harness.read(harness.run(harness.sample().request).run_id);
    expect(
      demoChatResponseSchema.safeParse({
        ...response,
        plans: response.plans.slice(1),
      }).success,
    ).toBe(false);
    response.plans[1]!.assignments[0]!.start = '2026-10-25T09:00:00+08:00';
    expect(demoChatResponseSchema.safeParse(response).success).toBe(false);
  });

  it('rejects a different quantified baseline and non-demo bundle reference', () => {
    const response = harness.read(harness.run(harness.sample().request).run_id);
    const mismatched = structuredClone(response);
    mismatched.result.result.baseline_ref = mismatched.plans[2]!.ref;
    expect(demoChatResponseSchema.safeParse(mismatched).success).toBe(false);
    const canonical = structuredClone(response);
    canonical.result.decision_ref.bundle_ref.id = 'canonical:planning';
    expect(demoChatResponseSchema.safeParse(canonical).success).toBe(false);
    const missing = harness.read(
      harness.run(harness.sample('missing-evidence').request).run_id,
    );
    expect(missing.result.result.baseline_ref).toBeNull();
    expect(demoChatResponseSchema.safeParse(missing).success).toBe(true);
  });
});

describe('local demo HTTP transport', () => {
  let server: Server;
  let origin: string;
  const endpoint = '/api/demo/crew-scheduling';
  beforeAll(async () => {
    server = createServer(createDemoChatHandler());
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing_test_port');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const post = (body: string, requestOrigin = origin) =>
    fetch(`${origin}${endpoint}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
      body,
    });

  it('submits the actual run contract and resolves a validated result through its status URL', async () => {
    const sampleResponse = await fetch(`${origin}${endpoint}/sample`);
    const sample = demoChatSampleSchema.parse(await sampleResponse.json());
    const response = await post(JSON.stringify(sample.request));
    expect(response.status).toBe(202);
    const accepted = demoChatAcceptedSchema.parse(await response.json());
    expect(response.headers.get('Location')).toBe(accepted.status_url);
    const resultResponse = await fetch(`${origin}${accepted.status_url}`);
    const result = demoChatResponseSchema.parse(await resultResponse.json());
    expect(result.result.run_id).toBe(accepted.run_id);
    expect(resultResponse.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects cross-origin writes, duplicate JSON keys, oversized input and unknown runs', async () => {
    expect((await post('{}', 'https://example.org')).status).toBe(403);
    expect(
      (
        await fetch(`${origin}${endpoint}/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const reboundStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          `${origin}${endpoint}/sample`,
          { headers: { Host: 'rebound.example.org' } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on('error', reject);
        request.end();
      },
    );
    expect(reboundStatus).toBe(403);
    expect((await post('{"input":{},"input":{}}')).status).toBe(400);
    expect((await post(' '.repeat(DEMO_CHAT_BODY_LIMIT + 1))).status).toBe(413);
    expect((await fetch(`${origin}${endpoint}/runs/demo:missing`)).status).toBe(
      404,
    );
    expect((await fetch(`${origin}${endpoint}/sample?case=live`)).status).toBe(
      400,
    );
    expect((await fetch(`${origin}/run`, { method: 'POST' })).status).toBe(404);
    const bad = await post('{}');
    expect(await bad.json()).toMatchObject({
      error: { code: 'invalid_run_contract' },
    });
  });
});
