import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { parsePlanningPackage } from './damage-planning-package.mjs';
import {
  SYNTHETIC_REDUCTION_TARGET,
  syntheticResidualImport,
} from '../dist/capabilities/damage-reduction-planning/fixtures.js';
import { syntheticReductionCandidate } from '../dist/capabilities/damage-reduction-planning/planning-fixtures.js';

// These declarations test validation only; they are never live demonstration data.
function packageInput() {
  return {
    schema_version: 'haze.reduction.live-package.v1',
    target: structuredClone(SYNTHETIC_REDUCTION_TARGET),
    candidate: syntheticReductionCandidate(),
    sources: [
      {
        name: 'residuals',
        input: { ...syntheticResidualImport(), origin: 'supplied' },
        row_ids: ['baseline-1', 'intervention-1'],
      },
    ],
  };
}

test('validates existing target, residual and candidate schemas without filling quantities', () => {
  const input = packageInput();
  const result = parsePlanningPackage(input);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.package.candidate.costs[0].amount, null);
  assert.deepEqual(result.package.target, input.target);
});

test('rejects synthetic inputs and names missing quantities and incompatible scope', () => {
  const input = packageInput();
  input.sources[0].input.origin = 'synthetic';
  input.sources[0].input.records[1].quantity = null;
  input.sources[0].input.records[1].scope.unit = 'other-unit';
  assert.deepEqual(parsePlanningPackage(input).gaps, [
    'supplied_residual_input_required:residuals',
    'incompatible_scope:residuals:intervention-1',
    'unknown_residual_quantity:residuals:intervention-1',
  ]);
});

test('does not silently select rows or accept missing and repeated identifiers', () => {
  const input = packageInput();
  input.sources[0].row_ids = ['baseline-1', 'baseline-1', 'missing'];
  assert.deepEqual(parsePlanningPackage(input).gaps, [
    'duplicate_selected_row:residuals:baseline-1',
    'selected_row_missing:residuals:missing',
    'missing_intervention_rows',
  ]);
});

test('rejects malformed candidate or target without inventing a package', () => {
  for (const field of ['candidate', 'target']) {
    const input = packageInput();
    delete input[field];
    const result = parsePlanningPackage(input);
    assert.equal(result.package, null);
    assert.ok(
      result.gaps.some((gap) => gap.startsWith(`invalid_package:${field}:`)),
    );
  }
});

test('names candidate evidence references that cannot resolve in the fresh verifier store', () => {
  const reference = { id: randomUUID(), version: 1, sha256: 'a'.repeat(64) };
  for (const evidenceList of [
    (candidate) => candidate.approval.evidence,
    (candidate) => candidate.costs[0].evidence,
    (candidate) => candidate.dependencies[0].evidence,
  ]) {
    const input = packageInput();
    evidenceList(input.candidate).push(reference);
    assert.deepEqual(parsePlanningPackage(input).gaps, [
      'unsupported_candidate_evidence_refs',
    ]);
  }
});
