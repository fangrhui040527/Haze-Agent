import type { Artifact } from '../../contracts/artifacts.js';
import {
  reductionAssessmentSchema,
  reductionInputSelectionSchema,
  type ReductionClaimEligibility,
} from '../../contracts/damage-reduction.js';
import { conditionalReductionPlanSchema } from '../../contracts/damage-reduction-plan.js';
import type { FinalRenderer } from '../../orchestration/ports.js';
import {
  finalAnswerFormat as format,
  roundedPercent,
} from '../../orchestration/final-answer.js';
import { readDamageReductionClaim } from './claims.js';
import {
  compareExactResiduals,
  parseExactDecimal,
} from './exact-comparison.js';

type ClaimReader = typeof readDamageReductionClaim;

/**
 * Current claim eligibility is re-derived through the existing claim checks;
 * the threshold is classified with exact integer arithmetic and only the
 * displayed percentage is rounded.
 */
export function createReductionFinalRenderer(
  readClaim: ClaimReader = readDamageReductionClaim,
): FinalRenderer {
  return {
    artifact_kinds: ['reduction.assessment', 'reduction.conditional-plan'],
    render({ task, artifacts, closure, reviews, services }) {
      const sections: ReturnType<FinalRenderer['render']>['sections'] = [];
      const limitations: string[] = [];
      const gaps: string[] = [];
      const find = (ref: { id: string; version: number; sha256: string }) =>
        closure.find(
          (item) =>
            item.id === ref.id &&
            item.version === ref.version &&
            item.sha256 === ref.sha256,
        ) ?? services.read(ref);
      for (const artifact of artifacts.filter(
        (item) => item.kind === 'reduction.assessment',
      )) {
        const assessment = reductionAssessmentSchema.parse(artifact.content);
        const selection = reductionInputSelectionSchema.parse(
          find(assessment.selection_ref).content,
        );
        const { target } = selection;
        const heading = `Reduction assessment: ${target.scope.endpoint} (${target.scope.geography})`;
        const scopeLine = `Scope: ${target.scope.endpoint} in ${target.scope.unit}; ${target.scope.population}; ${target.scope.geography}; ${target.scope.pollutant}; ${target.scope.period.start} to ${target.scope.period.end}. Comparator ${target.comparator}; intervention ${target.intervention}.`;
        const gap = (reason: string) => {
          gaps.push(reason);
          sections.push({ heading: `${heading}: gap`, lines: [scopeLine, reason] });
        };
        if (assessment.status !== 'supported') {
          gap(
            `The reduction assessment is ${assessment.status} (${assessment.reasons.join(', ') || 'no reason recorded'}); no reduction figure is reported.`,
          );
          limitations.push(...assessment.limitations);
          continue;
        }
        const review = format.review(reviews, artifact);
        let claim: ReductionClaimEligibility | undefined;
        if (review?.review_artifact)
          claim = readClaim(
            services.store,
            services.mode,
            {
              selection_ref: assessment.selection_ref,
              assessment_ref: {
                id: artifact.id,
                version: artifact.version,
                sha256: artifact.sha256,
              },
              review_ref: review.review_artifact,
            },
            {
              taskId: task.id,
              identity: task.identity,
              runId: task.current_run_id,
            },
          );
        if (!claim || claim.claim_eligibility === 'none') {
          gap(
            `Current claim eligibility is not established (${claim?.reasons.join(', ') || 'no supporting independent review'}); no reduction figure is reported.`,
          );
          continue;
        }
        const baseline = assessment.baseline_damage;
        const intervention = assessment.intervention_damage;
        const relative = assessment.relative_reduction;
        if (!baseline || !intervention || !relative) {
          gap('The supported assessment lacks a complete quantity set.');
          continue;
        }
        const exact = compareExactResiduals(
          parseExactDecimal(baseline),
          parseExactDecimal(intervention),
          target.target_fraction,
          target.relation,
        );
        if (
          exact.target_met === null ||
          exact.target_met !== assessment.target_met ||
          exact.absolute_reduction !== assessment.absolute_reduction
        ) {
          gap(
            'Exact re-classification disagrees with the reviewed assessment; no threshold conclusion is reported.',
          );
          continue;
        }
        const percent = roundedPercent(
          parseExactDecimal(relative.numerator),
          parseExactDecimal(relative.denominator),
        );
        const threshold = roundedPercent(
          parseExactDecimal(target.target_fraction),
          parseExactDecimal('1'),
        );
        sections.push({
          heading,
          lines: [
            scopeLine,
            `Baseline (${target.comparator}): ${baseline} ${target.scope.unit}.`,
            `Intervention (${target.intervention}): ${intervention} ${target.scope.unit}.`,
            `Avoided damage: ${assessment.absolute_reduction} ${target.scope.unit}.`,
            `Reduction: ${percent}% (${relative.numerator} / ${relative.denominator}; displayed rounded half-up to three decimal places).`,
            `Threshold: ${target.relation === 'at_least' ? 'at least' : 'greater than'} ${threshold}% — point estimate ${exact.target_met ? 'meets' : 'does not meet'} the target (classified with exact arithmetic, before rounding).`,
            `Claim eligibility: ${claim.claim_eligibility}; origin ${claim.origin}${claim.origin === 'synthetic' ? ' (synthetic, not a real-data result)' : ''}; scientific qualification ${claim.scientific_qualification}; no achieved reduction is claimed.`,
          ],
        });
        limitations.push(...assessment.limitations, ...review!.limitations);
      }
      for (const artifact of artifacts.filter(
        (item) => item.kind === 'reduction.conditional-plan',
      ))
        renderPlan(artifact, sections, limitations, gaps);
      return { sections, limitations, gaps };
    },
  };
}

function renderPlan(
  artifact: Artifact,
  sections: ReturnType<FinalRenderer['render']>['sections'],
  limitations: string[],
  gaps: string[],
) {
  const plan = conditionalReductionPlanSchema.parse(artifact.content);
  const { candidate } = plan;
  const heading = `Conditional plan: ${candidate.name}`;
  sections.push({
    heading: `${heading}${plan.state === 'conditional' ? '' : ': gap'}`,
    lines: [
      `Plan state ${plan.state}; assessment ${plan.assessment_status}; point estimate ${plan.point_estimate_label}; delivery ${plan.delivery_status}; no achieved reduction is claimed.`,
      ...(candidate.costs.length
        ? candidate.costs.map(
            (cost) =>
              `Cost ${cost.id}: ${cost.amount ?? 'unavailable'} ${cost.unit} — ${cost.description}${cost.prerequisite ? ` (prerequisite: ${cost.prerequisite})` : ''}`,
          )
        : ['Costs: none declared.']),
      ...(plan.prerequisites.length
        ? plan.prerequisites.map(
            (item) =>
              `Prerequisite ${item.id} (${item.reason}): ${item.description}`,
          )
        : ['Prerequisites: none outstanding.']),
      ...plan.objections
        .filter((item) => item.severity !== 'advisory')
        .map(
          (item) =>
            `Objection ${item.id} (${item.severity}): ${item.description}`,
        ),
    ],
  });
  if (plan.state !== 'conditional')
    gaps.push(
      `Conditional plan ${candidate.name} is ${plan.state}; ${plan.prerequisites.length} prerequisite(s) remain.`,
    );
  limitations.push(...plan.limitations);
}

export const reductionFinalRenderer = createReductionFinalRenderer();
