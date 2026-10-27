import { z } from 'zod';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../../contracts/json.js';
import {
  REDUCTION_METHOD_ID,
  physicalResidualRecordSchema,
  reductionInputSelectionSchema,
  reductionSelectionRequestSchema,
  type PhysicalResidualRecord,
  type ReductionInputSelection,
  type ReductionTarget,
} from '../../contracts/damage-reduction.js';
import { identifierSchema } from '../../contracts/common.js';

const importEnvelopeSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.physical-import.v1'),
  origin: z.enum(['synthetic', 'supplied']),
  records: z
    .array(z.object({ row_id: identifierSchema }).passthrough())
    .min(1)
    .max(1000),
});

export class ReductionInputError extends Error {
  constructor(
    readonly status: 'gap' | 'incompatible',
    message: string,
  ) {
    super(message);
  }
}
export interface NormalizedReductionInputs {
  selection: ReductionInputSelection;
  records: (PhysicalResidualRecord & {
    source_ref: ArtifactRef;
    origin: 'synthetic' | 'supplied';
  })[];
  origin: 'synthetic' | 'supplied';
}
export const exactReductionRef = ({
  id,
  version,
  sha256,
}: ArtifactRef): ArtifactRef => ({ id, version, sha256 });
const key = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;
const gap = (code: string): never => {
  throw new ReductionInputError('gap', code);
};
const incompatible = (code: string): never => {
  throw new ReductionInputError('incompatible', code);
};

export function createReductionSelection(
  target: ReductionTarget,
  sources: ReductionInputSelection['sources'],
): ReductionInputSelection {
  return reductionInputSelectionSchema.parse({
    schema_version: 'haze.reduction.input-selection.v1',
    target,
    scope_sha256: contractHash(target.scope),
    method_id: REDUCTION_METHOD_ID,
    method_version: '1',
    sources,
  });
}

/** Resolve only the exact pinned operator selection; artifact prose supplies no authority. */
export function resolveReductionSelectionRequest(
  value: unknown,
  artifacts: readonly Artifact[],
): ReductionInputSelection {
  const boundedSelection = (selection: ReductionInputSelection) => {
    if (
      selection.sources.reduce(
        (sum, source) => sum + source.row_ids.length,
        0,
      ) > 1000
    )
      throw new Error('selected_row_limit_exceeded');
    return selection;
  };
  const reference = reductionSelectionRequestSchema.safeParse(value);
  if (!reference.success)
    return boundedSelection(reductionInputSelectionSchema.parse(value));
  const matches = artifacts.filter(
    (artifact) => key(artifact) === key(reference.data.selection_ref),
  );
  if (matches.length !== 1)
    throw new Error('exact_operator_selection_original_required');
  const artifact = artifactSchema.parse(matches[0]);
  if (
    artifact.producer.kind === 'assignment' ||
    artifact.evidence_origin === 'derived' ||
    artifact.dependencies.length ||
    contractHash(artifact.content) !== artifact.sha256
  )
    throw new Error('original_operator_selection_required');
  return boundedSelection(
    reductionInputSelectionSchema.parse(
      typeof artifact.content === 'string'
        ? parseContractJson(artifact.content)
        : artifact.content,
    ),
  );
}

/** Only the immutable selection supplies numbers; adjacent task evidence is ignored. */
export function normalizeReductionSelection(
  value: ReductionInputSelection,
  artifacts: readonly Artifact[],
): NormalizedReductionInputs {
  const parsedSelection = reductionInputSelectionSchema.safeParse(value);
  if (!parsedSelection.success) return gap('invalid_selection_or_precision');
  const selection = parsedSelection.data;
  if (selection.scope_sha256 !== contractHash(selection.target.scope))
    return gap('scope_hash_mismatch');
  if (
    selection.sources.reduce((sum, source) => sum + source.row_ids.length, 0) >
    1000
  )
    return gap('selected_row_limit_exceeded');
  const selectedIds = new Set<string>();
  const records: NormalizedReductionInputs['records'] = [];
  let origin: NormalizedReductionInputs['origin'] = 'supplied';
  for (const source of selection.sources) {
    if (selectedIds.has(source.artifact.id))
      return incompatible('duplicate_or_conflicting_source_selection');
    selectedIds.add(source.artifact.id);
    const matches = artifacts.filter(
      (artifact) => key(artifact) === key(source.artifact),
    );
    if (matches.length !== 1) return gap('missing_or_ambiguous_exact_original');
    if (
      artifacts.some(
        (artifact) =>
          artifact.id === source.artifact.id &&
          key(artifact) !== key(source.artifact),
      )
    )
      return incompatible('conflicting_source_versions');
    const parsedArtifact = artifactSchema.safeParse(matches[0]);
    if (!parsedArtifact.success) return gap('invalid_original_artifact');
    const artifact = parsedArtifact.data;
    if (contractHash(artifact.content) !== artifact.sha256)
      return gap('source_hash_mismatch');
    if (
      artifact.producer.kind === 'assignment' ||
      artifact.evidence_origin === 'derived'
    )
      return gap('original_physical_decimal_import_required');
    let content: unknown = artifact.content;
    try {
      if (typeof content === 'string') content = parseContractJson(content);
    } catch {
      return gap('invalid_source_json');
    }
    const parsedImport = importEnvelopeSchema.safeParse(content);
    if (!parsedImport.success)
      return gap('physical_decimal_import_or_precision_required');
    const bundle = parsedImport.data;
    if (
      artifact.evidence_origin === 'synthetic_fixture' &&
      bundle.origin !== 'synthetic'
    )
      return incompatible('synthetic_origin_conflict');
    if (bundle.origin === 'synthetic') origin = 'synthetic';
    const rowMap = new Map<string, (typeof bundle.records)[number]>();
    for (const row of bundle.records) {
      if (rowMap.has(row.row_id))
        return incompatible('duplicate_or_conflicting_source_rows');
      rowMap.set(row.row_id, row);
    }
    if (new Set(source.row_ids).size !== source.row_ids.length)
      return incompatible('duplicate_selected_row');
    for (const rowId of source.row_ids) {
      const row = rowMap.get(rowId);
      if (!row) return gap('selected_row_missing');
      const parsedRow = physicalResidualRecordSchema.safeParse(row);
      if (!parsedRow.success)
        return gap('physical_decimal_import_or_precision_required');
      records.push({
        ...parsedRow.data,
        source_ref: exactReductionRef(artifact),
        origin: bundle.origin,
      });
    }
  }
  if (records.length > 1000) return gap('selected_row_limit_exceeded');
  try {
    canonicalJson(records, 524_288);
  } catch {
    return gap('normalized_input_byte_limit_exceeded');
  }
  const scope = canonicalJson(selection.target.scope);
  const sourceMethod = canonicalJson(records[0]!.original_method);
  const basis = records[0]!.evidence_basis;
  const roles = {
    baseline: new Map<string, string>(),
    intervention: new Map<string, string>(),
  };
  const supports = {
    baseline: new Set<string>(),
    intervention: new Set<string>(),
  };
  for (const row of records) {
    if (
      row.scenario !==
      (row.role === 'baseline'
        ? selection.target.comparator
        : selection.target.intervention)
    )
      return incompatible('incompatible_scenario');
    if (/^damage\./.test(row.original_method.id))
      return gap('legacy_accounting_precision_laundering');
    if (canonicalJson(row.scope) !== scope)
      return incompatible('incompatible_scope');
    if (canonicalJson(row.original_method) !== sourceMethod)
      return incompatible('incompatible_source_method');
    if (row.evidence_basis !== basis)
      return incompatible('incompatible_evidence_basis');
    if (roles[row.role].has(row.stratum_id))
      return incompatible('overlapping_strata');
    for (const support of row.support_ids) {
      if (supports[row.role].has(support))
        return incompatible('overlapping_support');
      supports[row.role].add(support);
    }
    roles[row.role].set(
      row.stratum_id,
      JSON.stringify([...row.support_ids].sort()),
    );
  }
  if (!roles.baseline.size || !roles.intervention.size)
    return gap('baseline_and_intervention_required');
  if (
    roles.baseline.size !== roles.intervention.size ||
    [...roles.baseline].some(
      ([id, support]) => roles.intervention.get(id) !== support,
    )
  )
    return incompatible('unmatched_comparison_support');
  return { selection, records, origin };
}
