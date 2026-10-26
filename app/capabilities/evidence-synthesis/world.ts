import { z } from 'zod';
import {
  artifactRefSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import { contractHash } from '../../contracts/json.js';
import type {
  CapabilityWorldModelAdapter,
  WorldModelRecordDraft,
} from '../../orchestration/ports.js';
import { synthesisNotesSchema, synthesisReviewSchema } from './contracts.js';

const exactReference = (left: ArtifactRef, right: ArtifactRef) =>
  left.id === right.id &&
  left.version === right.version &&
  left.sha256 === right.sha256;

const reference = (artifact: Artifact): ArtifactRef => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});

const key = ({ id, version, sha256 }: ArtifactRef) =>
  `${id}:${version}:${sha256}`;

function sourceText(artifact: Artifact): string {
  return typeof artifact.content === 'string'
    ? artifact.content
    : JSON.stringify(artifact.content);
}

function contentHashMatches(artifact: Artifact): boolean {
  try {
    return contractHash(artifact.content, 8_388_608) === artifact.sha256;
  } catch {
    return false;
  }
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
    payload: z.json().parse(JSON.parse(JSON.stringify(payload))),
    evidence,
    ...(relationships === undefined ? {} : { relationships }),
  };
}

function exactNotes(notesArtifact: Artifact, artifacts: readonly Artifact[]) {
  if (
    notesArtifact.kind !== 'evidence-synthesis.notes' ||
    !contentHashMatches(notesArtifact)
  )
    return undefined;
  const parsed = synthesisNotesSchema.safeParse(notesArtifact.content);
  if (!parsed.success) return undefined;
  const sources = new Map(
    artifacts.map((artifact) => [key(reference(artifact)), artifact]),
  );
  const resolved = [];
  for (const note of parsed.data.notes) {
    const source = sources.get(key(note.artifact));
    if (
      !source ||
      source.producer.kind === 'assignment' ||
      !contentHashMatches(source) ||
      sourceText(source).slice(0, 2400) !== note.excerpt
    )
      return undefined;
    resolved.push({ note, source });
  }
  return { value: parsed.data, resolved };
}

function extractSynthesisRecords(
  artifacts: readonly Artifact[],
): WorldModelRecordDraft[] {
  const records: WorldModelRecordDraft[] = [];
  const notesArtifacts = artifacts.filter(
    (artifact) => artifact.kind === 'evidence-synthesis.notes',
  );
  const reviews = artifacts.flatMap((artifact) => {
    if (
      artifact.kind !== 'evidence-synthesis.review' ||
      !contentHashMatches(artifact)
    )
      return [];
    const parsed = synthesisReviewSchema.safeParse(artifact.content);
    return parsed.success ? [{ artifact, value: parsed.data }] : [];
  });
  for (const notesArtifact of notesArtifacts) {
    const parsed = exactNotes(notesArtifact, artifacts);
    if (!parsed) continue;
    const notesRef = reference(notesArtifact);
    const bundleId = `synthesis-bundle:${key(notesRef)}`;
    const sourceRefs = parsed.resolved.map(({ note }) => note.artifact);
    const citationRecords = parsed.resolved.map(({ note, source }) => {
      const sourceId = `synthesis-source:${key(note.artifact)}`;
      const citationId = `synthesis-citation:${contractHash({
        notes: notesRef,
        citation: note.citation,
      })}`;
      records.push(
        draft(
          'synthesis_source_reference',
          sourceId,
          {
            artifact: note.artifact,
            kind: source.kind,
            producer: source.producer,
            created_at: source.created_at,
            evidence_origin: source.evidence_origin ?? null,
          },
          [note.artifact],
        ),
      );
      records.push(
        draft(
          'synthesis_citation',
          citationId,
          {
            bundle: notesRef,
            citation: note.citation,
            source: note.artifact,
            excerpt: note.excerpt,
          },
          [notesRef, note.artifact],
          [
            {
              kind: 'synthesis_source_reference',
              external_id: sourceId,
              relationship: 'quotes_from',
            },
          ],
        ),
      );
      return {
        kind: 'synthesis_citation',
        external_id: citationId,
        relationship: 'contains_citation',
      };
    });
    records.push(
      draft(
        'evidence_synthesis_bundle',
        bundleId,
        {
          notes: notesRef,
          citations: parsed.resolved.map(({ note }) => ({
            citation: note.citation,
            source: note.artifact,
            excerpt: note.excerpt,
          })),
          limitations: parsed.value.limitations,
        },
        [notesRef, ...sourceRefs],
        citationRecords,
      ),
    );
    for (const { artifact: reviewArtifact, value: review } of reviews) {
      if (
        !exactReference(review.notes, notesRef) ||
        review.status !== 'supported' ||
        review.reviewed_sources.length !== sourceRefs.length ||
        !sourceRefs.every((source) =>
          review.reviewed_sources.some((reviewed) =>
            exactReference(source, reviewed),
          ),
        ) ||
        !reviewArtifact.dependencies.some((dependency) =>
          exactReference(dependency, notesRef),
        ) ||
        !sourceRefs.every((source) =>
          reviewArtifact.dependencies.some((dependency) =>
            exactReference(dependency, source),
          ),
        )
      )
        continue;
      records.push(
        draft(
          'evidence_synthesis_review',
          `synthesis-review:${key(reference(reviewArtifact))}`,
          {
            review: reference(reviewArtifact),
            notes: notesRef,
            reviewed_sources: review.reviewed_sources,
            status: review.status,
            checks: review.checks,
            limitations: review.limitations,
          },
          [reference(reviewArtifact), notesRef, ...review.reviewed_sources],
          [
            {
              kind: 'evidence_synthesis_bundle',
              external_id: bundleId,
              relationship: 'reviewed_by',
            },
          ],
        ),
      );
    }
  }
  return records;
}

export const evidenceSynthesisWorldModelAdapter: CapabilityWorldModelAdapter = {
  extract: ({ artifacts }) => extractSynthesisRecords(artifacts),
  buildAcceptanceCandidate: ({ records, artifacts, assignments }) => {
    const byRef = new Map(
      artifacts.map((artifact) => [key(reference(artifact)), artifact]),
    );
    for (const record of records) {
      if (record.kind !== 'evidence_synthesis_review') continue;
      const projection = z
        .object({
          review: artifactRefSchema,
          notes: artifactRefSchema,
          reviewed_sources: z.array(artifactRefSchema),
          status: synthesisReviewSchema.shape.status,
        })
        .safeParse(record.payload);
      if (!projection.success || projection.data.status !== 'supported')
        continue;
      const notesArtifact = byRef.get(key(projection.data.notes));
      const reviewArtifact = byRef.get(key(projection.data.review));
      if (!notesArtifact || !reviewArtifact) continue;
      const parsedNotes = exactNotes(notesArtifact, artifacts);
      const review = synthesisReviewSchema.safeParse(reviewArtifact.content);
      if (
        !parsedNotes ||
        !review.success ||
        review.data.status !== 'supported' ||
        !exactReference(review.data.notes, reference(notesArtifact)) ||
        reviewArtifact.assignment_id === undefined ||
        reviewArtifact.producer.kind !== 'assignment' ||
        reviewArtifact.producer.id !== reviewArtifact.assignment_id ||
        review.data.reviewed_sources.length !== parsedNotes.resolved.length ||
        !parsedNotes.resolved.every(({ note }) =>
          review.data.reviewed_sources.some((source) =>
            exactReference(source, note.artifact),
          ),
        ) ||
        ![reference(notesArtifact), ...review.data.reviewed_sources].every(
          (required) =>
            reviewArtifact.dependencies.some((dependency) =>
              exactReference(dependency, required),
            ),
        )
      )
        continue;
      const reviewer = assignments.find(
        (assignment) =>
          assignment.id === reviewArtifact.assignment_id &&
          assignment.revision === reviewArtifact.assignment_revision &&
          assignment.definition_id === 'evidence-synthesis.review' &&
          assignment.role === 'EvidenceCritic' &&
          assignment.status === 'completed' &&
          assignment.support === 'supported',
      );
      if (!reviewer) continue;
      const bundle = records.find(
        (candidate) =>
          candidate.kind === 'evidence_synthesis_bundle' &&
          candidate.external_id ===
            `synthesis-bundle:${key(reference(notesArtifact))}`,
      );
      if (!bundle) continue;
      return {
        subject: bundle.ref,
        stated_use: 'evidence-synthesis',
        evidence: [
          reference(notesArtifact),
          ...review.data.reviewed_sources,
          reference(reviewArtifact),
        ],
      };
    }
    return undefined;
  },
  requiredReviewCoverage: ({ artifacts }) =>
    artifacts.flatMap((artifact) => {
      const parsed = exactNotes(artifact, artifacts);
      if (!parsed) return [];
      return [
        {
          id: `synthesis-citation-review:${artifact.id}:${artifact.version}`,
          evidence: [
            reference(artifact),
            ...parsed.resolved.map(({ note }) => note.artifact),
          ],
          reviewer_roles: ['EvidenceCritic' as const],
        },
      ];
    }),
};
