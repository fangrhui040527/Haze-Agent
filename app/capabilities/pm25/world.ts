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
import {
  pm25AnalysisSchema,
  captureSchema,
  independentlyCheckPm25,
  validateCapture,
} from './methods.js';
import {
  framePm25Scope,
  pm25CoverageSchema,
  pm25ScopeSchema,
} from './contracts.js';

const reviewContentSchema = z.strictObject({
  checks: z.array(z.string()).max(32),
  findings: z.array(z.string()).max(32),
  valid: z.boolean(),
  limitations: z.array(z.string()).max(32),
  verdict: z.enum(['supported', 'rejected']),
  reviewer_role: z.literal('EvidenceCritic'),
  reviewed_artifacts: z.array(artifactRefSchema).length(2),
});

const analysisProjectionSchema = z.strictObject({
  artifact: artifactRefSchema,
  capture: artifactRefSchema,
  location_external_id: z.string(),
  scope: pm25ScopeSchema,
  method: z.literal('haze.pm25.coverage.v1'),
  coverage: pm25CoverageSchema,
  range: z.strictObject({
    min: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
  }),
  limitations: z.array(z.string()),
});

const reference = (artifact: Artifact): ArtifactRef => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});

const exactReference = (left: ArtifactRef, right: ArtifactRef) =>
  left.id === right.id &&
  left.version === right.version &&
  left.sha256 === right.sha256;

const hasReference = (references: ArtifactRef[], expected: ArtifactRef) =>
  references.some((item) => exactReference(item, expected));

const contentMatchesHash = (artifact: Artifact) => {
  try {
    return contractHash(artifact.content, 8_388_608) === artifact.sha256;
  } catch {
    return false;
  }
};

function draft(
  kind: string,
  externalId: string,
  payload: WorldModelRecordDraft['payload'],
  evidence: ArtifactRef[],
  relationships?: WorldModelRecordDraft['relationships'],
): WorldModelRecordDraft {
  return {
    kind,
    external_id: externalId,
    payload,
    evidence,
    ...(relationships === undefined ? {} : { relationships }),
  };
}

function extractedPm25Records(
  artifacts: readonly Artifact[],
): WorldModelRecordDraft[] {
  const captures = artifacts.filter(
    (artifact) => artifact.kind === 'pm25.capture',
  );
  const analyses = artifacts.filter(
    (artifact) => artifact.kind === 'pm25.analysis',
  );
  const reviews = artifacts.filter((artifact) => artifact.kind === 'review');
  const records: WorldModelRecordDraft[] = [];

  for (const artifact of captures) {
    if (!contentMatchesHash(artifact)) continue;
    const parsed = captureSchema.safeParse(artifact.content);
    if (!parsed.success) continue;
    const capture = parsed.data;
    const normalizedLocation = capture.location.trim().toLowerCase();
    const locationExternalId = `pm25-location:${contractHash(normalizedLocation)}`;
    const captureRef = reference(artifact);
    records.push(
      draft(
        'pm25_location',
        locationExternalId,
        {
          requested_label: capture.location,
          normalized_label: normalizedLocation,
          identity_basis: 'requested_label',
          limitations: [
            'The requested location label is not geocoded or verified as a geographic identity.',
          ],
        },
        [],
      ),
      draft(
        'pm25_modeled_capture',
        `pm25-capture:${artifact.id}:${artifact.version}:${artifact.sha256}`,
        {
          artifact: captureRef,
          location_external_id: locationExternalId,
          source: capture.source,
          evidence_kind: capture.kind,
          units: capture.units,
          temporal_support: capture.temporal_support,
          sample_interval_minutes: capture.sample_interval_minutes,
          mode: capture.mode,
          selection: capture.selection,
          retrieved_at: capture.retrieved_at,
          issued_at: capture.issued_at,
          row_count: capture.rows.length,
          limitations: capture.limitations,
          evidence_origin: capture.evidence_origin ?? null,
        },
        [captureRef],
        [
          {
            kind: 'pm25_location',
            external_id: locationExternalId,
            relationship: 'located_in',
          },
        ],
      ),
    );

    for (const analysisArtifact of analyses) {
      if (!contentMatchesHash(analysisArtifact)) continue;
      const parsedAnalysis = pm25AnalysisSchema.safeParse(
        analysisArtifact.content,
      );
      if (!parsedAnalysis.success) continue;
      const analysis = parsedAnalysis.data;
      if (
        analysis.scope.location.trim().toLowerCase() !== normalizedLocation ||
        !hasReference(analysisArtifact.dependencies, captureRef)
      )
        continue;
      const analysisRef = reference(analysisArtifact);
      records.push(
        draft(
          'pm25_analysis_reference',
          `pm25-analysis:${analysisArtifact.id}:${analysisArtifact.version}:${analysisArtifact.sha256}`,
          {
            artifact: analysisRef,
            capture: captureRef,
            location_external_id: locationExternalId,
            scope: analysis.scope,
            method: analysis.method,
            coverage: analysis.coverage,
            range: analysis.range,
            limitations: analysis.unresolved_gaps,
          },
          [captureRef, analysisRef],
          [
            {
              kind: 'pm25_modeled_capture',
              external_id: `pm25-capture:${artifact.id}:${artifact.version}:${artifact.sha256}`,
              relationship: 'derived_from',
            },
          ],
        ),
      );

      for (const reviewArtifact of reviews) {
        if (
          !contentMatchesHash(reviewArtifact) ||
          reviewArtifact.producer.kind !== 'assignment' ||
          reviewArtifact.assignment_id === undefined ||
          reviewArtifact.producer.id !== reviewArtifact.assignment_id ||
          reviewArtifact.assignment_id === analysisArtifact.assignment_id ||
          !hasReference(reviewArtifact.dependencies, captureRef) ||
          !hasReference(reviewArtifact.dependencies, analysisRef)
        )
          continue;
        const review = reviewContentSchema.safeParse(reviewArtifact.content);
        if (!review.success) continue;
        records.push(
          draft(
            'pm25_numerical_review_reference',
            `pm25-review:${reviewArtifact.id}:${reviewArtifact.version}:${reviewArtifact.sha256}`,
            {
              artifact: reference(reviewArtifact),
              capture: captureRef,
              analysis: analysisRef,
              valid: review.data.valid,
              verdict: review.data.verdict,
              reviewed_artifacts: review.data.reviewed_artifacts,
              limitations: review.data.limitations,
            },
            [captureRef, analysisRef, reference(reviewArtifact)],
          ),
        );
      }
    }
  }
  return records;
}

export const pm25WorldModelAdapter: CapabilityWorldModelAdapter = {
  extract: ({ artifacts }) => extractedPm25Records(artifacts),
  buildAcceptanceCandidate: ({ request, records, artifacts, assignments }) => {
    let requestedScope;
    try {
      requestedScope = framePm25Scope(request);
    } catch {
      return undefined;
    }
    const byRef = new Map(
      artifacts.map((artifact) => [
        `${artifact.id}:${artifact.version}:${artifact.sha256}`,
        artifact,
      ]),
    );
    for (const record of records) {
      if (record.kind !== 'pm25_analysis_reference') continue;
      const parsedProjection = analysisProjectionSchema.safeParse(
        record.payload,
      );
      if (!parsedProjection.success) continue;
      const {
        artifact: analysisRef,
        capture: captureRef,
        scope,
      } = parsedProjection.data;
      const capture = byRef.get(
        `${captureRef.id}:${captureRef.version}:${captureRef.sha256}`,
      );
      const analysisArtifact = byRef.get(
        `${analysisRef.id}:${analysisRef.version}:${analysisRef.sha256}`,
      );
      if (
        !capture ||
        !analysisArtifact ||
        capture.kind !== 'pm25.capture' ||
        analysisArtifact.kind !== 'pm25.analysis' ||
        !contentMatchesHash(capture) ||
        !contentMatchesHash(analysisArtifact)
      )
        continue;
      const parsedCapture = captureSchema.safeParse(capture.content);
      if (!parsedCapture.success || parsedCapture.data.selection.truncated)
        continue;
      try {
        validateCapture(parsedCapture.data, scope);
      } catch {
        continue;
      }
      const parsedAnalysis = pm25AnalysisSchema.safeParse(
        analysisArtifact.content,
      );
      if (
        !parsedAnalysis.success ||
        contractHash(parsedAnalysis.data.scope) !==
          contractHash(requestedScope) ||
        parsedAnalysis.data.coverage.status !== 'available' ||
        parsedAnalysis.data.coverage.usable_row_count !==
          parsedAnalysis.data.coverage.row_count ||
        parsedAnalysis.data.coverage.modeled_count !==
          parsedAnalysis.data.coverage.row_count ||
        parsedAnalysis.data.coverage.observation_count !== 0 ||
        parsedAnalysis.data.coverage.unknown_kind_count !== 0 ||
        !hasReference(analysisArtifact.dependencies, captureRef)
      )
        continue;

      const checkedReview = artifacts.find((reviewArtifact) => {
        if (
          reviewArtifact.kind !== 'review' ||
          reviewArtifact.assignment_id === undefined ||
          reviewArtifact.producer.kind !== 'assignment' ||
          reviewArtifact.producer.id !== reviewArtifact.assignment_id ||
          reviewArtifact.assignment_id === analysisArtifact.assignment_id ||
          !contentMatchesHash(reviewArtifact) ||
          !hasReference(reviewArtifact.dependencies, captureRef) ||
          !hasReference(reviewArtifact.dependencies, analysisRef)
        )
          return false;
        const reviewer = assignments.find(
          (assignment) =>
            assignment.id === reviewArtifact.assignment_id &&
            assignment.revision === reviewArtifact.assignment_revision &&
            assignment.definition_id === 'pm25.check' &&
            assignment.role === 'EvidenceCritic' &&
            assignment.status === 'completed' &&
            assignment.support === 'supported',
        );
        if (!reviewer) return false;
        const review = reviewContentSchema.safeParse(reviewArtifact.content);
        return (
          review.success &&
          review.data.valid &&
          review.data.verdict === 'supported' &&
          review.data.findings.length === 0 &&
          review.data.reviewed_artifacts.length === 2 &&
          exactReference(review.data.reviewed_artifacts[0]!, captureRef) &&
          exactReference(review.data.reviewed_artifacts[1]!, analysisRef)
        );
      });
      if (!checkedReview) continue;
      const independentCheck = independentlyCheckPm25(
        capture.content,
        analysisArtifact.content,
        scope,
      );
      if (!independentCheck.valid) continue;
      return {
        subject: record.ref,
        stated_use: 'pm25-evidence-summary',
        evidence: [captureRef, analysisRef, reference(checkedReview)],
      };
    }
    return undefined;
  },
  requiredReviewCoverage: ({ artifacts }) => {
    const requirements = [];
    for (const analysis of artifacts.filter(
      (artifact) => artifact.kind === 'pm25.analysis',
    )) {
      const capture = artifacts.find(
        (artifact) =>
          artifact.kind === 'pm25.capture' &&
          hasReference(analysis.dependencies, reference(artifact)),
      );
      if (capture)
        requirements.push({
          id: `pm25-independent-numerical-review:${analysis.id}:${analysis.version}`,
          evidence: [reference(capture), reference(analysis)],
          reviewer_roles: ['EvidenceCritic' as const],
        });
    }
    return requirements;
  },
};
