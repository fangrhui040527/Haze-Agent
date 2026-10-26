import { z } from 'zod';
import { identifierSchema, timestampSchema } from '../../contracts/common.js';
import { artifactRefSchema } from '../../contracts/artifacts.js';

const boundedText = z.string().min(1).max(4096);

export const episodeScopeSchema = z
  .strictObject({
    episode_id: identifierSchema,
    label: boundedText,
    geography: z
      .strictObject({
        id: identifierSchema,
        label: boundedText,
      })
      .optional(),
    period: z
      .strictObject({
        start: timestampSchema,
        end: timestampSchema,
      })
      .optional(),
  })
  .superRefine((scope, context) => {
    if (
      scope.period &&
      Date.parse(scope.period.end) <= Date.parse(scope.period.start)
    )
      context.addIssue({
        code: 'custom',
        path: ['period'],
        message: 'Episode periods must have a positive end-exclusive interval.',
      });
  });

export const episodeContextSchema = z.strictObject({
  schema_version: z.literal('haze.episode.context.v1'),
  scope: episodeScopeSchema,
  linked_analyses: z.array(artifactRefSchema).max(64),
  evidence: z.array(artifactRefSchema).max(64),
  limitations: z.array(boundedText).max(32),
});

export const episodeEvidenceGapSchema = z.strictObject({
  schema_version: z.literal('haze.episode.evidence-gaps.v1'),
  scope: episodeScopeSchema.optional(),
  scope_status: z.enum(['scoped', 'unresolved']),
  branches: z
    .array(
      z.strictObject({
        id: z.enum(['observations', 'attribution']),
        status: z.literal('unresolved'),
        source_availability: z.enum([
          'not_configured',
          'unknown',
          'configured',
        ]),
        reason: boundedText,
      }),
    )
    .min(1)
    .max(8),
  limitations: z.array(boundedText).max(32),
});

export const episodeReviewedBranchSchema = z.strictObject({
  id: z.enum(['observations', 'attribution']),
  source_availability: z.enum(['not_configured', 'unknown', 'configured']),
  status: z.enum(['verified', 'unresolved']),
});

export const episodeReviewSchema = z.strictObject({
  schema_version: z.literal('haze.episode.review.v1'),
  context: artifactRefSchema,
  gap_report: artifactRefSchema,
  reviewed_analyses: z.array(artifactRefSchema).max(64),
  checked_scope: episodeScopeSchema,
  reviewed_branches: z.array(episodeReviewedBranchSchema).max(8),
  status: z.enum(['supported', 'partial', 'rejected']),
  limitations: z.array(boundedText).max(32),
});

export type EpisodeScope = z.infer<typeof episodeScopeSchema>;
export type EpisodeContext = z.infer<typeof episodeContextSchema>;
export type EpisodeEvidenceGap = z.infer<typeof episodeEvidenceGapSchema>;
export type EpisodeReview = z.infer<typeof episodeReviewSchema>;
