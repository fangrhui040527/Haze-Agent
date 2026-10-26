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
  synthesisNotesSchema,
  synthesisReviewSchema,
} from '../../app/capabilities/evidence-synthesis/contracts.js';
import { evidenceSynthesisWorldModelAdapter } from '../../app/capabilities/evidence-synthesis/world.js';

const identity = {
  principal: 'synthesis-test-user',
  workspace: 'synthesis-test-workspace',
};
const request = taskRequestSchema.parse({
  schema_version: 'haze.task.request.v3',
  objective: 'Explain this source material.',
});
const sourceContent =
  'A knowledge graph represents entities and the relationships between them.';
const sourceId = '00000000-0000-4000-8000-000000000041';
const notesId = '00000000-0000-4000-8000-000000000042';
const reviewId = '00000000-0000-4000-8000-000000000043';
const taskId = '00000000-0000-4000-8000-000000000044';
const runId = '00000000-0000-4000-8000-000000000045';
const extractorAssignmentId = '00000000-0000-4000-8000-000000000046';
const reviewerAssignmentId = '00000000-0000-4000-8000-000000000047';
const at = '2026-10-02T00:00:00.000Z';

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
    task_id: taskId,
    run_id: runId,
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
  options: {
    excerpt?: string;
    includeReview?: boolean;
  } = {},
) {
  const source = createArtifact(sourceId, 'imported.source', sourceContent);
  const sourceRef = ref(source);
  const notesContent = synthesisNotesSchema.parse({
    schema_version: 'haze.evidence-synthesis.notes.v1',
    notes: [
      {
        citation: 'S1',
        artifact: sourceRef,
        excerpt: options.excerpt ?? sourceContent,
      },
    ],
    limitations: ['Source origin is user-declared attribution.'],
  });
  const notes = createArtifact(
    notesId,
    'evidence-synthesis.notes',
    notesContent,
    { assignment: extractorAssignmentId, dependencies: [sourceRef] },
  );
  const reviewContent = synthesisReviewSchema.parse({
    schema_version: 'haze.evidence-synthesis.review.v1',
    notes: ref(notes),
    reviewed_sources: [sourceRef],
    status: 'supported',
    checks: ['exact_source_id_version_hash', 'excerpt_matches_source_prefix'],
    limitations: ['Review does not establish source authenticity.'],
  });
  const review =
    options.includeReview === false
      ? undefined
      : createArtifact(reviewId, 'evidence-synthesis.review', reviewContent, {
          assignment: reviewerAssignmentId,
          dependencies: [ref(notes), sourceRef],
        });
  const artifacts = [source, notes, ...(review ? [review] : [])];
  const assignments = review
    ? [
        {
          id: reviewerAssignmentId,
          revision: 1,
          definition_id: 'evidence-synthesis.review',
          role: 'EvidenceCritic' as const,
          status: 'completed' as const,
          support: 'supported' as const,
        },
      ]
    : [];
  return { artifacts, assignments, notes, review, source };
}

function draftsFor(artifacts: Artifact[]) {
  return evidenceSynthesisWorldModelAdapter.extract({ request, artifacts });
}

function recordsFor(artifacts: Artifact[]): WorldRecord[] {
  return draftsFor(artifacts).map((draft) =>
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
      producer: { kind: 'service', id: 'evidence-synthesis' },
      recorded_at: at,
    }),
  );
}

describe('evidence synthesis World Model adapter', () => {
  it('registers the adapter and projects exact source citations and reviewed bundles', () => {
    const registry = createExecutionRegistry({ mode: 'fixture' });
    expect(registry.capabilities.get('evidence-synthesis')?.worldModel).toBe(
      evidenceSynthesisWorldModelAdapter,
    );
    expect(registry.definitions.has('evidence-synthesis.review')).toBe(true);

    const data = fixture();
    const records = recordsFor(data.artifacts);
    expect(records.map((record) => record.kind)).toEqual(
      expect.arrayContaining([
        'synthesis_source_reference',
        'synthesis_citation',
        'evidence_synthesis_bundle',
        'evidence_synthesis_review',
      ]),
    );
    const citation = draftsFor(data.artifacts).find(
      (record) => record.kind === 'synthesis_citation',
    )!;
    expect(citation.payload).toMatchObject({
      source: ref(data.source),
      excerpt: sourceContent,
    });
    expect(citation.relationships).toContainEqual(
      expect.objectContaining({ relationship: 'quotes_from' }),
    );
    expect(
      evidenceSynthesisWorldModelAdapter.requiredReviewCoverage({
        request,
        assignments: [],
        artifacts: data.artifacts,
      }),
    ).toEqual([
      expect.objectContaining({
        id: `synthesis-citation-review:${data.notes.id}:1`,
        reviewer_roles: ['EvidenceCritic'],
      }),
    ]);
    const candidate =
      evidenceSynthesisWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records,
        assessments: [],
        artifacts: data.artifacts,
        assignments: data.assignments,
      });
    expect(candidate?.stated_use).toBe('evidence-synthesis');
    expect(candidate?.evidence).toContainEqual(ref(data.notes));
    expect(candidate?.evidence).toContainEqual(ref(data.review!));
  });

  it('rejects changed excerpts, missing reviews, and non-completed reviewer assignments', () => {
    const mismatchedExcerpt = fixture({ excerpt: 'A different quotation.' });
    expect(recordsFor(mismatchedExcerpt.artifacts)).toEqual([]);
    expect(
      evidenceSynthesisWorldModelAdapter.requiredReviewCoverage({
        request,
        assignments: [],
        artifacts: mismatchedExcerpt.artifacts,
      }),
    ).toEqual([]);

    const missingReview = fixture({ includeReview: false });
    const missingReviewRecords = recordsFor(missingReview.artifacts);
    expect(
      missingReviewRecords.some(
        (record) => record.kind === 'evidence_synthesis_review',
      ),
    ).toBe(false);
    expect(
      evidenceSynthesisWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records: missingReviewRecords,
        assessments: [],
        artifacts: missingReview.artifacts,
        assignments: [],
      }),
    ).toBeUndefined();

    const valid = fixture();
    expect(
      evidenceSynthesisWorldModelAdapter.buildAcceptanceCandidate({
        request,
        records: recordsFor(valid.artifacts),
        assessments: [],
        artifacts: valid.artifacts,
        assignments: valid.assignments.map((assignment) => ({
          ...assignment,
          status: 'failed' as const,
        })),
      }),
    ).toBeUndefined();
  });
});
