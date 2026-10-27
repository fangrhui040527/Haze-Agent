import { describe, expect, it } from 'vitest';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import { taskRequestSchema } from '../../app/contracts/tasks.js';
import {
  worldRecordSchema,
  type WorldRecord,
} from '../../app/contracts/world.js';
import { createExecutionRegistry } from '../../app/composition.js';
import {
  damageAccountComponentSchema,
  damageAccountManifestSchema,
  damageAccountScopeSchema,
  type DamageAccountScope,
} from '../../app/capabilities/damage-account-intake/contracts.js';
import { damageAccountIntakeWorldModelAdapter } from '../../app/capabilities/damage-account-intake/world.js';

const identity = {
  principal: 'damage-test-user',
  workspace: 'damage-test-workspace',
};
const at = '2026-10-25T00:00:00.000Z';
const scope: DamageAccountScope = {
  account_id: 'klang-account',
  account_type: 'physical_outcomes',
  episode_id: 'episode-2026-10',
  geography: { id: 'klang', label: 'Klang', level: 'district' },
  period: {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-02T00:00:00Z',
  },
  counterfactual_id: 'same-weather-without-specified-fires',
};
const request = taskRequestSchema.parse({
  schema_version: 'haze.task.request.v3',
  objective: 'Assemble the damage account.',
  scope,
});
const ids = {
  source: '00000000-0000-4000-8000-000000000011',
  component: '00000000-0000-4000-8000-000000000012',
  manifest: '00000000-0000-4000-8000-000000000013',
  arithmeticReview: '00000000-0000-4000-8000-000000000014',
  applicabilityReview: '00000000-0000-4000-8000-000000000015',
  lineage: '00000000-0000-4000-8000-000000000016',
};

function createArtifact(
  id: string,
  kind: string,
  content: unknown,
  options: {
    assignment?: string;
    dependencies?: ArtifactRef[];
    media_type?: 'application/json';
  } = {},
): Artifact {
  return artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    id,
    version: 1,
    sha256: contractHash(content),
    identity,
    task_id: '00000000-0000-4000-8000-000000000021',
    run_id: '00000000-0000-4000-8000-000000000022',
    ...(options.assignment
      ? {
          assignment_id: options.assignment,
          assignment_revision: 1,
        }
      : {}),
    objective_revision: 1,
    generation: 1,
    kind,
    producer: options.assignment
      ? { kind: 'assignment', id: options.assignment }
      : { kind: 'user', id: identity.principal },
    created_at: at,
    dependencies: options.dependencies ?? [],
    required_tools: [],
    content,
    ...(options.media_type ? { media_type: options.media_type } : {}),
  });
}

function ref(artifact: Artifact): ArtifactRef {
  return {
    id: artifact.id,
    version: artifact.version,
    sha256: artifact.sha256,
  };
}

function buildFixture(options: { omitManifestComponent?: boolean } = {}) {
  const source = createArtifact(ids.source, 'source.import', {
    survey_id: 'survey-source-1',
  });
  const componentValue = damageAccountComponentSchema.parse({
    schema_version: 'haze.damage.component.v1',
    account_id: scope.account_id,
    component_id: 'health-count',
    revision: 1,
    scope_sha256: contractHash(scope),
    category: 'physical_outcome',
    measure: { value: 12, unit: 'cases' },
    evidence: [ref(source)],
    included_in_total: false,
    limitations: ['Illustrative test value only.'],
  });
  const component = createArtifact(
    ids.component,
    'damage-accounting.component',
    componentValue,
    { dependencies: [ref(source)] },
  );
  const manifestValue = damageAccountManifestSchema.parse({
    schema_version: 'haze.damage.account-manifest.v1',
    scope,
    revision: 1,
    required_component_ids: ['health-count'],
    components: options.omitManifestComponent
      ? []
      : [
          {
            component_id: 'health-count',
            revision: 1,
            artifact: ref(component),
          },
        ],
  });
  const manifest = createArtifact(
    ids.manifest,
    'damage-accounting.manifest',
    manifestValue,
    { dependencies: [ref(component)] },
  );
  const arithmeticId = ids.arithmeticReview;
  const applicabilityId = ids.applicabilityReview;
  const arithmeticReview = createArtifact(
    ids.arithmeticReview,
    'damage-accounting.component-review',
    {
      schema_version: 'haze.damage.component-review.v1',
      account_id: scope.account_id,
      component: {
        component_id: 'health-count',
        revision: 1,
        artifact: ref(component),
      },
      review_type: 'arithmetic',
      status: 'supported',
      checked_artifacts: [ref(component), ref(source)],
      limitations: ['Arithmetic review only.'],
    },
    {
      assignment: arithmeticId,
      dependencies: [ref(component), ref(source)],
    },
  );
  const applicabilityReview = createArtifact(
    ids.applicabilityReview,
    'damage-accounting.component-review',
    {
      schema_version: 'haze.damage.component-review.v1',
      account_id: scope.account_id,
      component: {
        component_id: 'health-count',
        revision: 1,
        artifact: ref(component),
      },
      review_type: 'scientific_applicability',
      status: 'supported',
      checked_artifacts: [ref(component), ref(source)],
      limitations: ['Applicability review remains distinct from arithmetic.'],
    },
    {
      assignment: applicabilityId,
      dependencies: [ref(component), ref(source)],
    },
  );
  const artifacts = [
    source,
    component,
    manifest,
    arithmeticReview,
    applicabilityReview,
  ];
  const assignments = [
    {
      id: arithmeticId,
      revision: 1,
      definition_id: 'damage-accounting.review.arithmetic',
      role: 'EvidenceCritic' as const,
      status: 'completed' as const,
      support: 'supported' as const,
    },
    {
      id: applicabilityId,
      revision: 1,
      definition_id: 'damage-accounting.review.scientific_applicability',
      role: 'EvidenceCritic' as const,
      status: 'completed' as const,
      support: 'supported' as const,
    },
  ];
  return { artifacts, assignments, component, manifest };
}

function worldRecords(artifacts: Artifact[]): WorldRecord[] {
  return damageAccountIntakeWorldModelAdapter
    .extract({ request, artifacts })
    .map((record) =>
      worldRecordSchema.parse({
        schema_version: 'haze.world.record.v1',
        ref: {
          id: `wm:${contractHash(record.external_id)}`,
          revision: 1,
          sha256: contractHash(record.payload),
        },
        scope: { ...identity, mode: 'fixture' },
        kind: record.kind,
        external_id: record.external_id,
        payload: record.payload,
        producer: { kind: 'service', id: 'damage-account-intake' },
        recorded_at: at,
      }),
    );
}

describe('damage-account-intake World Model contracts and adapter', () => {
  it('registers the capability and strictly validates scoped accounts', () => {
    const registry = createExecutionRegistry({ mode: 'fixture' });
    expect(registry.capabilities.has('damage-account-intake')).toBe(true);
    expect(registry.definitions.has('damage-accounting.intake')).toBe(true);
    expect(damageAccountScopeSchema.safeParse(scope).success).toBe(true);
    expect(
      damageAccountScopeSchema.safeParse({
        ...scope,
        extra: 'rejected',
      }).success,
    ).toBe(false);
    expect(
      damageAccountScopeSchema.safeParse({
        ...scope,
        period: {
          start: scope.period.end,
          end: scope.period.start,
        },
      }).success,
    ).toBe(false);
  });

  it('builds a candidate only for complete exact component closure and independent review types', () => {
    const { artifacts, assignments } = buildFixture();
    const records = worldRecords(artifacts);
    expect(records.map((record) => record.kind)).toEqual(
      expect.arrayContaining([
        'damage_account_reference',
        'damage_component_reference',
        'damage_component_review_reference',
      ]),
    );
    const candidate =
      damageAccountIntakeWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records,
        assessments: [],
        artifacts,
        assignments,
      });
    expect(candidate?.stated_use).toBe('damage-account:physical_outcomes');
    expect(candidate?.evidence).toEqual(
      expect.arrayContaining([
        ref(artifacts[1]!),
        ref(artifacts[3]!),
        ref(artifacts[4]!),
      ]),
    );
    expect(
      damageAccountIntakeWorldModelAdapter.requiredReviewCoverage({
        request,
        assignments: [],
        artifacts,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'arithmetic:health-count:1' }),
        expect.objectContaining({
          id: 'scientific_applicability:health-count:1',
        }),
      ]),
    );
  });

  it('keeps missing or unreviewed required components ineligible', () => {
    const { artifacts, assignments } = buildFixture({
      omitManifestComponent: true,
    });
    expect(
      damageAccountIntakeWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records: worldRecords(artifacts),
        assessments: [],
        artifacts,
        assignments,
      }),
    ).toBeUndefined();

    const valid = buildFixture();
    expect(
      damageAccountIntakeWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records: worldRecords(valid.artifacts),
        assessments: [],
        artifacts: valid.artifacts.filter(
          (artifact) => artifact.id !== ids.applicabilityReview,
        ),
        assignments: valid.assignments,
      }),
    ).toBeUndefined();
  });
});
