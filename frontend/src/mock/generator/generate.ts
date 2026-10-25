import { bandForPm25, bandIndex, bandLabel } from '../../shared/lib/bands.ts';
import { createRng, type Rng } from '../../shared/lib/random.ts';
import {
  DATASET_SCHEMA_VERSION,
  type DemoDataset,
} from '../../shared/types/dataset.ts';
import type {
  AgentResult,
  CategoryId,
  EvidenceCheck,
  FireInfo,
  ForecastInfo,
  HazeItem,
  Impact,
  ImpactKind,
  ItemSourceRef,
  ItemStatus,
  Measurement,
  SourceKind,
  TimelineEntry,
  Trend,
  Weather,
} from '../../shared/types/domain.ts';
import { CHAT_SCRIPTS } from './chatScripts.ts';
import {
  COUNTRY_FOCUS,
  locationsFor,
  type Coverage,
  type LocationProfile,
  type LocationSeed,
} from './locations.ts';
import { SOURCE_SEEDS, type SourceSeed } from './sources.ts';
import {
  detailsFor,
  headlineFor,
  LONG_TEXT,
  summaryFor,
  type TextFacts,
} from './text.ts';

export const DEMO_NOTICE =
  'FICTIONAL DEMO DATA. Every value, source and event in this file is invented to test the Haze interface. Do not use it for health or safety decisions.';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Everything makeItem() needs. Build one with createContext(). */
export interface GenContext {
  rng: Rng;
  nowMs: number;
  locations: readonly LocationSeed[];
  sources: readonly SourceSeed[];
  nextId: () => string;
}

export interface ItemOverrides {
  location?: LocationSeed;
  category?: CategoryId;
  status?: ItemStatus;
  /** Multiplies the location's typical PM2.5. */
  pm25Multiplier?: number;
  /** Exact PM2.5 (null = no data). Overrides the multiplier. */
  pm25?: number | null;
  /** How long ago the record was updated. 0 = now. */
  ageHours?: number;
  forecastDirection?: ForecastInfo['direction'];
  tags?: string[];
}

export function createContext(
  seed: number,
  nowMs: number,
  locations: readonly LocationSeed[] = locationsFor('asean'),
  sources: readonly SourceSeed[] = SOURCE_SEEDS,
  idPrefix = `itm-${seed.toString(36)}`,
): GenContext {
  let counter = 0;
  return {
    rng: createRng(seed),
    nowMs,
    locations,
    sources,
    nextId: () => `${idPrefix}-${String(++counter).padStart(4, '0')}`,
  };
}

const iso = (ms: number) =>
  new Date(Math.round(ms / 1000) * 1000).toISOString();

// ---------------------------------------------------------------------------
// Picking helpers
// ---------------------------------------------------------------------------

function pickLocation(ctx: GenContext): LocationSeed {
  // Haze-prone places and focus countries (Malaysia, then Indonesia) get more items,
  // but every place can appear.
  return ctx.rng.weighted(
    ctx.locations.map(
      (l) =>
        [
          l,
          (Math.sqrt(l.profile.basePm25) + 2) *
            (COUNTRY_FOCUS[l.location.countryCode] ?? 1),
        ] as const,
    ),
  );
}

function pickCategory(ctx: GenContext, profile: LocationProfile): CategoryId {
  return ctx.rng.weighted<CategoryId>([
    ['reading', 30],
    ['hotspot', profile.fireLand ? 12 : 2],
    ['forecast', 14],
    ['advisory', profile.basePm25 > 50 ? 10 : 4],
    ['health', 6],
    ['disruption', profile.basePm25 > 60 ? 10 : 4],
    ['news', 10],
    ['community', 7],
    ['sensor_issue', 3],
  ]);
}

function pickStatus(
  ctx: GenContext,
  category: CategoryId,
  ageHours: number,
): ItemStatus {
  if (category === 'sensor_issue')
    return ctx.rng.chance(0.7) ? 'stale' : 'unverified';
  if (category === 'news' || category === 'community') {
    return ctx.rng.weighted<ItemStatus>([
      ['unverified', 45],
      ['partial', 25],
      ['verified', 15],
      ['conflicting', 10],
      ['retracted', 3],
    ]);
  }
  return ctx.rng.weighted<ItemStatus>([
    ['verified', 55],
    ['partial', 18],
    ['unverified', 8],
    ['conflicting', 8],
    ['stale', ageHours > 12 ? 18 : 2],
    ['retracted', 2],
  ]);
}

function samplePm25(
  ctx: GenContext,
  profile: LocationProfile,
  multiplier: number,
): number {
  const spread = Math.exp(ctx.rng.float(-0.6, 0.6));
  const spike = ctx.rng.chance(0.05) ? 2.5 : 1;
  return Math.max(
    1,
    Math.round(profile.basePm25 * multiplier * spread * spike),
  );
}

function maybeNull(
  ctx: GenContext,
  n: number,
  probability = 0.08,
): number | null {
  return ctx.rng.chance(probability) ? null : n;
}

function measurementsFor(
  ctx: GenContext,
  category: CategoryId,
  pm25: number | null,
): Measurement[] {
  const pm = (
    pollutant: Measurement['pollutant'],
    value: number | null,
    unit: Measurement['unit'] = 'µg/m³',
  ): Measurement => ({
    pollutant,
    value,
    unit,
    averaging: '1h',
  });
  const pm10 =
    pm25 === null ? null : Math.round(pm25 * ctx.rng.float(1.2, 1.9));
  switch (category) {
    case 'reading':
      return [
        pm('pm25', pm25),
        pm('pm10', pm10 === null ? null : maybeNull(ctx, pm10)),
        pm('o3', maybeNull(ctx, ctx.rng.int(8, 80)), 'ppb'),
        pm('no2', maybeNull(ctx, ctx.rng.int(4, 60)), 'ppb'),
        pm(
          'co',
          maybeNull(ctx, Math.round(ctx.rng.float(0.2, 3.5) * 10) / 10),
          'mg/m³',
        ),
        pm('so2', maybeNull(ctx, ctx.rng.int(1, 25)), 'ppb'),
      ];
    case 'hotspot':
    case 'advisory':
    case 'health':
    case 'disruption':
      return [pm('pm25', pm25), pm('pm10', pm10)];
    case 'news':
      return pm25 !== null && ctx.rng.chance(0.5) ? [pm('pm25', pm25)] : [];
    case 'sensor_issue':
      return [pm('pm25', null)];
    case 'forecast':
    case 'community':
      return [];
  }
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

function weatherFor(ctx: GenContext, pm25: number | null): Weather {
  const visibility =
    pm25 === null
      ? ctx.rng.float(5, 20)
      : Math.max(0.3, 25 - pm25 / 8 + ctx.rng.float(-2, 2));
  return {
    windSpeedKmh: maybeNull(ctx, ctx.rng.int(0, 35), 0.05),
    windDirection: ctx.rng.chance(0.05) ? null : ctx.rng.pick(COMPASS),
    humidityPct: maybeNull(ctx, ctx.rng.int(35, 98), 0.05),
    rainMm: maybeNull(
      ctx,
      ctx.rng.chance(0.7) ? 0 : Math.round(ctx.rng.float(0.2, 25) * 10) / 10,
      0.05,
    ),
    visibilityKm: maybeNull(ctx, Math.round(visibility * 10) / 10, 0.05),
    temperatureC: maybeNull(ctx, ctx.rng.int(-5, 38), 0.05),
  };
}

function fireFor(ctx: GenContext, profile: LocationProfile): FireInfo {
  return {
    hotspotCount: ctx.rng.int(
      3,
      Math.max(10, Math.round(profile.basePm25 * 3)),
    ),
    maxFrpMw: maybeNull(ctx, Math.round(ctx.rng.float(5, 450)), 0.1),
    landType: profile.fireLand ?? 'mixed',
    detectionConfidence: ctx.rng.weighted([
      ['high', 3],
      ['nominal', 5],
      ['low', 2],
    ] as const),
  };
}

const IMPACT_TEXT: Record<
  ImpactKind,
  (name: string, count: number | null) => string
> = {
  school_closure: (n, c) =>
    `${c ?? 'Several'} schools in ${n} switched to home learning.`,
  flight_delay: (n, c) =>
    `${c ?? 'Several'} flights at ${n} airport were delayed by low visibility.`,
  hospital_visits: (n) =>
    `Clinics in ${n} report more visits for coughs and breathing problems (fictional).`,
  event_cancelled: (n, c) =>
    `${c ?? 'Several'} outdoor events in ${n} were cancelled or postponed.`,
  outdoor_work_advisory: (n) =>
    `Employers in ${n} were reminded to follow official outdoor-work guidance.`,
  transport: (n) =>
    `Ferries and some road services around ${n} ran slower because of poor visibility.`,
};

function impactsFor(
  ctx: GenContext,
  category: CategoryId,
  name: string,
): Impact[] {
  const make = (kind: ImpactKind): Impact => {
    const count =
      kind === 'school_closure'
        ? ctx.rng.int(5, 900)
        : kind === 'flight_delay'
          ? ctx.rng.int(3, 120)
          : kind === 'event_cancelled'
            ? ctx.rng.int(1, 30)
            : null;
    return { kind, count, description: IMPACT_TEXT[kind](name, count) };
  };
  if (category === 'disruption') {
    const kinds = ctx.rng.shuffle<ImpactKind>([
      'school_closure',
      'flight_delay',
      'event_cancelled',
      'transport',
      'hospital_visits',
    ]);
    return kinds.slice(0, ctx.rng.int(1, 2)).map(make);
  }
  if (category === 'advisory' && ctx.rng.chance(0.5))
    return [make('outdoor_work_advisory')];
  if (category === 'health' && ctx.rng.chance(0.4))
    return [make('hospital_visits')];
  return [];
}

// ---------------------------------------------------------------------------
// Sources and evidence
// ---------------------------------------------------------------------------

const SOURCE_PLAN: Record<
  CategoryId,
  { primary: SourceKind[]; supporting: SourceKind[] }
> = {
  reading: {
    primary: ['ground_monitor'],
    supporting: ['low_cost_sensor', 'satellite', 'government'],
  },
  hotspot: { primary: ['satellite'], supporting: ['government', 'news'] },
  forecast: { primary: ['forecast_model'], supporting: ['government'] },
  advisory: { primary: ['government'], supporting: ['ground_monitor', 'news'] },
  health: { primary: ['government'], supporting: ['ground_monitor'] },
  disruption: { primary: ['news'], supporting: ['government', 'community'] },
  news: { primary: ['news'], supporting: ['community'] },
  community: { primary: ['community'], supporting: ['low_cost_sensor'] },
  sensor_issue: { primary: ['ground_monitor'], supporting: [] },
};

function coversRegion(s: SourceSeed, region: string): boolean {
  return (
    s.scope === 'global' || (s.scope as readonly string[]).includes(region)
  );
}

function sourcesOfKind(
  ctx: GenContext,
  seed: LocationSeed,
  kinds: SourceKind[],
): SourceSeed[] {
  const inScope = ctx.sources.filter(
    (s) =>
      kinds.includes(s.source.kind) && coversRegion(s, seed.location.region),
  );
  // Prefer regional sources over global ones.
  const regional = inScope.filter((s) => s.scope !== 'global');
  return regional.length > 0
    ? [...regional, ...inScope.filter((s) => s.scope === 'global')]
    : inScope;
}

function excerptFor(
  ctx: GenContext,
  s: SourceSeed,
  f: TextFacts,
  valueOverride?: number | null,
): string {
  const pm25 = valueOverride === undefined ? f.pm25 : valueOverride;
  const name = f.seed.location.name;
  switch (s.source.kind) {
    case 'ground_monitor':
      return pm25 === null
        ? `Station ${f.stationCode} reported no data for this hour.`
        : `Station ${f.stationCode} reported 1-h PM2.5 of ${pm25} µg/m³.`;
    case 'low_cost_sensor':
      return pm25 === null
        ? 'Nearby sensors were offline.'
        : `${ctx.rng.int(3, 25)} nearby sensors averaged ${Math.round(pm25 * ctx.rng.float(0.9, 1.25))} µg/m³ (uncorrected).`;
    case 'satellite':
      return `${f.fire?.hotspotCount ?? ctx.rng.int(0, 40)} heat anomalies within 50 km; aerosol optical depth ${ctx.rng.float(0.2, 3).toFixed(2)}.`;
    case 'forecast_model':
      return `Forecast PM2.5 ${f.forecast?.expectedPm25 ?? pm25 ?? 'n/a'} µg/m³ for ${name}.`;
    case 'government':
      return pm25 === null
        ? `Bulletin for ${name}: monitoring coverage reduced.`
        : `Bulletin: air quality "${bandLabel(bandForPm25(pm25))}" in ${name}.`;
    case 'news':
      return `"Thick haze blanketed ${name} this morning," the outlet reported${pm25 !== null ? `, quoting ${pm25} µg/m³` : ''}.`;
    case 'community':
      return `${ctx.rng.int(3, 40)} users reported smoke smell in ${f.district}.`;
    case 'data_platform':
      return `Query result for ${name}: PM2.5 ${pm25 ?? 'n/a'} µg/m³.`;
  }
}

function sourceRefsFor(
  ctx: GenContext,
  f: TextFacts,
  status: ItemStatus,
  observedMs: number,
  updatedMs: number,
): ItemSourceRef[] {
  const plan = SOURCE_PLAN[f.category];
  const primaryOptions = sourcesOfKind(ctx, f.seed, plan.primary);
  const fallback = ctx.sources[0];
  const primary = primaryOptions[0] ?? fallback;
  if (!primary) return [];

  const supportingCount =
    status === 'unverified'
      ? 0
      : status === 'verified'
        ? ctx.rng.int(1, 3)
        : ctx.rng.int(0, 2);
  const supporting = ctx.rng
    .shuffle(
      sourcesOfKind(ctx, f.seed, plan.supporting).filter(
        (s) => s.source.id !== primary.source.id,
      ),
    )
    .slice(0, supportingCount);

  const ref = (
    s: SourceSeed,
    role: ItemSourceRef['role'],
    valueOverride?: number | null,
  ): ItemSourceRef => {
    const isReport = s.source.evidenceKind === 'report';
    return {
      sourceId: s.source.id,
      role,
      // Order is always: measured/published <= retrieved <= updated.
      measuredAt: isReport ? null : iso(observedMs),
      publishedAt: isReport ? iso(observedMs) : null,
      retrievedAt: iso(
        Math.max(observedMs + MINUTE, updatedMs - ctx.rng.int(2, 4) * MINUTE),
      ),
      validUntil:
        s.source.kind === 'forecast_model' && f.forecast
          ? f.forecast.validTo
          : null,
      excerpt: excerptFor(ctx, s, f, valueOverride),
    };
  };

  const refs = [
    ref(primary, 'primary'),
    ...supporting.map((s) => ref(s, 'supporting')),
  ];
  if (status === 'conflicting') {
    const other = ctx.rng.pick(
      sourcesOfKind(ctx, f.seed, ['ground_monitor', 'low_cost_sensor', 'news'])
        .filter((s) => s.source.id !== primary.source.id)
        .concat(primary),
    );
    const differing =
      f.pm25 === null
        ? ctx.rng.int(20, 120)
        : Math.round(f.pm25 * ctx.rng.pick([0.45, 0.55, 1.6, 1.8]));
    refs.push(ref(other, 'conflicting', differing));
  }
  return refs;
}

const CHECK_POOL = [
  { id: 'freshness', label: 'Freshness' },
  { id: 'agreement', label: 'Independent sources agree' },
  { id: 'units', label: 'Units consistent' },
  { id: 'location', label: 'Location matches' },
  { id: 'plausibility', label: 'Value in plausible range' },
  { id: 'duplicates', label: 'Not a duplicate' },
  { id: 'provenance', label: 'Source identified' },
] as const;

const CHECK_DETAIL: Record<string, Record<EvidenceCheck['result'], string>> = {
  freshness: {
    pass: 'Newest source is less than 2 hours old.',
    warn: 'Newest source is 2–6 hours old.',
    fail: 'Newest source is more than 6 hours old.',
    pending: 'Waiting for timestamps.',
  },
  agreement: {
    pass: 'At least two independent sources agree within 25%.',
    warn: 'Only one independent source so far.',
    fail: 'Sources disagree by more than 40%.',
    pending: 'Only one source so far; waiting for a second.',
  },
  units: {
    pass: 'All values use µg/m³ or were converted with a recorded method.',
    warn: 'One source used a different unit; converted.',
    fail: 'Units could not be reconciled.',
    pending: 'Not checked yet.',
  },
  location: {
    pass: 'Source coordinates fall inside the location area.',
    warn: 'Nearest source is 30–60 km away.',
    fail: 'Source location does not match.',
    pending: 'Not checked yet.',
  },
  plausibility: {
    pass: 'Value is within the expected range for this place and season.',
    warn: 'Unusually high or low; double-checked against a second station.',
    fail: 'Value outside physical limits.',
    pending: 'Not checked yet.',
  },
  duplicates: {
    pass: 'No duplicate record found.',
    warn: 'Possible duplicate merged.',
    fail: 'Duplicate of another record.',
    pending: 'Not checked yet.',
  },
  provenance: {
    pass: 'Every source is identified with a link and timestamp.',
    warn: 'One source has no direct link.',
    fail: 'A source retracted or withdrew this information.',
    pending: 'Not checked yet.',
  },
};

function checksFor(ctx: GenContext, status: ItemStatus): EvidenceCheck[] {
  const extras = ctx.rng.shuffle(
    CHECK_POOL.filter((c) => c.id !== 'freshness' && c.id !== 'agreement'),
  );
  const chosen = [
    CHECK_POOL[0],
    CHECK_POOL[1],
    ...extras.slice(0, ctx.rng.int(2, 3)),
  ];
  if (status === 'retracted' && !chosen.some((c) => c.id === 'provenance')) {
    chosen.push(CHECK_POOL[6]);
  }
  const warnIds = new Set<string>(
    status === 'partial'
      ? ctx.rng
          .shuffle(chosen.map((c) => c.id).filter((id) => id !== 'freshness'))
          .slice(0, ctx.rng.int(1, 2))
      : [],
  );
  return chosen.map(({ id, label }) => {
    let result: EvidenceCheck['result'] = 'pass';
    if (status === 'partial' && warnIds.has(id)) result = 'warn';
    if (status === 'unverified')
      result = id === 'freshness' ? 'pass' : 'pending';
    if (status === 'conflicting' && id === 'agreement') result = 'fail';
    if (status === 'stale' && id === 'freshness') result = 'fail';
    if (status === 'retracted' && id === 'provenance') result = 'fail';
    return { id, label, result, detail: CHECK_DETAIL[id]?.[result] ?? '' };
  });
}

function agentResultsFor(
  ctx: GenContext,
  f: TextFacts,
  refs: ItemSourceRef[],
  checks: EvidenceCheck[],
  revision: number,
): AgentResult[] {
  const count = (r: EvidenceCheck['result']) =>
    checks.filter((c) => c.result === r).length;
  const failed = count('fail');
  const warned = count('warn');
  const pending = count('pending');
  const guidance = ctx.sources.find(
    (s) =>
      s.source.kind === 'government' &&
      s.scope !== 'global' &&
      coversRegion(s, f.seed.location.region),
  );
  const band = f.pm25 === null ? null : bandForPm25(f.pm25);

  const workershield: AgentResult =
    band === null
      ? {
          agent: 'workershield',
          outcome: 'skipped',
          summary: 'No measured value to assess.',
          durationMs: ctx.rng.int(200, 900),
        }
      : bandIndex(band) >= 2
        ? {
            agent: 'workershield',
            outcome: 'ok',
            summary: `Outdoor-exposure note added, pointing to official guidance from ${guidance?.source.name ?? 'the local authority'}. No medical advice given.`,
            durationMs: ctx.rng.int(800, 4000),
          }
        : {
            agent: 'workershield',
            outcome: 'ok',
            summary: 'No outdoor-exposure note needed at this demo band.',
            durationMs: ctx.rng.int(300, 1500),
          };

  const pastYear = ctx.rng.int(2015, 2025);
  return [
    {
      agent: 'hazeops',
      outcome: refs.length > 0 ? 'ok' : 'failed',
      summary: `Gathered ${refs.length} source(s).`,
      durationMs: ctx.rng.int(600, 6000),
    },
    {
      agent: 'worldmodel',
      outcome: 'ok',
      summary:
        revision > 1
          ? `Stored revision ${revision}; revision ${revision - 1} superseded.`
          : 'Stored as a new record (revision 1).',
      durationMs: ctx.rng.int(50, 400),
    },
    ctx.rng.chance(0.55)
      ? {
          agent: 'hmem',
          outcome: 'ok',
          summary: `Similar episode recalled: ${f.seed.location.name}, ${pastYear} season (fictional).`,
          durationMs: ctx.rng.int(100, 900),
        }
      : {
          agent: 'hmem',
          outcome: 'skipped',
          summary: 'No similar past episode in memory.',
          durationMs: ctx.rng.int(50, 300),
        },
    {
      agent: 'evidencecritic',
      outcome: failed > 0 ? 'warning' : 'ok',
      summary: `${count('pass')} passed, ${warned} warning(s), ${failed} failed, ${pending} pending.`,
      durationMs: ctx.rng.int(500, 5000),
    },
    workershield,
  ];
}

const OBSERVED_LABEL: Record<CategoryId, string> = {
  reading: 'Measured by monitoring station',
  hotspot: 'Satellite pass detected heat anomalies',
  forecast: 'Forecast issued',
  advisory: 'Advisory published',
  health: 'Guidance published',
  disruption: 'First report of disruption',
  news: 'Article published',
  community: 'First community report',
  sensor_issue: 'Station stopped reporting',
};

function timelineFor(
  category: CategoryId,
  status: ItemStatus,
  observedMs: number,
  updatedMs: number,
  checks: EvidenceCheck[],
  revision: number,
): TimelineEntry[] {
  const passed = checks.filter((c) => c.result === 'pass').length;
  const entries: TimelineEntry[] = [
    { at: iso(observedMs), label: OBSERVED_LABEL[category], agent: null },
    {
      at: iso(updatedMs - 4 * MINUTE),
      label: 'Retrieved by HazeOps',
      agent: 'hazeops',
    },
    {
      at: iso(updatedMs - 3 * MINUTE),
      label: `Stored by World Model (revision ${revision})`,
      agent: 'worldmodel',
    },
    {
      at: iso(updatedMs - 1 * MINUTE),
      label: `Checked by EvidenceCritic: ${passed}/${checks.length} passed`,
      agent: 'evidencecritic',
    },
  ];
  if (status === 'retracted')
    entries.push({
      at: iso(updatedMs),
      label: 'Retracted after a source withdrew it',
      agent: 'evidencecritic',
    });
  entries.push({ at: iso(updatedMs), label: 'Record updated', agent: null });
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

export function makeItem(
  ctx: GenContext,
  overrides: ItemOverrides = {},
): HazeItem {
  const seed = overrides.location ?? pickLocation(ctx);
  const { location, profile } = seed;
  const category = overrides.category ?? pickCategory(ctx, profile);
  const ageHours =
    overrides.ageHours ??
    (ctx.rng.chance(0.75) ? ctx.rng.float(0, 18) : ctx.rng.float(18, 72));
  const updatedMs = ctx.nowMs - ageHours * HOUR;
  const observedMs = updatedMs - ctx.rng.int(5, 90) * MINUTE;
  const status = overrides.status ?? pickStatus(ctx, category, ageHours);

  const pm25 =
    overrides.pm25 !== undefined
      ? overrides.pm25
      : category === 'sensor_issue' || category === 'community'
        ? null
        : samplePm25(ctx, profile, overrides.pm25Multiplier ?? 1);

  const measurements = measurementsFor(ctx, category, pm25);
  const measuredPm25 =
    measurements.find((m) => m.pollutant === 'pm25')?.value ?? null;
  const pm10 = measurements.find((m) => m.pollutant === 'pm10')?.value ?? null;

  const trend: Trend | null =
    category === 'reading' || category === 'advisory'
      ? ctx.rng.weighted<Trend>([
          ['up', 4],
          ['down', 3],
          ['flat', 3],
        ])
      : null;
  const weather = [
    'reading',
    'hotspot',
    'forecast',
    'disruption',
    'advisory',
  ].includes(category)
    ? weatherFor(ctx, pm25)
    : null;
  const fire = category === 'hotspot' ? fireFor(ctx, profile) : null;
  const forecast: ForecastInfo | null =
    category === 'forecast'
      ? {
          validFrom: iso(observedMs),
          validTo: iso(observedMs + ctx.rng.pick([12, 24, 48]) * HOUR),
          expectedPm25: pm25,
          direction:
            overrides.forecastDirection ??
            ctx.rng.weighted([
              ['worsening', 4],
              ['improving', 3],
              ['steady', 3],
            ] as const),
        }
      : null;
  const impacts = impactsFor(ctx, category, location.name);
  const revision = ctx.rng.weighted([
    [1, 6],
    [2, 3],
    [3, 1],
  ] as const);

  const facts: TextFacts = {
    seed,
    category,
    pm25: category === 'forecast' ? pm25 : measuredPm25,
    pm10,
    trend,
    fire,
    forecast,
    impacts,
    weather,
    stationCode: `${location.countryCode}-${ctx.rng.int(1, 40).toString().padStart(2, '0')}`,
    district: ctx.rng.pick(profile.districts),
    sourceCount: 0,
  };

  const sources = sourceRefsFor(ctx, facts, status, observedMs, updatedMs);
  facts.sourceCount = sources.length;
  const checks = checksFor(ctx, status);

  return {
    id: ctx.nextId(),
    fictional: true,
    locationId: location.id,
    category,
    headline: headlineFor(facts, ctx.rng),
    summary: summaryFor(facts),
    details: detailsFor(facts, ctx.rng),
    status,
    observedAt: iso(observedMs),
    updatedAt: iso(updatedMs),
    revision,
    measurements,
    trend,
    weather,
    fire,
    forecast,
    impacts,
    sources,
    checks,
    agentResults: agentResultsFor(ctx, facts, sources, checks, revision),
    timeline: timelineFor(
      category,
      status,
      observedMs,
      updatedMs,
      checks,
      revision,
    ),
    relatedIds: [],
    tags: [
      location.region,
      category,
      ...(fire ? [fire.landType] : []),
      ...(overrides.tags ?? []),
    ],
  };
}

/** Link each item to up to 3 others: same place first, then same region. */
export function linkRelated(
  items: HazeItem[],
  locations: readonly LocationSeed[],
): void {
  const regionOf = new Map(
    locations.map((l) => [l.location.id, l.location.region]),
  );
  const byRecency = [...items].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  for (const item of items) {
    const samePlace = byRecency
      .filter((o) => o.id !== item.id && o.locationId === item.locationId)
      .slice(0, 2);
    const sameRegion = byRecency
      .filter(
        (o) =>
          o.locationId !== item.locationId &&
          regionOf.get(o.locationId) === regionOf.get(item.locationId),
      )
      .slice(0, 3 - samePlace.length);
    item.relatedIds = [...samePlace, ...sameRegion].map((o) => o.id);
  }
}

// ---------------------------------------------------------------------------
// Edge cases: deliberately awkward items so every UI state gets exercised
// ---------------------------------------------------------------------------

function edgeCases(ctx: GenContext): HazeItem[] {
  const at = (id: string) =>
    ctx.locations.find((l) => l.location.id === id) ?? ctx.locations[0];
  const tag = (name: string) => ['edge-case', name];

  const missingValues = makeItem(ctx, {
    location: at('singapore'),
    category: 'reading',
    pm25: null,
    status: 'unverified',
    ageHours: 0.5,
    tags: tag('missing-values'),
  });
  missingValues.measurements = missingValues.measurements.map((m) => ({
    ...m,
    value: null,
  }));

  const zeroAt = at('kota-kinabalu');
  const zero = makeItem(ctx, {
    location: zeroAt,
    category: 'reading',
    pm25: 0,
    status: 'verified',
    ageHours: 1,
    tags: tag('zero-reading'),
  });
  zero.trend = 'flat';
  zero.headline = `PM2.5 reads 0 µg/m³ in ${zeroAt.location.name} (instrument floor)`;
  const extreme = makeItem(ctx, {
    location: at('palangka-raya'),
    category: 'reading',
    pm25: 912,
    status: 'partial',
    ageHours: 0.3,
    tags: tag('extreme-value'),
  });

  const long = makeItem(ctx, {
    location: at('medan'),
    category: 'news',
    status: 'unverified',
    ageHours: 2,
    tags: tag('long-text'),
  });
  long.headline = `Very long headline: ${LONG_TEXT.slice(0, 220)}`;
  long.summary = LONG_TEXT.slice(0, 300);
  long.details = [LONG_TEXT, LONG_TEXT];

  const retracted = makeItem(ctx, {
    location: at('jakarta'),
    category: 'news',
    status: 'retracted',
    ageHours: 3,
    tags: tag('retracted'),
  });
  const newsOnly = makeItem(ctx, {
    location: at('kuantan'),
    category: 'news',
    status: 'unverified',
    ageHours: 0.8,
    tags: tag('news-only'),
  });
  const conflicting = makeItem(ctx, {
    location: at('johor-bahru'),
    category: 'reading',
    status: 'conflicting',
    ageHours: 1.5,
    tags: tag('conflicting'),
  });

  const noChecks = makeItem(ctx, {
    location: at('shah-alam'),
    category: 'community',
    status: 'unverified',
    ageHours: 0.2,
    tags: tag('no-checks'),
  });
  noChecks.checks = [];

  const missingSource = makeItem(ctx, {
    location: at('ipoh'),
    category: 'reading',
    status: 'partial',
    ageHours: 4,
    tags: tag('missing-source'),
  });
  missingSource.sources.push({
    sourceId: 'source-that-no-longer-exists',
    role: 'supporting',
    measuredAt: null,
    publishedAt: null,
    retrievedAt: missingSource.updatedAt,
    validUntil: null,
    excerpt:
      'This source id is not in the source list, to test how the UI copes.',
  });

  const stale = makeItem(ctx, {
    location: at('miri'),
    category: 'reading',
    status: 'stale',
    ageHours: 60,
    tags: tag('stale'),
  });
  const longForecast = makeItem(ctx, {
    location: at('kuching'),
    category: 'forecast',
    status: 'verified',
    ageHours: 0.1,
    forecastDirection: 'worsening',
    tags: tag('long-forecast'),
  });
  if (longForecast.forecast) {
    longForecast.forecast.validTo = iso(
      Date.parse(longForecast.forecast.validFrom) + 72 * HOUR,
    );
  }
  const nonAscii = makeItem(ctx, {
    location: at('hat-yai'),
    category: 'community',
    status: 'unverified',
    ageHours: 0.6,
    tags: tag('non-ascii'),
  });
  nonAscii.headline =
    'Community report from Hat Yai (หาดใหญ่): "ควันหนามาก" (very thick smoke) at dusk';

  return [
    missingValues,
    zero,
    extreme,
    long,
    retracted,
    newsOnly,
    conflicting,
    noChecks,
    missingSource,
    stale,
    longForecast,
    nonAscii,
  ];
}

// ---------------------------------------------------------------------------
// The whole dataset
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  seed: number;
  itemCount: number;
  now: Date;
  /** Which places to include. Default 'asean' (Malaysia first, then Indonesia). */
  coverage?: Coverage;
}

export function generateDataset({
  seed,
  itemCount,
  now,
  coverage = 'asean',
}: GenerateOptions): DemoDataset {
  const locations = locationsFor(coverage);
  const regions = new Set(locations.map((l) => l.location.region));
  const ctx = createContext(
    seed,
    now.getTime(),
    locations,
    SOURCE_SEEDS.filter(
      (s) => s.scope === 'global' || s.scope.some((r) => regions.has(r)),
    ),
  );
  const items: HazeItem[] = [];

  // Every location gets at least two items so filters never show an empty place.
  for (const location of ctx.locations) {
    items.push(makeItem(ctx, { location }), makeItem(ctx, { location }));
  }
  items.push(...edgeCases(ctx));
  while (items.length < itemCount) items.push(makeItem(ctx));

  linkRelated(items, ctx.locations);
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    fictional: true,
    notice: DEMO_NOTICE,
    seed,
    generatedAt: now.toISOString(),
    locations: ctx.locations.map((l) => l.location),
    sources: ctx.sources.map((s) => s.source),
    items,
    chatScripts: CHAT_SCRIPTS,
  };
}
