/**
 * Machine-readable validation findings.
 *
 * Architecture v0.13 §15.2 separates malformed input (400), invalid operating
 * semantics (422) and a completed environmental insufficiency, which is a
 * domain outcome rather than a server fault. Findings therefore carry an
 * explicit domain and severity, a JSON Pointer into the offending document and
 * the affected record IDs, so an owner can correct the sample. Nothing here
 * applies a correction.
 */

/** Which boundary owns the finding. */
export type FindingDomain =
  'contract' | 'operating_input' | 'scheduling' | 'environmental';

/**
 * `blocking` prevents a valid admitted bundle or a quantified comparison.
 * `scoped_exclusion` removes only the affected alternatives.
 * `advisory` records a represented fact that blocks nothing by itself.
 */
export type FindingSeverity = 'blocking' | 'scoped_exclusion' | 'advisory';

export interface Finding {
  code: string;
  domain: FindingDomain;
  severity: FindingSeverity;
  /** RFC 6901 pointer into the document named by `document`. */
  pointer: string;
  document: string;
  path: (string | number)[];
  affected_ids: string[];
  message: string;
}

/**
 * Closed code vocabulary. Consumers switch on these, never on message text.
 */
export const FINDING_CODES = {
  malformed_json: 'malformed_json',
  unsupported_contract_version: 'unsupported_contract_version',
  invalid_contract_shape: 'invalid_contract_shape',
  missing_required_field: 'missing_required_field',
  unknown_property: 'unknown_property',
  duplicate_identifier: 'duplicate_identifier',
  unknown_reference: 'unknown_reference',
  reference_mismatch: 'reference_mismatch',
  timezone_offset_mismatch: 'timezone_offset_mismatch',
  invalid_horizon: 'invalid_horizon',
  duration_not_whole_steps: 'duration_not_whole_steps',
  unaligned_start: 'unaligned_start',
  interval_out_of_horizon: 'interval_out_of_horizon',
  interval_overlap: 'interval_overlap',
  precedence_violation: 'precedence_violation',
  predecessor_cycle: 'predecessor_cycle',
  occupancy_gap_or_overlap: 'occupancy_gap_or_overlap',
  worker_ineligible: 'worker_ineligible',
  worker_unavailable: 'worker_unavailable',
  resource_overload: 'resource_overload',
  baseline_start_not_allowed: 'baseline_start_not_allowed',
  fixed_activity_start_mismatch: 'fixed_activity_start_mismatch',
  attested_absence_basis_required: 'attested_absence_basis_required',
  demo_reference_requires_historical_harness:
    'demo_reference_requires_historical_harness',
  environmental_envelope_invalid: 'environmental_envelope_invalid',
  environmental_record_invalid: 'environmental_record_invalid',
  environmental_interval_overlap: 'environmental_interval_overlap',
  environmental_interval_reversed: 'environmental_interval_reversed',
  environmental_null_interval: 'environmental_null_interval',
  environmental_negative_value: 'environmental_negative_value',
  environmental_nonfinite_value: 'environmental_nonfinite_value',
  environmental_invalid_unit: 'environmental_invalid_unit',
  environmental_unsupported_conversion: 'environmental_unsupported_conversion',
  environmental_unexpected_pollutant: 'environmental_unexpected_pollutant',
  environmental_duplicate_series: 'environmental_duplicate_series',
  environmental_series_binding_mismatch:
    'environmental_series_binding_mismatch',
  environmental_scenario_missing: 'environmental_scenario_missing',
  environmental_coverage_gap: 'environmental_coverage_gap',
  environmental_baseline_coverage_missing:
    'environmental_baseline_coverage_missing',
  environmental_location_unresolved: 'environmental_location_unresolved',
  stale_artifact_reference: 'stale_artifact_reference',
  raw_bytes_mismatch: 'raw_bytes_mismatch',
  duplicate_artifact_identity: 'duplicate_artifact_identity',
  timezone_envelope_mismatch: 'timezone_envelope_mismatch',
  canonical_capability_unavailable: 'canonical_capability_unavailable',
  locator_selection_mismatch: 'locator_selection_mismatch',
  locator_row_unresolved: 'locator_row_unresolved',
  source_row_malformed: 'source_row_malformed',
  series_value_source_mismatch: 'series_value_source_mismatch',
  series_interval_source_mismatch: 'series_interval_source_mismatch',
} as const;

export type FindingCode = (typeof FINDING_CODES)[keyof typeof FINDING_CODES];

/** RFC 6901 pointer for a contract path. */
export function pointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return '';
  const escape = (segment: string | number) =>
    String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
  return `/${path.map(escape).join('/')}`;
}

export function finding(input: {
  code: FindingCode;
  domain: FindingDomain;
  severity: FindingSeverity;
  document: string;
  path?: readonly (string | number)[];
  affected_ids?: readonly string[];
  message: string;
}): Finding {
  const path = [...(input.path ?? [])];
  return {
    code: input.code,
    domain: input.domain,
    severity: input.severity,
    pointer: pointer(path),
    document: input.document,
    path,
    affected_ids: [...(input.affected_ids ?? [])],
    message: input.message,
  };
}

export function hasBlocking(findings: readonly Finding[]): boolean {
  return findings.some((entry) => entry.severity === 'blocking');
}
