import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import type { DamageInputs } from '../../contracts/damage-account.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import {
  damageMethodInvocationSchema,
  damageMethodOutputSchema,
  damagePublishedEffectSchema,
  damageScientificCheckSchema,
  damageScientificReviewSchema,
  type DamageApplicability,
} from '../../contracts/damage-evidence-review.js';

export const sameEvidenceRef = (a: ArtifactRef, b: ArtifactRef): boolean =>
  a.id === b.id && a.version === b.version && a.sha256 === b.sha256;
export const exactEvidenceRef = ({
  id,
  version,
  sha256,
}: ArtifactRef): ArtifactRef => ({ id, version, sha256 });
export function retainedArtifact(
  ref: ArtifactRef,
  artifacts: readonly Artifact[],
): Artifact {
  const value = artifacts.find((a) => sameEvidenceRef(a, ref));
  if (!value || contractHash(value.content) !== value.sha256)
    throw new Error(
      'Exact retained evidence is missing or its content hash changed.',
    );
  return value;
}
const sameRefs = (a: ArtifactRef[], b: ArtifactRef[]) =>
  a.length === b.length &&
  new Set(a.map((ref) => canonicalJson(ref))).size === a.length &&
  a.every((ref) => b.some((other) => sameEvidenceRef(ref, other)));

/** This method imports a published effect. It performs no exposure/health inference. */
export function importPublishedPhysicalEffect(
  input: unknown,
  artifacts: readonly Artifact[],
) {
  const invocation = damageMethodInvocationSchema.parse(input);
  invocation.inputs.forEach((ref) => retainedArtifact(ref, artifacts));
  if (
    !invocation.inputs.some((ref) =>
      sameEvidenceRef(ref, invocation.source_location.artifact),
    )
  )
    throw new Error('Published effect must be among the exact method inputs.');
  const source = retainedArtifact(
    invocation.source_location.artifact,
    artifacts,
  );
  if (source.producer.kind === 'assignment')
    throw new Error(
      'Published physical effects require a retained imported record or deterministic extraction, never a model-authored assertion.',
    );
  const published = damagePublishedEffectSchema.parse(source.content);
  if (
    published.effect_id !== invocation.parameters.effect_id ||
    canonicalJson(published.applicability) !==
      canonicalJson(invocation.applicability) ||
    published.source_locator !== invocation.source_location.locator
  )
    throw new Error(
      'Published effect, locator or applicability conflicts with the invocation.',
    );
  for (const ref of published.source_refs) {
    retainedArtifact(ref, artifacts);
    if (!invocation.inputs.some((inputRef) => sameEvidenceRef(inputRef, ref)))
      throw new Error(
        'Original published evidence must be pinned as a method input.',
      );
  }
  const { lower, upper, interpretation } = invocation.uncertainty;
  if (
    (lower === undefined) !== (upper === undefined) ||
    (interpretation === 'not_quantified') !== (lower === undefined) ||
    (lower !== undefined &&
      upper !== undefined &&
      (lower > published.quantity || upper < published.quantity))
  )
    throw new Error(
      'Declared uncertainty must contain the published central quantity.',
    );
  return damageMethodOutputSchema.parse({
    schema_version: 'haze.damage.method-output.v1',
    invocation,
    quantity: published.quantity,
    unit: published.applicability.unit,
    qualification: 'awaiting_scientific_review',
  });
}

/** Expert authority and automated validation remain distinct records. */
export function checkScientificReview(options: {
  output: Artifact;
  review: Artifact;
  artifacts: readonly Artifact[];
  applicability?: DamageApplicability;
  now?: string;
}) {
  const { output, review, artifacts } = options;
  const now = options.now ?? new Date().toISOString();
  retainedArtifact(output, artifacts);
  retainedArtifact(review, artifacts);
  const method = damageMethodOutputSchema.parse(output.content);
  const decision = damageScientificReviewSchema.parse(review.content);
  const reasons: string[] = [];
  if (
    [
      output,
      ...method.invocation.inputs.map((ref) =>
        retainedArtifact(ref, artifacts),
      ),
    ].some((a) => a.evidence_origin === 'synthetic_fixture')
  )
    reasons.push(
      'Synthetic fixtures cannot establish a scientifically supported public-evidence result.',
    );
  if (
    review.producer.kind !== 'user' ||
    review.evidence_origin !== 'user_supplied'
  )
    reasons.push(
      'Scientific decisions require a separately imported expert record; an automated assignment cannot supply expert authority.',
    );
  if (!sameEvidenceRef(decision.reviewed_output, output))
    reasons.push('Scientific review targets another output version.');
  if (!sameRefs(decision.reviewed_inputs, method.invocation.inputs))
    reasons.push('Scientific review does not bind the exact input versions.');
  if (
    decision.method_id !== method.invocation.method_id ||
    decision.method_version !== method.invocation.method_version
  )
    reasons.push('Scientific review targets another method version.');
  if (
    canonicalJson(decision.applicability) !==
      canonicalJson(method.invocation.applicability) ||
    (options.applicability &&
      canonicalJson(options.applicability) !==
        canonicalJson(decision.applicability))
  )
    reasons.push(
      'Requested applicability exceeds the reviewed geography, period, population, endpoint or attribution basis.',
    );
  if (decision.verdict !== 'applicable' || decision.unresolved_questions.length)
    reasons.push('Scientific applicability is rejected or unresolved.');
  if (decision.applicability.attribution_basis === 'unresolved')
    reasons.push('Attribution basis remains unresolved.');
  if (
    Date.parse(decision.decided_at) > Date.parse(now) ||
    Date.parse(decision.expires_at) <= Date.parse(now)
  )
    reasons.push('Scientific review is not current.');
  for (const ref of method.invocation.inputs) retainedArtifact(ref, artifacts);
  const reconstructed = importPublishedPhysicalEffect(
    method.invocation,
    artifacts,
  );
  if (canonicalJson(reconstructed) !== canonicalJson(method))
    reasons.push(
      'Method output does not reproduce from its retained original inputs.',
    );
  return damageScientificCheckSchema.parse({
    schema_version: 'haze.damage.scientific-check.v1',
    method_output: exactEvidenceRef(output),
    expert_review: exactEvidenceRef(review),
    qualified: reasons.length === 0,
    reasons,
    checked_at: now,
    applicability: options.applicability ?? method.invocation.applicability,
  });
}

/** Validate declared scientific claims before accounting or automatic World Model reuse. */
export function assertScientificInputBindings(
  inputs: DamageInputs,
  artifacts: readonly Artifact[],
  now?: string,
): void {
  const reporting = inputs.scope.reporting;
  if (!reporting) return; // Legacy accounts remain readable and scientifically unqualified.
  const outputs = reporting.scientific_bindings.map((binding) => {
    const output = retainedArtifact(binding.method_output, artifacts);
    const review = retainedArtifact(binding.expert_review, artifacts);
    const check = checkScientificReview({
      output,
      review,
      artifacts,
      applicability: reporting.applicability,
      ...(now ? { now } : {}),
    });
    if (!check.qualified)
      throw new Error(
        `Scientific review prevents reuse: ${check.reasons.join(' ')}`,
      );
    return damageMethodOutputSchema.parse(output.content);
  });
  if (
    reporting.applicability.occurrence_period.start !==
      inputs.scope.effect_period.start ||
    reporting.applicability.occurrence_period.end !==
      inputs.scope.effect_period.end ||
    reporting.applicability.population !== inputs.scope.population ||
    reporting.applicability.comparison_scenario !==
      inputs.scope.baseline_scenario_id
  )
    throw new Error(
      'Scientific reporting metadata conflicts with the accounting scope.',
    );
  for (const effect of inputs.effects.filter(
    (e) => e.included && e.quantity !== null,
  )) {
    if (effect.origin === 'synthetic')
      throw new Error(
        'Synthetic physical effects cannot carry scientific public-evidence qualification.',
      );
    if (
      !outputs.some(
        (method) =>
          method.invocation.parameters.effect_id === effect.effect_id &&
          method.quantity === effect.quantity &&
          method.unit === effect.unit &&
          method.invocation.applicability.comparison_scenario ===
            effect.baseline_id &&
          effect.population_stratum ===
            method.invocation.applicability.population &&
          canonicalJson(effect.geography_id ?? null) ===
            canonicalJson(method.invocation.applicability.geography) &&
          method.invocation.applicability.endpoint === effect.endpoint_id &&
          canonicalJson(method.invocation.applicability.occurrence_period) ===
            canonicalJson(effect.period),
      )
    )
      throw new Error(
        'Each reported physical effect requires an exact applicable, independently reviewed method output.',
      );
  }
}
