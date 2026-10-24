import { ContractError } from '../contracts/index.js';
import type { FindingCode, FindingDomain } from './findings.js';
import { FINDING_CODES, finding } from './findings.js';
import type { Finding } from './findings.js';

/**
 * Translate the frozen contract validator's output into coded findings.
 *
 * `validateContract` reports structural failures through Zod issue codes and
 * domain failures through refinement messages. Consumers must not match on
 * message text, so every known message is mapped to one code here and an
 * unrecognised message degrades to `invalid_contract_shape` rather than being
 * dropped.
 */
const SEMANTIC_RULES: readonly (readonly [
  RegExp,
  FindingCode,
  FindingDomain,
])[] = [
  [/offset/i, FINDING_CODES.timezone_offset_mismatch, 'operating_input'],
  [
    /whole-minute timestamps/i,
    FINDING_CODES.timezone_offset_mismatch,
    'operating_input',
  ],
  [/^Horizon must be/i, FINDING_CODES.invalid_horizon, 'operating_input'],
  [
    /^Duplicate ID or instant/i,
    FINDING_CODES.duplicate_identifier,
    'operating_input',
  ],
  [
    /^Unknown (activity|predecessor|resource|worker|location)/i,
    FINDING_CODES.unknown_reference,
    'operating_input',
  ],
  [
    /^Missing activity/i,
    FINDING_CODES.missing_required_field,
    'operating_input',
  ],
  [
    /attested absence basis/i,
    FINDING_CODES.attested_absence_basis_required,
    'operating_input',
  ],
  [
    /must exactly match declared bundle controls/i,
    FINDING_CODES.reference_mismatch,
    'operating_input',
  ],
  [
    /Duration must be positive whole planning steps/i,
    FINDING_CODES.duration_not_whole_steps,
    'operating_input',
  ],
  [
    /Release\/deadline must be aligned/i,
    FINDING_CODES.interval_out_of_horizon,
    'scheduling',
  ],
  [/Allowed start must align/i, FINDING_CODES.unaligned_start, 'scheduling'],
  [
    /Intervals must be positive, within the horizon/i,
    FINDING_CODES.interval_out_of_horizon,
    'scheduling',
  ],
  [/Intervals must not overlap/i, FINDING_CODES.interval_overlap, 'scheduling'],
  [
    /Baseline start is not allowed/i,
    FINDING_CODES.baseline_start_not_allowed,
    'scheduling',
  ],
  [
    /Fixed activities must declare/i,
    FINDING_CODES.fixed_activity_start_mismatch,
    'scheduling',
  ],
  [
    /Predecessor graph must be acyclic/i,
    FINDING_CODES.predecessor_cycle,
    'scheduling',
  ],
  [
    /finish-to-start precedence/i,
    FINDING_CODES.precedence_violation,
    'scheduling',
  ],
  [
    /(occupancy gap or overlap|occupy the complete common horizon)/i,
    FINDING_CODES.occupancy_gap_or_overlap,
    'scheduling',
  ],
  [
    /exceeds worker availability/i,
    FINDING_CODES.worker_unavailable,
    'scheduling',
  ],
  [/Worker is ineligible/i, FINDING_CODES.worker_ineligible, 'scheduling'],
  [
    /resource demand exceeds interval capacity/i,
    FINDING_CODES.resource_overload,
    'scheduling',
  ],
  [
    /Environmental source interval must be within valid_interval/i,
    FINDING_CODES.environmental_interval_overlap,
    'environmental',
  ],
  [
    /(Environmental|Located source) intervals must not overlap/i,
    FINDING_CODES.environmental_interval_overlap,
    'environmental',
  ],
  [
    /Interval end must be later than its start/i,
    FINDING_CODES.environmental_interval_reversed,
    'environmental',
  ],
  [
    /Evidence timestamps must use UTC/i,
    FINDING_CODES.timezone_offset_mismatch,
    'environmental',
  ],
  [
    /(Missing values require an explicit null reason|Observed values cannot have a null reason)/i,
    FINDING_CODES.environmental_null_interval,
    'environmental',
  ],
];

interface ContractIssue {
  path?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Structural failures inside an environmental record carry their own codes so
 * a bad concentration or unit is not reported as a generic shape error.
 */
function classifyEnvironmentalField(
  message: string,
  issueCode: string,
  path: readonly (string | number)[],
): readonly [FindingCode, FindingDomain] | null {
  const field = path.at(-1);
  if (field === 'value') {
    if (issueCode === 'too_small') {
      return [FINDING_CODES.environmental_negative_value, 'environmental'];
    }
    if (issueCode === 'not_finite' || /finite/i.test(message)) {
      return [FINDING_CODES.environmental_nonfinite_value, 'environmental'];
    }
  }
  if (field === 'unit') {
    return [FINDING_CODES.environmental_invalid_unit, 'environmental'];
  }
  return null;
}

function classify(
  message: string,
  issueCode: string,
  fallbackDomain: FindingDomain,
  path: readonly (string | number)[],
): readonly [FindingCode, FindingDomain] {
  if (issueCode === 'unrecognized_keys') {
    return [FINDING_CODES.unknown_property, 'contract'];
  }
  if (issueCode === 'invalid_type' && /received undefined/i.test(message)) {
    return [FINDING_CODES.missing_required_field, 'contract'];
  }
  if (fallbackDomain === 'environmental') {
    const environmental = classifyEnvironmentalField(message, issueCode, path);
    if (environmental) return environmental;
  }
  if (issueCode !== 'custom') {
    return [FINDING_CODES.invalid_contract_shape, 'contract'];
  }
  for (const [pattern, code, domain] of SEMANTIC_RULES) {
    if (pattern.test(message)) return [code, domain];
  }
  return [FINDING_CODES.invalid_contract_shape, fallbackDomain];
}

/** IDs of the records enclosing `path`, nearest last. Root IDs are skipped. */
export function enclosingIds(
  document: unknown,
  path: readonly (string | number)[],
): string[] {
  const ids: string[] = [];
  let node: unknown = document;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') break;
    node = (node as Record<string | number, unknown>)[segment];
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.endsWith('_id') && typeof value === 'string') ids.push(value);
    }
  }
  return [...new Set(ids)];
}

function trailingId(message: string): string[] {
  const match = /:\s*([A-Za-z0-9][A-Za-z0-9._:/-]*)$/.exec(message);
  return match?.[1] ? [match[1]] : [];
}

/**
 * Coded findings for one thrown contract failure. Structural and domain
 * failures are both reported; neither grants acceptance or applicability.
 */
export function contractFindings(input: {
  error: unknown;
  document: string;
  value?: unknown;
  domain?: FindingDomain;
}): Finding[] {
  const fallbackDomain = input.domain ?? 'contract';
  const { error } = input;
  if (!(error instanceof ContractError)) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      finding({
        code: FINDING_CODES.malformed_json,
        domain: 'contract',
        severity: 'blocking',
        document: input.document,
        message: `Document could not be read as canonical JSON: ${message}. Correct the bytes; no value is coerced or defaulted.`,
      }),
    ];
  }
  if (error.code === 'unsupported_contract_version') {
    const supported = (error.details as { supported_versions?: unknown })
      ?.supported_versions;
    return [
      finding({
        code: FINDING_CODES.unsupported_contract_version,
        domain: 'contract',
        severity: 'blocking',
        document: input.document,
        path: ['schema_version'],
        message: `Unsupported contract version. Supported: ${JSON.stringify(supported)}. Migrate the document explicitly; v1 payloads are not reinterpreted as v2.`,
      }),
    ];
  }
  if (error.code === 'demo_reference_requires_historical_harness') {
    const path = (error.details as { path?: unknown })?.path;
    return [
      finding({
        code: FINDING_CODES.demo_reference_requires_historical_harness,
        domain: 'operating_input',
        severity: 'blocking',
        document: input.document,
        path: Array.isArray(path) ? (path as (string | number)[]) : [],
        message:
          'A demo-local reference is not a canonical bundle reference. Submit it through the explicitly labelled historical harness surface.',
      }),
    ];
  }
  const issues = Array.isArray(error.details)
    ? (error.details as ContractIssue[])
    : [];
  if (issues.length === 0) {
    return [
      finding({
        code: FINDING_CODES.invalid_contract_shape,
        domain: fallbackDomain,
        severity: 'blocking',
        document: input.document,
        message: `Contract validation failed with code ${error.code}.`,
      }),
    ];
  }
  return issues.map((issue) => {
    const path = Array.isArray(issue.path)
      ? (issue.path as (string | number)[])
      : [];
    const message = typeof issue.message === 'string' ? issue.message : '';
    const issueCode = typeof issue.code === 'string' ? issue.code : '';
    const [code, domain] = classify(message, issueCode, fallbackDomain, path);
    return finding({
      code,
      domain,
      severity: 'blocking',
      document: input.document,
      path,
      affected_ids: [
        ...new Set([
          ...enclosingIds(input.value, path),
          ...trailingId(message),
        ]),
      ],
      message: `${message}. Correct the named field in the source fixture; the validator applies no correction.`,
    });
  });
}
