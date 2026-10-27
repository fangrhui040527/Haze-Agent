import { z } from 'zod';
import { contractHash } from '../../contracts/json.js';
import {
  artifactRefSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import type {
  CapabilityWorldModelAdapter,
  WorldModelRecordDraft,
} from '../../orchestration/ports.js';
import { runToolOutputSchema, type RunToolOutput } from './contracts.js';

/**
 * The team World Model is the single authority for SmokeLedger findings: reviewed
 * outlooks and source traces become records with exact artifact evidence. The
 * SmokeLedger sidecar no longer keeps facts of its own for task requests.
 */

const PRODUCTS = {
  'smokeledger.air_outlook': 'smokeledger_air_outlook',
  'smokeledger.trace_sources': 'smokeledger_source_trace',
} as const;
type ProductKind = keyof typeof PRODUCTS;

const reviewSchema = z.looseObject({
  valid: z.boolean(),
  reviewed_artifacts: z.array(artifactRefSchema),
  findings: z.array(z.string()).default([]),
});
const sourcesSchema = z.looseObject({
  confidence: z.string().optional(),
  top_concessions: z
    .array(z.looseObject({ concession_id: z.string() }))
    .optional(),
});

const reference = (artifact: Artifact): ArtifactRef => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});
const sameRef = (left: ArtifactRef, right: ArtifactRef) =>
  left.id === right.id &&
  left.version === right.version &&
  left.sha256 === right.sha256;
const contentMatchesHash = (artifact: Artifact) => {
  try {
    return contractHash(artifact.content, 8_388_608) === artifact.sha256;
  } catch {
    return false;
  }
};
const townId = (town: string) =>
  `haze-town:${town
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
const productId = (artifact: Artifact) =>
  `${PRODUCTS[artifact.kind as ProductKind]}:${artifact.id}:${artifact.version}:${artifact.sha256}`;

function product(
  artifact: Artifact,
): { artifact: Artifact; run: RunToolOutput } | undefined {
  if (!(artifact.kind in PRODUCTS) || !contentMatchesHash(artifact))
    return undefined;
  const run = runToolOutputSchema.safeParse(artifact.content);
  return run.success && run.data.response.status !== 'error'
    ? { artifact, run: run.data }
    : undefined;
}

function records(artifacts: readonly Artifact[]): WorldModelRecordDraft[] {
  const drafts: WorldModelRecordDraft[] = [];
  const towns = new Set<string>();
  for (const found of artifacts.map(product)) {
    if (!found) continue;
    const { artifact, run } = found;
    const output = run.response.output;
    const town = townId(run.scope.town);
    if (!towns.has(town)) {
      towns.add(town);
      drafts.push({
        kind: 'haze_town',
        external_id: town,
        payload: {
          town: run.scope.town,
          identity_basis: 'smokeledger_supported_town',
          limitations: [
            'Town-centre point used for the whole district; not a station location.',
          ],
        },
        evidence: [],
      });
    }
    const claims = output?.claims ?? [];
    const sources = sourcesSchema.safeParse(run.response['sources']);
    drafts.push({
      kind: PRODUCTS[artifact.kind as ProductKind],
      external_id: productId(artifact),
      payload: {
        artifact: reference(artifact),
        town_external_id: town,
        method: `smokeledger.${run.operation}`,
        window: run.scope.window,
        mode: run.response.mode,
        evidence_origin: artifact.evidence_origin ?? null,
        summary: output?.summary ?? null,
        cited_evidence_ids: [
          ...new Set(claims.flatMap((claim) => claim.evidence_ids)),
        ].sort(),
        not_assessed: claims
          .map((claim) => claim.text)
          .filter((text) => /\bnot assessed\b/i.test(text)),
        uncovered: output?.validity?.unserved ?? [],
        ...(run.operation === 'trace_sources'
          ? {
              confidence: sources.success
                ? (sources.data.confidence ?? null)
                : null,
              // Concession ids are leads for verification; names are never recorded.
              concession_leads: sources.success
                ? (sources.data.top_concessions ?? []).map(
                    (c) => c.concession_id,
                  )
                : [],
            }
          : {}),
        limitations: output?.limitations ?? [],
      },
      evidence: [reference(artifact)],
      relationships: [
        { kind: 'haze_town', external_id: town, relationship: 'located_in' },
      ],
    });
  }
  return drafts;
}

export const smokeLedgerWorldModelAdapter: CapabilityWorldModelAdapter = {
  extract: ({ artifacts }) => records(artifacts),
  // A record is offered for acceptance only with a passed review of its exact artifact.
  buildAcceptanceCandidate: ({ records: stored, artifacts, assignments }) => {
    const byId = new Map(artifacts.map((a) => [a.id, a]));
    const ordered = [...stored].sort(
      (a, b) =>
        Number(b.kind === 'smokeledger_air_outlook') -
        Number(a.kind === 'smokeledger_air_outlook'),
    );
    for (const record of ordered) {
      if (!Object.values(PRODUCTS).includes(record.kind as never)) continue;
      const ref = artifactRefSchema.safeParse(
        (record.payload as { artifact?: unknown } | null)?.artifact,
      );
      if (!ref.success) continue;
      const artifact = byId.get(ref.data.id);
      if (!artifact || !sameRef(reference(artifact), ref.data)) continue;
      if (!product(artifact)) continue;
      const review = artifacts.find((candidate) => {
        if (
          candidate.kind !== 'review' ||
          !contentMatchesHash(candidate) ||
          candidate.assignment_id === artifact.assignment_id
        )
          return false;
        const reviewer = assignments.find(
          (a) =>
            a.id === candidate.assignment_id &&
            a.revision === candidate.assignment_revision &&
            a.definition_id === 'smokeledger.review' &&
            a.role === 'EvidenceCritic' &&
            a.status === 'completed',
        );
        const content = reviewSchema.safeParse(candidate.content);
        return (
          reviewer !== undefined &&
          content.success &&
          content.data.valid &&
          content.data.reviewed_artifacts.some((r) => sameRef(r, ref.data))
        );
      });
      if (!review) continue;
      return {
        subject: record.ref,
        stated_use: 'smokeledger-episode',
        evidence: [ref.data, reference(review)],
      };
    }
    return undefined;
  },
  requiredReviewCoverage: ({ artifacts }) =>
    artifacts
      .filter((artifact) => artifact.kind in PRODUCTS)
      .map((artifact) => ({
        id: `smokeledger-independent-review:${artifact.id}:${artifact.version}`,
        evidence: [reference(artifact)],
        reviewer_roles: ['EvidenceCritic' as const],
      })),
};
