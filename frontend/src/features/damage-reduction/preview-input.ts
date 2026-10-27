import type {
  Artifact,
  ArtifactRef,
} from '../../../../app/contracts/artifacts.ts';
import {
  physicalResidualImportSchema,
  reductionTargetSchema,
  type PhysicalResidualImport,
  type ReductionTarget,
} from '../../../../app/contracts/damage-reduction.ts';
import {
  reductionCandidateSchema,
  reductionPreviewRequestSchema,
  type ReductionCandidate,
  type ReductionPreviewRequest,
} from '../../../../app/contracts/damage-reduction-plan.ts';

export function exactPreviewRef({
  id,
  version,
  sha256,
}: ArtifactRef): ArtifactRef {
  return { id, version, sha256 };
}

export function readResidualSource(artifact: Artifact): PhysicalResidualImport {
  const source: unknown =
    typeof artifact.content === 'string'
      ? JSON.parse(artifact.content)
      : artifact.content;
  const imported = physicalResidualImportSchema.safeParse(source);
  if (!imported.success)
    throw new Error(
      'Import physical-residual JSON with decimal strings and declared scope, scenario and support for every row.',
    );
  if (
    new Set(imported.data.records.map((row) => row.row_id)).size !==
    imported.data.records.length
  )
    throw new Error(
      'Original row identifiers must be unique within each source.',
    );
  return imported.data;
}

/** Matches the server's canonical key ordering; this hashes scope, never quantities. */
export function canonicalScope(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new Error('Scope must contain JSON values only.');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalScope).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalScope(record[key])}`)
    .join(',')}}`;
}

export async function createPreviewRequest(
  targetValue: unknown,
  candidateValue: unknown,
  sources: { artifact: ArtifactRef; row_ids: string[] }[],
): Promise<ReductionPreviewRequest> {
  const target = reductionTargetSchema.parse(targetValue);
  const candidate = reductionCandidateSchema.parse(candidateValue);
  if (!sources.length || sources.some((source) => !source.row_ids.length))
    throw new Error(
      'Select at least one numerical row from each included physical source.',
    );
  if (
    sources.reduce((total, source) => total + source.row_ids.length, 0) > 1000
  )
    throw new Error('Select at most 1,000 numerical rows.');
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalScope(target.scope)),
  );
  const scopeSha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return reductionPreviewRequestSchema.parse({
    schema_version: 'haze.reduction.preview-request.v1',
    selection: {
      schema_version: 'haze.reduction.input-selection.v1',
      target,
      scope_sha256: scopeSha256,
      method_id: 'reduction.imported-residual-comparison.v1',
      method_version: '1',
      sources,
    },
    candidate,
  });
}

export function targetFromSources(sources: Artifact[]): ReductionTarget | null {
  const rows = sources.flatMap((source) => readResidualSource(source).records);
  const baseline = rows.find((row) => row.role === 'baseline');
  const intervention = rows.find((row) => row.role === 'intervention');
  if (!baseline || !intervention) return null;
  return {
    scope: structuredClone(baseline.scope),
    target_fraction: '0.1',
    relation: 'at_least',
    comparator: baseline.scenario,
    intervention: intervention.scenario,
    assessment_rule: 'point_estimate',
  };
}

export function blankCandidate(name: string): ReductionCandidate {
  return {
    id: 'digital-intervention',
    version: '1',
    name,
    kind: 'exposure_alert',
    description:
      'Proposed digital service; operating rules and capacity require review.',
    rule_owner: null,
    trigger_rule: null,
    action_rule: null,
    approval: {
      status: 'proposed',
      approver: null,
      approved_at: null,
      evidence: [],
    },
    constraints: [],
    costs: [],
    dependencies: [],
    claims: [],
  };
}

/** A revised rule draft cannot silently inherit approval of its prior version. */
export function proposeEditedCandidate(
  candidate: ReductionCandidate,
): ReductionCandidate {
  return {
    ...candidate,
    approval: {
      status: 'proposed',
      approver: null,
      approved_at: null,
      evidence: [],
    },
  };
}
