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
import {
  episodeContextSchema,
  episodeEvidenceGapSchema,
  episodeReviewedBranchSchema,
  episodeReviewSchema,
} from './contracts.js';

const exactReference = (left: ArtifactRef, right: ArtifactRef) =>
  left.id === right.id &&
  left.version === right.version &&
  left.sha256 === right.sha256;

const reference = (artifact: Artifact): ArtifactRef => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});

const key = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;

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

function extractEpisodeRecords(
  artifacts: readonly Artifact[],
): WorldModelRecordDraft[] {
  const records: WorldModelRecordDraft[] = [];
  const contexts = artifacts.flatMap((artifact) => {
    if (
      artifact.kind !== 'episode-investigation.context' ||
      !contentHashMatches(artifact)
    )
      return [];
    const parsed = episodeContextSchema.safeParse(artifact.content);
    return parsed.success ? [{ artifact, value: parsed.data }] : [];
  });
  const gaps = artifacts.flatMap((artifact) => {
    if (
      artifact.kind !== 'episode-investigation.evidence-gaps' ||
      !contentHashMatches(artifact)
    )
      return [];
    const parsed = episodeEvidenceGapSchema.safeParse(artifact.content);
    return parsed.success ? [{ artifact, value: parsed.data }] : [];
  });
  const reviews = artifacts.flatMap((artifact) => {
    if (
      artifact.kind !== 'episode-investigation.review' ||
      !contentHashMatches(artifact)
    )
      return [];
    const parsed = episodeReviewSchema.safeParse(artifact.content);
    return parsed.success ? [{ artifact, value: parsed.data }] : [];
  });

  for (const { artifact, value } of contexts) {
    const episodeId = value.scope.episode_id;
    const contextRef = reference(artifact);
    const exactAnalyses = value.linked_analyses.filter((analysisRef) =>
      artifacts.some(
        (candidate) =>
          candidate.kind.endsWith('.analysis') &&
          exactReference(reference(candidate), analysisRef) &&
          contentHashMatches(candidate),
      ),
    );
    records.push(
      draft(
        'episode_context',
        `episode:${contractHash(episodeId)}`,
        {
          context: contextRef,
          scope: value.scope,
          linked_analyses: exactAnalyses,
          limitations: value.limitations,
        },
        [contextRef, ...exactAnalyses],
      ),
    );
    for (const analysis of exactAnalyses) {
      const linked = artifacts.find(
        (candidate) =>
          candidate.kind.endsWith('.analysis') &&
          exactReference(reference(candidate), analysis),
      )!;
      records.push(
        draft(
          'episode_linked_analysis',
          `episode-analysis:${contractHash({
            episode_id: episodeId,
            analysis,
          })}`,
          {
            episode_id: episodeId,
            analysis,
            kind: linked.kind,
            producer: linked.producer,
            created_at: linked.created_at,
          },
          [contextRef, analysis],
          [
            {
              kind: 'episode_context',
              external_id: `episode:${contractHash(episodeId)}`,
              relationship: 'observed_by_analysis',
            },
          ],
        ),
      );
    }

    for (const { artifact: gapArtifact, value: gap } of gaps) {
      if (
        gap.scope_status !== 'scoped' ||
        !gap.scope ||
        contractHash(gap.scope) !== contractHash(value.scope)
      )
        continue;
      const gapRef = reference(gapArtifact);
      const gapExternalId = `episode-gaps:${contractHash({
        episode_id: episodeId,
        gap: gapRef,
      })}`;
      records.push(
        draft(
          'episode_evidence_gap',
          gapExternalId,
          {
            episode_id: episodeId,
            gap_report: gapRef,
            scope: gap.scope,
            branches: gap.branches,
            limitations: gap.limitations,
          },
          [contextRef, gapRef],
          [
            {
              kind: 'episode_context',
              external_id: `episode:${contractHash(episodeId)}`,
              relationship: 'has_unresolved_branches',
            },
          ],
        ),
      );
      for (const { artifact: reviewArtifact, value: review } of reviews)
        if (
          exactReference(review.context, contextRef) &&
          exactReference(review.gap_report, gapRef) &&
          contractHash(review.checked_scope) === contractHash(value.scope)
        )
          records.push(
            draft(
              'episode_review_reference',
              `episode-review:${contractHash(reference(reviewArtifact))}`,
              {
                review: reference(reviewArtifact),
                context: contextRef,
                gap_report: gapRef,
                reviewed_analyses: review.reviewed_analyses,
                reviewed_branches: review.reviewed_branches,
                status: review.status,
                limitations: review.limitations,
              },
              [
                reference(reviewArtifact),
                contextRef,
                gapRef,
                ...review.reviewed_analyses,
              ],
              [
                {
                  kind: 'episode_context',
                  external_id: `episode:${contractHash(episodeId)}`,
                  relationship: 'reviewed_by',
                },
              ],
            ),
          );
    }
  }
  return records;
}

export const episodeInvestigationWorldModelAdapter: CapabilityWorldModelAdapter =
  {
    extract: ({ artifacts }) => extractEpisodeRecords(artifacts),
    buildAcceptanceCandidate: ({ records, artifacts, assignments }) => {
      const byRef = new Map(
        artifacts.map((artifact) => [key(reference(artifact)), artifact]),
      );
      for (const record of records) {
        if (record.kind !== 'episode_review_reference') continue;
        const parsed = z
          .object({
            review: artifactRefSchema,
            context: artifactRefSchema,
            gap_report: artifactRefSchema,
            reviewed_analyses: z.array(artifactRefSchema),
            reviewed_branches: z.array(episodeReviewedBranchSchema),
            status: episodeReviewSchema.shape.status,
          })
          .safeParse(record.payload);
        if (!parsed.success || parsed.data.status === 'rejected') continue;
        const contextArtifact = byRef.get(key(parsed.data.context));
        const gapArtifact = byRef.get(key(parsed.data.gap_report));
        const reviewArtifact = byRef.get(key(parsed.data.review));
        if (!contextArtifact || !gapArtifact || !reviewArtifact) continue;
        const context = episodeContextSchema.safeParse(contextArtifact.content);
        const gap = episodeEvidenceGapSchema.safeParse(gapArtifact.content);
        const review = episodeReviewSchema.safeParse(reviewArtifact.content);
        const exactAnalyses =
          context.success &&
          parsed.data.reviewed_analyses.length ===
            context.data.linked_analyses.length &&
          context.data.linked_analyses.every(
            (analysis) =>
              parsed.data.reviewed_analyses.some((reviewed) =>
                exactReference(analysis, reviewed),
              ) &&
              byRef.get(key(analysis))?.kind.endsWith('.analysis') === true,
          );
        if (
          !context.success ||
          !gap.success ||
          !review.success ||
          gap.data.scope_status !== 'scoped' ||
          !gap.data.scope ||
          contractHash(context.data.scope) !== contractHash(gap.data.scope) ||
          contractHash(context.data.scope) !==
            contractHash(review.data.checked_scope) ||
          reviewArtifact.assignment_id === undefined ||
          reviewArtifact.producer.kind !== 'assignment' ||
          reviewArtifact.producer.id !== reviewArtifact.assignment_id ||
          ![parsed.data.context, parsed.data.gap_report].every((required) =>
            reviewArtifact.dependencies.some((dependency) =>
              exactReference(dependency, required),
            ),
          ) ||
          !exactAnalyses ||
          !parsed.data.reviewed_analyses.every((analysis) =>
            reviewArtifact.dependencies.some((dependency) =>
              exactReference(dependency, analysis),
            ),
          ) ||
          review.data.reviewed_branches.length !== gap.data.branches.length ||
          !gap.data.branches.every((branch) =>
            review.data.reviewed_branches.some(
              (checked) =>
                checked.id === branch.id &&
                checked.source_availability === branch.source_availability &&
                checked.status === 'unresolved',
            ),
          ) ||
          !context.data.linked_analyses.length ||
          context.data.linked_analyses.length !==
            parsed.data.reviewed_analyses.length ||
          !context.data.linked_analyses.every((analysis) =>
            parsed.data.reviewed_analyses.some((checked) =>
              exactReference(analysis, checked),
            ),
          )
        )
          continue;
        const reviewer = assignments.find(
          (assignment) =>
            assignment.id === reviewArtifact.assignment_id &&
            assignment.revision === reviewArtifact.assignment_revision &&
            assignment.definition_id === 'episode-investigation.review' &&
            assignment.role === 'EvidenceCritic' &&
            assignment.status === 'completed' &&
            assignment.support === 'supported',
        );
        if (!reviewer) continue;
        if (
          parsed.data.reviewed_analyses.some(
            (analysis) =>
              byRef.get(key(analysis))?.assignment_id === reviewer.id,
          )
        )
          continue;
        const contextRecord = records.find(
          (candidate) =>
            candidate.kind === 'episode_context' &&
            candidate.external_id ===
              `episode:${contractHash(context.data.scope.episode_id)}`,
        );
        if (!contextRecord) continue;
        return {
          subject: contextRecord.ref,
          stated_use: 'episode-investigation-context',
          evidence: [
            parsed.data.context,
            parsed.data.gap_report,
            ...parsed.data.reviewed_analyses,
            parsed.data.review,
          ],
        };
      }
      return undefined;
    },
    requiredReviewCoverage: ({ artifacts }) => {
      const requirements = [];
      for (const { artifact, value } of artifacts.flatMap((candidate) => {
        if (
          candidate.kind !== 'episode-investigation.context' ||
          !contentHashMatches(candidate)
        )
          return [];
        const parsed = episodeContextSchema.safeParse(candidate.content);
        return parsed.success
          ? [{ artifact: candidate, value: parsed.data }]
          : [];
      })) {
        const gap = artifacts.find((candidate) => {
          if (
            candidate.kind !== 'episode-investigation.evidence-gaps' ||
            !contentHashMatches(candidate)
          )
            return false;
          const parsed = episodeEvidenceGapSchema.safeParse(candidate.content);
          return (
            parsed.success &&
            parsed.data.scope_status === 'scoped' &&
            parsed.data.scope !== undefined &&
            contractHash(parsed.data.scope) === contractHash(value.scope)
          );
        });
        if (!gap) continue;
        requirements.push({
          id: `episode-context-review:${value.scope.episode_id}`,
          evidence: [
            reference(artifact),
            reference(gap),
            ...value.linked_analyses,
          ],
          reviewer_roles: ['EvidenceCritic' as const],
        });
      }
      return requirements;
    },
  };

export const episodeArtifactKey = key;
