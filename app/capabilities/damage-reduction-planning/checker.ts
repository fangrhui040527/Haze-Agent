import { z } from 'zod';
import {
  physicalResidualRecordSchema,
  reductionAssessmentSchema,
  reductionInputSelectionSchema,
  reductionReviewSchema,
  type PhysicalResidualRecord,
  type ReductionAssessment,
  type ReductionInputSelection,
  type ReductionReview,
} from '../../contracts/damage-reduction.js';
import {
  artifactRefSchema,
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import { identifierSchema } from '../../contracts/common.js';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../../contracts/json.js';

// Deliberately independent of the import adapter and producer arithmetic. A fixed
// 12-place integer scale is sufficient for every accepted original source token.
const SCALE = 1_000_000_000_000n;
const originalEnvelope = z.strictObject({
  schema_version: z.literal('haze.reduction.physical-import.v1'),
  origin: z.enum(['synthetic', 'supplied']),
  records: z
    .array(z.object({ row_id: identifierSchema }).passthrough())
    .min(1)
    .max(1000),
});
const bounded = (value: bigint): bigint => {
  if (value.toString().replace('-', '').length > 128)
    throw new Error('Independent reconstruction exceeds 128 decimal digits.');
  return value;
};
function originalDecimal(token: string): bigint {
  if (!/^(?:0|-?(?:[1-9]\d*|0\.\d*[1-9]|[1-9]\d*\.\d*[1-9]))$/.test(token))
    throw new Error('Original quantity is not a canonical decimal token.');
  const negative = token.startsWith('-');
  const unsigned = negative ? token.slice(1) : token;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (
    fraction.length > 12 ||
    unsigned.replace('.', '').replace(/^0+/, '').length > 18
  )
    throw new Error('Original decimal precision exceeds the method bounds.');
  const value = BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
  return bounded(negative ? -value : value);
}
function exactDecimal(value: bigint): string {
  bounded(value);
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % SCALE)
    .toString()
    .padStart(12, '0')
    .replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${magnitude / SCALE}${fraction ? `.${fraction}` : ''}`;
}
const same = (left: unknown, right: unknown) =>
  canonicalJson(left) === canonicalJson(right);
const refKey = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;

class ReconstructionFailure extends Error {
  constructor(
    readonly status: 'gap' | 'incompatible',
    message: string,
  ) {
    super(message);
  }
}

interface Reconstructed {
  status: ReductionAssessment['status'];
  reasons: string[];
  origin: ReductionAssessment['origin'];
  baseline_damage: string | null;
  intervention_damage: string | null;
  absolute_reduction: string | null;
  relative_reduction: ReductionAssessment['relative_reduction'];
  target_met: boolean | null;
}

/** Read only explicitly selected ORIGINAL rows, independently checking support. */
function reconstruct(
  selection: ReductionInputSelection,
  artifacts: readonly Artifact[],
): Reconstructed {
  const result: Reconstructed = {
    status: 'gap',
    reasons: [],
    origin: 'unknown',
    baseline_damage: null,
    intervention_damage: null,
    absolute_reduction: null,
    relative_reduction: null,
    target_met: null,
  };
  if (contractHash(selection.target.scope) !== selection.scope_sha256)
    throw new ReconstructionFailure('gap', 'scope_hash_mismatch');
  if (
    selection.sources.reduce((sum, source) => sum + source.row_ids.length, 0) >
    1000
  )
    throw new ReconstructionFailure('gap', 'selected_row_limit_exceeded');
  const sourceIds = new Set<string>();
  const rows: PhysicalResidualRecord[] = [];
  let synthetic = false;
  const normalizedRecords: unknown[] = [];
  for (const source of selection.sources) {
    if (sourceIds.has(source.artifact.id))
      throw new ReconstructionFailure(
        'incompatible',
        'duplicate_or_conflicting_source_selection',
      );
    sourceIds.add(source.artifact.id);
    const matches = artifacts.filter(
      (artifact) => refKey(artifact) === refKey(source.artifact),
    );
    if (matches.length !== 1)
      throw new ReconstructionFailure(
        'gap',
        'missing_or_ambiguous_exact_original',
      );
    if (
      artifacts.some(
        (artifact) =>
          artifact.id === source.artifact.id &&
          refKey(artifact) !== refKey(source.artifact),
      )
    )
      throw new ReconstructionFailure(
        'incompatible',
        'conflicting_source_versions',
      );
    const artifact = artifactSchema.safeParse(matches[0]);
    if (!artifact.success)
      throw new ReconstructionFailure('gap', 'invalid_original_artifact');
    if (contractHash(artifact.data.content) !== source.artifact.sha256)
      throw new ReconstructionFailure('gap', 'source_hash_mismatch');
    const original = artifact.data;
    if (
      original.producer.kind === 'assignment' ||
      original.evidence_origin === 'derived'
    )
      throw new ReconstructionFailure(
        'gap',
        'original_physical_decimal_import_required',
      );
    let content: unknown;
    try {
      content =
        typeof original.content === 'string'
          ? parseContractJson(original.content)
          : original.content;
    } catch {
      throw new ReconstructionFailure('gap', 'invalid_source_json');
    }
    const imported = originalEnvelope.safeParse(content);
    if (!imported.success)
      throw new ReconstructionFailure(
        'gap',
        'physical_decimal_import_or_precision_required',
      );
    if (
      original.evidence_origin === 'synthetic_fixture' &&
      imported.data.origin !== 'synthetic'
    )
      throw new ReconstructionFailure(
        'incompatible',
        'synthetic_origin_conflict',
      );
    synthetic ||= imported.data.origin === 'synthetic';
    if (
      new Set(imported.data.records.map((row) => row.row_id)).size !==
      imported.data.records.length
    )
      throw new ReconstructionFailure(
        'incompatible',
        'duplicate_or_conflicting_source_rows',
      );
    if (new Set(source.row_ids).size !== source.row_ids.length)
      throw new ReconstructionFailure('incompatible', 'duplicate_selected_row');
    for (const rowId of source.row_ids) {
      const originalRow = imported.data.records.find(
        (record) => record.row_id === rowId,
      );
      if (!originalRow)
        throw new ReconstructionFailure('gap', 'selected_row_missing');
      const selectedRow = physicalResidualRecordSchema.safeParse(originalRow);
      if (!selectedRow.success)
        throw new ReconstructionFailure(
          'gap',
          'physical_decimal_import_or_precision_required',
        );
      const row = selectedRow.data;
      normalizedRecords.push({
        ...row,
        source_ref: {
          id: original.id,
          version: original.version,
          sha256: original.sha256,
        },
        origin: imported.data.origin,
      });
      rows.push(row);
    }
  }
  if (rows.length > 1000)
    throw new ReconstructionFailure('gap', 'selected_row_limit_exceeded');
  try {
    canonicalJson(normalizedRecords, 524_288);
  } catch {
    throw new ReconstructionFailure(
      'gap',
      'normalized_input_byte_limit_exceeded',
    );
  }
  result.origin = synthetic ? 'synthetic' : 'supplied';
  const support = {
    baseline: new Set<string>(),
    intervention: new Set<string>(),
  };
  const strata = {
    baseline: new Map<string, string[]>(),
    intervention: new Map<string, string[]>(),
  };
  const first = rows[0];
  for (const row of rows) {
    if (
      row.scenario !==
      (row.role === 'baseline'
        ? selection.target.comparator
        : selection.target.intervention)
    )
      throw new ReconstructionFailure('incompatible', 'incompatible_scenario');
    if (/^damage\./.test(row.original_method.id))
      throw new ReconstructionFailure(
        'gap',
        'legacy_accounting_precision_laundering',
      );
    if (!same(row.scope, selection.target.scope))
      throw new ReconstructionFailure('incompatible', 'incompatible_scope');
    if (first && !same(row.original_method, first.original_method))
      throw new ReconstructionFailure(
        'incompatible',
        'incompatible_source_method',
      );
    if (first && row.evidence_basis !== first.evidence_basis)
      throw new ReconstructionFailure(
        'incompatible',
        'incompatible_evidence_basis',
      );
    if (strata[row.role].has(row.stratum_id))
      throw new ReconstructionFailure('incompatible', 'overlapping_strata');
    strata[row.role].set(row.stratum_id, [...row.support_ids].sort());
    for (const atom of row.support_ids) {
      if (support[row.role].has(atom))
        throw new ReconstructionFailure('incompatible', 'overlapping_support');
      support[row.role].add(atom);
    }
  }
  if (!strata.baseline.size || !strata.intervention.size)
    throw new ReconstructionFailure(
      'gap',
      'baseline_and_intervention_required',
    );
  if (!same([...strata.baseline].sort(), [...strata.intervention].sort()))
    throw new ReconstructionFailure(
      'incompatible',
      'unmatched_comparison_support',
    );
  if (rows.some((row) => row.quantity === null)) {
    result.reasons = ['unknown_residual_quantity'];
    return result;
  }
  let baseline = 0n;
  let intervention = 0n;
  for (const row of rows) {
    const quantity = originalDecimal(row.quantity!);
    if (row.role === 'baseline') baseline = bounded(baseline + quantity);
    else intervention = bounded(intervention + quantity);
  }
  const difference = bounded(baseline - intervention);
  result.baseline_damage = exactDecimal(baseline);
  result.intervention_damage = exactDecimal(intervention);
  result.absolute_reduction = exactDecimal(difference);
  if (baseline <= 0n) {
    result.reasons = ['positive_baseline_required'];
    return result;
  }
  if (intervention < 0n) {
    result.reasons = ['nonnegative_intervention_required'];
    return result;
  }
  if (rows.some((row) => row.quantity?.startsWith('-'))) {
    result.reasons = ['nonnegative_residuals_required'];
    return result;
  }
  const threshold = originalDecimal(selection.target.target_fraction);
  const left = bounded(difference * SCALE);
  const right = bounded(threshold * baseline);
  result.status = 'supported';
  result.relative_reduction = {
    numerator: exactDecimal(difference),
    denominator: exactDecimal(baseline),
  };
  result.target_met =
    selection.target.relation === 'greater_than' ? left > right : left >= right;
  return result;
}

/** No producer arithmetic/import functions are called, including on honest gaps. */
export function independentlyCheckReduction(
  selection: ReductionInputSelection,
  artifacts: readonly Artifact[],
  selectionRef: ArtifactRef,
  assessment: ReductionAssessment,
  assessmentRef: ArtifactRef,
  reviewer: ReductionReview['reviewer'],
  producerAssignmentId?: string,
): ReductionReview {
  const findings: string[] = [];
  const checks: ReductionReview['checks'] = [];
  const check = (code: string, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    if (!passed) findings.push(detail);
  };
  check(
    'independent_reviewer',
    reviewer.assignment_id !== producerAssignmentId,
    'Reviewer must differ from the assessment producer.',
  );
  const selected = reductionInputSelectionSchema.safeParse(selection);
  const proposed = reductionAssessmentSchema.safeParse(assessment);
  const selectedRef = artifactRefSchema.safeParse(selectionRef);
  const proposedRef = artifactRefSchema.safeParse(assessmentRef);
  check(
    'selection_contract',
    selected.success,
    'Selection must satisfy the bounded physical residual contract.',
  );
  check(
    'assessment_contract',
    proposed.success,
    'Assessment must satisfy the bounded unqualified prediction contract.',
  );
  check(
    'selection_hash',
    selectedRef.success && contractHash(selection) === selectionRef.sha256,
    'Selection reference must bind the exact saved selection.',
  );
  check(
    'assessment_hash',
    proposedRef.success && contractHash(assessment) === assessmentRef.sha256,
    'Assessment reference must bind the exact saved output.',
  );
  if (selected.success && proposed.success) {
    check(
      'selection_link',
      same(proposed.data.selection_ref, selectionRef),
      'Assessment must refer to the reviewed input selection.',
    );
    let expected: Reconstructed;
    let reconstructionError: string | undefined;
    try {
      expected = reconstruct(selected.data, artifacts);
    } catch (error) {
      expected = {
        status: error instanceof ReconstructionFailure ? error.status : 'gap',
        reasons: [
          error instanceof ReconstructionFailure
            ? error.message
            : 'invalid_or_unbounded_input',
        ],
        origin: 'unknown',
        baseline_damage: null,
        intervention_damage: null,
        absolute_reduction: null,
        relative_reduction: null,
        target_met: null,
      };
      reconstructionError =
        error instanceof Error ? error.message : 'Invalid original input.';
    }
    check(
      'independent_status',
      proposed.data.status === expected.status,
      `Independent original-input reconstruction requires ${expected.status}${reconstructionError ? `: ${reconstructionError}` : '.'}`,
    );
    for (const field of [
      'origin',
      'baseline_damage',
      'intervention_damage',
      'absolute_reduction',
      'relative_reduction',
      'target_met',
    ] as const)
      check(
        `exact_${field}`,
        same(proposed.data[field], expected[field]),
        `${field} must match independently reconstructed exact original inputs.`,
      );
    check(
      'explicit_gaps',
      same(proposed.data.reasons, expected.reasons),
      'Unavailable or incompatible assessment must retain a precise reason.',
    );
    check(
      'prediction_only',
      proposed.data.scientific_qualification === 'unqualified' &&
        proposed.data.limitations.length > 0,
      'Arithmetic does not establish scientific applicability or achieved reduction.',
    );
  }
  return reductionReviewSchema.parse({
    schema_version: 'haze.reduction.review.v1',
    verdict: findings.length ? 'rejected' : 'supported',
    claim_eligibility:
      findings.length || !proposed.success
        ? 'none'
        : proposed.data.status === 'supported'
          ? 'arithmetic_checked_scenario'
          : proposed.data.origin === 'unknown'
            ? 'none'
            : 'imported_estimate',
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
    reviewed_artifacts: [selectionRef, assessmentRef],
    reviewer,
    checks,
    findings,
    limitations: [
      'Independent reconstruction checks original decimal inputs, declared support and numerical comparison only.',
      'Scientific qualification is unqualified; no achieved reduction, delivery or causal effectiveness is established.',
    ],
  });
}
