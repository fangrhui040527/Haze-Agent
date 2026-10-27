import { randomUUID } from 'node:crypto';
import type { Artifact } from '../../contracts/artifacts.js';
import type {
  PhysicalResidualImport,
  ReductionTarget,
} from '../../contracts/damage-reduction.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import { createReductionSelection, exactReductionRef } from './inputs.js';

/** Entirely invented engineering data; short metadata is intentional and disclosed. */
export function createReductionCapacityFixture(
  rows: number,
  originals: number,
  normalizedBytes?: number,
) {
  if (
    !Number.isInteger(rows) ||
    rows < 2 ||
    rows > 1002 ||
    !Number.isInteger(originals) ||
    originals < 1 ||
    originals > 16 ||
    originals > rows
  )
    throw new Error('invalid_capacity_fixture_size');
  const target: ReductionTarget = {
    scope: {
      endpoint: 'synthetic days',
      unit: 'days',
      population: 'fixture',
      geography: 'fixture',
      pollutant: 'fixture',
      period: { start: '2027-01-01', end: '2027-01-31' },
      coverage: 'all',
      missingness: 'none',
      exclusions: [],
    },
    target_fraction: '0.1',
    relation: 'at_least',
    comparator: 'B',
    intervention: 'I',
    assessment_rule: 'point_estimate',
  };
  const inputs: PhysicalResidualImport[] = Array.from(
    { length: originals },
    () => ({
      schema_version: 'haze.reduction.physical-import.v1',
      origin: 'synthetic',
      records: [],
    }),
  );
  for (let index = 0; index < rows; index++) {
    const baseline = index % 2 === 0;
    const stratum = `s${Math.floor(index / 2)}`;
    inputs[index % originals]!.records.push({
      row_id: `r${index}`,
      role: baseline ? 'baseline' : 'intervention',
      scenario: baseline ? 'B' : 'I',
      evidence_basis: 'prospective',
      scope: structuredClone(target.scope),
      stratum_id: stratum,
      support_ids: [stratum],
      quantity: baseline ? '100' : '88',
      original_method: { id: 'synthetic', version: '1' },
      applicability: 'synthetic',
    });
  }
  const artifacts: Artifact[] = inputs.map((content) => ({
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    identity: { principal: 'fixture', workspace: 'fixture' },
    kind: 'artifact.import',
    producer: { kind: 'user', id: 'fixture' },
    created_at: '2026-10-27T00:00:00Z',
    dependencies: [],
    required_tools: [],
    evidence_origin: 'synthetic_fixture',
    content,
  }));
  const measure = () =>
    Buffer.byteLength(
      canonicalJson(
        inputs.flatMap((input, index) =>
          input.records.map((record) => ({
            ...record,
            source_ref: exactReductionRef(artifacts[index]!),
            origin: input.origin,
          })),
        ),
        8_388_608,
      ),
    );
  if (normalizedBytes !== undefined) {
    let remaining = normalizedBytes - measure();
    if (!Number.isSafeInteger(normalizedBytes) || remaining < 0)
      throw new Error('capacity_padding_target_too_small');
    for (const input of inputs)
      for (const row of input.records) {
        const padding = Math.min(remaining, 4096 - row.applicability.length);
        row.applicability += 'x'.repeat(padding);
        remaining -= padding;
      }
    if (remaining) throw new Error('capacity_padding_target_too_large');
    artifacts.forEach((artifact) => {
      artifact.sha256 = contractHash(artifact.content);
    });
  }
  const selection = createReductionSelection(
    target,
    artifacts.map((artifact, index) => ({
      artifact: exactReductionRef(artifact),
      row_ids: inputs[index]!.records.map(({ row_id }) => row_id),
    })),
  );
  return { target, artifacts, selection, normalized_bytes: measure() };
}
