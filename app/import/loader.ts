import { createHash } from 'node:crypto';
import type {
  EnvironmentalSeries,
  EvidenceRecord,
  ExecutionSurface,
  ImmutableReference,
  PlanningBundle,
} from '../contracts/index.js';
import {
  CANONICAL_SERIALIZER_VERSION,
  contractHash,
} from '../contracts/index.js';
import type {
  EnvironmentalPack,
  Finding,
  ScheduleInput,
  ValidationReport,
} from '../validation/index.js';
import {
  FINDING_CODES,
  parseInputDocument,
  validateInputs,
} from '../validation/index.js';
import { finding } from '../validation/findings.js';

/** Exact bytes as read, with the locator they were read from. */
export interface SourceDocument {
  path: string;
  bytes: Uint8Array;
}

export interface ScenarioSource {
  scenario_id: string;
  evidence: SourceDocument;
  series: SourceDocument;
  /** The raw source the evidence records bind by `raw_sha256`. */
  raw: SourceDocument;
}

export interface ImportRequest {
  planning: SourceDocument;
  environmental?: readonly ScenarioSource[];
  /** Illustrative schedules; never planner output. */
  verificationSchedules?: SourceDocument;
  requiredScenarios?: readonly string[];
  /** Declared references the caller already holds, checked for staleness. */
  expectedBundleRef?: ImmutableReference;
  surface?: ExecutionSurface;
}

export type ArtifactKind =
  | 'planning_bundle'
  | 'evidence_record'
  | 'environmental_series'
  | 'raw_source'
  | 'verification_schedule';

export interface ImportedArtifact {
  kind: ArtifactKind;
  artifact_id: string;
  revision: number | null;
  path: string;
  byte_length: number;
  /** sha256 over the exact bytes on disk. */
  raw_sha256: string;
  /** sha256 over the canonical serialization; null for non-JSON sources. */
  canonical_sha256: string | null;
  serializer: typeof CANONICAL_SERIALIZER_VERSION | null;
  /** Demo-local artifacts are never canonical references. */
  reference_scope: 'demo_local' | 'canonical';
  /** Unit and native resolution are carried through, never converted. */
  unit: string | null;
  native_temporal_resolution: { value: number; unit: string } | null;
  original_timezone: string | null;
  lineage: ArtifactLineage | null;
}

/** Declared upstream identity plus every transformation that produced it. */
export interface ArtifactLineage {
  upstream_id: string;
  upstream_revision: number;
  transformations: {
    operation: string;
    method_id: string;
    method_version: string;
    input_refs: ImmutableReference[];
  }[];
}

export interface PinnedHandoff {
  surface: 'historical_harness' | 'canonical';
  serializer: typeof CANONICAL_SERIALIZER_VERSION;
  bundle_ref: ImmutableReference;
  policy_ref: ImmutableReference;
  method_ref: ImmutableReference;
  evidence_refs: ImmutableReference[];
  scenarios: { scenario_id: string; evidence_refs: ImmutableReference[] }[];
  schedule_refs: ImmutableReference[];
  /** Validation is an engineering check; acceptance stays unauthorized. */
  operating_acceptance: 'not_authorized';
  recommendation_eligible: false;
}

export interface ImportResult {
  status: 'imported' | 'draft_rejected';
  surface: 'historical_harness' | 'canonical';
  serializer: typeof CANONICAL_SERIALIZER_VERSION;
  artifacts: ImportedArtifact[];
  /** Null whenever the draft was rejected; no partial bundle is pinned. */
  handoff: PinnedHandoff | null;
  validation: ValidationReport;
  findings: Finding[];
  /** Capabilities this repository does not implement, stated rather than faked. */
  unavailable_capabilities: { capability: string; reason: string }[];
  canonical: {
    epoch_ref: null;
    head_ref: null;
    publication_ref: null;
    reasons: Record<string, string>;
  };
}

/**
 * Findings about environmental *support* rather than document integrity. They
 * narrow what can be scored and are reported in full, but they do not reject
 * the import: a missing hour is a domain insufficiency, not a malformed file.
 */
const SUPPORT_CODES = new Set<string>([
  FINDING_CODES.environmental_coverage_gap,
  FINDING_CODES.environmental_baseline_coverage_missing,
  FINDING_CODES.environmental_scenario_missing,
  FINDING_CODES.environmental_null_interval,
]);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function reference(value: unknown): ImmutableReference | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id === 'string' &&
    typeof record.revision === 'number' &&
    typeof record.sha256 === 'string'
  ) {
    return {
      id: record.id,
      revision: record.revision,
      sha256: record.sha256,
    };
  }
  return null;
}

function sameReference(a: ImmutableReference, b: ImmutableReference): boolean {
  return a.id === b.id && a.revision === b.revision && a.sha256 === b.sha256;
}

interface ParsedScenario {
  scenario_id: string;
  evidenceDocument: string;
  seriesDocument: string;
  rawSha256: string;
  evidenceEnvelope: Record<string, unknown>;
  seriesEnvelope: Record<string, unknown>;
  evidenceRecords: EvidenceRecord[];
  series: EnvironmentalSeries[];
}

/**
 * Import the fictional sample pack across the shared boundary.
 *
 * The loader is deterministic over bytes: it parses with the canonical reader,
 * recomputes every hash from the supplied bytes and compares declared
 * references against those hashes. It converts no timezone, coerces no number,
 * substitutes no missing value and selects no series implicitly. A passing
 * import is an engineering check, never authorized operating acceptance.
 */
export function importSamplePack(request: ImportRequest): ImportResult {
  const findings: Finding[] = [];
  const artifacts: ImportedArtifact[] = [];
  const surface = request.surface ?? 'historical_harness';

  const planningRead = parseInputDocument(
    decode(request.planning.bytes),
    request.planning.path,
  );
  findings.push(...planningRead.findings);
  const planningValue = planningRead.value;

  const scenarios: ParsedScenario[] = [];
  for (const source of request.environmental ?? []) {
    const evidenceRead = parseInputDocument(
      decode(source.evidence.bytes),
      source.evidence.path,
    );
    const seriesRead = parseInputDocument(
      decode(source.series.bytes),
      source.series.path,
    );
    findings.push(...evidenceRead.findings, ...seriesRead.findings);
    const evidenceEnvelope = asRecord(evidenceRead.value);
    const seriesEnvelope = asRecord(seriesRead.value);
    if (!evidenceEnvelope || !seriesEnvelope) continue;
    const rawSha256 = sha256(source.raw.bytes);
    artifacts.push({
      kind: 'raw_source',
      artifact_id: `demo:raw-${source.scenario_id}`,
      revision: null,
      path: source.raw.path,
      byte_length: source.raw.bytes.byteLength,
      raw_sha256: rawSha256,
      canonical_sha256: null,
      serializer: null,
      reference_scope: 'demo_local',
      unit: null,
      native_temporal_resolution: null,
      original_timezone: null,
      lineage: null,
    });
    scenarios.push({
      scenario_id: source.scenario_id,
      evidenceDocument: source.evidence.path,
      seriesDocument: source.series.path,
      rawSha256,
      evidenceEnvelope,
      seriesEnvelope,
      evidenceRecords: recordList<EvidenceRecord>(evidenceEnvelope, 'records'),
      series: recordList<EnvironmentalSeries>(seriesEnvelope, 'series'),
    });
  }

  const packs: EnvironmentalPack[] = scenarios.map((scenario) => ({
    scenario_id: scenario.scenario_id,
    document: scenario.seriesDocument,
    evidence: scenario.evidenceEnvelope,
    series: scenario.seriesEnvelope,
  }));

  const candidates: { schedules: ScheduleInput[]; refs: ImmutableReference[] } =
    request.verificationSchedules
      ? readSchedules(request.verificationSchedules, findings, artifacts)
      : { schedules: [], refs: [] };

  const validation = validateInputs({
    planning: planningValue,
    planningDocument: request.planning.path,
    environmental: packs,
    candidates: candidates.schedules,
    ...(request.requiredScenarios
      ? { requiredScenarios: request.requiredScenarios }
      : {}),
    surface,
  });
  findings.push(...validation.findings);

  const planning = validation.operating_input_valid
    ? (planningValue as PlanningBundle)
    : null;

  if (planning) {
    const bundleHash = contractHash(planning);
    artifacts.push({
      kind: 'planning_bundle',
      artifact_id: 'demo:klang-fixture-input-v2',
      revision: 1,
      path: request.planning.path,
      byte_length: request.planning.bytes.byteLength,
      raw_sha256: sha256(request.planning.bytes),
      canonical_sha256: bundleHash,
      serializer: CANONICAL_SERIALIZER_VERSION,
      reference_scope: 'demo_local',
      unit: null,
      native_temporal_resolution: null,
      original_timezone: planning.timezone,
      lineage: null,
    });
    if (
      request.expectedBundleRef &&
      !sameReference(request.expectedBundleRef, {
        id: 'demo:klang-fixture-input-v2',
        revision: 1,
        sha256: bundleHash,
      })
    ) {
      findings.push(
        finding({
          code: FINDING_CODES.stale_artifact_reference,
          domain: 'operating_input',
          severity: 'blocking',
          document: request.planning.path,
          affected_ids: [request.expectedBundleRef.id],
          message: `The supplied bundle reference no longer matches the imported bytes (${bundleHash}). Re-resolve the reference; the loader does not accept a stale hash.`,
        }),
      );
    }
  }

  findings.push(...bindScenarioArtifacts(scenarios, planning, artifacts));
  findings.push(...duplicateIdentityFindings(artifacts));

  // Import succeeds when the bytes and references are sound. Environmental
  // support is a separate domain outcome reported through `validation`: a
  // coverage gap narrows what can be scored, it does not invalidate the import.
  const rejecting = findings.filter(
    (entry) => entry.severity === 'blocking' && !SUPPORT_CODES.has(entry.code),
  );
  const status: ImportResult['status'] =
    rejecting.length === 0 && planning !== null ? 'imported' : 'draft_rejected';

  return {
    status,
    surface,
    serializer: CANONICAL_SERIALIZER_VERSION,
    artifacts,
    handoff:
      status === 'imported' && planning !== null
        ? pinnedHandoff({ planning, scenarios, artifacts, surface, candidates })
        : null,
    validation,
    findings,
    unavailable_capabilities: UNAVAILABLE_CAPABILITIES,
    canonical: {
      epoch_ref: null,
      head_ref: null,
      publication_ref: null,
      reasons: {
        epoch_ref: 'canonical_state_implementation_unproved',
        head_ref: 'canonical_current_read_unproved',
        publication_ref: 'publication_disabled_for_demo_local_records',
      },
    },
  };
}

/** Both consumers receive the identical pinned artifact set. */
export function plannerHandoff(result: ImportResult): PinnedHandoff | null {
  return result.handoff;
}

export function verificationHandoff(
  result: ImportResult,
): PinnedHandoff | null {
  return result.handoff;
}

const UNAVAILABLE_CAPABILITIES: { capability: string; reason: string }[] = [
  {
    capability: 'authenticated_post_run_admission',
    reason:
      'No HTTP server exists in this repository; demo-local references are rejected on the canonical surface by the contract validator instead.',
  },
  {
    capability: 'evidence_acceptance_and_review',
    reason:
      'No authorized reviewer or acceptance record exists; evidence disposition stays not_assessed.',
  },
  {
    capability: 'canonical_epoch_head_and_publication',
    reason:
      'Canonical state, current-read and publication gates are unproved, so the historical harness is used with publication disabled.',
  },
  {
    capability: 'qualified_intended_use_applicability_review',
    reason:
      'Occupational-hygiene and environmental-method review are outside this slice; applicability stays not_assessed.',
  },
  {
    capability: 'planner_and_independent_numerical_checker',
    reason:
      'This boundary delivers pinned inputs only; no schedule is scored or selected here.',
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordList<T>(envelope: Record<string, unknown>, key: string): T[] {
  const value = envelope[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function readSchedules(
  source: SourceDocument,
  findings: Finding[],
  artifacts: ImportedArtifact[],
): { schedules: ScheduleInput[]; refs: ImmutableReference[] } {
  const read = parseInputDocument(decode(source.bytes), source.path);
  findings.push(...read.findings);
  const envelope = asRecord(read.value);
  if (!envelope) return { schedules: [], refs: [] };
  const entries = recordList<Record<string, unknown>>(envelope, 'schedules');
  const schedules: ScheduleInput[] = [];
  const refs: ImmutableReference[] = [];
  entries.forEach((entry, index) => {
    const declared = reference(entry.ref);
    const record = asRecord(entry.record);
    if (!declared || !record) return;
    const recomputed = contractHash(record);
    if (recomputed !== declared.sha256) {
      findings.push(
        finding({
          code: FINDING_CODES.stale_artifact_reference,
          domain: 'operating_input',
          severity: 'blocking',
          document: source.path,
          path: ['schedules', index, 'ref', 'sha256'],
          affected_ids: [declared.id],
          message: `Illustrative schedule ${declared.id} declares ${declared.sha256} but its bytes hash to ${recomputed}. Regenerate the fixture hashes rather than editing the reference.`,
        }),
      );
      return;
    }
    const assignments = recordList<{ activity_id: string; start: string }>(
      record,
      'assignments',
    );
    schedules.push({
      schedule_id: declared.id,
      kind: 'candidate',
      assignments,
    });
    refs.push(declared);
    artifacts.push({
      kind: 'verification_schedule',
      artifact_id: declared.id,
      revision: declared.revision,
      path: `${source.path}#/schedules/${index}`,
      byte_length: source.bytes.byteLength,
      raw_sha256: sha256(source.bytes),
      canonical_sha256: recomputed,
      serializer: CANONICAL_SERIALIZER_VERSION,
      reference_scope: 'demo_local',
      unit: null,
      native_temporal_resolution: null,
      original_timezone: null,
      lineage: null,
    });
  });
  return { schedules, refs };
}

/**
 * Bind evidence and series artifacts to their exact bytes.
 *
 * Every declared hash is checked against one recomputed from the supplied
 * bytes, so altered bytes surface as a stale reference instead of being
 * silently accepted.
 */
function bindScenarioArtifacts(
  scenarios: readonly ParsedScenario[],
  planning: PlanningBundle | null,
  artifacts: ImportedArtifact[],
): Finding[] {
  const findings: Finding[] = [];
  const evidenceHashes = new Map<string, string>();
  for (const scenario of scenarios) {
    if (
      planning &&
      typeof scenario.seriesEnvelope.timezone === 'string' &&
      scenario.seriesEnvelope.timezone !== planning.timezone
    ) {
      findings.push(
        finding({
          code: FINDING_CODES.timezone_envelope_mismatch,
          domain: 'environmental',
          severity: 'blocking',
          document: scenario.seriesDocument,
          path: ['timezone'],
          affected_ids: [scenario.scenario_id],
          message: `Series pack declares timezone ${String(scenario.seriesEnvelope.timezone)} while the bundle declares ${planning.timezone}. The loader performs no timezone conversion; correct the source metadata.`,
        }),
      );
    }
    scenario.evidenceRecords.forEach((record, index) => {
      const canonical = contractHash(record);
      evidenceHashes.set(`${record.evidence_id}@${record.revision}`, canonical);
      if (record.raw_sha256 !== scenario.rawSha256) {
        findings.push(
          finding({
            code: FINDING_CODES.raw_bytes_mismatch,
            domain: 'environmental',
            severity: 'blocking',
            document: `${scenario.evidenceDocument}#/records/${index}`,
            path: ['raw_sha256'],
            affected_ids: [record.evidence_id],
            message: `Evidence ${record.evidence_id} binds raw bytes ${record.raw_sha256}, but the supplied source hashes to ${scenario.rawSha256}. Re-bind the record to the bytes it actually describes.`,
          }),
        );
      }
      artifacts.push({
        kind: 'evidence_record',
        artifact_id: record.evidence_id,
        revision: record.revision,
        path: `${scenario.evidenceDocument}#/records/${index}`,
        byte_length: 0,
        raw_sha256: record.raw_sha256,
        canonical_sha256: canonical,
        serializer: CANONICAL_SERIALIZER_VERSION,
        reference_scope: record.evidence_id.startsWith('demo:')
          ? 'demo_local'
          : 'canonical',
        unit: record.unit,
        native_temporal_resolution: record.native_temporal_resolution,
        original_timezone: record.original_timezone,
        lineage: {
          upstream_id: record.upstream_id,
          upstream_revision: record.upstream_revision,
          transformations: record.provenance.chain
            .filter((step) => step.operation !== 'collection')
            .map((step) => ({
              operation: step.operation,
              method_id: step.method_id,
              method_version: step.method_version,
              input_refs: step.input_refs.map((entry) => ({ ...entry })),
            })),
        },
      });
    });
    scenario.series.forEach((series, index) => {
      const document = `${scenario.seriesDocument}#/series/${index}`;
      const expected = evidenceHashes.get(
        `${series.evidence_ref.id}@${series.evidence_ref.revision}`,
      );
      if (expected === undefined) {
        findings.push(
          finding({
            code: FINDING_CODES.environmental_series_binding_mismatch,
            domain: 'environmental',
            severity: 'blocking',
            document,
            path: ['evidence_ref'],
            affected_ids: [series.series_id, series.evidence_ref.id],
            message: `Series ${series.series_id} references evidence ${series.evidence_ref.id}@${series.evidence_ref.revision}, which this pack does not supply.`,
          }),
        );
      } else if (expected !== series.evidence_ref.sha256) {
        findings.push(
          finding({
            code: FINDING_CODES.stale_artifact_reference,
            domain: 'environmental',
            severity: 'blocking',
            document,
            path: ['evidence_ref', 'sha256'],
            affected_ids: [series.series_id, series.evidence_ref.id],
            message: `Series ${series.series_id} pins evidence hash ${series.evidence_ref.sha256}, but the supplied record hashes to ${expected}. Regenerate the binding.`,
          }),
        );
      }
      if (series.source_ref.sha256 !== scenario.rawSha256) {
        findings.push(
          finding({
            code: FINDING_CODES.raw_bytes_mismatch,
            domain: 'environmental',
            severity: 'blocking',
            document,
            path: ['source_ref', 'sha256'],
            affected_ids: [series.series_id],
            message: `Series ${series.series_id} pins source bytes ${series.source_ref.sha256}, but the supplied raw source hashes to ${scenario.rawSha256}.`,
          }),
        );
      }
      artifacts.push({
        kind: 'environmental_series',
        artifact_id: series.series_id,
        revision: series.evidence_ref.revision,
        path: document,
        byte_length: 0,
        raw_sha256: scenario.rawSha256,
        canonical_sha256: contractHash(series),
        serializer: CANONICAL_SERIALIZER_VERSION,
        reference_scope: 'demo_local',
        unit: series.unit,
        native_temporal_resolution: series.native_temporal_resolution,
        original_timezone:
          typeof scenario.seriesEnvelope.timezone === 'string'
            ? scenario.seriesEnvelope.timezone
            : null,
        lineage: {
          upstream_id: series.evidence_ref.id,
          upstream_revision: series.evidence_ref.revision,
          transformations: [],
        },
      });
    });
  }
  if (planning) {
    const declared = new Map(
      planning.evidence_refs.map((entry) => [
        `${entry.id}@${entry.revision}`,
        entry,
      ]),
    );
    for (const [key, hash] of evidenceHashes) {
      const entry = declared.get(key);
      if (!entry) {
        findings.push(
          finding({
            code: FINDING_CODES.environmental_series_binding_mismatch,
            domain: 'environmental',
            severity: 'blocking',
            document: 'planning.evidence_refs',
            affected_ids: [key],
            message: `Imported evidence ${key} is not declared in the bundle's evidence_refs. Declare it or remove the record; the loader adds nothing implicitly.`,
          }),
        );
      } else if (entry.sha256 !== hash) {
        findings.push(
          finding({
            code: FINDING_CODES.stale_artifact_reference,
            domain: 'environmental',
            severity: 'blocking',
            document: 'planning.evidence_refs',
            affected_ids: [entry.id],
            message: `Bundle pins evidence ${entry.id} at ${entry.sha256}, but the supplied record hashes to ${hash}.`,
          }),
        );
      }
    }
  }
  return findings;
}

function duplicateIdentityFindings(
  artifacts: readonly ImportedArtifact[],
): Finding[] {
  const seen = new Map<string, ImportedArtifact>();
  const findings: Finding[] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.kind}:${artifact.artifact_id}@${artifact.revision ?? 'null'}`;
    const previous = seen.get(key);
    if (previous && previous.canonical_sha256 !== artifact.canonical_sha256) {
      findings.push(
        finding({
          code: FINDING_CODES.duplicate_artifact_identity,
          domain: 'environmental',
          severity: 'blocking',
          document: artifact.path,
          affected_ids: [artifact.artifact_id],
          message: `Artifact ${artifact.artifact_id} appears twice with different bytes. An immutable identity cannot carry two contents; give the revision a new number.`,
        }),
      );
    }
    seen.set(key, artifact);
  }
  return findings;
}

function pinnedHandoff(input: {
  planning: PlanningBundle;
  scenarios: readonly ParsedScenario[];
  artifacts: readonly ImportedArtifact[];
  surface: ExecutionSurface;
  candidates: { refs: ImmutableReference[] };
}): PinnedHandoff {
  const evidenceRefs = input.planning.evidence_refs.map((entry) => ({
    ...entry,
  }));
  return {
    surface: input.surface,
    serializer: CANONICAL_SERIALIZER_VERSION,
    bundle_ref: {
      id: 'demo:klang-fixture-input-v2',
      revision: 1,
      sha256: contractHash(input.planning),
    },
    policy_ref: { ...input.planning.policy_ref },
    method_ref: { ...input.planning.method_ref },
    evidence_refs: evidenceRefs,
    scenarios: input.scenarios.map((scenario) => ({
      scenario_id: scenario.scenario_id,
      evidence_refs: scenario.evidenceRecords.map((record) => ({
        id: record.evidence_id,
        revision: record.revision,
        sha256: contractHash(record),
      })),
    })),
    schedule_refs: input.candidates.refs.map((entry) => ({ ...entry })),
    operating_acceptance: 'not_authorized',
    recommendation_eligible: false,
  };
}
