import { describe, expect, it } from 'vitest';
import type { Artifact, ArtifactRef } from '../../app/contracts/artifacts.js';
import type {
  PilotRecordContext,
  PilotRecordBody,
} from '../../app/contracts/damage-reduction-pilot.js';
import type {
  ReductionProgrammeRecord,
  ReductionProgrammeSnapshot,
} from '../../app/contracts/damage-reduction-programme.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  syntheticDigitalActionRecord,
  syntheticActionReceipt,
} from '../../app/capabilities/damage-reduction-programmes/pilot-fixtures.js';
import { projectPilotRecords } from '../../app/capabilities/damage-reduction-programmes/pilot-records.js';
import { SYNTHETIC_REDUCTION_TARGET } from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import { syntheticReductionCandidate } from '../../app/capabilities/damage-reduction-planning/planning-fixtures.js';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const identity = { principal: 'latch-test', workspace: 'latch-test' };
const at = '2027-01-03T00:00:00Z';
const missing: ArtifactRef = { id: id(99), version: 1, sha256: 'a'.repeat(64) };
type Action = Extract<PilotRecordBody, { kind: 'digital_action' }>;

function setup() {
  const artifacts = new Map<string, Artifact>();
  const artifact = (
    value: number,
    content: Artifact['content'],
  ): ArtifactRef => {
    const result: Artifact = {
      schema_version: 'haze.artifact.v3',
      id: id(value),
      version: 1,
      sha256: contractHash(content),
      identity,
      kind: 'source.import',
      producer: { kind: 'user', id: identity.principal },
      created_at: at,
      dependencies: [],
      required_tools: [],
      content,
      evidence_origin: 'user_supplied',
    };
    artifacts.set(result.id, result);
    return { id: result.id, version: result.version, sha256: result.sha256 };
  };
  const trigger = artifact(90, {
    description: 'Supplied external trigger evidence for this unit fixture.',
  });
  const snapshot: ReductionProgrammeSnapshot = {
    schema_version: 'haze.reduction.programme.v1',
    id: id(1),
    revision: 1,
    mode: 'fixture',
    title: 'Action-latch regression fixture',
    accountable_owner: 'Local test operator',
    scientific_owner: null,
    preview: {
      schema_version: 'haze.reduction.preview-request.v1',
      candidate: syntheticReductionCandidate(),
      selection: {
        schema_version: 'haze.reduction.input-selection.v1',
        target: SYNTHETIC_REDUCTION_TARGET,
        scope_sha256: contractHash(SYNTHETIC_REDUCTION_TARGET.scope),
        method_id: 'reduction.imported-residual-comparison.v1',
        method_version: '1',
        sources: [
          { artifact: trigger, row_ids: ['baseline-1', 'intervention-1'] },
        ],
      },
    },
    budget: {
      max_model_calls: 400,
      max_tool_calls: 400,
      max_runs: 12,
      max_attempts_per_phase: 3,
    },
    created_at: at,
    updated_at: at,
  };
  const context: PilotRecordContext = {
    identity,
    now: at,
    current_draft: null,
    current_lineage: null,
    readArtifact(ref) {
      const value = artifacts.get(ref.id);
      if (!value) throw new Error('Held or unavailable proof.');
      return value;
    },
    assertEvidenceCurrent(ref) {
      if (!artifacts.has(ref.id)) throw new Error('Held or unavailable proof.');
    },
  };
  const action = (overrides: Partial<Action> = {}): Action => ({
    ...syntheticDigitalActionRecord(),
    mode: 'imported_live',
    status: 'confirmed',
    trigger_refs: [trigger],
    ...overrides,
  });
  const confirm = (value: number, supplied: Action): Action => {
    const receipt = {
      ...syntheticActionReceipt(supplied),
      origin: 'imported_service' as const,
      service: 'Imported external service fixture',
      receipt_id: `receipt-${value}`,
    };
    return { ...supplied, receipt_ref: artifact(value, receipt) };
  };
  const record = (value: number, body: Action): ReductionProgrammeRecord => ({
    id: id(value),
    programme_id: snapshot.id,
    programme_revision: value,
    created_at: at,
    record: body,
    task_binding: null,
    applicability: 'programme_record',
  });
  const project = (records: ReductionProgrammeRecord[]) =>
    projectPilotRecords(snapshot, records, context).actions;
  return { action, confirm, record, project, artifact, artifacts, trigger };
}

describe('immutable digital-action state latches', () => {
  it('keeps known synthetic receipt origin across missing sibling triggers and missing raw children', () => {
    for (const missingChild of [false, true]) {
      const { action, confirm, record, project, artifact, artifacts } = setup();
      const firstAction = action({
        trigger_refs: missingChild ? [] : [missing],
      });
      const receipt = {
        ...syntheticActionReceipt(firstAction),
        origin: missingChild
          ? ('imported_service' as const)
          : ('synthetic' as const),
        raw_receipt_ref: missingChild ? missing : null,
      };
      const proof = artifact(11, receipt);
      if (missingChild)
        artifacts.get(proof.id)!.evidence_origin = 'synthetic_fixture';
      const first = record(2, { ...firstAction, receipt_ref: proof });
      const later = record(3, confirm(12, action()));
      const views = project([first, later]);
      expect(views[0]).toMatchObject({
        origin: 'simulated',
        effective_status: 'simulated',
        recorded_delivery: false,
      });
      expect(views[1]).toMatchObject({
        origin: 'simulated',
        effective_status: 'simulated',
        recorded_delivery: false,
      });
    }
  });
  it('preserves a retained simulation when its historical proof is unavailable', () => {
    const { action, confirm, record, project } = setup();
    const simulation = record(
      2,
      action({
        mode: 'simulated',
        status: 'proposed',
        trigger_refs: [missing],
      }),
    );
    const later = record(3, confirm(11, action()));
    const views = project([simulation, later]);
    expect(views[0]).toMatchObject({
      currency: 'stale',
      origin: 'simulated',
      effective_status: 'simulated',
      recorded_delivery: false,
    });
    expect(views[1]).toMatchObject({
      origin: 'simulated',
      effective_status: 'simulated',
      recorded_delivery: false,
    });
  });

  it('keeps the original unknown anchor through failed-source history and invalid replays', () => {
    const { action, confirm, record, project } = setup();
    const first = record(
      2,
      action({ status: 'unknown', trigger_refs: [missing] }),
    );
    const replay = record(3, confirm(11, action()));
    const reconciliation = record(
      4,
      confirm(12, action({ reconciles_record_id: first.id })),
    );
    const after = record(5, confirm(13, action()));
    const views = project([first, replay, reconciliation, after]);
    expect(views[0]).toMatchObject({
      currency: 'stale',
      effective_status: 'unknown',
    });
    expect(views[1]?.effective_status).toBe('unknown');
    // Replacing the missing original trigger is a different action, even if
    // its new receipt names the earlier unknown event as a reconciliation.
    expect(views[2]?.effective_status).toBe('unknown');
    expect(views[3]?.effective_status).toBe('unknown');
    expect(views[3]?.reasons.join(' ')).toContain(
      'identity differs from its original event',
    );
  });

  it('allows an exact valid receipt to reconcile a declared-unknown event without relatching it afterward', () => {
    const { action, confirm, record, project } = setup();
    const first = record(2, action({ status: 'unknown' }));
    const reconciliation = record(
      3,
      confirm(
        11,
        action({ status: 'unknown', reconciles_record_id: first.id }),
      ),
    );
    const after = record(4, confirm(12, action()));
    const views = project([first, reconciliation, after]);
    expect(views[1]?.effective_status).toBe('confirmed');
    expect(views[2]?.effective_status).toBe('confirmed');
  });

  it('does not clear unknown state when reconciliation later fails its current proof checks', () => {
    const { action, confirm, record, project, artifacts } = setup();
    const first = record(2, action({ status: 'unknown' }));
    const reconciliation = record(
      3,
      confirm(11, action({ reconciles_record_id: first.id })),
    );
    // A missing raw proof fails after parsing the matching receipt. The later
    // replay must still identify the original unresolved action exactly.
    const receipt = artifacts.get(
      reconciliation.record.kind === 'digital_action'
        ? reconciliation.record.receipt_ref!.id
        : '',
    )!;
    const changed = {
      ...(receipt.content as object),
      raw_receipt_ref: missing,
    };
    receipt.content = changed;
    receipt.sha256 = contractHash(changed);
    if (reconciliation.record.kind === 'digital_action')
      reconciliation.record.receipt_ref = {
        id: receipt.id,
        version: receipt.version,
        sha256: receipt.sha256,
      };
    const after = record(4, confirm(12, action()));
    const views = project([first, reconciliation, after]);
    expect(views[1]?.currency).toBe('stale');
    expect(views[2]?.effective_status).toBe('unknown');
  });
});
