#!/usr/bin/env node
// Real-world haze use cases executed against the LIVE Zetaris stack.
//
// Preconditions (all satisfied by the documented install path):
//   docker compose up --detach           -> api/driver/postgres/ui healthy
//   npm run zetaris:fetch:pm25           -> air_quality.hourly_observations
//   node .../fetch_nasa_firms.ts         -> NASA_FIRMS_FILES.active_fires
//
// Each case runs through the repository's OWN SQL runner
// (app/adapters/zetaris/scripts/run_sql.py, REST channel) rather than a
// reimplementation, so what is recorded is the real operator path.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ZETARIS_ROOT = resolve('app/adapters/zetaris');

const CASES = [
  {
    id: 'UC-Z1',
    title: 'Hotspot inventory: how many active fires were ingested?',
    question:
      'An analyst opening the haze console first needs to know the size and recency of the fire dataset.',
    sql: 'SELECT COUNT(*) AS hotspots, MIN(acq_date) AS earliest, MAX(acq_date) AS latest, COUNT(DISTINCT source) AS satellites FROM NASA_FIRMS_FILES.active_fires',
    expect: (rows) => Number(rows[0]?.[0]) > 0,
  },
  {
    id: 'UC-Z2',
    title: 'Which fires are burning hardest? (top fire radiative power)',
    question:
      'Attribution starts from the most energetic fires, because weak detections rarely drive a haze episode.',
    sql: 'SELECT location_id, region, ROUND(CAST(frp AS DOUBLE), 2) AS frp_mw, confidence, acq_myt FROM NASA_FIRMS_FILES.active_fires ORDER BY CAST(frp AS DOUBLE) DESC LIMIT 5',
    expect: (rows) => rows.length > 0,
  },
  {
    id: 'UC-Z3',
    title: 'Detection provenance: which satellite saw what, and when?',
    question:
      'Every claim must name its sensor. Mixed VIIRS platforms must stay distinguishable.',
    sql: 'SELECT source, daynight, COUNT(*) AS detections FROM NASA_FIRMS_FILES.active_fires GROUP BY source, daynight ORDER BY detections DESC',
    expect: (rows) => rows.length > 0,
  },
  {
    id: 'UC-Z4',
    title: 'Geographic spread: where are the fires concentrated?',
    question:
      'Peninsular vs East Malaysia matters: transboundary haze and local burning need different responses.',
    sql: 'SELECT region, COUNT(*) AS hotspots, COUNT(DISTINCT location_id) AS locations FROM NASA_FIRMS_FILES.active_fires GROUP BY region ORDER BY hotspots DESC',
    expect: (rows) => rows.length > 0,
  },
  {
    id: 'UC-Z5',
    title: 'Data-quality gate: confidence distribution of detections',
    question:
      'Low-confidence detections must be separable so they can be excluded from a published finding.',
    sql: 'SELECT confidence, COUNT(*) AS detections, ROUND(AVG(CAST(frp AS DOUBLE)), 2) AS mean_frp FROM NASA_FIRMS_FILES.active_fires GROUP BY confidence ORDER BY detections DESC',
    expect: (rows) => rows.length > 0,
  },
  {
    id: 'UC-Z6',
    title: 'PM2.5 coverage: how much air-quality evidence is retained?',
    question:
      'The modelled PM2.5 feed is the measurement side of the question; its coverage bounds any claim.',
    sql: 'SELECT COUNT(*) AS samples, COUNT(DISTINCT location_name) AS locations, MIN(observation_time) AS first_hour, MAX(observation_time) AS last_hour FROM air_quality.hourly_observations',
    expect: (rows) => Number(rows[0]?.[0]) > 0,
  },
  {
    id: 'UC-Z7',
    title: 'Where is the air worst right now? (peak PM2.5 by location)',
    question:
      'The operational question a resident asks: which places are above the unhealthy threshold?',
    sql: 'SELECT location_name, ROUND(MAX(pm2_5_ug_m3), 1) AS peak_pm25, ROUND(AVG(pm2_5_ug_m3), 1) AS mean_pm25 FROM air_quality.hourly_observations GROUP BY location_name ORDER BY peak_pm25 DESC LIMIT 5',
    expect: (rows) => rows.length > 0,
  },
  {
    id: 'UC-Z8',
    title: 'WHO exceedance: hours above the 15 ug/m3 24-hour guideline',
    question:
      'A policy-relevant count, not a raw reading: how many location-hours breach the WHO 2021 guideline?',
    sql: 'SELECT COUNT(*) AS exceeding_hours, COUNT(DISTINCT location_name) AS affected_locations, ROUND(MAX(pm2_5_ug_m3), 1) AS worst FROM air_quality.hourly_observations WHERE pm2_5_ug_m3 > 15',
    expect: (rows) => rows.length > 0,
  },
  {
    id: 'UC-Z9',
    title:
      'CROSS-SOURCE ATTRIBUTION: fires within ~50km of the worst-affected places',
    question:
      'The actual haze-attribution join. Pairs each high-PM2.5 location with nearby active fires, which is what a source-attribution answer must be built on. A crude degree box stands in for a proper geodesic buffer.',
    sql: `SELECT aq.location_name,
       ROUND(MAX(aq.pm2_5_ug_m3), 1) AS peak_pm25,
       COUNT(DISTINCT f.location_id) AS nearby_fire_sites,
       ROUND(SUM(CAST(f.frp AS DOUBLE)), 1) AS nearby_total_frp
FROM air_quality.hourly_observations aq
JOIN NASA_FIRMS_FILES.active_fires f
  ON ABS(CAST(f.latitude AS DOUBLE) - aq.requested_latitude) < 0.45
 AND ABS(CAST(f.longitude AS DOUBLE) - aq.requested_longitude) < 0.45
GROUP BY aq.location_name
ORDER BY nearby_total_frp DESC
LIMIT 8`,
    expect: (rows) => Array.isArray(rows),
    note: 'A zero-row result is a legitimate finding: it means no ingested fire sits near a monitored location in this window, so no fire-based attribution is supportable from this evidence.',
  },
  {
    id: 'UC-Z10',
    title: 'Registration metadata is inspectable (schema introspection)',
    question:
      'An auditor must be able to see the registered shape of each source, not just its rows.',
    sql: 'DESCRIBE air_quality.hourly_observations',
    expect: (rows) => rows.some((r) => String(r[0]).includes('pm2_5')),
  },
];

function runSql(sql) {
  const started = Date.now();
  const proc = spawnSync('python', ['scripts/run_sql.py', '-e', sql], {
    cwd: ZETARIS_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
  });
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  // run_sql.py prints each result row as a Python list literal, indented.
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s{4,}\[(.*)\]\s*$/.exec(line);
    if (!m) continue;
    rows.push(
      m[1]
        .split(/,\s*(?=(?:[^']*'[^']*')*[^']*$)/)
        .map((cell) => cell.trim().replace(/^'|'$/g, ''))
        .map((cell) => (cell === 'None' ? null : cell)),
    );
  }
  const okLine = /done:\s*(\d+)\/(\d+)\s*statements ok/.exec(out);
  return {
    exitCode: proc.status,
    elapsed_ms: Date.now() - started,
    statements_ok: okLine ? `${okLine[1]}/${okLine[2]}` : null,
    rows,
    raw_tail: out.trim().split(/\r?\n/).slice(-6).join('\n'),
  };
}

const records = [];
for (const c of CASES) {
  process.stdout.write(`\n>>> ${c.id} ${c.title}\n`);
  const r = runSql(c.sql);
  const passed = r.exitCode === 0 && c.expect(r.rows);
  records.push({
    id: c.id,
    title: c.title,
    why_it_matters: c.question,
    sql: c.sql,
    status: passed ? 'PASS' : 'FAIL',
    exit_code: r.exitCode,
    statements_ok: r.statements_ok,
    elapsed_ms: r.elapsed_ms,
    row_count: r.rows.length,
    rows: r.rows.slice(0, 10),
    ...(c.note ? { interpretation_note: c.note } : {}),
    ...(passed ? {} : { raw_tail: r.raw_tail }),
  });
  process.stdout.write(
    `    ${passed ? 'PASS' : 'FAIL'} ${r.statements_ok ?? ''} ${Math.round(r.elapsed_ms / 1000)}s rows=${r.rows.length}\n`,
  );
  for (const row of r.rows.slice(0, 5))
    process.stdout.write(`      ${JSON.stringify(row)}\n`);
}

const pass = records.filter((r) => r.status === 'PASS').length;
const report = {
  suite: 'Zetaris live real-world haze use cases',
  executed_at: new Date().toISOString(),
  stack: {
    engine: 'Zetaris Lightning 2.4.3-v2.4.3.1-hackathon',
    channel: 'REST via app/adapters/zetaris/scripts/run_sql.py',
    rest_url: process.env.ZETARIS_REST_URL ?? 'http://localhost:8888/api/v1.0',
  },
  datasets: {
    'NASA_FIRMS_FILES.active_fires':
      'NASA FIRMS VIIRS active fire detections, Malaysia (live fetch)',
    'air_quality.hourly_observations':
      'Open-Meteo modelled hourly PM2.5/PM10 for 345 Malaysian locations',
  },
  totals: { total: records.length, pass, fail: records.length - pass },
  cases: records,
};
writeFileSync(
  'qa/zetaris-usecases.json',
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
  `\n=== ${pass}/${records.length} use cases passed -> qa/zetaris-usecases.json ===\n`,
);
process.exit(pass === records.length ? 0 : 1);
