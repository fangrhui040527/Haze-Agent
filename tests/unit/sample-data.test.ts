import { describe, expect, it } from 'vitest';
import {
  listSampleScenarios,
  loadSampleScenario,
  parseSampleScenario,
} from '../../app/sample-data/index.js';
import { analyzePm25 } from '../../app/capabilities/pm25/methods.js';
import { normalizeDamageInputs } from '../../app/capabilities/damage-appraisal/inputs.js';
import { compileDamageAccount } from '../../app/capabilities/damage-appraisal/methods.js';
import { artifactSchema } from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';

describe('raw synthetic sample scenarios', () => {
  it('loads exactly three distinct input scenarios with provenance and gaps', async () => {
    const manifests = await listSampleScenarios();
    expect(manifests.map(({ id }) => id)).toEqual([
      'evidence-investigation',
      'damage-account',
      'damage-reduction',
    ]);
    expect(manifests.map(({ kind }) => kind)).toEqual([
      'pm25',
      'damage-account',
      'damage-reduction',
    ]);
    for (const manifest of manifests) {
      expect(manifest.synthetic).toBe(true);
      expect(manifest.provenance.origin).toBe('locally-authored-synthetic');
      expect(manifest.gaps.length).toBeGreaterThan(0);
      expect(manifest).not.toHaveProperty('answer');
      expect(manifest).not.toHaveProperty('expected_results');
      expect(manifest).not.toHaveProperty('actions');
    }
  });

  it('preserves null and absent source samples for ordinary coverage calculation', async () => {
    const scenario = await loadSampleScenario('evidence-investigation');
    if (!('capture' in scenario)) throw new Error('Expected PM2.5 inputs.');
    expect(scenario.capture.rows.some(({ value }) => value === null)).toBe(
      true,
    );
    const analysis = analyzePm25(scenario.capture, scenario.manifest.scope);
    expect(analysis.coverage.status).toBe('partial');
    expect(analysis.coverage.observation_count).toBe(0);
    expect(analysis.coverage.missing_intervals).toEqual([
      {
        start: '2026-10-01T02:00:00.000Z',
        end: '2026-10-01T04:00:00.000Z',
      },
    ]);
    expect(scenario).not.toHaveProperty('analysis');
    expect(scenario).not.toHaveProperty('review');
    expect(() =>
      parseSampleScenario({
        ...scenario,
        capture: { ...scenario.capture, evidence_origin: 'modeled' },
      }),
    ).toThrow('explicitly synthetic');
    expect(() =>
      parseSampleScenario({
        ...scenario,
        capture: {
          ...scenario.capture,
          rows: scenario.capture.rows.map((row, index) =>
            index === 0 ? { ...row, value: 999 } : row,
          ),
        },
      }),
    ).toThrow('exact raw source row');
  });

  it('keeps missing mortality separate from supplied quantities and valuations', async () => {
    const scenario = await loadSampleScenario('damage-account');
    if (
      !('input' in scenario) ||
      scenario.input.schema_version !== 'haze.damage.import.v1'
    )
      throw new Error('Expected accounting inputs.');
    expect(
      scenario.input.effects.find(
        ({ endpoint_id }) => endpoint_id === 'mortality',
      ),
    ).toMatchObject({
      quantity: null,
      status: 'not_estimated',
      included: false,
    });
    expect(
      scenario.input.incidence.some(
        ({ financing_type }) => financing_type === 'transfer',
      ),
    ).toBe(true);
    expect(scenario.input).not.toHaveProperty('welfare_totals');
    expect(scenario.input).not.toHaveProperty('review');
    const source = artifactSchema.parse({
      schema_version: 'haze.artifact.v3',
      id: '705c7670-37ca-4b3c-9c85-bfbaf1b14d54',
      version: 1,
      sha256: contractHash(scenario.input),
      identity: {
        principal: 'sample-data-test',
        workspace: 'sample-data-test',
      },
      kind: 'source.import',
      producer: { kind: 'user', id: 'sample-data-test' },
      created_at: '2026-10-28T00:00:00Z',
      dependencies: [],
      required_tools: [],
      media_type: 'application/json',
      filename: 'damage-input.json',
      declared_origin: 'Hand-authored synthetic source input.',
      evidence_origin: 'synthetic_fixture',
      content: scenario.input,
    });
    const components = compileDamageAccount(normalizeDamageInputs([source]));
    expect(components['damage.physical'].totals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'treatment_cases' }),
        expect.objectContaining({ unit: 'lost_workdays' }),
      ]),
    );
    expect(components['damage.welfare'].excluded_effect_ids).toContain(
      'historical-mortality',
    );
    const effects = scenario.input.effects;
    expect(() =>
      parseSampleScenario({
        ...scenario,
        input: {
          ...scenario.input,
          effects: effects.map((effect, index) =>
            index === 0 ? { ...effect, origin: 'measured' } : effect,
          ),
        },
      }),
    ).toThrow('explicitly synthetic');
  });

  it('provides compatible non-overlapping prospective inputs and an unapproved proposal', async () => {
    const scenario = await loadSampleScenario('damage-reduction');
    if (!('candidate' in scenario))
      throw new Error('Expected intervention inputs.');
    expect(scenario.input.origin).toBe('synthetic');
    expect(scenario.candidate.approval.status).toBe('proposed');
    expect(scenario.candidate.claims).toEqual([]);
    expect(scenario.input.records).toHaveLength(4);
    const baseline = scenario.input.records.filter(
      ({ role }) => role === 'baseline',
    );
    const intervention = scenario.input.records.filter(
      ({ role }) => role === 'intervention',
    );
    expect(baseline.map(({ stratum_id }) => stratum_id).sort()).toEqual(
      intervention.map(({ stratum_id }) => stratum_id).sort(),
    );
    for (const record of scenario.input.records) {
      expect(record.scope).toEqual(scenario.target.scope);
      expect(record.evidence_basis).toBe('prospective');
      expect(record.quantity).not.toBeNull();
    }
    expect(scenario).not.toHaveProperty('assessment');
    expect(scenario).not.toHaveProperty('plan');
    expect(scenario).not.toHaveProperty('review');
    expect(() =>
      parseSampleScenario({
        ...scenario,
        candidate: {
          ...scenario.candidate,
          approval: { ...scenario.candidate.approval, status: 'approved' },
        },
      }),
    ).toThrow('synthetic proposals');
  });

  it('rejects unknown scenario IDs and manifest paths outside the declared inputs', async () => {
    await expect(loadSampleScenario('../README')).rejects.toThrow(
      'Unknown sample',
    );
    const scenario = await loadSampleScenario('evidence-investigation');
    expect(() =>
      parseSampleScenario({
        ...scenario,
        manifest: {
          ...scenario.manifest,
          inputs: { capture: '../private.json', notes: 'source-notes.md' },
        },
      }),
    ).toThrow();
  });
});
