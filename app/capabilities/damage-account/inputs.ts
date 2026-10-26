import { z } from 'zod';
import {
  artifactRefSchema,
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import { contractHash, parseContractJson } from '../../contracts/json.js';
import {
  damageImportSchema,
  damageInputsSchema,
  type DamageImport,
  type DamageInputs,
} from '../../contracts/damage-account.js';

const TABLES = [
  'effects',
  'unit_values',
  'incidence',
  'coverage',
  'scenarios',
  'source_fire_categories',
] as const;
export const exactDamageRef = ({
  id,
  version,
  sha256,
}: ArtifactRef): ArtifactRef => ({ id, version, sha256 });
export const damageRefKey = (ref: ArtifactRef): string =>
  `${ref.id}:${ref.version}:${ref.sha256}`;
export const DAMAGE_METHODS = {
  'damage.imported-quantity.v1':
    'Retain declared source-attributable imported physical quantities without estimating exposure or health response.',
  'damage.declared-unit-value.v1':
    'Multiply compatible imported quantity by an explicitly declared unit value on one currency, price and horizon basis.',
  'damage.accounting.v1':
    'Select nonoverlapping effects, reconcile financing once and cancel internal transfers across the declared social boundary.',
  'damage.project-scenario.v1':
    'Compare independently imported residual project quantities with a declared comparator; no effectiveness is inferred.',
} as const;
export const DAMAGE_LIMITATIONS = [
  'Imported-input accounting MVP; numerical agreement does not establish causal attribution, health applicability, valuation transfer, legal responsibility or empirical regional completeness.',
  'No exposure-to-health model, currency conversion, discounting, probabilistic uncertainty propagation or legal findings are implemented.',
  'Missing harm is withheld and remains outside any reported parameter interval; overlapping alternatives are retained separately.',
  'Revision bridges require explicitly selected exact prior/current accounts and fresh independent review; they do not establish an observed change in haze.',
];

/** RFC 4180 subset: quoted commas/newlines/escaped quotes, bounded by the artifact importer. */
function csvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else cell += ch;
    } else if (ch === '"') {
      if (cell || closed) throw new Error('Malformed CSV quoting.');
      quoted = true;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(cell);
      cell = '';
      closed = false;
      if (ch !== ',') {
        if (ch === '\r' && source[i + 1] === '\n') i++;
        if (row.some((item) => item !== '')) rows.push(row);
        row = [];
      }
    } else {
      if (closed) throw new Error('Unexpected text after CSV closing quote.');
      cell += ch;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length > 10001) throw new Error('CSV exceeds 10000 data rows.');
  return rows;
}

/** CSV has schema_version,table_type,record columns; record is a JSON object, never a formula. */
function parseCsv(source: string): DamageImport {
  const [header, ...rows] = csvRows(source);
  if (
    JSON.stringify(header) !==
    JSON.stringify(['schema_version', 'table_type', 'record'])
  )
    throw new Error(
      'Damage CSV requires exactly schema_version,table_type,record columns.',
    );
  const bundle: Record<string, unknown> = {
    schema_version: 'haze.damage.import.v1',
  };
  for (const fields of rows) {
    if (fields.length !== 3 || fields[0] !== 'haze.damage.import.v1')
      throw new Error('Unsupported damage CSV schema or column count.');
    const table = fields[1]!;
    if (table !== 'scope' && !TABLES.includes(table as (typeof TABLES)[number]))
      throw new Error('Unsupported damage CSV table type.');
    const record: unknown = parseContractJson(fields[2]!);
    if (table === 'scope') {
      if (bundle.scope) throw new Error('Duplicate scope in CSV.');
      bundle.scope = record;
    } else {
      const tableRows = (bundle[table] ??= []) as unknown[];
      tableRows.push(record);
    }
  }
  return damageImportSchema.parse(bundle);
}

export function normalizeDamageInputs(
  artifacts: readonly Artifact[],
): DamageInputs {
  if (!artifacts.length || artifacts.length > 128)
    throw new Error(
      'Damage accounting requires 1–128 exact authorized input artifacts.',
    );
  const validated = artifacts.map((source) => {
    const artifact = artifactSchema.parse(source);
    if (contractHash(artifact.content) !== artifact.sha256)
      throw new Error('Damage input hash mismatch.');
    return artifact;
  });
  const authorized = new Set(validated.map(damageRefKey));
  if (
    authorized.size !== validated.length ||
    new Set(validated.map((a) => a.id)).size !== validated.length
  )
    throw new Error('Duplicate or conflicting input artifact versions.');
  const bundles = readBundles(validated);
  const result: DamageInputs = damageInputsSchema.parse({
    schema_version: 'haze.damage.inputs.v1',
    scope: bundles.find((b) => b.bundle.scope)?.bundle.scope,
    source_refs: validated.map(exactDamageRef),
    manifest: [],
    limitations: DAMAGE_LIMITATIONS,
  });
  let scopeCount = 0;
  for (const { artifact, bundle } of bundles) {
    const artifactRef = exactDamageRef(artifact);
    if (bundle.scope) {
      scopeCount++;
      result.scope = bundle.scope;
      result.manifest.push({
        artifact: artifactRef,
        table_type: 'scope',
        selected_rows: [0],
        access_classification: 'task-authorized',
        method_version: '1',
        native_support:
          'Declared scope, periods, population and social boundary.',
      });
    }
    for (const table of TABLES) {
      const rows = bundle[table];
      if (!rows.length) continue;
      result.manifest.push({
        artifact: artifactRef,
        table_type: table,
        selected_rows: rows.map((_, i) => i),
        access_classification: 'task-authorized',
        method_version: '1',
        native_support:
          'Exact retained rows in their declared native units and support; no scientific acceptance inferred.',
      });
      for (const row of rows) {
        if ('source_refs' in row) {
          for (const ref of row.source_refs) {
            artifactRefSchema.parse(ref);
            if (!authorized.has(damageRefKey(ref)))
              throw new Error(
                'Fabricated, unauthorized or mismatched damage source reference.',
              );
          }
          if (
            !row.source_refs.some(
              (ref) => damageRefKey(ref) === damageRefKey(artifactRef),
            )
          )
            row.source_refs.push(artifactRef);
        }
      }
      // Each table was independently schema-checked above; preserve the correlated table type.
      (result[table] as unknown[]).push(...rows);
    }
  }
  if (scopeCount !== 1)
    throw new Error('Exactly one declared damage scope is required.');
  return damageInputsSchema.parse(result);
}

function readBundles(artifacts: readonly Artifact[]) {
  return artifacts.map((artifact) => {
    let bundle: DamageImport;
    if (artifact.media_type === 'text/csv') {
      if (typeof artifact.content !== 'string')
        throw new Error('CSV input must contain text.');
      bundle = parseCsv(artifact.content);
    } else if (
      artifact.media_type === 'application/json' ||
      (typeof artifact.content === 'object' && artifact.content !== null)
    ) {
      bundle = damageImportSchema.parse(
        typeof artifact.content === 'string'
          ? parseContractJson(artifact.content)
          : artifact.content,
      );
    } else
      throw new Error(
        'Damage accounting imports support typed JSON and CSV only.',
      );
    return { artifact, bundle };
  });
}

export const damageComponentRefsSchema = z.record(
  z.string(),
  artifactRefSchema,
);
