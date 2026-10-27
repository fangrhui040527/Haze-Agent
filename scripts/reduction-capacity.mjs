import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { contractHash } from '../dist/contracts/json.js';
import { createReductionCapacityFixture } from '../dist/capabilities/damage-reduction-planning/capacity-fixtures.js';
import { assessReduction } from '../dist/capabilities/damage-reduction-planning/methods.js';
import { independentlyCheckReduction } from '../dist/capabilities/damage-reduction-planning/checker.js';

// Local engineering acceptance limits fixed before measurement, not production SLOs.
export const CAPACITY_ACCEPTANCE = {
  kernel_iteration_ms: 5000,
  task_latency_ms: 30000,
  kernel_process_peak_rss_bytes: 512 * 1024 * 1024,
  api_process_peak_rss_bytes: 1024 * 1024 * 1024,
  warm_repetitions: 5,
};

export const capacityCases = () => [
  { id: 'small', rows: 2, originals: 2 },
  { id: 'medium', rows: 100, originals: 8 },
  { id: 'large', rows: 500, originals: 16 },
  { id: 'exact-byte-limit', rows: 500, originals: 16, bytes: 524288 },
  {
    id: 'byte-limit-plus-one',
    rows: 500,
    originals: 16,
    bytes: 524289,
    reason: 'normalized_input_byte_limit_exceeded',
  },
  {
    id: 'row-ceiling-hits-byte-limit',
    rows: 1000,
    originals: 16,
    reason: 'normalized_input_byte_limit_exceeded',
  },
  {
    id: 'aggregate-row-limit',
    rows: 1002,
    originals: 16,
    reason: 'selected_row_limit_exceeded',
  },
];

export function verifyCapacityKernel() {
  const measurements = [];
  for (const entry of capacityCases()) {
    const fixture = createReductionCapacityFixture(
      entry.rows,
      entry.originals,
      entry.bytes,
    );
    const times = [];
    for (let run = 0; run <= CAPACITY_ACCEPTANCE.warm_repetitions; run++) {
      const started = performance.now();
      const selectionRef = {
        id: randomUUID(),
        version: 1,
        sha256: contractHash(fixture.selection),
      };
      const assessment = assessReduction(
        fixture.selection,
        fixture.artifacts,
        selectionRef,
      );
      const review = independentlyCheckReduction(
        fixture.selection,
        fixture.artifacts,
        selectionRef,
        assessment,
        { id: randomUUID(), version: 1, sha256: contractHash(assessment) },
        { assignment_id: randomUUID(), revision: 1 },
      );
      const elapsed = performance.now() - started;
      assert.equal(
        review.verdict,
        'supported',
        JSON.stringify(review.findings),
      );
      if (entry.reason) {
        assert.equal(assessment.status, 'gap');
        assert.deepEqual(assessment.reasons, [entry.reason]);
        assert.equal(assessment.target_met, null);
      } else {
        assert.equal(assessment.status, 'supported');
        assert.equal(
          assessment.baseline_damage,
          String((entry.rows / 2) * 100),
        );
        assert.equal(
          assessment.intervention_damage,
          String((entry.rows / 2) * 88),
        );
        assert.equal(
          assessment.absolute_reduction,
          String((entry.rows / 2) * 12),
        );
        assert.equal(assessment.target_met, true);
      }
      assert.ok(
        elapsed <= CAPACITY_ACCEPTANCE.kernel_iteration_ms,
        `${entry.id} exceeded kernel acceptance: ${elapsed} ms`,
      );
      times.push(elapsed);
    }
    const warm = times.slice(1).sort((a, b) => a - b);
    measurements.push({
      ...entry,
      normalized_bytes: fixture.normalized_bytes,
      first_iteration_ms: times[0],
      warm_p50_ms: warm[Math.ceil(warm.length * 0.5) - 1],
      warm_p95_ms: warm[Math.ceil(warm.length * 0.95) - 1],
      warm_iterations_ms: warm,
      expected_status: entry.reason ? 'gap' : 'supported',
    });
  }
  const peakRss = process.resourceUsage().maxRSS * 1024;
  assert.ok(
    peakRss <= CAPACITY_ACCEPTANCE.kernel_process_peak_rss_bytes,
    `Kernel process exceeded memory acceptance: ${peakRss} bytes`,
  );
  return {
    acceptance: CAPACITY_ACCEPTANCE,
    measurements,
    kernel_process_peak_rss_bytes: peakRss,
    limitations: [
      'First/warm in-process iterations are measured; isolated cold-process distributions are not measured.',
      'Kernel peak RSS is the parent process high-water mark, including module/fixture overhead.',
      'Row and byte ceilings apply together. Even short metadata makes this 1000-row fixture exceed 512 KiB.',
    ],
  };
}
