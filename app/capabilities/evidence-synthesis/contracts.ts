import { z } from 'zod';
import { artifactRefSchema } from '../../contracts/artifacts.js';
import { identifierSchema } from '../../contracts/common.js';

const boundedText = z.string().min(1).max(4096);

export const synthesisNoteSchema = z.strictObject({
  citation: z.string().regex(/^S[1-9]\d*$/u),
  artifact: artifactRefSchema,
  excerpt: z.string().min(1).max(2400),
});

export const synthesisNotesSchema = z.strictObject({
  schema_version: z.literal('haze.evidence-synthesis.notes.v1'),
  notes: z.array(synthesisNoteSchema).min(1).max(64),
  limitations: z.array(boundedText).max(32),
});

export const synthesisReviewSchema = z.strictObject({
  schema_version: z.literal('haze.evidence-synthesis.review.v1'),
  notes: artifactRefSchema,
  reviewed_sources: z.array(artifactRefSchema).min(1).max(64),
  status: z.enum(['supported', 'rejected']),
  checks: z.array(identifierSchema).min(1).max(16),
  limitations: z.array(boundedText).max(32),
});

export type SynthesisNote = z.infer<typeof synthesisNoteSchema>;
export type SynthesisNotes = z.infer<typeof synthesisNotesSchema>;
export type SynthesisReview = z.infer<typeof synthesisReviewSchema>;
