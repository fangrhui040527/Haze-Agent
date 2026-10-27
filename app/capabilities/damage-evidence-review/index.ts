import { z } from 'zod';
import { canonicalJson } from '../../contracts/json.js';
import { artifactRefSchema } from '../../contracts/artifacts.js';
import {
  damageComparisonRequestSchema,
  damageComparisonSchema,
  damageMethodInvocationSchema,
  damageMethodOutputSchema,
  damageScientificCheckSchema,
  damageComparisonReviewSchema,
} from '../../contracts/damage-evidence-review.js';
import type {
  AssignmentDefinition,
  ExecutionMode,
  ToolDefinition,
} from '../../orchestration/ports.js';
import { compareDamageInterventions } from './comparison.js';
import {
  checkScientificReview,
  exactEvidenceRef,
  importPublishedPhysicalEffect,
  retainedArtifact,
  sameEvidenceRef,
} from './science.js';

export {
  assertScientificInputBindings,
  checkScientificReview,
  importPublishedPhysicalEffect,
} from './science.js';
export { compareDamageInterventions } from './comparison.js';

const scienceSelection = z.strictObject({
  output: artifactRefSchema,
  review: artifactRefSchema,
});
const comparisonSelection = z.strictObject({ request: artifactRefSchema });
const checkSelection = comparisonSelection.extend({
  comparison: artifactRefSchema,
});

export function createDamageEvidenceReviewTools(options: {
  mode: ExecutionMode;
}): ToolDefinition[] {
  return [
    {
      id: 'damage.method.import',
      version: '1',
      mode: options.mode,
      description:
        'Import a published physical effect from exact retained source inputs using a versioned method; does not grant scientific qualification.',
      inputSchema: damageMethodInvocationSchema,
      outputSchema: damageMethodOutputSchema,
      output_artifact_kind: 'damage.method-output',
      execute: (input, context) =>
        Promise.resolve(importPublishedPhysicalEffect(input, context.inputs)),
    },
    {
      id: 'damage.science.check',
      version: '1',
      mode: options.mode,
      description:
        'Check a separately imported expert scientific decision against exact retained method output, inputs, applicability and expiry. Automated arithmetic cannot replace expert review.',
      inputSchema: scienceSelection,
      outputSchema: damageScientificCheckSchema,
      output_artifact_kind: 'damage.scientific-check',
      execute: (input, context) => {
        const selection = scienceSelection.parse(input);
        return Promise.resolve(
          damageScientificCheckSchema.parse({
            ...checkScientificReview({
              output: retainedArtifact(selection.output, context.inputs),
              review: retainedArtifact(selection.review, context.inputs),
              artifacts: context.inputs,
            }),
            reviewer: {
              assignment_id: context.assignmentId,
              revision: context.assignmentRevision,
            },
          }),
        );
      },
    },
    {
      id: 'damage.interventions.compare',
      version: '1',
      mode: options.mode,
      description:
        'Evaluate A and lower-budget B against one exact reviewed historical baseline, retaining unsupported parameters as gaps and clearly labelling assumptions.',
      inputSchema: comparisonSelection,
      outputSchema: damageComparisonSchema,
      output_artifact_kind: 'damage.comparison',
      execute: (input, context) => {
        const selection = comparisonSelection.parse(input);
        const request = retainedArtifact(selection.request, context.inputs);
        return Promise.resolve(
          compareDamageInterventions(request.content, context.inputs),
        );
      },
    },
    {
      id: 'damage.interventions.check',
      version: '1',
      mode: options.mode,
      description:
        'Independently reconstruct residual, avoided damage, percentage and net benefit from the retained comparison request; never copy producer arithmetic.',
      inputSchema: checkSelection,
      outputSchema: damageComparisonReviewSchema,
      output_artifact_kind: 'damage.comparison-review',
      execute: (input, context) => {
        const selection = checkSelection.parse(input);
        const request = damageComparisonRequestSchema.parse(
          retainedArtifact(selection.request, context.inputs).content,
        );
        const comparison = damageComparisonSchema.parse(
          retainedArtifact(selection.comparison, context.inputs).content,
        );
        const findings: string[] = [];
        // Re-run provenance/applicability gates; numerical agreement cannot bypass them.
        const trusted = compareDamageInterventions(request, context.inputs);
        if (
          canonicalJson(trusted.baseline) !==
            canonicalJson(comparison.baseline) ||
          trusted.lower_budget_verified !== comparison.lower_budget_verified ||
          canonicalJson(trusted.gaps) !== canonicalJson(comparison.gaps)
        )
          findings.push(
            'Baseline evidence, cost qualification or applicability gates disagree.',
          );
        if (
          !sameEvidenceRef(
            request.baseline.account,
            comparison.baseline.account,
          )
        )
          findings.push('Comparison changed the baseline reference.');
        for (const [index, intervention] of request.interventions.entries()) {
          const result = comparison.interventions[index]!;
          const gated = trusted.interventions[index]!;
          if (
            gated.status !== result.status ||
            canonicalJson(gated.gaps) !== canonicalJson(result.gaps) ||
            canonicalJson(gated.assumptions) !==
              canonicalJson(result.assumptions) ||
            canonicalJson(gated.evidence) !== canonicalJson(result.evidence) ||
            canonicalJson(gated.cost_basis) !==
              canonicalJson(result.cost_basis) ||
            gated.intervention_cost !== result.intervention_cost ||
            (gated.net_monetary_benefit === null) !==
              (result.net_monetary_benefit === null)
          )
            findings.push(
              'Material parameter provenance, missingness or assumptions disagree.',
            );
          if (
            result.id !== intervention.id ||
            !sameEvidenceRef(result.baseline, request.baseline.account)
          )
            findings.push('Intervention baseline or identity differs.');
          if (result.residual_damage === null) {
            if (
              result.status !== 'insufficient_evidence' ||
              result.avoided_damage !== null ||
              result.reduction_percent !== null
            )
              findings.push('Withheld outcomes must retain missingness.');
            continue;
          }
          const original = request.baseline.quantity;
          const adoption = intervention.adoption.value;
          const effectiveness = intervention.effectiveness.value;
          if (
            original === null ||
            original <= 0 ||
            adoption === null ||
            effectiveness === null
          ) {
            findings.push(
              'Producer calculated from a missing or zero denominator.',
            );
            continue;
          }
          // Independent arrangement: calculate avoided outcomes first, then residual.
          const avoided = original * adoption * effectiveness;
          const percentage = 100 * adoption * effectiveness;
          const near = (a: number | null, b: number) =>
            a !== null && Math.abs(a - b) <= Math.max(1, Math.abs(b)) * 1e-10;
          if (
            !near(result.avoided_damage, avoided) ||
            !near(result.residual_damage, original - avoided) ||
            !near(result.reduction_percent, percentage)
          )
            findings.push(
              'Independent residual or percentage reconstruction disagrees.',
            );
          if (
            result.status !==
            (percentage + 1e-12 >= 10 ? 'meets_target' : 'below_target')
          )
            findings.push(
              'Target classification disagrees with the requested 10% outcome.',
            );
          if (result.net_monetary_benefit !== null) {
            const cost = intervention.cost.value;
            if (
              cost === null ||
              !near(result.net_monetary_benefit, avoided - cost)
            )
              findings.push('Independent monetary net benefit disagrees.');
          }
        }
        const [a, b] = request.interventions;
        if (
          comparison.lower_budget_verified &&
          (a.cost.value === null ||
            b.cost.value === null ||
            b.cost.value >= a.cost.value ||
            a.cost.basis !== 'evidence' ||
            b.cost.basis !== 'evidence')
        )
          findings.push('Lower-budget claim is unsupported.');
        return Promise.resolve(
          damageComparisonReviewSchema.parse({
            schema_version: 'haze.damage.comparison-review.v1',
            valid: findings.length === 0,
            findings,
            reviewed_artifacts: [selection.request, selection.comparison],
            applicability: 'arithmetic_only_scientific_review_is_separate',
            reviewer: {
              assignment_id: context.assignmentId,
              revision: context.assignmentRevision,
            },
          }),
        );
      },
    },
  ];
}

export function createDamageEvidenceReviewAssignments(): AssignmentDefinition[] {
  return [
    {
      id: 'damage.method.import',
      agent: 'DamageAccountant',
      tool: 'damage.method.import',
      kind: 'damage.method-output',
      instructions:
        'Use exact retained published-effect and original-source references. Keep the reported study scope and uncertainty; never extrapolate exposure or health impacts.',
    },
    {
      id: 'damage.science.review',
      agent: 'EvidenceCritic',
      tool: 'damage.science.check',
      kind: 'damage.scientific-check',
      instructions:
        'Validate the exact separately imported expert decision. Missing, stale, rejected or unresolved scientific review cannot be called scientifically supported. Never invent an expert.',
    },
    {
      id: 'damage.interventions.compare',
      agent: 'WorkerShield',
      tool: 'damage.interventions.compare',
      kind: 'damage.comparison',
      instructions:
        'Assemble mechanism, implementation scope, prerequisites, adoption, effectiveness and costs from retained evidence or labelled assumptions. Evaluate A and B against the same pinned historical baseline using the registered method. Costs and effectiveness are independent; disclose missingness and hypothetical results.',
    },
    {
      id: 'damage.interventions.check',
      agent: 'EvidenceCritic',
      tool: 'damage.interventions.check',
      kind: 'damage.comparison-review',
      instructions:
        'Independently check A/B outcome arithmetic and pinned baseline, retaining below-target and insufficient-evidence results. This arithmetic review does not provide expert scientific approval.',
    },
  ].map((definition) => ({
    id: definition.id,
    version: '1',
    capability: 'damage-evidence-research',
    agent: definition.agent as AssignmentDefinition['agent'],
    tools: [definition.tool],
    instructions: definition.instructions,
    execute: async (services) => {
      const value = await services.tool(definition.tool, services.input);
      const artifact = services.save(definition.kind, value, {
        evidence_origin: 'derived',
      });
      const parsed = damageScientificCheckSchema.safeParse(value);
      const comparison = damageComparisonSchema.safeParse(value);
      const independent = z
        .object({ valid: z.boolean(), findings: z.array(z.string()) })
        .safeParse(value);
      const gaps = parsed.success
        ? parsed.data.reasons
        : comparison.success
          ? [
              ...new Set([
                ...comparison.data.gaps,
                ...comparison.data.interventions.flatMap((i) => i.gaps),
              ]),
            ]
          : independent.success
            ? independent.data.findings
            : [];
      return {
        status: 'completed',
        summary: `${definition.kind} retained with exact evidence references.`,
        support:
          (parsed.success && !parsed.data.qualified) ||
          (independent.success && !independent.data.valid)
            ? 'gap'
            : gaps.length
              ? 'partial'
              : 'supported',
        uncertainty: gaps,
        outputs: [exactEvidenceRef(artifact)],
      };
    },
  }));
}
