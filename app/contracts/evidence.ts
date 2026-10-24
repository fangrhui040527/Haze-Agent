import { z } from 'zod';
import {
  identifierSchema,
  inputOriginSchema,
  reasonSchema,
  referenceSchema,
  timestampSchema,
} from './common.js';

const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const intervalSchema = z.strictObject({
  start: timestampSchema,
  end: timestampSchema,
});

const passageLocatorSchema = z.strictObject({
  kind: z.literal('passage'),
  document_ref: referenceSchema,
  page: z.number().int().positive(),
  section: z.string().min(1),
  quoted_passage: z.string().min(1),
  start_offset: z.number().int().nonnegative(),
  end_offset: z.number().int().positive(),
  passage_sha256: sha256Schema,
});

const dataLocatorSchema = z.strictObject({
  kind: z.literal('data'),
  series_id: identifierSchema,
  run_id: identifierSchema,
  row_ids: z.array(identifierSchema).min(1),
  intervals: z
    .array(intervalSchema.extend({ location_id: identifierSchema }))
    .min(1),
  location_ids: z.array(identifierSchema).min(1),
  selection_sha256: sha256Schema,
});

const structuredLocatorSchema = z.strictObject({
  kind: z.literal('structured_fields'),
  record_ref: referenceSchema,
  field_pointers: z.array(z.string().min(1)).min(1),
});

const locatorSchema = z.discriminatedUnion('kind', [
  passageLocatorSchema,
  dataLocatorSchema,
  structuredLocatorSchema,
]);

const provenanceStepSchema = z.strictObject({
  operation: z.enum([
    'collection',
    'transformation',
    'conversion',
    'selection',
  ]),
  method_id: identifierSchema,
  method_version: z.string().min(1),
  description: z.string().min(1),
  input_refs: z.array(referenceSchema),
});

const provenanceSchema = z.strictObject({
  description: z.string().min(1),
  chain: z.array(provenanceStepSchema),
  access_permissions: z.array(identifierSchema),
});

const nullReasonMapSchema = z.record(z.string(), reasonSchema);

export const evidenceShape = z.strictObject({
  schema_version: z.literal('haze.evidence.v2'),
  evidence_id: identifierSchema,
  revision: revisionSchema,
  upstream_id: identifierSchema,
  upstream_revision: revisionSchema,
  raw_sha256: sha256Schema,
  raw_ref: identifierSchema,
  source_kind: z.enum([
    'observation',
    'forecast',
    'modeled_microenvironment',
    'synthetic_fixture',
  ]),
  input_origin: inputOriginSchema,
  title: z.string().min(1),
  source_owner: z.string().min(1),
  provenance: provenanceSchema,
  locator: locatorSchema,
  pollutant: z.string().min(1).nullable(),
  quantity: z.string().min(1).nullable(),
  unit: z.string().min(1).nullable(),
  issued_at: timestampSchema.nullable(),
  published_at: timestampSchema.nullable(),
  valid_interval: intervalSchema,
  retrieved_at: timestampSchema.nullable(),
  accepted_at: timestampSchema.nullable(),
  original_timezone: z.string().min(1).nullable(),
  native_temporal_resolution: z
    .strictObject({
      value: z.number().positive().finite(),
      unit: z.enum(['second', 'minute', 'hour', 'day']),
    })
    .nullable(),
  spatial_support: z
    .strictObject({
      description: z.string().min(1),
      location_ids: z.array(identifierSchema).min(1),
    })
    .nullable(),
  quality_ref: referenceSchema.nullable(),
  licence_ref: referenceSchema.nullable(),
  access_ref: referenceSchema.nullable(),
  permitted_uses: z.array(identifierSchema).min(1),
  limitations: z.array(z.string().min(1)),
  review_refs: z.array(referenceSchema),
  disposition: z.enum([
    'not_assessed',
    'accepted_for_declared_use',
    'rejected',
    'withdrawn',
    'superseded',
  ]),
  expiry: timestampSchema.nullable(),
  freshness_rule_ref: referenceSchema.nullable(),
  supersession_ref: referenceSchema.nullable(),
  withdrawal_ref: referenceSchema.nullable(),
  null_reasons: nullReasonMapSchema,
});

const nullableEvidenceFields = [
  'pollutant',
  'quantity',
  'unit',
  'issued_at',
  'published_at',
  'retrieved_at',
  'accepted_at',
  'original_timezone',
  'native_temporal_resolution',
  'spatial_support',
  'quality_ref',
  'licence_ref',
  'access_ref',
  'expiry',
  'freshness_rule_ref',
  'supersession_ref',
  'withdrawal_ref',
] as const;

function nullReasonIssues(
  nullability: Record<string, boolean>,
  reasons: Record<string, unknown>,
  path: (string | number)[],
  context: z.RefinementCtx,
) {
  for (const [field, isNull] of Object.entries(nullability)) {
    if (isNull !== Object.hasOwn(reasons, field)) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'null_reasons', field],
        message: 'Null fields require exactly one explicit null reason',
      });
    }
  }
  for (const field of Object.keys(reasons)) {
    if (!Object.hasOwn(nullability, field)) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'null_reasons', field],
        message:
          'Null reason does not correspond to an inapplicable nullable field',
      });
    }
  }
}

function isUtc(value: string) {
  return value.endsWith('Z');
}

function validUtcInterval(
  interval: { start: string; end: string },
  path: (string | number)[],
  context: z.RefinementCtx,
) {
  if (!isUtc(interval.start) || !isUtc(interval.end)) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Evidence timestamps must use UTC',
    });
  }
  if (Date.parse(interval.start) >= Date.parse(interval.end)) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Interval end must be later than its start',
    });
  }
}

export const evidenceSchema = evidenceShape.superRefine((value, context) => {
  nullReasonIssues(
    Object.fromEntries(
      nullableEvidenceFields.map((field) => [field, value[field] === null]),
    ),
    value.null_reasons,
    [],
    context,
  );
  validUtcInterval(value.valid_interval, ['valid_interval'], context);
  for (const field of [
    'issued_at',
    'published_at',
    'retrieved_at',
    'accepted_at',
    'expiry',
  ] as const) {
    const timestamp = value[field];
    if (timestamp !== null && !isUtc(timestamp)) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: 'Evidence timestamps must use UTC',
      });
    }
  }
  if (
    value.source_kind === 'synthetic_fixture' &&
    value.input_origin !== 'synthetic_fixture'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['input_origin'],
      message: 'Synthetic evidence requires synthetic_fixture input origin',
    });
  }
  if (value.locator.kind === 'data') {
    let previousEnd: number | undefined;
    value.locator.intervals.forEach((interval, index) => {
      validUtcInterval(interval, ['locator', 'intervals', index], context);
      const start = Date.parse(interval.start);
      const end = Date.parse(interval.end);
      if (previousEnd !== undefined && start < previousEnd) {
        context.addIssue({
          code: 'custom',
          path: ['locator', 'intervals', index, 'start'],
          message: 'Located source intervals must not overlap',
        });
      }
      previousEnd = end;
    });
  }
});

export const environmentalSeriesShape = z.strictObject({
  schema_version: z.literal('haze.environmental_series.v2'),
  series_id: identifierSchema,
  evidence_ref: referenceSchema,
  source_kind: z.enum([
    'observation',
    'forecast',
    'modeled_microenvironment',
    'synthetic_fixture',
  ]),
  source_ref: referenceSchema,
  run_id: identifierSchema.nullable(),
  pollutant: z.string().min(1),
  unit: z.string().min(1),
  location_id: identifierSchema,
  native_temporal_resolution: z.strictObject({
    value: z.number().positive().finite(),
    unit: z.enum(['second', 'minute', 'hour', 'day']),
  }),
  spatial_support_ref: referenceSchema,
  issued_at: timestampSchema.nullable(),
  retrieved_at: timestampSchema.nullable(),
  accepted_at: timestampSchema.nullable(),
  valid_interval: intervalSchema,
  intervals: z
    .array(
      intervalSchema.extend({
        value: z.number().nonnegative().finite().nullable(),
        quality_flag: identifierSchema,
        null_reason: reasonSchema.nullable(),
      }),
    )
    .min(1),
  quality_ref: referenceSchema.nullable(),
  licence_ref: referenceSchema.nullable(),
  applicability_ref: referenceSchema.nullable(),
  freshness_rule_ref: referenceSchema.nullable(),
  uncertainty_ref: referenceSchema.nullable(),
  null_reasons: nullReasonMapSchema,
});

const nullableSeriesFields = [
  'run_id',
  'issued_at',
  'retrieved_at',
  'accepted_at',
  'quality_ref',
  'licence_ref',
  'applicability_ref',
  'freshness_rule_ref',
  'uncertainty_ref',
] as const;

export const environmentalSeriesSchema = environmentalSeriesShape.superRefine(
  (value, context) => {
    nullReasonIssues(
      Object.fromEntries(
        nullableSeriesFields.map((field) => [field, value[field] === null]),
      ),
      value.null_reasons,
      [],
      context,
    );
    validUtcInterval(value.valid_interval, ['valid_interval'], context);
    for (const field of ['issued_at', 'retrieved_at', 'accepted_at'] as const) {
      const timestamp = value[field];
      if (timestamp !== null && !isUtc(timestamp)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Evidence timestamps must use UTC',
        });
      }
    }
    let previousEnd: number | undefined;
    value.intervals.forEach((interval, index) => {
      validUtcInterval(interval, ['intervals', index], context);
      const start = Date.parse(interval.start);
      const end = Date.parse(interval.end);
      const validStart = Date.parse(value.valid_interval.start);
      const validEnd = Date.parse(value.valid_interval.end);
      if (start < validStart || end > validEnd) {
        context.addIssue({
          code: 'custom',
          path: ['intervals', index],
          message:
            'Environmental source interval must be within valid_interval',
        });
      }
      if (previousEnd !== undefined && start < previousEnd) {
        context.addIssue({
          code: 'custom',
          path: ['intervals', index, 'start'],
          message: 'Environmental intervals must not overlap',
        });
      }
      if (interval.value === null && interval.null_reason === null) {
        context.addIssue({
          code: 'custom',
          path: ['intervals', index, 'null_reason'],
          message: 'Missing values require an explicit null reason',
        });
      }
      if (interval.value !== null && interval.null_reason !== null) {
        context.addIssue({
          code: 'custom',
          path: ['intervals', index, 'null_reason'],
          message: 'Observed values cannot have a null reason',
        });
      }
      previousEnd = end;
    });
  },
);

export type EvidenceRecord = z.infer<typeof evidenceShape>;
export type EnvironmentalSeries = z.infer<typeof environmentalSeriesShape>;
