import { describe, expect, it, vi } from 'vitest';
import {
  ProgrammeMutationIntent,
  ReductionProgrammeClient,
} from './programme-api.ts';
import {
  attemptId,
  programmeAttempt,
  programmeId,
  programmeView,
} from './programme-test-fixtures.ts';
import { artifactRef } from '../../services/agents/testFixtures.ts';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const receipt = (operation: 'create' | 'revise' | 'record' | 'phase') => ({
  schema_version: 'haze.reduction.programme.receipt.v1',
  programme_id: programmeId,
  revision: operation === 'create' ? 1 : 2,
  operation,
  attempt: operation === 'phase' ? programmeAttempt() : null,
});
const createBody = () => ({
  schema_version: 'haze.reduction.programme.create.v1',
  expected_revision: 0,
  title: 'Synthetic programme',
  accountable_owner: 'Local operator',
  scientific_owner: null,
  preview: programmeView().programme.preview,
});

describe('governed programme browser API', () => {
  it('reads bounded programme selection without starting phases', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        schema_version: 'haze.reduction.programme.list.v1',
        programmes: [programmeView().programme],
        next_offset: null,
      }),
    );
    const result = await new ReductionProgrammeClient(fetcher, '').list();
    expect(result.programmes[0]?.id).toBe(programmeId);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      '/api/reduction-programmes?offset=0&limit=10',
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
  });
  it('validates current programme identity and rejects forged scientific qualification', async () => {
    const view = programmeView();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(view));
    expect(
      await new ReductionProgrammeClient(fetcher, '').programme(programmeId),
    ).toEqual(view);
    await expect(
      new ReductionProgrammeClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            json({ ...view, programme: { ...view.programme, id: attemptId } }),
          ),
        '',
      ).programme(programmeId),
    ).rejects.toThrow('another programme');
    await expect(
      new ReductionProgrammeClient(
        vi.fn<typeof fetch>().mockResolvedValue(
          json({
            ...view,
            scientific_qualification: 'externally_approved',
            achieved_reduction: true,
          }),
        ),
        '',
      ).programme(programmeId),
    ).rejects.toThrow('unsupported response');
  });
  it('creates with revision zero and an idempotency key while admitting no task', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(receipt('create')));
    const result = await new ReductionProgrammeClient(fetcher, '').create(
      createBody(),
      'create-programme',
    );
    expect(result.attempt).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'create-programme',
      },
    });
    const posted = JSON.parse(
      fetcher.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(posted.expected_revision).toBe(0);
    expect(posted).not.toHaveProperty('identity');
    expect(posted).not.toHaveProperty('mode');
  });
  it('rejects missing revision-zero creation before transport', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const body = createBody();
    await expect(
      new ReductionProgrammeClient(fetcher, '').create(
        { ...body, expected_revision: 1 },
        'invalid-create',
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('starts only the explicitly requested phase with the exact programme revision and assessment', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ ...receipt('phase'), attempt: programmeAttempt('planning') }),
      );
    const body = {
      schema_version: 'haze.reduction.programme.phase.v1',
      expected_revision: 1,
      phase: 'planning',
      assessment_attempt_id: attemptId,
    };
    const result = await new ReductionProgrammeClient(fetcher, '').startPhase(
      programmeId,
      body,
      'explicit-phase',
    );
    expect(result.attempt?.assessment_attempt_id).toBe(attemptId);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/api/reduction-programmes/${programmeId}/phases`,
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual(
      body,
    );
  });
  it('retains exact note/attachment and metadata mutation envelopes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(receipt('record')))
      .mockResolvedValueOnce(json(receipt('revise')));
    const client = new ReductionProgrammeClient(fetcher, '');
    const body = {
      schema_version: 'haze.reduction.programme.record-request.v1',
      expected_revision: 1,
      record: {
        kind: 'attachment',
        artifact: artifactRef,
        description:
          'Historical preview only; no inherited admission reservation.',
      },
    };
    await client.record(programmeId, body, 'attachment');
    await client.revise(
      programmeId,
      {
        schema_version: 'haze.reduction.programme.revise.v1',
        expected_revision: 1,
        reason: 'Record a new owner',
        accountable_owner: 'Updated operator',
      },
      'metadata',
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual(
      body,
    );
    expect(
      JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string),
    ).toMatchObject({ expected_revision: 1, reason: 'Record a new owner' });
  });
  it('preserves pilot-input revision, exact planning dependency and typed-record idempotency envelopes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(receipt('revise')))
      .mockResolvedValueOnce(
        json({
          ...receipt('phase'),
          attempt: {
            ...programmeAttempt(),
            phase: 'pilot',
            planning_attempt_id: attemptId,
            pilot_input_ref: artifactRef,
          },
        }),
      )
      .mockResolvedValueOnce(json(receipt('record')));
    const client = new ReductionProgrammeClient(fetcher, '');
    await client.revise(
      programmeId,
      {
        schema_version: 'haze.reduction.programme.revise.v1',
        expected_revision: 1,
        reason: 'Select exact supplied pilot inputs',
        pilot_input_ref: artifactRef,
      },
      'pilot-input',
    );
    const phase = {
      schema_version: 'haze.reduction.programme.phase.v1',
      expected_revision: 2,
      phase: 'pilot',
      planning_attempt_id: attemptId,
    };
    const result = await client.startPhase(
      programmeId,
      phase,
      'explicit-pilot',
    );
    expect(result.attempt?.planning_attempt_id).toBe(attemptId);
    const record = {
      schema_version: 'haze.reduction.programme.record-request.v1',
      expected_revision: 3,
      record: {
        kind: 'delivery_verification',
        registration_id: null,
        action_record_ids: [attemptId],
        verification_ref: artifactRef,
      },
    };
    await client.record(programmeId, record, 'exact-verification');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string),
    ).toMatchObject({ expected_revision: 1, pilot_input_ref: artifactRef });
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual(
      phase,
    );
    expect(JSON.parse(fetcher.mock.calls[2]?.[1]?.body as string)).toEqual(
      record,
    );
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': 'exact-verification',
    });
  });
  it('binds explicit evaluation selection, registration and adoption to exact revisions and idempotency keys', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...receipt('revise'), revision: 2 }))
      .mockResolvedValueOnce(
        json({
          ...receipt('phase'),
          revision: 3,
          attempt: {
            ...programmeAttempt(),
            phase: 'evaluation',
            programme_revision: 3,
            registration_id: attemptId,
            evaluation_input_ref: artifactRef,
          },
        }),
      )
      .mockResolvedValueOnce(json({ ...receipt('record'), revision: 4 }));
    const client = new ReductionProgrammeClient(fetcher, '');
    const revise = {
      schema_version: 'haze.reduction.programme.revise.v1',
      expected_revision: 1,
      reason: 'Select exact imported external comparison',
      evaluation_input_ref: artifactRef,
      evaluation_dossier_ref: null,
    };
    await client.revise(programmeId, revise, 'evaluation-input');
    const phase = {
      schema_version: 'haze.reduction.programme.phase.v1',
      expected_revision: 2,
      phase: 'evaluation',
      registration_id: attemptId,
    };
    await client.startPhase(programmeId, phase, 'explicit-evaluation');
    const record = {
      schema_version: 'haze.reduction.programme.record-request.v1',
      expected_revision: 3,
      record: {
        kind: 'evaluation_qualification',
        decision: 'conditional',
        result_ref: artifactRef,
        technical_review_ref: artifactRef,
        dossier_ref: artifactRef,
        adopted_by: 'Local operator',
        attested_at: '2026-10-27T00:00:00Z',
        reason: 'Retain conditional scientific adoption.',
        supersedes_record_id: null,
      },
    };
    await client.record(programmeId, record, 'scientific-adoption');
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [index, body, key] of [
      [0, revise, 'evaluation-input'],
      [1, phase, 'explicit-evaluation'],
      [2, record, 'scientific-adoption'],
    ] as const) {
      expect(
        JSON.parse(fetcher.mock.calls[index]?.[1]?.body as string),
      ).toEqual(body);
      expect(fetcher.mock.calls[index]?.[1]?.headers).toMatchObject({
        'Idempotency-Key': key,
      });
    }
  });
  it('surfaces concurrency conflicts and never retries a mutation automatically', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        {
          error: {
            message: 'Programme revision changed; refresh before retry.',
          },
        },
        409,
      ),
    );
    await expect(
      new ReductionProgrammeClient(fetcher, '').startPhase(
        programmeId,
        {
          schema_version: 'haze.reduction.programme.phase.v1',
          expected_revision: 1,
          phase: 'assessment',
        },
        'manual-only',
      ),
    ).rejects.toThrow('revision changed');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects another programme mutation receipt', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ ...receipt('phase'), programme_id: attemptId }),
      );
    await expect(
      new ReductionProgrammeClient(fetcher, '').startPhase(
        programmeId,
        {
          schema_version: 'haze.reduction.programme.phase.v1',
          expected_revision: 1,
          phase: 'assessment',
        },
        'wrong-receipt',
      ),
    ).rejects.toThrow('receipt');
  });
  it('rejects a revision that raises ceilings beyond the bounded programme contract', () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() =>
      new ReductionProgrammeClient(fetcher, '').revise(
        programmeId,
        {
          schema_version: 'haze.reduction.programme.revise.v1',
          expected_revision: 1,
          reason: 'Raise resource envelope',
          budget: {
            max_model_calls: 401,
            max_tool_calls: 400,
            max_runs: 12,
            max_attempts_per_phase: 3,
          },
        },
        'invalid-budget',
      ),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reads only a bounded history page and checks every programme binding', async () => {
    const history = {
      schema_version: 'haze.reduction.programme.history.v1',
      revisions: [],
      attempts: [programmeAttempt()],
      records: [],
      next_offset: null,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(history));
    expect(
      await new ReductionProgrammeClient(fetcher, '').history(programmeId, 5),
    ).toEqual(history);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/api/reduction-programmes/${programmeId}/history?offset=5&limit=5`,
    );
    await expect(
      new ReductionProgrammeClient(
        vi.fn<typeof fetch>().mockResolvedValue(
          json({
            ...history,
            attempts: [{ ...programmeAttempt(), programme_id: attemptId }],
          }),
        ),
        '',
      ).history(programmeId),
    ).rejects.toThrow('another programme');
  });
  it('rejects unsupported content, oversized responses and pre-aborted reads', async () => {
    await expect(
      new ReductionProgrammeClient(
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response('<html/>', {
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
        '',
      ).programme(programmeId),
    ).rejects.toThrow('unavailable');
    await expect(
      new ReductionProgrammeClient(
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(' '.repeat(2 * 1024 * 1024 + 1), {
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
        '',
      ).programme(programmeId),
    ).rejects.toThrow('size limit');
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ReductionProgrammeClient(fetcher, '').programme(
        programmeId,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reuses the same identity for unchanged manual retries and changes it with the revision', () => {
    const intent = new ProgrammeMutationIntent();
    const create = vi
      .fn()
      .mockReturnValueOnce('first')
      .mockReturnValueOnce('second');
    expect(
      intent.key(
        'phase',
        { expected_revision: 1, phase: 'assessment' },
        create,
      ),
    ).toBe('first');
    expect(
      intent.key(
        'phase',
        { expected_revision: 1, phase: 'assessment' },
        create,
      ),
    ).toBe('first');
    expect(
      intent.key(
        'phase',
        { expected_revision: 2, phase: 'assessment' },
        create,
      ),
    ).toBe('second');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
