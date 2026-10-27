import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import { type EvaluationRecordBody } from '../../app/contracts/damage-reduction-evaluation.js';
import {
  type ReductionProgrammeRecord,
  type ReductionProgrammeSnapshot,
  type ReductionProgrammeView,
} from '../../app/contracts/damage-reduction-programme.js';
import {
  collectEvaluationEvidence,
  embeddedEvaluationReferences,
  evaluationLineageFingerprint,
  projectEvaluationRecords,
  validateEvaluationRecord,
} from '../../app/capabilities/damage-reduction-programmes/evaluation-records.js';
import type { ProgrammeHost } from '../../app/capabilities/damage-reduction-programmes/ports.js';
import {
  syntheticExternalEvaluationInput,
  syntheticQualificationDossier,
} from '../../app/capabilities/damage-reduction-programmes/evaluation-fixtures.js';
import { SYNTHETIC_REDUCTION_TARGET } from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';

const exact = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const artifact = (content: unknown): Artifact =>
  artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    identity: localTaskIdentity,
    kind: 'user-import',
    producer: { kind: 'user', id: 'engineering-fixture' },
    created_at: '2026-10-01T00:00:00Z',
    dependencies: [],
    evidence_origin: 'user_supplied',
    content,
  });
function hostFor(values: Artifact[]) {
  const map = new Map(values.map((value) => [value.id, value])),
    held = new Set<string>();
  const absent = (): never => {
    throw new Error(
      'No task runtime is available in this pure engineering fixture.',
    );
  };
  const host: ProgrammeHost = {
    mode: 'fixture',
    atomic: (operation) => operation(),
    afterCommit: (operation) => operation(),
    readTask: absent,
    readArtifact(reference) {
      const result = map.get(reference.id);
      if (!result) throw new Error('Missing fixture source.');
      return result;
    },
    assertEvidenceCurrent(reference) {
      if (held.has(reference.id))
        throw new Error('Source held by engineering fixture.');
      if (!map.has(reference.id)) throw new Error('Missing fixture source.');
    },
    pinTaskInputs: absent,
    previewView: absent,
    admitTask: absent,
    updateTask: absent,
    controlTask: absent,
    runResult: () => undefined,
  };
  return { host, map, held };
}
function stored(
  record: ReductionProgrammeRecord['record'],
  id: string = randomUUID(),
): ReductionProgrammeRecord {
  return {
    id,
    programme_id: '4ac5e320-63cc-43fc-8baa-a1f563572b90',
    programme_revision: 1,
    created_at: '2026-10-01T00:00:00Z',
    record,
    task_binding: null,
    applicability: 'programme_record',
  };
}
function currentView(
  result: ArtifactRef,
  review: ArtifactRef,
  dossier: ArtifactRef,
): ReductionProgrammeView {
  // The record validator reads bindings only; product-schema/registered producer
  // checks are covered by the separate kernel and actual-runtime suites.
  return {
    attempts: [
      {
        attempt: { phase: 'evaluation' },
        currency: 'current',
        historical_artifact_refs: [result],
      },
    ],
    evaluation: {
      current: {
        result: { artifact: result, value: { dossier_ref: dossier } },
        review: { artifact: review },
      },
    },
  } as unknown as ReductionProgrammeView;
}
const qualification = (
  result: ArtifactRef,
  review: ArtifactRef,
  dossier: ArtifactRef,
): Extract<EvaluationRecordBody, { kind: 'evaluation_qualification' }> => ({
  kind: 'evaluation_qualification',
  decision: 'qualified',
  result_ref: result,
  technical_review_ref: review,
  dossier_ref: dossier,
  adopted_by: 'Hypothetical local operator; engineering test only',
  attested_at: new Date().toISOString(),
  reason:
    'Retain an explicit human attestation without asserting an actual reference case.',
  supersedes_record_id: null,
});

describe('external evaluation retained-record guards', () => {
  it('canonicalizes exact embedded refs and rejects invalid UUIDs, versions, hashes and cyclic values', () => {
    const source = artifact({ origin: 'supplied' }),
      reference = exact(source);
    expect(
      embeddedEvaluationReferences({
        first: { ...reference, description: 'Retained wrapper' },
        duplicate: reference,
      }),
    ).toEqual([reference]);
    expect(
      embeddedEvaluationReferences({ id: 'design-id', version: '1' }),
    ).toEqual([]);
    for (const changed of [
      { ...reference, id: 'not-a-uuid' },
      { ...reference, version: 0 },
      { ...reference, version: 1.5 },
      { ...reference, version: '1' },
      { ...reference, sha256: 'wrong' },
    ])
      expect(() => embeddedEvaluationReferences(changed)).toThrow(/reference/);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => embeddedEvaluationReferences(cycle)).toThrow(/cyclic/);
  });
  it('rejects exact-reference cycles, mismatched bytes and cross-identity proof without dropping current grants', () => {
    const first = artifact({ origin: 'supplied', name: 'first' }),
      second = artifact({ origin: 'supplied', name: 'second' });
    first.dependencies = [exact(second)];
    second.dependencies = [exact(first)];
    const { host, held } = hostFor([first, second]);
    expect(() =>
      collectEvaluationEvidence([exact(first)], host, localTaskIdentity),
    ).toThrow(/cyclic/);
    second.dependencies = [];
    expect(
      collectEvaluationEvidence([exact(first)], host, localTaskIdentity),
    ).toHaveLength(2);
    held.add(second.id);
    expect(() =>
      collectEvaluationEvidence([exact(first)], host, localTaskIdentity),
    ).toThrow(/held/);
    held.clear();
    expect(() =>
      collectEvaluationEvidence(
        [{ ...exact(first), sha256: '0'.repeat(64) }],
        host,
        localTaskIdentity,
      ),
    ).toThrow(/exact/);
    second.identity = { ...localTaskIdentity, principal: 'another-principal' };
    expect(() =>
      collectEvaluationEvidence([exact(first)], host, localTaskIdentity),
    ).toThrow(/principal|workspace/);
  });
  it('fingerprints selected registration facts independently of object identity and irrelevant programme notes', () => {
    const source = artifact({ origin: 'synthetic' }),
      reference = exact(source);
    const registration = {
      kind: 'pilot_registration' as const,
      feasibility_ref: reference,
      protocol_ref: reference,
      review_ref: reference,
      outcome_access: {
        collection: 'unknown' as const,
        analysis: 'unknown' as const,
        collection_started_at: null,
        analysis_started_at: null,
        attested_by: 'Engineering operator',
        attested_at: '2026-10-01T00:00:00Z',
        evidence: [],
      },
      external_registration: null,
    };
    const selected = stored(registration),
      other = stored(registration);
    const fingerprint = evaluationLineageFingerprint(
      [selected, other],
      selected.id,
    );
    expect(fingerprint).toBe(
      evaluationLineageFingerprint([selected], selected.id),
    );
    expect(
      evaluationLineageFingerprint(
        structuredClone([selected, other]),
        selected.id,
      ),
    ).toBe(fingerprint);
    expect(
      evaluationLineageFingerprint(
        [
          selected,
          other,
          stored({ kind: 'note', text: 'Unrelated annotation' }),
        ],
        selected.id,
      ),
    ).toBe(fingerprint);
    expect(
      evaluationLineageFingerprint(
        [
          selected,
          other,
          stored({
            kind: 'pilot_deviation',
            registration_id: selected.id,
            action_record_ids: [],
            category: 'material-departure',
            description: 'New retained material event.',
            material: true,
            status: 'open',
            occurred_at: '2026-10-01T00:00:00Z',
            evidence: [],
            resolves_deviation_id: null,
          }),
        ],
        selected.id,
      ),
    ).not.toBe(fingerprint);
  });
  it('requires prior adoption for withdrawal and fresh exact products before adoption can resume', () => {
    const result = artifact({ name: 'result' }),
      review = artifact({ name: 'review' }),
      dossier = artifact({ name: 'dossier' }),
      { host, map } = hostFor([result, review, dossier]);
    const view = currentView(exact(result), exact(review), exact(dossier)),
      record = qualification(exact(result), exact(review), exact(dossier));
    expect(() =>
      validateEvaluationRecord(
        { ...record, decision: 'withdrawn' },
        [],
        view,
        host,
        localTaskIdentity,
      ),
    ).toThrow(/prior|adoption/);
    const adoption = stored(record),
      withdrawal = stored({
        ...record,
        decision: 'withdrawn',
        supersedes_record_id: adoption.id,
      });
    withdrawal.created_at = '2026-10-02T00:00:00Z';
    expect(() =>
      validateEvaluationRecord(
        withdrawal.record as EvaluationRecordBody,
        [adoption],
        view,
        host,
        localTaskIdentity,
      ),
    ).not.toThrow();
    expect(() =>
      validateEvaluationRecord(
        { ...record, supersedes_record_id: withdrawal.id },
        [adoption, withdrawal],
        view,
        host,
        localTaskIdentity,
      ),
    ).toThrow(/fresh/);
    const input = syntheticExternalEvaluationInput({
      programme_id: randomUUID(),
      target_sha256: contractHash(SYNTHETIC_REDUCTION_TARGET),
      scope_sha256: contractHash(SYNTHETIC_REDUCTION_TARGET.scope),
      scope: SYNTHETIC_REDUCTION_TARGET.scope,
      registration_id: randomUUID(),
      protocol_ref: exact(result),
      action_record_ids: [randomUUID()],
      rules: [{ id: 'example-rule', version: '1' }],
      report_ref: exact(result),
      data_ref: exact(result),
      review_ref: exact(review),
      expected_output_ref: exact(result),
    });
    const dossierBody = syntheticQualificationDossier(input, exact(result));
    dossierBody.reviewer.reviewed_at = '2026-10-03T00:00:00Z';
    const freshResult = artifact({ name: 'fresh-result' }),
      freshReview = artifact({ name: 'fresh-review' }),
      freshDossier = artifact(dossierBody),
      freshView = currentView(
        exact(freshResult),
        exact(freshReview),
        exact(freshDossier),
      ),
      fresh = qualification(
        exact(freshResult),
        exact(freshReview),
        exact(freshDossier),
      );
    freshResult.created_at = '2026-10-03T00:00:00Z';
    freshReview.created_at = '2026-10-03T00:00:00Z';
    for (const product of [freshResult, freshReview, freshDossier])
      map.set(product.id, product);
    expect(() =>
      validateEvaluationRecord(
        fresh,
        [adoption, withdrawal],
        freshView,
        host,
        localTaskIdentity,
      ),
    ).toThrow(/supersede/);
    expect(() =>
      validateEvaluationRecord(
        { ...fresh, supersedes_record_id: withdrawal.id },
        [adoption, withdrawal],
        freshView,
        host,
        localTaskIdentity,
      ),
    ).not.toThrow();
    const copied = artifact({
      ...dossierBody,
      reviewer: {
        ...dossierBody.reviewer,
        reviewed_at: '2026-10-01T00:00:00Z',
      },
    });
    map.set(copied.id, copied);
    expect(() =>
      validateEvaluationRecord(
        {
          ...fresh,
          dossier_ref: exact(copied),
          supersedes_record_id: withdrawal.id,
        },
        [adoption, withdrawal],
        currentView(exact(freshResult), exact(freshReview), exact(copied)),
        host,
        localTaskIdentity,
      ),
    ).toThrow(/copying|after|fresh/);
    freshReview.created_at = '2026-10-01T00:00:00Z';
    expect(() =>
      validateEvaluationRecord(
        { ...fresh, supersedes_record_id: withdrawal.id },
        [adoption, withdrawal],
        freshView,
        host,
        localTaskIdentity,
      ),
    ).toThrow(/after|fresh/);
  });
  it('permits exact retained historical objection resolution but preserves a material latch for missing, synthetic-wrapped or held proof', () => {
    const result = artifact({ name: 'historical-result' }),
      leaf = artifact({
        origin: 'synthetic',
        statement: 'Synthetic resolution cannot settle science.',
      }),
      wrapper = artifact({ origin: 'supplied', proof: exact(leaf) }),
      fresh = artifact({
        origin: 'supplied',
        statement:
          'New non-synthetic proof example; this is still an engineering test.',
      });
    const { host, held } = hostFor([result, leaf, wrapper, fresh]);
    const opened = stored({
      kind: 'evaluation_objection',
      result_ref: exact(result),
      severity: 'material',
      status: 'open',
      description: 'Known material scientific objection.',
      evidence: [],
      resolves_record_id: null,
    });
    const resolution = (proof: ArtifactRef) =>
      stored({
        kind: 'evaluation_objection',
        result_ref: exact(result),
        severity: 'material',
        status: 'resolved',
        description:
          'Explicit supporting resolution of the retained objection.',
        evidence: [proof],
        resolves_record_id: opened.id,
      });
    const base = {
      attempts: [
        {
          attempt: { phase: 'evaluation' },
          currency: 'historical',
          historical_artifact_refs: [exact(result)],
        },
      ],
    } as unknown as ReductionProgrammeView;
    const snapshot = {} as ReductionProgrammeSnapshot;
    const resolve = resolution(exact(fresh));
    expect(() =>
      validateEvaluationRecord(
        resolve.record as EvaluationRecordBody,
        [opened],
        base,
        host,
        localTaskIdentity,
      ),
    ).not.toThrow();
    const wrapped = projectEvaluationRecords(
      snapshot,
      [opened, resolution(exact(wrapper))],
      base,
      host,
      localTaskIdentity,
    );
    expect(wrapped.objections[0]?.unresolved).toBe(true);
    const cleared = projectEvaluationRecords(
      snapshot,
      [opened, resolve],
      base,
      host,
      localTaskIdentity,
    );
    expect(cleared.objections[0]?.unresolved).toBe(false);
    held.add(fresh.id);
    expect(
      projectEvaluationRecords(
        snapshot,
        [opened, resolve],
        base,
        host,
        localTaskIdentity,
      ).objections[0]?.unresolved,
    ).toBe(true);
    expect(() =>
      validateEvaluationRecord(
        { ...resolve.record, severity: 'minor' } as EvaluationRecordBody,
        [opened],
        base,
        host,
        localTaskIdentity,
      ),
    ).toThrow(/severity|original|objection/);
  });
});
