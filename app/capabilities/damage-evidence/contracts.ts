import { z } from 'zod';

export const evidencePeriodSchema = z
  .strictObject({
    start: z.iso.date(),
    end: z.iso.date(),
  })
  .refine((value) => value.start <= value.end, 'Period ends before it starts.');

export const evidenceGeographySchema = z.strictObject({
  country: z.literal('MY'),
  level: z.enum(['country', 'state', 'district', 'grid']),
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  boundary_version: z.string().max(160).nullable(),
});

export const damageEvidenceScopeSchema = z.strictObject({
  geography: evidenceGeographySchema,
  occurrence_period: evidencePeriodSchema,
  outcome: z.enum(['deaths', 'illness_cases', 'lost_workdays']),
  attribution_basis: z.enum(['fire_attributed', 'all_pm25', 'unspecified']),
  monetary_view: z.enum([
    'physical_only',
    'financial_loss',
    'social_welfare',
    'both',
  ]),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  price_year: z.number().int().min(1900).max(2200).nullable(),
});

export const acquisitionSelectionSchema = z.strictObject({
  state: z.string().min(1).max(80).optional(),
  district: z.string().min(1).max(80).optional(),
  period: evidencePeriodSchema,
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  sex: z.enum(['both', 'male', 'female']).default('both'),
  age: z.string().min(1).max(40).default('overall'),
  ethnicity: z.string().min(1).max(40).default('overall'),
});
export const acquisitionRequestSchema = z.strictObject({
  source_id: z.string().min(1).max(120),
  selection: acquisitionSelectionSchema,
});

export const evidenceStageSchema = z.enum([
  'missing',
  'discovered',
  'acquired',
  'validated',
  'applicable',
]);
export type DamageEvidenceScope = z.infer<typeof damageEvidenceScopeSchema>;
export type AcquisitionSelection = z.infer<typeof acquisitionSelectionSchema>;
export type AcquisitionRequest = z.infer<typeof acquisitionRequestSchema>;
export type EvidenceStage = z.infer<typeof evidenceStageSchema>;

export interface EvidenceSourceDefinition {
  id: string;
  kind: 'numerical' | 'document' | 'access_gap';
  title: string;
  supported_inputs: string[];
  endpoint: string;
  documentation_url: string;
  geography: string;
  period: { start: string | null; end: string | null; resolution: string };
  units: string[];
  parser_version: string;
  access_requirements: string[];
  refresh_cadence_seconds: number;
  minimum_request_interval_ms: number;
  maximum_bytes: number;
  limitations: string[];
  discovery_queries: { en: string; ms: string };
}

export interface NormalizedEvidenceValue {
  input: string;
  value: number;
  unit: string;
  period: { start: string; end: string };
  geography: {
    level: 'country' | 'state' | 'district' | 'grid';
    name: string;
    boundary_version: string | null;
  };
  strata: Record<string, string>;
  currency: string | null;
  price_year: number | null;
  source_locator: string;
  transformation: {
    operation: 'identity' | 'multiply';
    factor: number;
    original_value: number;
    original_unit: string;
  };
}

export interface EvidenceCapture {
  schema_version: 'haze.damage.evidence.capture.v1';
  capture_id: string;
  source_id: string;
  request_key: string;
  request: AcquisitionRequest;
  source_url: string;
  parser_version: string;
  source_version: { etag: string | null; last_modified: string | null };
  retrieved_at: string;
  raw_ref: string;
  raw_sha256: string;
  raw_bytes: number;
  media_type: string;
  redirect_chain?: string[];
  document_published_at: string | null;
  observation_period: { start: string; end: string } | null;
  evidence_origin: 'external_source' | 'synthetic_fixture';
  stage: 'acquired' | 'validated';
  normalized_values: NormalizedEvidenceValue[];
  excerpt: { text: string; locator: string } | null;
  gaps: string[];
  omitted_gap_count?: number;
  limitations: string[];
}

export interface AcquisitionAttempt {
  schema_version: 'haze.damage.evidence.attempt.v1';
  id: string;
  source_id: string;
  request_key: string;
  started_at: string;
  finished_at: string;
  source_url: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  http_status: number | null;
  capture_id: string | null;
  unchanged: boolean;
  error: string | null;
}
