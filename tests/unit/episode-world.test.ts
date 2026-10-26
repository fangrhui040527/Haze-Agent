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
  episodeContextSchema,
  episodeEvidenceGapSchema,
  episodeScopeSchema,
} from '../../app/capabilities/episode-investigation/contracts.js';
import { episodeInvestigationWorldModelAdapter } from '../../app/capabilities/episode-investigation/world.js';

const identity = {
  principal: 'episode-test-user',
  workspace: 'episode-test-workspace',
};
const scope = {
  episode_id: 'episode-2026-10',
  label: 'October haze episode',
  geography: { id: 'klang-valley', label: 'Klang Valley' },
  period: {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-02T00:00:00Z',
  },
};
const request = taskRequestSchema.parse({
  schema_version: 'haze.task.request.v3',
  objective: 'Investigate the October haze episode.',
  scope,
});
const ids = {
  analysis: '00000000-0000-4000-8000-000000000031',
  context: '00000000-0000-4000-8000-000000000032',
  gaps: '00000000-0000-4000-8000-000000000033',
  review: '00000000-0000-4000-8000-000000000034',
  task: '00000000-0000-4000-8000-000000000035',
  run: '00000000-0000-4000-8000-000000000036',
};
const at = '2026-10-02T00:00:00.000Z';
const branches = [
  {
    id: 'observations' as const,
    status: 'unresolved' as const,
    source_availability: 'not_configured' as const,
    reason: 'No observation adapter is configured.',
  },
  {
    id: 'attribution' as const,
    status: 'unresolved' as const,
    source_availability: 'not_configured' as const,
    reason: 'No attribution source is configured.',
  },
];

function createArtifact(
  id: string,
  kind: string,
  content: unknown,
  options: {
    assignment?: string;
    dependencies?: ArtifactRef[];
  } = {},
): Artifact {
  return artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    id,
    version: 1,
    sha256: contractHash(content),
    identity,
    task_id: ids.task,
    run_id: ids.run,
    ...(options.assignment
      ? { assignment_id: options.assignment, assignment_revision: 1 }
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
  });
}

function ref(artifact: Artifact): ArtifactRef {
  return {
    id: artifact.id,
    version: artifact.version,
    sha256: artifact.sha256,
  };
}

function fixture(
  options: { mismatchGap?: boolean; includeReview?: boolean } = {},
) {
  const analysis = createArtifact(ids.analysis, 'pm25.analysis', {
    method: 'fixture-method',
    result: 'sample result',
  });
  const parsedScope = episodeScopeSchema.parse(scope);
  const contextContent = episodeContextSchema.parse({
    schema_version: 'haze.episode.context.v1',
    scope: parsedScope,
    linked_analyses: [ref(analysis)],
    evidence: [ref(analysis)],
    limitations: ['Episode labels are not independently geocoded.'],
  });
  const context = createArtifact(
    ids.context,
    'episode-investigation.context',
    contextContent,
    { dependencies: [ref(analysis)] },
  );
  const gapScope = options.mismatchGap
    ? { ...parsedScope, episode_id: 'different-episode' }
    : parsedScope;
  const gapContent = episodeEvidenceGapSchema.parse({
    schema_version: 'haze.episode.evidence-gaps.v1',
    scope: gapScope,
    scope_status: 'scoped',
    branches,
    limitations: [
      'Unresolved evidence branches do not prove that evidence or events are absent.',
    ],
  });
  const gaps = createArtifact(
    ids.gaps,
    'episode-investigation.evidence-gaps',
    gapContent,
    { dependencies: [ref(context), ref(analysis)] },
  );
  const reviewId = '00000000-0000-4000-8000-000000000037';
  const review =
    options.includeReview === false
      ? undefined
      : createArtifact(
          ids.review,
          'episode-investigation.review',
          {
            schema_version: 'haze.episode.review.v1',
            context: ref(context),
            gap_report: ref(gaps),
            reviewed_analyses: [ref(analysis)],
            checked_scope: parsedScope,
            reviewed_branches: branches.map((branch) => ({
              id: branch.id,
              source_availability: branch.source_availability,
              status: 'unresolved' as const,
            })),
            status: 'partial',
            limitations: [
              'Review checks exact references and explicit gap declarations only.',
            ],
          },
          {
            assignment: reviewId,
            dependencies: [ref(context), ref(gaps), ref(analysis)],
          },
        );
  const artifacts = [analysis, context, gaps, ...(review ? [review] : [])];
  const assignments = review
    ? [
        {
          id: reviewId,
          revision: 1,
          definition_id: 'episode-investigation.review',
          role: 'EvidenceCritic' as const,
          status: 'completed' as const,
          support: 'supported' as const,
        },
      ]
    : [];
  return { artifacts, assignments, analysis, context, gaps };
}

function recordsFor(artifacts: Artifact[]): WorldRecord[] {
  return episodeInvestigationWorldModelAdapter
    .extract({ request, artifacts })
    .map((draft) =>
      worldRecordSchema.parse({
        schema_version: 'haze.world.record.v1',
        ref: {
          id: `wm:${contractHash(draft.external_id)}`,
          revision: 1,
          sha256: contractHash(draft.payload),
        },
        scope: { ...identity, mode: 'fixture' },
        kind: draft.kind,
        external_id: draft.external_id,
        payload: draft.payload,
        producer: { kind: 'service', id: 'episode-investigation' },
        recorded_at: at,
      }),
    );
}

describe('episode investigation World Model adapter', () => {
  it('registers explicit episode context and independent review work', () => {
    const registry = createExecutionRegistry({ mode: 'fixture' });
    expect(registry.capabilities.get('episode-investigation')?.worldModel).toBe(
      episodeInvestigationWorldModelAdapter,
    );
    expect(registry.definitions.has('episode-investigation.review')).toBe(true);
  });

  it('projects exact linked analyses and keeps unconfigured evidence branches unresolved', () => {
    const data = fixture();
    const records = recordsFor(data.artifacts);
    expect(records.map((record) => record.kind)).toEqual(
      expect.arrayContaining([
        'episode_context',
        'episode_linked_analysis',
        'episode_evidence_gap',
        'episode_review_reference',
      ]),
    );
    expect(
      episodeInvestigationWorldModelAdapter.requiredReviewCoverage({
        request,
        assignments: [],
        artifacts: data.artifacts,
      }),
    ).toEqual([
      expect.objectContaining({
        id: `episode-context-review:${scope.episode_id}`,
        reviewer_roles: ['EvidenceCritic'],
      }),
    ]);
    const candidate =
      episodeInvestigationWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records,
        assessments: [],
        artifacts: data.artifacts,
        assignments: data.assignments,
      });
    expect(candidate?.stated_use).toBe('episode-investigation-context');
    expect(candidate?.evidence).toContainEqual(ref(data.context));
    expect(candidate?.evidence).toContainEqual(ref(data.gaps));
    expect(candidate?.evidence).toContainEqual(ref(data.analysis));
    const gapRecord = records.find(
      (record) => record.kind === 'episode_evidence_gap',
    )!;
    expect(gapRecord.payload).toMatchObject({
      branches: branches.map(({ id, status, source_availability }) => ({
        id,
        status,
        source_availability,
      })),
    });
  });

  it('rejects mismatched episode scope, missing review, or absent reviewer authority', () => {
    const mismatched = fixture({ mismatchGap: true });
    expect(
      episodeInvestigationWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records: recordsFor(mismatched.artifacts),
        assessments: [],
        artifacts: mismatched.artifacts,
        assignments: mismatched.assignments,
      }),
    ).toBeUndefined();
    const missing = fixture({ includeReview: false });
    expect(
      episodeInvestigationWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records: recordsFor(missing.artifacts),
        assessments: [],
        artifacts: missing.artifacts,
        assignments: [],
      }),
    ).toBeUndefined();
    const valid = fixture();
    expect(
      episodeInvestigationWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records: recordsFor(valid.artifacts),
        assessments: [],
        artifacts: valid.artifacts,
        assignments: [],
      }),
    ).toBeUndefined();
  });
});
