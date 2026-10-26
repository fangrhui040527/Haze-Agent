import { z } from 'zod';
import { boundedJsonSchema } from '../../contracts/artifacts.js';
import { contractHash, parseContractJson } from '../../contracts/json.js';
import {
  artifactRefSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import type {
  CapabilityWorldModelAdapter,
  WorldModelRecordDraft,
} from '../../orchestration/ports.js';
import {
  damageAccountComponentSchema,
  damageAccountLineageSchema,
  damageAccountManifestSchema,
  damageAccountReviewSchema,
  damageAccountScopeSchema,
  type DamageAccountComponent,
  type DamageAccountManifest,
  type DamageComponentRef,
  type DamageReviewType,
} from './contracts.js';

const exactReference = (left: ArtifactRef, right: ArtifactRef) =>
  left.id === right.id &&
  left.version === right.version &&
  left.sha256 === right.sha256;

const artifactKey = ({ id, version, sha256 }: ArtifactRef) =>
  `${id}:${version}:${sha256}`;

const accountExternalId = (accountId: string, revision: number) =>
  `damage-account:${contractHash(accountId)}:${revision}`;

const componentExternalId = (
  accountId: string,
  componentId: string,
  revision: number,
) =>
  `damage-component:${contractHash({
    accountId,
    componentId,
  })}:${revision}`;

function content(artifact: Artifact): unknown {
  if (typeof artifact.content !== 'string') return artifact.content;
  if (artifact.media_type !== 'application/json') return undefined;
  try {
    return parseContractJson(artifact.content);
  } catch {
    return undefined;
  }
}

function hasContentHash(artifact: Artifact): boolean {
  try {
    return contractHash(artifact.content, 8_388_608) === artifact.sha256;
  } catch {
    return false;
  }
}

function componentTypes(
  category: DamageAccountComponent['category'],
): DamageReviewType[] {
  switch (category) {
    case 'physical_outcome':
      return ['arithmetic', 'scientific_applicability'];
    case 'financial_entry':
      return ['arithmetic'];
    case 'welfare_valuation':
    case 'source_fire_extension':
      return ['arithmetic', 'scientific_applicability'];
  }
}

function exactComponents(
  manifest: DamageAccountManifest,
  artifacts: readonly Artifact[],
): {
  ref: DamageComponentRef;
  artifact: Artifact;
  value: DamageAccountComponent;
}[] {
  const byRef = new Map(
    artifacts.map((artifact) => [artifactKey(artifact), artifact]),
  );
  const scopeHash = contractHash(manifest.scope);
  const resolved = [];
  for (const ref of manifest.components) {
    const artifact = byRef.get(artifactKey(ref.artifact));
    if (!artifact || !hasContentHash(artifact)) continue;
    const parsed = damageAccountComponentSchema.safeParse(content(artifact));
    if (
      !parsed.success ||
      parsed.data.account_id !== manifest.scope.account_id ||
      parsed.data.component_id !== ref.component_id ||
      parsed.data.revision !== ref.revision ||
      parsed.data.scope_sha256 !== scopeHash ||
      (['financial_entry', 'welfare_valuation'].includes(
        parsed.data.category,
      ) &&
        parsed.data.measure.currency !== manifest.scope.currency)
    )
      continue;
    if (
      parsed.data.evidence.some((evidence) => !byRef.has(artifactKey(evidence)))
    )
      continue;
    resolved.push({ ref, artifact, value: parsed.data });
  }
  return resolved;
}

function reference(artifact: Artifact): ArtifactRef {
  return {
    id: artifact.id,
    version: artifact.version,
    sha256: artifact.sha256,
  };
}

function draft(
  kind: string,
  externalId: string,
  payload: unknown,
  evidence: ArtifactRef[],
  relationships?: WorldModelRecordDraft['relationships'],
): WorldModelRecordDraft {
  return {
    kind,
    external_id: externalId,
    payload: boundedJsonSchema.parse(JSON.parse(JSON.stringify(payload))),
    evidence,
    ...(relationships === undefined ? {} : { relationships }),
  };
}

function extractDamageRecords(
  artifacts: readonly Artifact[],
): WorldModelRecordDraft[] {
  const records: WorldModelRecordDraft[] = [];
  const manifests = artifacts.flatMap((artifact) => {
    if (!hasContentHash(artifact)) return [];
    const parsed = damageAccountManifestSchema.safeParse(content(artifact));
    return parsed.success ? [{ artifact, value: parsed.data }] : [];
  });

  for (const { artifact: manifestArtifact, value: manifest } of manifests) {
    const manifestRef = reference(manifestArtifact);
    const accountId = accountExternalId(
      manifest.scope.account_id,
      manifest.revision,
    );
    records.push(
      draft(
        'damage_account_reference',
        accountId,
        {
          manifest: manifestRef,
          scope: manifest.scope,
          revision: manifest.revision,
          required_component_ids: manifest.required_component_ids,
          components: manifest.components,
          completeness: 'manifest_declared',
        },
        [manifestRef],
      ),
    );

    for (const { ref, artifact, value } of exactComponents(
      manifest,
      artifacts,
    )) {
      records.push(
        draft(
          'damage_component_reference',
          componentExternalId(
            manifest.scope.account_id,
            ref.component_id,
            ref.revision,
          ),
          {
            component: ref,
            account_id: manifest.scope.account_id,
            scope: manifest.scope,
            category: value.category,
            measure: value.measure,
            evidence: value.evidence,
            overlap_group: value.overlap_group ?? null,
            included_in_total: value.included_in_total,
            limitations: value.limitations,
          },
          [reference(artifact), ...value.evidence],
          [
            {
              kind: 'damage_account_reference',
              external_id: accountId,
              relationship: 'part_of',
            },
          ],
        ),
      );
    }
  }

  for (const artifact of artifacts) {
    if (!hasContentHash(artifact)) continue;
    const review = damageAccountReviewSchema.safeParse(content(artifact));
    if (review.success) {
      const componentId = componentExternalId(
        review.data.account_id,
        review.data.component.component_id,
        review.data.component.revision,
      );
      if (
        !records.some(
          (record) =>
            record.kind === 'damage_component_reference' &&
            record.external_id === componentId,
        )
      )
        continue;
      records.push(
        draft(
          'damage_component_review_reference',
          `damage-review:${contractHash({
            account_id: review.data.account_id,
            component: review.data.component,
            review_type: review.data.review_type,
            artifact: reference(artifact),
          })}`,
          {
            review: reference(artifact),
            account_id: review.data.account_id,
            component: review.data.component,
            review_type: review.data.review_type,
            status: review.data.status,
            checked_artifacts: review.data.checked_artifacts,
            limitations: review.data.limitations,
          },
          [reference(artifact), review.data.component.artifact],
          [
            {
              kind: 'damage_component_reference',
              external_id: componentExternalId(
                review.data.account_id,
                review.data.component.component_id,
                review.data.component.revision,
              ),
              relationship: 'reviews',
            },
          ],
        ),
      );
      continue;
    }
    const lineage = damageAccountLineageSchema.safeParse(content(artifact));
    if (!lineage.success) continue;
    const fromArtifact = artifacts.find((candidate) =>
      exactReference(reference(candidate), lineage.data.from_manifest),
    );
    const toArtifact = artifacts.find((candidate) =>
      exactReference(reference(candidate), lineage.data.to_manifest),
    );
    if (!fromArtifact || !toArtifact) continue;
    records.push(
      draft(
        'damage_account_lineage',
        `damage-lineage:${contractHash(lineage.data)}`,
        lineage.data,
        [
          reference(artifact),
          lineage.data.from_manifest,
          lineage.data.to_manifest,
        ],
      ),
    );
  }
  return records;
}

export const damageAccountIntakeWorldModelAdapter: CapabilityWorldModelAdapter =
  {
    extract: ({ artifacts }) => extractDamageRecords(artifacts),
    buildAcceptanceCandidate: ({
      request,
      records,
      artifacts,
      assignments,
    }) => {
      const scope = damageAccountScopeSchema.safeParse(request.scope);
      if (!scope.success) return undefined;
      const byRef = new Map(
        artifacts.map((artifact) => [artifactKey(artifact), artifact]),
      );
      const manifests = artifacts.flatMap((artifact) => {
        if (!hasContentHash(artifact)) return [];
        const parsed = damageAccountManifestSchema.safeParse(content(artifact));
        return parsed.success ? [{ artifact, value: parsed.data }] : [];
      });

      for (const { artifact: manifestArtifact, value: manifest } of manifests) {
        if (
          contractHash(manifest.scope) !== contractHash(scope.data) ||
          new Set(manifest.required_component_ids).size !==
            manifest.required_component_ids.length ||
          new Set(
            manifest.components.map((component) => component.component_id),
          ).size !== manifest.components.length ||
          !manifest.required_component_ids.every((id) =>
            manifest.components.some(
              (component) => component.component_id === id,
            ),
          )
        )
          continue;
        if (
          manifest.components.some(
            (component) => !byRef.has(artifactKey(component.artifact)),
          )
        )
          continue;
        const resolved = exactComponents(manifest, artifacts);
        if (resolved.length !== manifest.components.length) continue;
        const componentIds = new Set(
          resolved.map(({ ref }) => ref.component_id),
        );
        if (
          !manifest.required_component_ids.every((id) => componentIds.has(id))
        )
          continue;
        if (
          ['financial_incidence', 'social_welfare'].includes(
            manifest.scope.account_type,
          ) &&
          resolved.some(
            ({ value }) =>
              ['financial_entry', 'welfare_valuation'].includes(
                value.category,
              ) && value.measure.currency !== manifest.scope.currency,
          )
        )
          continue;

        const manifestRef = reference(manifestArtifact);
        if (manifest.revision > 1) {
          const hasLineage = artifacts.some((lineageArtifact) => {
            if (!hasContentHash(lineageArtifact)) return false;
            const lineage = damageAccountLineageSchema.safeParse(
              content(lineageArtifact),
            );
            const previousManifest = lineage.success
              ? byRef.get(artifactKey(lineage.data.from_manifest))
              : undefined;
            const parsedPrevious = previousManifest
              ? damageAccountManifestSchema.safeParse(content(previousManifest))
              : undefined;
            return (
              lineage.success &&
              lineage.data.account_id === manifest.scope.account_id &&
              lineage.data.from_revision === manifest.revision - 1 &&
              lineage.data.to_revision === manifest.revision &&
              exactReference(lineage.data.to_manifest, manifestRef) &&
              previousManifest !== undefined &&
              hasContentHash(previousManifest) &&
              parsedPrevious?.success === true &&
              parsedPrevious.data.scope.account_id ===
                manifest.scope.account_id &&
              parsedPrevious.data.revision === lineage.data.from_revision
            );
          });
          if (!hasLineage) continue;
        }

        const requiredEvidence: ArtifactRef[] = [manifestRef];
        let reviewsComplete = true;
        for (const { ref, artifact, value } of resolved) {
          requiredEvidence.push(reference(artifact), ...value.evidence);
          for (const reviewType of componentTypes(value.category)) {
            const assignmentId = `damage-accounting.review.${reviewType}`;
            const review = artifacts.find((reviewArtifact) => {
              if (
                !hasContentHash(reviewArtifact) ||
                reviewArtifact.assignment_id === undefined ||
                reviewArtifact.producer.kind !== 'assignment' ||
                reviewArtifact.producer.id !== reviewArtifact.assignment_id
              )
                return false;
              const parsed = damageAccountReviewSchema.safeParse(
                content(reviewArtifact),
              );
              if (
                !parsed.success ||
                parsed.data.account_id !== manifest.scope.account_id ||
                parsed.data.review_type !== reviewType ||
                parsed.data.status !== 'supported' ||
                parsed.data.component.component_id !== ref.component_id ||
                parsed.data.component.revision !== ref.revision ||
                !exactReference(parsed.data.component.artifact, ref.artifact) ||
                ![reference(artifact), ...value.evidence].every((required) =>
                  parsed.data.checked_artifacts.some((checked) =>
                    exactReference(checked, required),
                  ),
                )
              )
                return false;
              const reviewer = assignments.find(
                (candidate) =>
                  candidate.id === reviewArtifact.assignment_id &&
                  candidate.revision === reviewArtifact.assignment_revision &&
                  candidate.definition_id === assignmentId &&
                  candidate.role === 'EvidenceCritic' &&
                  candidate.status === 'completed' &&
                  candidate.support === 'supported',
              );
              return (
                reviewer !== undefined && reviewer.id !== artifact.assignment_id
              );
            });
            if (!review) {
              reviewsComplete = false;
              break;
            }
            requiredEvidence.push(reference(review));
          }
          if (!reviewsComplete) break;
        }
        if (!reviewsComplete) continue;
        const accountRecord = records.find((record) => {
          if (
            record.kind !== 'damage_account_reference' ||
            record.external_id !==
              accountExternalId(manifest.scope.account_id, manifest.revision)
          )
            return false;
          const payload = z
            .object({ manifest: artifactRefSchema })
            .safeParse(record.payload);
          return (
            payload.success &&
            exactReference(payload.data.manifest, manifestRef)
          );
        });
        if (!accountRecord) continue;
        return {
          subject: accountRecord.ref,
          stated_use: `damage-account:${manifest.scope.account_type}`,
          evidence: [
            ...new Map(
              requiredEvidence.map((ref) => [artifactKey(ref), ref]),
            ).values(),
          ],
        };
      }
      return undefined;
    },
    requiredReviewCoverage: ({ request, artifacts }) => {
      const scope = damageAccountScopeSchema.safeParse(request.scope);
      if (!scope.success) return [];
      const coverage = [];
      for (const { value: manifest } of artifacts.flatMap((artifact) => {
        if (!hasContentHash(artifact)) return [];
        const parsed = damageAccountManifestSchema.safeParse(content(artifact));
        return parsed.success ? [{ value: parsed.data }] : [];
      })) {
        if (contractHash(manifest.scope) !== contractHash(scope.data)) continue;
        for (const { ref, value } of exactComponents(manifest, artifacts))
          for (const reviewType of componentTypes(value.category))
            coverage.push({
              id: `${reviewType}:${ref.component_id}:${ref.revision}`,
              evidence: [ref.artifact],
              reviewer_roles: ['EvidenceCritic' as const],
            });
      }
      return coverage;
    },
  };
