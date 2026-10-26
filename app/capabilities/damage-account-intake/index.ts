import { contractHash, parseContractJson } from '../../contracts/json.js';
import { type Artifact, type ArtifactRef } from '../../contracts/artifacts.js';
import type {
  AssignmentDefinition,
  CapabilityDefinition,
} from '../../orchestration/ports.js';
import {
  damageAccountComponentSchema,
  damageAccountManifestSchema,
  damageAccountScopeSchema,
} from './contracts.js';
import { damageAccountIntakeWorldModelAdapter } from './world.js';

function artifactContent(artifact: Artifact): unknown {
  if (typeof artifact.content !== 'string') return artifact.content;
  if (artifact.media_type !== 'application/json') return undefined;
  try {
    return parseContractJson(artifact.content);
  } catch {
    return undefined;
  }
}

function exact(artifact: Artifact): ArtifactRef {
  return {
    id: artifact.id,
    version: artifact.version,
    sha256: artifact.sha256,
  };
}

export function createDamageAccountIntakeCapability(): CapabilityDefinition {
  return {
    card: {
      id: 'damage-account-intake',
      version: 'damage-account-intake.v1',
      purpose:
        'Organize supplied physical, financial-incidence, welfare, or source-fire account components without inventing impact estimates.',
      work_products: [
        'Scoped damage-account manifest',
        'Exact component and evidence references',
        'Explicit completeness and review gaps',
      ],
      required_tools: [],
      roles: ['WorkerShield', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: [
        'This capability does not estimate causal attribution, calculate damages, or establish scientific applicability.',
        'Account and component reviews must be independently supplied and tied to exact immutable revisions.',
      ],
    },
    matches: (request) =>
      /\b(damage[- ]account[- ]intake|damage account|damage accounting|revenue recovery|financial incidence|social welfare account)\b/iu.test(
        request.objective,
      ),
    assignments: (request) => [
      {
        key: 'account-intake',
        definition_id: 'damage-accounting.intake',
        brief:
          'Validate the declared account scope and exact supplied component closure; do not calculate damage or causal effects.',
        depends_on: [],
        input: request.scope ?? null,
      },
    ],
    worldModel: damageAccountIntakeWorldModelAdapter,
  };
}

export function createDamageAccountIntakeAssignments(): AssignmentDefinition[] {
  return [
    {
      id: 'damage-accounting.intake',
      version: 'damage-accounting-intake.v1',
      capability: 'damage-account-intake',
      agent: 'WorkerShield',
      tools: [],
      instructions:
        'Validate account scope and exact component references. Never infer missing values, calculate impact, or claim causal attribution or scientific review.',
      execute(services) {
        const scope = damageAccountScopeSchema.safeParse(services.input);
        if (!scope.success) {
          services.question(
            'Provide an exact damage-account scope with account type, episode, geography, period, and counterfactual; financial and welfare accounts also require currency and price year.',
          );
          return {
            status: 'waiting_human',
            summary: 'Waiting for an explicit damage-account scope.',
            support: 'gap',
            uncertainty: [
              'No account was assembled because its scope is incomplete or invalid.',
            ],
            outputs: [],
          };
        }

        const manifests = services.context.inputs.flatMap((artifact) => {
          const parsed = damageAccountManifestSchema.safeParse(
            artifactContent(artifact),
          );
          return parsed.success ? [{ artifact, value: parsed.data }] : [];
        });
        const manifest = manifests.find(
          ({ value }) => contractHash(value.scope) === contractHash(scope.data),
        );
        if (!manifest) {
          const artifact = services.save('damage-accounting.intake', {
            scope: scope.data,
            status: 'partial',
            required_component_ids: [],
            resolved_component_ids: [],
            missing_component_ids: [],
            limitations: [
              'No exact manifest matching the requested account scope was supplied.',
              'No damage figure or causal attribution was computed.',
            ],
          });
          return {
            status: 'completed',
            summary:
              'The account scope is explicit, but no matching component manifest was supplied.',
            support: 'gap',
            uncertainty: [
              'Required component closure and independent reviews remain unavailable.',
            ],
            outputs: [artifact],
          };
        }

        const components = services.context.inputs.flatMap((artifact) => {
          const parsed = damageAccountComponentSchema.safeParse(
            artifactContent(artifact),
          );
          return parsed.success ? [{ artifact, value: parsed.data }] : [];
        });
        const resolved = manifest.value.components.filter((component) => {
          const artifact = services.context.inputs.find(
            (candidate) =>
              candidate.id === component.artifact.id &&
              candidate.version === component.artifact.version &&
              candidate.sha256 === component.artifact.sha256,
          );
          return (
            artifact !== undefined &&
            components.some(
              ({ artifact: parsedArtifact, value }) =>
                parsedArtifact.id === artifact.id &&
                value.account_id === manifest.value.scope.account_id &&
                value.component_id === component.component_id &&
                value.revision === component.revision &&
                value.scope_sha256 === contractHash(manifest.value.scope),
            )
          );
        });
        const resolvedIds = new Set(
          resolved.map((component) => component.component_id),
        );
        const missing = manifest.value.required_component_ids.filter(
          (id) => !resolvedIds.has(id),
        );
        const complete = missing.length === 0;
        const output = services.save('damage-accounting.intake', {
          scope: manifest.value.scope,
          manifest: exact(manifest.artifact),
          manifest_revision: manifest.value.revision,
          status: complete ? 'components_present' : 'partial',
          required_component_ids: manifest.value.required_component_ids,
          resolved_component_ids: [...resolvedIds],
          missing_component_ids: missing,
          component_refs: resolved.map((component) => ({
            component_id: component.component_id,
            revision: component.revision,
            artifact: component.artifact,
          })),
          limitations: [
            'Component presence is not a review, causal attribution, or validation of scientific applicability.',
            'Physical outcomes, financial incidence, and welfare valuations are separate account types and must not be combined without an explicit overlap reconciliation.',
          ],
        });
        return {
          status: 'completed',
          summary: complete
            ? `All ${resolvedIds.size} required component references are present; independent reviews remain separate.`
            : `${missing.length} required component reference(s) are missing.`,
          support: complete ? 'partial' : 'gap',
          uncertainty: [
            'No damage figure, causal attribution, or scientific applicability determination was computed.',
            ...(missing.length
              ? [`Missing required components: ${missing.join(', ')}.`]
              : ['Required independent component reviews remain unverified.']),
          ],
          outputs: [output],
        };
      },
    },
  ];
}
