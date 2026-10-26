import { z } from 'zod';
import {
  CONTRACT_LIMITS,
  identifierSchema,
  timestampSchema,
} from './common.js';
import { artifactRefSchema, boundedJsonSchema } from './artifacts.js';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = z.string().min(1).max(CONTRACT_LIMITS.text);
const worldModeSchema = z.enum(['live', 'fixture', 'replay']);
const worldScopeSchema = z.strictObject({
  principal: identifierSchema,
  workspace: identifierSchema,
  mode: worldModeSchema,
});
const worldRecordRefSchema = z.strictObject({
  id: identifierSchema,
  revision,
  sha256: digest,
});
const actorSchema = z.strictObject({
  kind: z.enum(['user', 'service', 'assignment']),
  id: identifierSchema,
});

export const worldRecordSchema = z.strictObject({
  schema_version: z.literal('haze.world.record.v1'),
  ref: worldRecordRefSchema,
  scope: worldScopeSchema,
  kind: identifierSchema,
  external_id: identifierSchema.optional(),
  payload: boundedJsonSchema,
  producer: actorSchema,
  observed_at: timestampSchema.optional(),
  retrieved_at: timestampSchema.optional(),
  recorded_at: timestampSchema,
});

export const worldRelationshipSchema = z.strictObject({
  schema_version: z.literal('haze.world.relationship.v1'),
  id: identifierSchema,
  scope: worldScopeSchema,
  kind: identifierSchema,
  from: worldRecordRefSchema,
  to: worldRecordRefSchema,
  attributes: boundedJsonSchema.optional(),
  recorded_at: timestampSchema,
});

export const worldSupportRevisionSchema = z.strictObject({
  schema_version: z.literal('haze.world.support-revision.v1'),
  id: identifierSchema,
  scope: worldScopeSchema,
  revision,
  kind: z.enum(['artifact', 'record', 'method', 'policy', 'grant']),
  sha256: digest,
  artifact: artifactRefSchema.optional(),
  record: worldRecordRefSchema.optional(),
  recorded_at: timestampSchema,
});

export const worldAssessmentSchema = z.strictObject({
  schema_version: z.literal('haze.world.assessment.v1'),
  id: identifierSchema,
  scope: worldScopeSchema,
  subject: worldRecordRefSchema,
  producer: actorSchema,
  reviewer: z.strictObject({
    assignment_id: identifierSchema,
    revision,
  }),
  status: z.enum(['supported', 'partial', 'rejected']),
  evidence: z.array(artifactRefSchema).max(CONTRACT_LIMITS.references),
  support_revisions: z
    .array(worldSupportRevisionSchema)
    .max(CONTRACT_LIMITS.references),
  limitations: z.array(z.string().max(CONTRACT_LIMITS.text)).max(64),
  assessed_at: timestampSchema,
});

const acceptanceBase = {
  schema_version: z.literal('haze.world.acceptance.v1'),
  id: identifierSchema,
  scope: worldScopeSchema,
  subject: worldRecordRefSchema,
  stated_use: identifierSchema,
  policy: z.strictObject({
    id: identifierSchema,
    version: identifierSchema,
    sha256: digest,
  }),
  support_revisions: z
    .array(worldSupportRevisionSchema)
    .max(CONTRACT_LIMITS.references),
  evaluated_at: timestampSchema,
};
export const worldAcceptanceOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...acceptanceBase,
    status: z.literal('accepted'),
    accepted_at: timestampSchema,
  }),
  z.strictObject({
    ...acceptanceBase,
    status: z.literal('pending_review'),
    reasons: z.array(boundedText).min(1).max(64),
  }),
  z.strictObject({
    ...acceptanceBase,
    status: z.literal('not_eligible'),
    reasons: z.array(boundedText).min(1).max(64),
  }),
  z.strictObject({
    ...acceptanceBase,
    status: z.literal('held'),
    hold_ids: z.array(identifierSchema).min(1).max(64),
  }),
  z.strictObject({
    ...acceptanceBase,
    status: z.literal('superseded'),
    superseded_by: worldRecordRefSchema,
  }),
]);

export const worldHoldSchema = z
  .strictObject({
    schema_version: z.literal('haze.world.hold.v1'),
    id: identifierSchema,
    scope: worldScopeSchema,
    subject: worldRecordRefSchema,
    reason: boundedText,
    source: z.enum([
      'correction',
      'grant_revocation',
      'source_supersession',
      'method_change',
      'policy_change',
      'unknown_impact',
    ]),
    created_at: timestampSchema,
    cleared_at: timestampSchema.optional(),
    cleared_reason: z.string().min(1).max(CONTRACT_LIMITS.text).optional(),
  })
  .superRefine((hold, context) => {
    if (hold.cleared_at !== undefined && hold.cleared_reason === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['cleared_reason'],
        message: 'A cleared hold requires a reason.',
      });
    }
    if (hold.cleared_at === undefined && hold.cleared_reason !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['cleared_at'],
        message: 'A hold-clear reason requires a clear timestamp.',
      });
    }
  });

export const worldLineageEntrySchema = z.strictObject({
  event_id: identifierSchema,
  event_kind: identifierSchema,
  record: worldRecordRefSchema.optional(),
  relationship: worldRelationshipSchema.optional(),
  support_revision: worldSupportRevisionSchema.optional(),
  assessment: worldAssessmentSchema.optional(),
  acceptance: worldAcceptanceOutcomeSchema.optional(),
  hold: worldHoldSchema.optional(),
  actor: actorSchema,
  recorded_at: timestampSchema,
});

const pageSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  next_cursor: z.string().min(1).max(512).optional(),
  has_more: z.boolean(),
});

export const worldHistoryPageSchema = z
  .strictObject({
    schema_version: z.literal('haze.world.history-page.v1'),
    record: worldRecordRefSchema,
    entries: z.array(worldLineageEntrySchema).max(100),
    page: pageSchema,
  })
  .superRefine((page, context) => {
    if (page.page.has_more !== (page.page.next_cursor !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['page'],
        message: 'has_more must match the presence of next_cursor.',
      });
    }
    if (
      new TextEncoder().encode(JSON.stringify(page)).byteLength >
      CONTRACT_LIMITS.bytes
    ) {
      context.addIssue({
        code: 'custom',
        message: 'World Model history response exceeds the 1 MiB bound.',
      });
    }
  });

export const worldLineagePageSchema = z
  .strictObject({
    schema_version: z.literal('haze.world.lineage-page.v1'),
    record: worldRecordRefSchema,
    entries: z.array(worldLineageEntrySchema).max(100),
    page: pageSchema,
  })
  .superRefine((page, context) => {
    if (page.page.has_more !== (page.page.next_cursor !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['page'],
        message: 'has_more must match the presence of next_cursor.',
      });
    }
    if (
      new TextEncoder().encode(JSON.stringify(page)).byteLength >
      CONTRACT_LIMITS.bytes
    ) {
      context.addIssue({
        code: 'custom',
        message: 'World Model lineage response exceeds the 1 MiB bound.',
      });
    }
  });

export const worldOperationReceiptSchema = z.strictObject({
  schema_version: z.literal('haze.world.operation-receipt.v1'),
  id: identifierSchema,
  scope: worldScopeSchema,
  operation_key: z.string().min(1).max(200),
  fingerprint: digest,
  outcome: z.enum(['created', 'updated', 'accepted', 'held', 'no_change']),
  records: z.array(worldRecordRefSchema).max(CONTRACT_LIMITS.references),
  recorded_at: timestampSchema,
});

export type WorldRecord = z.infer<typeof worldRecordSchema>;
export type WorldRelationship = z.infer<typeof worldRelationshipSchema>;
export type WorldSupportRevision = z.infer<typeof worldSupportRevisionSchema>;
export type WorldAssessment = z.infer<typeof worldAssessmentSchema>;
export type WorldAcceptanceOutcome = z.infer<
  typeof worldAcceptanceOutcomeSchema
>;
export type WorldHold = z.infer<typeof worldHoldSchema>;
export type WorldLineageEntry = z.infer<typeof worldLineageEntrySchema>;
export type WorldHistoryPage = z.infer<typeof worldHistoryPageSchema>;
export type WorldLineagePage = z.infer<typeof worldLineagePageSchema>;
export type WorldOperationReceipt = z.infer<typeof worldOperationReceiptSchema>;
