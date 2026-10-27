import { describe, expect, it } from 'vitest';
import { contractHash } from '../../app/contracts/json.js';
import type { Artifact } from '../../app/contracts/artifacts.js';
import { identifierSchema } from '../../app/contracts/common.js';
import { smokeLedgerWorldModelAdapter as adapter } from '../../app/capabilities/smokeledger/world.js';

// Synthetic artifacts only; hashes are real so content tampering is detectable.

const scope = {
  town: 'Batu Pahat',
  window: {
    start: '2026-10-26T00:00:00+08:00',
    end: '2026-10-28T00:00:00+08:00',
  },
};

function artifact(
  kind: string,
  content: unknown,
  extra: Partial<Artifact> = {},
): Artifact {
  return {
    id: crypto.randomUUID(),
    version: 1,
    sha256: contractHash(content),
    kind,
    content,
    assignment_id: crypto.randomUUID(),
    assignment_revision: 1,
    evidence_origin: 'external_source',
    ...extra,
  } as unknown as Artifact;
}

const run = (operation: 'assess_haze' | 'trace_sources', extra = {}) => ({
  operation,
  scope,
  run_id: `haze-${operation}-x`,
  response: {
    run_id: `haze-${operation}-x`,
    status: 'success',
    mode: 'live',
    output: {
      summary:
        'Fires on peat: not assessed, because no peat map is loaded [E-aa6885079e].',
      claims: [
        {
          id: 'c1',
          kind: 'inference',
          text: 'Fires on peat: not assessed, because no peat map is loaded [E-aa6885079e].',
          evidence_ids: ['E-aa6885079e'],
        },
      ],
      evidence: [{ evidence_id: 'E-aa6885079e', sha256: 'x' }],
      limitations: ['Names are leads for verification.'],
      validity: { unserved: [] },
    },
    ...extra,
  },
});
const ref = (a: Artifact) => ({
  id: a.id,
  version: a.version,
  sha256: a.sha256,
});

describe('SmokeLedger findings in the team World Model', () => {
  it('records one town and each reviewed product with exact artifact evidence', () => {
    const outlook = artifact('smokeledger.air_outlook', run('assess_haze'));
    const trace = artifact(
      'smokeledger.trace_sources',
      run('trace_sources', {
        sources: {
          confidence: 'not assessed',
          top_concessions: [{ concession_id: 'GFW-0412', name: 'Hidden Co' }],
        },
      }),
    );
    const drafts = adapter.extract({
      request: {} as never,
      artifacts: [outlook, trace],
    });
    expect(drafts.map((d) => d.kind)).toEqual([
      'haze_town',
      'smokeledger_air_outlook',
      'smokeledger_source_trace',
    ]);
    for (const d of drafts)
      expect(identifierSchema.safeParse(d.external_id).success).toBe(true);
    expect(drafts[0]!.external_id).toBe('haze-town:batu-pahat');
    expect(drafts[2]).toMatchObject({
      evidence: [ref(trace)],
      relationships: [
        {
          kind: 'haze_town',
          external_id: 'haze-town:batu-pahat',
          relationship: 'located_in',
        },
      ],
      payload: {
        method: 'smokeledger.trace_sources',
        not_assessed: [expect.stringContaining('not assessed')],
        concession_leads: ['GFW-0412'],
      },
    });
    // Concession names are never recorded, only ids as leads.
    expect(JSON.stringify(drafts)).not.toContain('Hidden Co');
  });

  it('ignores tampered, unsupported and unrelated artifacts', () => {
    const tampered = {
      ...artifact('smokeledger.air_outlook', run('assess_haze')),
      sha256: 'f'.repeat(64),
    } as Artifact;
    const failed = artifact(
      'smokeledger.air_outlook',
      run('assess_haze', { status: 'error', error: { type: 'unsupported' } }),
    );
    const other = artifact('pm25.capture', { rows: [] });
    expect(
      adapter.extract({
        request: {} as never,
        artifacts: [tampered, failed, other],
      }),
    ).toEqual([]);
  });

  it('offers a record for acceptance only with a passed independent review of its exact artifact', () => {
    const outlook = artifact('smokeledger.air_outlook', run('assess_haze'));
    const reviewer = crypto.randomUUID();
    const review = (valid: boolean) =>
      artifact(
        'review',
        { valid, reviewed_artifacts: [ref(outlook)], findings: [] },
        { assignment_id: reviewer },
      );
    const record = {
      ref: { id: 'world-record-1', revision: 1 },
      kind: 'smokeledger_air_outlook',
      payload: { artifact: ref(outlook) },
    };
    const assignments = [
      {
        id: reviewer,
        revision: 1,
        definition_id: 'smokeledger.review',
        role: 'EvidenceCritic' as const,
        status: 'completed' as const,
        support: 'supported' as const,
      },
    ];
    const candidate = (reviewArtifact: Artifact, roster = assignments) =>
      adapter.buildAcceptanceCandidate({
        request: {} as never,
        records: [record as never],
        assessments: [],
        artifacts: [outlook, reviewArtifact],
        assignments: roster,
      });
    const passed = review(true);
    expect(candidate(passed)).toEqual({
      subject: record.ref,
      stated_use: 'smokeledger-episode',
      evidence: [ref(outlook), ref(passed)],
    });
    expect(candidate(review(false))).toBeUndefined();
    // A review by anything other than the registered independent critic does not count.
    expect(
      candidate(passed, [{ ...assignments[0]!, role: 'HazeOps' as never }]),
    ).toBeUndefined();
  });

  it('requires EvidenceCritic coverage for every outlook and trace', () => {
    const outlook = artifact('smokeledger.air_outlook', run('assess_haze'));
    const trace = artifact('smokeledger.trace_sources', run('trace_sources'));
    const drafts = artifact('smokeledger.community_message_drafts', {});
    expect(
      adapter.requiredReviewCoverage({
        request: {} as never,
        assignments: [],
        artifacts: [outlook, trace, drafts],
      }),
    ).toEqual([
      expect.objectContaining({
        evidence: [ref(outlook)],
        reviewer_roles: ['EvidenceCritic'],
      }),
      expect.objectContaining({
        evidence: [ref(trace)],
        reviewer_roles: ['EvidenceCritic'],
      }),
    ]);
  });
});
