import { describe, expect, it } from 'vitest';
import {
  worldAcceptanceOutcomeSchema,
  worldAssessmentSchema,
  worldHistoryPageSchema,
  worldHoldSchema,
  worldLineagePageSchema,
  worldOperationReceiptSchema,
  worldRecordSchema,
  worldRelationshipSchema,
  worldSupportRevisionSchema,
} from '../../app/contracts/world.js';

const at = '2026-10-26T00:00:00Z';
const digest = 'a'.repeat(64);
const scope = {
  principal: 'test-user',
  workspace: 'test-workspace',
  mode: 'fixture' as const,
};
const ref = { id: 'location:klang', revision: 1, sha256: digest };
const supportRevision = {
  schema_version: 'haze.world.support-revision.v1',
  id: 'support:analysis',
  scope,
  revision: 1,
  kind: 'artifact',
  sha256: digest,
  artifact: {
    id: '00000000-0000-4000-8000-000000000001',
    version: 1,
    sha256: digest,
  },
  recorded_at: at,
};
const lineageEntry = {
  event_id: 'event:1',
  event_kind: 'record_created',
  record: ref,
  actor: { kind: 'service', id: 'haze' },
  recorded_at: at,
};

describe('World Model public contracts', () => {
  it('accepts scoped records, relationships, support revisions, and independent assessments', () => {
    expect(
      worldRecordSchema.parse({
        schema_version: 'haze.world.record.v1',
        ref,
        scope,
        kind: 'location',
        external_id: 'geo:klang',
        payload: { country: 'MY' },
        producer: { kind: 'service', id: 'config-sync' },
        observed_at: at,
        retrieved_at: at,
        recorded_at: at,
      }).scope,
    ).toEqual(scope);
    expect(
      worldRelationshipSchema.parse({
        schema_version: 'haze.world.relationship.v1',
        id: 'relationship:1',
        scope,
        kind: 'supported_by',
        from: ref,
        to: { id: 'evidence:1', revision: 1, sha256: digest },
        recorded_at: at,
      }).kind,
    ).toBe('supported_by');
    expect(worldSupportRevisionSchema.parse(supportRevision).kind).toBe(
      'artifact',
    );
    expect(
      worldAssessmentSchema.parse({
        schema_version: 'haze.world.assessment.v1',
        id: 'assessment:1',
        scope,
        subject: ref,
        producer: { kind: 'assignment', id: 'pm25.analyze' },
        reviewer: { assignment_id: 'pm25.check', revision: 2 },
        status: 'supported',
        evidence: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            version: 1,
            sha256: digest,
          },
        ],
        support_revisions: [supportRevision],
        limitations: ['Modeled evidence only.'],
        assessed_at: at,
      }).reviewer.assignment_id,
    ).toBe('pm25.check');
  });

  it('validates each acceptance state with its required authority or reason fields', () => {
    const base = {
      schema_version: 'haze.world.acceptance.v1',
      id: 'acceptance:1',
      scope,
      subject: ref,
      stated_use: 'research',
      policy: { id: 'research-v1', version: '1', sha256: digest },
      support_revisions: [supportRevision],
      evaluated_at: at,
    };
    expect(
      worldAcceptanceOutcomeSchema.parse({
        ...base,
        status: 'accepted',
        accepted_at: at,
      }).status,
    ).toBe('accepted');
    for (const value of [
      {
        ...base,
        status: 'pending_review',
        reasons: ['Independent review pending.'],
      },
      {
        ...base,
        status: 'not_eligible',
        reasons: ['Required component missing.'],
      },
      { ...base, status: 'held', hold_ids: ['hold:correction'] },
      {
        ...base,
        status: 'superseded',
        superseded_by: { id: 'location:klang', revision: 2, sha256: digest },
      },
    ]) {
      expect(worldAcceptanceOutcomeSchema.parse(value).status).toBe(
        value.status,
      );
    }
    expect(() =>
      worldAcceptanceOutcomeSchema.parse({
        ...base,
        status: 'not_eligible',
        reasons: [],
      }),
    ).toThrow();
  });

  it('requires explicit reason and timestamp together when clearing a hold', () => {
    expect(
      worldHoldSchema.parse({
        schema_version: 'haze.world.hold.v1',
        id: 'hold:1',
        scope,
        subject: ref,
        reason: 'A supporting source was superseded.',
        source: 'source_supersession',
        created_at: at,
      }).cleared_at,
    ).toBeUndefined();
    const cleared = {
      schema_version: 'haze.world.hold.v1',
      id: 'hold:1',
      scope,
      subject: ref,
      reason: 'A supporting source was superseded.',
      source: 'source_supersession',
      created_at: at,
      cleared_at: at,
      cleared_reason: 'A replacement review completed.',
    };
    expect(worldHoldSchema.parse(cleared).cleared_reason).toBe(
      'A replacement review completed.',
    );
    expect(() =>
      worldHoldSchema.parse({ ...cleared, cleared_reason: undefined }),
    ).toThrow();
  });

  it('bounds paginated history and lineage responses and validates cursors', () => {
    const page = {
      limit: 25,
      next_cursor: 'cursor:25',
      has_more: true,
    };
    const history = {
      schema_version: 'haze.world.history-page.v1',
      record: ref,
      entries: [lineageEntry],
      page,
    };
    const lineage = {
      schema_version: 'haze.world.lineage-page.v1',
      record: ref,
      entries: [lineageEntry],
      page,
    };
    expect(worldHistoryPageSchema.parse(history).entries).toHaveLength(1);
    expect(worldLineagePageSchema.parse(lineage).page.next_cursor).toBe(
      'cursor:25',
    );
    expect(() =>
      worldHistoryPageSchema.parse({
        ...history,
        page: { limit: 25, has_more: true },
      }),
    ).toThrow();
    expect(() =>
      worldLineagePageSchema.parse({
        ...lineage,
        entries: Array.from({ length: 101 }, () => lineageEntry),
      }),
    ).toThrow();
    expect(() =>
      worldHistoryPageSchema.parse({
        ...history,
        entries: [{ ...lineageEntry, event_kind: 'x'.repeat(1_048_000) }],
      }),
    ).toThrow();
  });

  it('requires bounded operation receipts and rejects invalid execution modes and references', () => {
    expect(
      worldOperationReceiptSchema.parse({
        schema_version: 'haze.world.operation-receipt.v1',
        id: 'receipt:1',
        scope,
        operation_key: 'accept:task-1:artifact-1',
        fingerprint: digest,
        outcome: 'accepted',
        records: [ref],
        recorded_at: at,
      }).outcome,
    ).toBe('accepted');
    expect(() =>
      worldRecordSchema.parse({
        schema_version: 'haze.world.record.v1',
        ref: { ...ref, sha256: 'bad' },
        scope: { ...scope, mode: 'production' },
        kind: 'location',
        payload: {},
        producer: { kind: 'service', id: 'config-sync' },
        recorded_at: at,
      }),
    ).toThrow();
    expect(() =>
      worldRelationshipSchema.parse({
        schema_version: 'haze.world.relationship.v1',
        id: 'relationship:1',
        scope,
        kind: 'supported_by',
        from: ref,
        to: { ...ref, revision: 0 },
        recorded_at: at,
      }),
    ).toThrow();
  });
});
