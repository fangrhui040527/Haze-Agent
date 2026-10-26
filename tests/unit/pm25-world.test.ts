import { describe, expect, it } from 'vitest';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  worldRecordSchema,
  type WorldRecord,
} from '../../app/contracts/world.js';
import { taskRequestSchema } from '../../app/contracts/tasks.js';
import {
  analyzePm25,
  captureSchema,
  independentlyCheckPm25,
  type Pm25Analysis,
} from '../../app/capabilities/pm25/methods.js';
import {
  PM25_SOURCE_ID,
  type EvidenceCapture,
} from '../../app/capabilities/pm25/evidence.js';
import { pm25WorldModelAdapter } from '../../app/capabilities/pm25/world.js';

const identity = { principal: 'pm25-test-user', workspace: 'pm25-test-space' };
const scope = {
  location: 'Fixture Town',
  period: {
    start: '2026-10-24T00:00:00Z',
    end: '2026-10-24T04:00:00Z',
  },
};
const request = taskRequestSchema.parse({
  schema_version: 'haze.task.request.v3',
  objective: 'Summarize modeled PM2.5 evidence for Fixture Town.',
  scope,
});
const ids = {
  capture: '00000000-0000-4000-8000-000000000001',
  analysis: '00000000-0000-4000-8000-000000000002',
  review: '00000000-0000-4000-8000-000000000003',
  task: '00000000-0000-4000-8000-000000000004',
  run: '00000000-0000-4000-8000-000000000005',
};
const completedReviewer = {
  id: ids.review,
  revision: 1,
  definition_id: 'pm25.check',
  role: 'EvidenceCritic' as const,
  status: 'completed' as const,
  support: 'supported' as const,
};
const at = '2026-10-24T06:00:00.000Z';

function capture(
  options: {
    truncated?: boolean;
    missing?: boolean;
  } = {},
): EvidenceCapture {
  const sourceValues = options.missing ? [10, null, 20, 15] : [10, 30, 20, 15];
  const values = options.truncated ? sourceValues.slice(0, 3) : sourceValues;
  const rawRows = sourceValues.map((value, index) => [
    scope.location,
    new Date(Date.parse(scope.period.start) + index * 3_600_000).toISOString(),
    'model',
    '2026-10-23T01:00:00Z',
    value,
    'open-meteo-air-quality',
    at,
    null,
    null,
  ]);
  const rows = values.map((value, index) => ({
    start: new Date(
      Date.parse(scope.period.start) + index * 3_600_000,
    ).toISOString(),
    end: new Date(
      Date.parse(scope.period.start) + index * 3_600_000,
    ).toISOString(),
    value,
    issued_at: null,
    location: scope.location,
    ingested_at: at,
    latitude: null,
    longitude: null,
  }));
  return {
    source: PM25_SOURCE_ID,
    kind: 'modeled',
    units: 'µg/m³',
    location: scope.location,
    retrieved_at: at,
    issued_at: null,
    rows,
    raw: JSON.stringify({ data: rawRows }),
    selection: {
      backend: 'zetaris-rest',
      query: 'Fixture selection only; no query was run.',
      request_id: 'fixture-selection',
      row_limit: options.truncated ? 3 : 1500,
      returned_rows: rawRows.length,
      truncated: options.truncated ?? false,
      source_filter: 'open-meteo-air-quality',
      selected_raw_row_indices: rows.map((_, index) => index),
    },
    limitations: ['Synthetic fixture; no live readiness established.'],
    mode: 'fixture',
    evidence_origin: 'synthetic_fixture',
    temporal_support: 'instantaneous',
    sample_interval_minutes: 60,
    units_reference: 'https://open-meteo.com/en/docs/air-quality-api',
  };
}

function artifact(
  id: string,
  kind: string,
  content: unknown,
  assignmentId: string,
  dependencies: ArtifactRef[] = [],
): Artifact {
  return artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    id,
    version: 1,
    sha256: contractHash(content),
    identity,
    task_id: ids.task,
    run_id: ids.run,
    assignment_id: assignmentId,
    assignment_revision: 1,
    objective_revision: 1,
    generation: 1,
    kind,
    producer: { kind: 'assignment', id: assignmentId },
    created_at: at,
    dependencies,
    required_tools: [],
    content,
    evidence_origin: 'derived',
  });
}

function ref(value: Artifact): ArtifactRef {
  return { id: value.id, version: value.version, sha256: value.sha256 };
}

function recordsFor(artifacts: Artifact[]): WorldRecord[] {
  return pm25WorldModelAdapter.extract({ request, artifacts }).map((draft) =>
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
      producer: { kind: 'service', id: 'pm25-world-adapter' },
      recorded_at: at,
    }),
  );
}

function validArtifacts(
  options: {
    truncated?: boolean;
    missing?: boolean;
    staleAnalysis?: boolean;
  } = {},
) {
  const selectedCapture = capture(options);
  const captureArtifact = artifact(
    ids.capture,
    'pm25.capture',
    selectedCapture,
    ids.capture,
  );
  const analysis: Pm25Analysis = analyzePm25(selectedCapture, scope);
  const analysisArtifact = artifact(
    ids.analysis,
    'pm25.analysis',
    analysis,
    ids.analysis,
    options.staleAnalysis
      ? [
          {
            id: ids.capture,
            version: 1,
            sha256: 'a'.repeat(64),
          },
        ]
      : [ref(captureArtifact)],
  );
  const checked = independentlyCheckPm25(selectedCapture, analysis, scope);
  const reviewArtifact = artifact(
    ids.review,
    'review',
    {
      ...checked,
      verdict: checked.valid ? 'supported' : 'rejected',
      reviewer_role: 'EvidenceCritic',
      reviewed_artifacts: [captureArtifact, analysisArtifact].map(ref),
    },
    ids.review,
    [ref(captureArtifact), ref(analysisArtifact)],
  );
  return [captureArtifact, analysisArtifact, reviewArtifact];
}

describe('PM2.5 World Model adapter', () => {
  it('projects requested location identity, exact modeled selection and analysis refs without copying raw evidence', () => {
    const artifacts = validArtifacts();
    const drafts = pm25WorldModelAdapter.extract({ request, artifacts });
    expect(drafts.map((draft) => draft.kind)).toEqual([
      'pm25_location',
      'pm25_modeled_capture',
      'pm25_analysis_reference',
      'pm25_numerical_review_reference',
    ]);
    const location = drafts[0]!.payload as {
      identity_basis: string;
      requested_label: string;
    };
    expect(location).toMatchObject({
      requested_label: scope.location,
      identity_basis: 'requested_label',
    });
    expect(drafts[1]!.relationships).toContainEqual({
      kind: 'pm25_location',
      external_id: `pm25-location:${contractHash(scope.location.toLowerCase())}`,
      relationship: 'located_in',
    });
    expect(drafts[2]!.relationships).toContainEqual({
      kind: 'pm25_modeled_capture',
      external_id: `pm25-capture:${ids.capture}:1:${artifacts[0]!.sha256}`,
      relationship: 'derived_from',
    });
    const captureProjection = drafts[1]!.payload as {
      artifact: ArtifactRef;
      selection: EvidenceCapture['selection'];
      evidence_kind: string;
      temporal_support: string;
    };
    const sourceCapture = captureSchema.parse(artifacts[0]!.content);
    expect(captureProjection).toMatchObject({
      artifact: ref(artifacts[0]!),
      selection: sourceCapture.selection,
      evidence_kind: 'modeled',
      temporal_support: 'instantaneous',
    });
    expect(JSON.stringify(drafts)).not.toContain(sourceCapture.raw);
    const candidate = pm25WorldModelAdapter.buildAcceptanceCandidate({
      request,
      records: recordsFor(artifacts),
      assessments: [],
      artifacts,
      assignments: [completedReviewer],
    });
    expect(candidate).toEqual({
      subject: recordsFor(artifacts).find(
        (record) => record.kind === 'pm25_analysis_reference',
      )!.ref,
      stated_use: 'pm25-evidence-summary',
      evidence: artifacts.map(ref),
    });
    expect(
      pm25WorldModelAdapter.requiredReviewCoverage({
        request,
        assignments: [],
        artifacts,
      }),
    ).toEqual([
      {
        id: `pm25-independent-numerical-review:${ids.analysis}:1`,
        evidence: [ref(artifacts[0]!), ref(artifacts[1]!)],
        reviewer_roles: ['EvidenceCritic'],
      },
    ]);
  });

  it('does not offer a candidate when the exact independent review is absent or references stale hashes', () => {
    const artifacts = validArtifacts();
    for (const values of [
      artifacts.slice(0, 2),
      [
        artifacts[0]!,
        artifacts[1]!,
        artifact(
          ids.review,
          'review',
          {
            ...(artifacts[2]!.content as Record<string, unknown>),
            reviewed_artifacts: [
              ref(artifacts[0]!),
              { ...ref(artifacts[1]!), sha256: 'b'.repeat(64) },
            ],
          },
          ids.review,
          [ref(artifacts[0]!), ref(artifacts[1]!)],
        ),
      ],
    ]) {
      expect(
        pm25WorldModelAdapter.buildAcceptanceCandidate({
          request,
          records: recordsFor(values),
          assessments: [],
          artifacts: values,
          assignments: [completedReviewer],
        }),
      ).toBeUndefined();
    }
    expect(
      pm25WorldModelAdapter.buildAcceptanceCandidate({
        request,
        records: recordsFor(artifacts),
        assessments: [],
        artifacts,
        assignments: [],
      }),
    ).toBeUndefined();
    const selfReviewed = [
      artifacts[0]!,
      artifacts[1]!,
      artifact(ids.review, 'review', artifacts[2]!.content, ids.analysis, [
        ref(artifacts[0]!),
        ref(artifacts[1]!),
      ]),
    ];
    expect(
      pm25WorldModelAdapter.buildAcceptanceCandidate({
        request,
        records: recordsFor(selfReviewed),
        assessments: [],
        artifacts: selfReviewed,
        assignments: [completedReviewer],
      }),
    ).toBeUndefined();
  });

  it('rejects tampered artifact content, stale capture links and incomplete source coverage', () => {
    const valid = validArtifacts();
    const tamperedCapture = {
      ...valid[0]!,
      content: { ...(valid[0]!.content as object), location: 'Other Town' },
    };
    const tamperedArtifacts = [tamperedCapture, valid[1]!, valid[2]!];
    const stale = validArtifacts({ staleAnalysis: true });
    const truncated = validArtifacts({ truncated: true });
    const missingSamples = validArtifacts({ missing: true });
    for (const values of [
      tamperedArtifacts,
      stale,
      truncated,
      missingSamples,
    ]) {
      expect(
        pm25WorldModelAdapter.buildAcceptanceCandidate({
          request,
          records: recordsFor(values),
          assessments: [],
          artifacts: values,
          assignments: [completedReviewer],
        }),
      ).toBeUndefined();
    }
    const mismatchedRequest = taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Summarize modeled PM2.5 for Another Town.',
      scope: {
        ...scope,
        location: 'Another Town',
      },
    });
    expect(
      pm25WorldModelAdapter.buildAcceptanceCandidate({
        request: mismatchedRequest,
        records: recordsFor(valid),
        assessments: [],
        artifacts: valid,
        assignments: [completedReviewer],
      }),
    ).toBeUndefined();
  });
});
