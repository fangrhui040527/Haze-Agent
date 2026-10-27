import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireDamageEvidence,
  acquisitionRequestSchema,
  DamageEvidenceArchive,
  damageEvidenceSource,
  evidenceCompatibilityGaps,
  normalizeDamageEvidence,
  parseEvidenceCsv,
  planDamageEvidence,
  selectDamageEvidenceCase,
  type AcquisitionRequest,
  type DamageEvidenceScope,
} from '../../app/capabilities/damage-evidence/index.js';

const directories: string[] = [];
const archive = () => {
  const path = mkdtempSync(join(tmpdir(), 'damage-evidence-'));
  directories.push(path);
  return new DamageEvidenceArchive(path);
};
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const request = (
  source_id = 'dosm-district-population',
  period = { start: '2024-09-01', end: '2024-09-30' },
): AcquisitionRequest =>
  acquisitionRequestSchema.parse({
    source_id,
    selection: { state: 'Selangor', district: 'Klang', period },
  });
const population =
  'state,district,date,sex,age,ethnicity,population\nSelangor,Klang,2024-01-01,both,overall,overall,1174.7\nSelangor,Klang,2024-01-01,male,overall,overall,600\nSelangor,Petaling,2024-01-01,both,overall,overall,2000\n';
const scope: DamageEvidenceScope = {
  geography: {
    country: 'MY',
    level: 'district',
    id: 'MY:Selangor:Klang',
    name: 'Klang',
    boundary_version: 'test-only-boundary',
  },
  occurrence_period: { start: '2024-09-01', end: '2024-09-30' },
  outcome: 'deaths',
  attribution_basis: 'fire_attributed',
  monetary_view: 'physical_only',
  currency: null,
  price_year: null,
};
const fakeFetch =
  (body: string, headers?: Record<string, string>): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(body, { status: 200, ...(headers ? { headers } : {}) }),
    );
const signal = () => new AbortController().signal;

describe('damage evidence acquisition and feasibility', () => {
  it('normalizes thousands of persons once with exact original CSV row support', () => {
    const normalized = normalizeDamageEvidence(
      damageEvidenceSource(request().source_id),
      Buffer.from(population),
      request().selection,
    );
    expect(normalized.gaps).toEqual([]);
    expect(normalized.values).toHaveLength(1);
    expect(normalized.values[0]).toMatchObject({
      value: 1_174_700,
      unit: 'persons',
      source_locator: '/csv/record/2/population',
      transformation: {
        original_value: 1174.7,
        factor: 1000,
        original_unit: 'thousand_persons',
      },
    });
  });

  it('rejects duplicate selected strata instead of double counting', () => {
    expect(() =>
      normalizeDamageEvidence(
        damageEvidenceSource(request().source_id),
        Buffer.from(
          population +
            'Selangor,Klang,2024-01-01,both,overall,overall,1174.7\n',
        ),
        request().selection,
      ),
    ).toThrow(/Overlapping/);
  });

  it('preserves missing values and rejects periods outside source evidence', () => {
    const missing = normalizeDamageEvidence(
      damageEvidenceSource(request().source_id),
      Buffer.from(population.replace('1174.7', '')),
      request().selection,
    );
    expect(missing.values).toHaveLength(0);
    expect(missing.gaps.join(' ')).toContain('not zero');
    const historic = request('dosm-district-population', {
      start: '2015-09-01',
      end: '2015-09-30',
    });
    expect(
      normalizeDamageEvidence(
        damageEvidenceSource(historic.source_id),
        Buffer.from(population),
        historic.selection,
      ).values,
    ).toEqual([]);
  });

  it('handles quoted CSV values and multiline records', () => {
    expect(parseEvidenceCsv('a,b\r\n"a,b","two\nlines"\r\n')).toEqual([
      ['a', 'b'],
      ['a,b', 'two\nlines'],
    ]);
    expect(() => parseEvidenceCsv('a,"unfinished')).toThrow(/Unterminated/);
  });

  it('keeps PM10 and Air Pollutant Index distinct from PM2.5 concentration', () => {
    const source = damageEvidenceSource('malaysia-monthly-pollution');
    const pm10 = normalizeDamageEvidence(
      source,
      Buffer.from(
        JSON.stringify([
          { date: '2024-09-01', pollutant: 'PM 10', concentration: 40 },
        ]),
      ),
      request().selection,
    );
    expect(pm10.values).toEqual([]);
    expect(pm10.gaps.join(' ')).toContain('non-PM2.5');
    const modeled = damageEvidenceSource('open-meteo-air-quality');
    expect(() =>
      normalizeDamageEvidence(
        modeled,
        Buffer.from(
          JSON.stringify({
            latitude: 3,
            longitude: 101,
            hourly_units: { pm2_5: 'AQI' },
            hourly: { time: ['2024-09-01T00:00'], pm2_5: [30] },
          }),
        ),
        request().selection,
      ),
    ).toThrow(/unit mismatch/);
  });

  it('retains immutable originals, deduplicates unchanged captures and survives restart/failure', async () => {
    const first = archive();
    let now = new Date('2026-10-27T01:00:00Z');
    const options = {
      signal: signal(),
      fetch: fakeFetch(population),
      now: () => now,
      sleep: (ms: number) => {
        now = new Date(now.getTime() + ms);
        return Promise.resolve();
      },
    };
    const result = await acquireDamageEvidence(first, request(), options);
    expect(result.capture.stage).toBe('validated');
    expect(first.readRaw(result.capture.raw_ref).toString()).toBe(population);
    const restarted = new DamageEvidenceArchive(first.root);
    const repeated = await acquireDamageEvidence(restarted, request(), options);
    expect(repeated.unchanged).toBe(true);
    expect(restarted.listCaptures()).toHaveLength(1);
    await expect(
      acquireDamageEvidence(restarted, request(), {
        ...options,
        fetch: () =>
          Promise.resolve(new Response('unavailable', { status: 503 })),
      }),
    ).rejects.toThrow('503');
    expect(restarted.attempts(request())).toHaveLength(3);
    expect(restarted.availability(request(), now)).toMatchObject({
      current_availability: 'unavailable',
      last_usable_capture: { capture_id: result.capture.capture_id },
      latest_attempt: { status: 'failed', http_status: 503 },
    });
  });

  it('persists provider throttles and cancellation attempts without making a request', async () => {
    const target = archive();
    let current = new Date('2026-10-27T01:00:00Z');
    let waited = 0;
    const options = {
      signal: signal(),
      now: () => current,
      fetch: fakeFetch('[]'),
      sleep: (ms: number) => {
        waited += ms;
        current = new Date(current.getTime() + ms);
        return Promise.resolve();
      },
    };
    await acquireDamageEvidence(
      target,
      request('dosm-district-deaths'),
      options,
    );
    await acquireDamageEvidence(
      new DamageEvidenceArchive(target.root),
      request('dosm-selangor-wages'),
      options,
    );
    expect(waited).toBe(15_100);
    const cancelled = new AbortController();
    cancelled.abort();
    let calls = 0;
    await expect(
      acquireDamageEvidence(target, request(), {
        signal: cancelled.signal,
        fetch: () => {
          calls++;
          return Promise.resolve(new Response(population));
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(target.attempts(request())[0]?.status).toBe('cancelled');
  });

  it('retains raw bytes when normalization rejects a response and never calls it validated', async () => {
    const target = archive();
    const result = await acquireDamageEvidence(target, request(), {
      signal: signal(),
      fetch: fakeFetch('a,changed\n1,2\n'),
    });
    expect(result.capture.stage).toBe('acquired');
    expect(result.capture.gaps.join(' ')).toContain('columns changed');
    expect(target.readRaw(result.capture.raw_ref).length).toBeGreaterThan(0);
  });

  it('enforces streaming byte bounds and records rejected attempts', async () => {
    const target = archive();
    await expect(
      acquireDamageEvidence(target, request(), {
        signal: signal(),
        fetch: fakeFetch(population),
        source: {
          ...damageEvidenceSource(request().source_id),
          maximum_bytes: 5,
        },
      }),
    ).rejects.toThrow(/byte bound/);
    expect(target.attempts(request())[0]?.status).toBe('failed');
    expect(target.listCaptures()).toHaveLength(0);
  });

  it('retains bounded same-host redirects and rejects unregistered destinations', async () => {
    const target = archive();
    let calls = 0;
    const result = await acquireDamageEvidence(target, request(), {
      signal: signal(),
      fetch: () =>
        Promise.resolve(
          ++calls === 1
            ? new Response(null, {
                status: 301,
                headers: { location: '/population/current.csv' },
              })
            : new Response(population),
        ),
    });
    expect(result.capture.redirect_chain).toEqual([
      'https://storage.dosm.gov.my/population/current.csv',
    ]);
    const rejected = archive();
    await expect(
      acquireDamageEvidence(rejected, request(), {
        signal: signal(),
        fetch: () =>
          Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://unregistered.invalid/data' },
            }),
          ),
      }),
    ).rejects.toThrow(/registered HTTPS host/);
    expect(rejected.attempts(request())[0]?.status).toBe('failed');
  });

  it('marks a successful HTTP browser challenge as a document gap, not usable published evidence', () => {
    const source = damageEvidenceSource('crippa-2016-acute-mortality-pmc');
    const result = normalizeDamageEvidence(
      source,
      Buffer.from('<title>Checking your browser - reCAPTCHA</title>'),
      request().selection,
    );
    expect(result.excerpt).toBeNull();
    expect(result.gaps.join(' ')).toContain(
      'not the requested source document',
    );
    expect(
      selectDamageEvidenceCase([
        {
          id: 'blocked',
          scope,
          retained: [],
          rationale: 'No original acquired.',
        },
      ]).selected_candidate,
    ).toBeNull();
  });

  it('checks retained evidence before search and never confuses acquisition with applicability', async () => {
    const result = await acquireDamageEvidence(archive(), request(), {
      signal: signal(),
      fetch: fakeFetch(population),
    });
    expect(
      evidenceCompatibilityGaps(scope, result.capture).join(' '),
    ).toContain('boundary version');
    const compatibleCapture = {
      ...result.capture,
      normalized_values: result.capture.normalized_values.map((value) => ({
        ...value,
        geography: {
          ...value.geography,
          boundary_version: scope.geography.boundary_version,
        },
      })),
    };
    const plan = planDamageEvidence(scope, [compatibleCapture]);
    expect(
      plan.requirements.find((requirement) => requirement.id === 'population'),
    ).toMatchObject({
      stage: 'validated',
      retained_captures: [result.capture.capture_id],
    });
    expect(plan.quantified_outputs_permitted).toBe(false);
    expect(plan.interventions.map((item) => item.estimate)).toEqual([
      null,
      null,
    ]);
    expect(
      plan.requirements.some(
        (requirement) =>
          requirement.id === 'fire_attribution' &&
          requirement.stage === 'missing',
      ),
    ).toBe(true);
    const wrongPeriod = {
      ...scope,
      occurrence_period: { start: '2015-09-01', end: '2015-09-30' },
    };
    expect(
      evidenceCompatibilityGaps(wrongPeriod, result.capture).join(' '),
    ).toContain('occurrence period');
    const cases = selectDamageEvidenceCase([
      {
        id: '2015',
        scope: wrongPeriod,
        retained: [compatibleCapture],
        rationale:
          'Old synthetic episode date, deliberately incompatible with current population.',
      },
      {
        id: '2024',
        scope,
        retained: [compatibleCapture],
        rationale:
          'Better compatible public context; no historical health effect assumed.',
      },
    ]);
    expect(cases.selected_candidate).toBe('2024');
    expect(cases.quantified_outputs_permitted).toBe(false);
    expect(cases.rejected_alternatives[0]?.id).toBe('2015');
  });

  it('keeps the last validated capture when a later HTTP200 response fails normalization', async () => {
    const target = archive();
    const firstTime = new Date('2026-10-27T01:00:00Z');
    const first = await acquireDamageEvidence(target, request(), {
      signal: signal(),
      fetch: fakeFetch(population),
      now: () => firstTime,
    });
    const secondTime = new Date(firstTime.getTime() + 20_000);
    const rejected = await acquireDamageEvidence(target, request(), {
      signal: signal(),
      fetch: fakeFetch('changed,column\n1,2'),
      now: () => secondTime,
    });
    expect(rejected.capture.stage).toBe('acquired');
    expect(
      new DamageEvidenceArchive(target.root).availability(
        request(),
        secondTime,
      ),
    ).toMatchObject({
      current_availability: 'unavailable',
      last_usable_capture: { capture_id: first.capture.capture_id },
      age_seconds: 20,
      latest_attempt: {
        status: 'succeeded',
        capture_id: rejected.capture.capture_id,
      },
    });
  });

  it('keeps whitespace, nonnumeric values and overflow as gaps instead of zero or null quantities', () => {
    const source = damageEvidenceSource('dosm-district-population');
    for (const value of [' ', '   ', 'null', 'NaN', '1e308']) {
      const result = normalizeDamageEvidence(
        source,
        Buffer.from(population.replace('1174.7', value)),
        request().selection,
      );
      expect(result.values).toEqual([]);
      expect(result.gaps.length).toBeGreaterThan(0);
    }
  });

  it('bounds missingness details and retained-ref inventories with explicit omission counts', async () => {
    const source = damageEvidenceSource('open-meteo-air-quality');
    const result = normalizeDamageEvidence(
      source,
      Buffer.from(
        JSON.stringify({
          latitude: 3,
          longitude: 101,
          hourly_units: { pm2_5: 'ug/m3' },
          hourly: {
            time: Array<string>(25_000).fill('2024-09-01T00:00'),
            pm2_5: Array<null>(25_000).fill(null),
          },
        }),
      ),
      request().selection,
    );
    expect(result.gaps.length).toBeLessThanOrEqual(200);
    expect(result.omitted_gap_count).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1_048_576);
    const acquired = await acquireDamageEvidence(archive(), request(), {
      signal: signal(),
      fetch: fakeFetch(population),
    });
    const captures = Array.from({ length: 500 }, (_, index) => ({
      ...acquired.capture,
      capture_id: index.toString(16).padStart(64, '0'),
    }));
    const requirement = planDamageEvidence(scope, captures).requirements.find(
      (entry) => entry.id === 'population',
    );
    expect(requirement).toMatchObject({
      retained_capture_count: 500,
      omitted_retained_capture_count: 400,
    });
    expect(requirement?.retained_captures).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(requirement))).toBeLessThan(
      1_048_576,
    );
  });
});
