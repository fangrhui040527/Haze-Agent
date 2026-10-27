import { randomUUID } from 'node:crypto';
import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import {
  reductionSensitivityRequestSchema,
  reductionSensitivityReportSchema,
  type ReductionSensitivityReport,
  type ReductionSensitivityRequest,
} from '../../contracts/damage-reduction-sensitivity.js';
import { independentlyCheckReduction } from './checker.js';
import {
  createReductionSelection,
  normalizeReductionSelection,
} from './inputs.js';
import { assessReduction } from './methods.js';

/** These refs identify derived products embedded in this diagnostic, not API records. */
const diagnosticRef = (content: unknown): ArtifactRef => ({
  id: randomUUID(),
  version: 1,
  sha256: contractHash(content),
});

/** Preserve the supplied pairing; never combine marginal ranges or assign probabilities. */
export function analyzeReductionSensitivity(
  value: ReductionSensitivityRequest,
  artifacts: readonly Artifact[],
): ReductionSensitivityReport {
  const request = reductionSensitivityRequestSchema.parse(value);
  const requestHash = contractHash(request);
  const sources = new Set(
    request.pairs.flatMap(({ sources }) =>
      sources.map(({ artifact }) => artifact.id),
    ),
  );
  const selectedRows = request.pairs.reduce(
    (sum, pair) =>
      sum + pair.sources.reduce((n, source) => n + source.row_ids.length, 0),
    0,
  );
  if (sources.size > 16 || artifacts.length > 16 || selectedRows > 1000)
    throw new Error('sensitivity_bundle_limit_exceeded');

  let supportFingerprint: string | undefined;
  let totalNormalizedBytes = 0;
  const pairs = request.pairs.map((pair) => {
    const selection = createReductionSelection(request.target, pair.sources);
    const selectionRef = diagnosticRef(selection);
    const assessment = assessReduction(selection, artifacts, selectionRef);
    const assessmentRef = diagnosticRef(assessment);
    const review = independentlyCheckReduction(
      selection,
      artifacts,
      selectionRef,
      assessment,
      assessmentRef,
      { assignment_id: randomUUID(), revision: 1 },
    );
    const reasons = [...assessment.reasons];
    let compatible = false;
    try {
      const normalized = normalizeReductionSelection(selection, artifacts);
      totalNormalizedBytes += Buffer.byteLength(
        canonicalJson(normalized.records),
      );
      const fingerprint = canonicalJson(
        normalized.records
          .map((record) => ({
            role: record.role,
            stratum: record.stratum_id,
            support: [...record.support_ids].sort(),
            method: record.original_method,
            basis: record.evidence_basis,
          }))
          .sort(
            (a, b) =>
              a.role.localeCompare(b.role) ||
              a.stratum.localeCompare(b.stratum),
          ),
      );
      supportFingerprint ??= fingerprint;
      compatible = supportFingerprint === fingerprint;
      if (!compatible) reasons.push('paired_support_or_method_mismatch');
    } catch {
      // The assessment and independent review retain the original precise gap.
    }
    if (review.verdict !== 'supported')
      reasons.push('independent_review_rejected');
    return {
      id: pair.id,
      selection_ref: selectionRef,
      selection,
      assessment_ref: assessmentRef,
      assessment,
      review,
      comparison_compatible: compatible,
      reasons,
    };
  });
  if (totalNormalizedBytes > 1_048_576)
    throw new Error('sensitivity_normalized_byte_limit_exceeded');
  const complete = pairs.every(
    (pair) =>
      pair.comparison_compatible &&
      pair.assessment.status === 'supported' &&
      pair.review.verdict === 'supported',
  );
  const met = pairs.filter(
    ({ assessment }) => assessment.target_met === true,
  ).length;
  return reductionSensitivityReportSchema.parse({
    schema_version: 'haze.reduction.sensitivity-report.v1',
    method_id: 'reduction.supplied-pair-sensitivity.v1',
    request,
    request_sha256: requestHash,
    origin: pairs.some(({ assessment }) => assessment.origin === 'synthetic')
      ? 'synthetic'
      : pairs.some(({ assessment }) => assessment.origin === 'unknown')
        ? 'unknown'
        : 'supplied',
    pairs,
    conclusion: !complete
      ? 'incomplete'
      : met === pairs.length
        ? 'all_supplied_pairs_meet'
        : met
          ? 'some_supplied_pairs_meet'
          : 'no_supplied_pairs_meet',
    probability_of_target: null,
    scientific_qualification: 'unqualified',
    claim_eligibility: 'none',
    achieved_reduction: false,
    limitations: [
      'Describes only the supplied paired scenario set; its completeness, scientific plausibility and dependence assumptions require external review.',
      'No probability, confidence interval or scientifically robust target conclusion is estimated.',
      'Original snapshots and exact selected rows are checked; current API permissions, holds and applicability are not revalidated by this offline diagnostic.',
      'Derived refs and reconstruction IDs are local report identifiers, not application records or human/agent reviewer attestations; no application claim is enabled.',
    ],
  });
}
