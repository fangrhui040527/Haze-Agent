#!/usr/bin/env node
// Does the data pipeline actually retrieve data?
//
// Most Zetaris source scripts REGISTER REST tables inside Zetaris rather than
// fetching themselves — Zetaris calls the upstream later. So with no Zetaris
// server the scripts can only dry-run, and the upstreams they point at are
// never exercised. This probe hits each upstream directly, using the SAME
// endpoint construction the scripts use, and validates the response shape.
//
// Endpoint parity is taken from:
//   open_meteo_wind/fetch_open_meteo_wind.ts   endpoint()
//   air_quality/fetch_air_quality.ts
//   nasa_power/fetch_nasa_power.ts             PARAMETERS + endpoint()
//   weather/fetch_weather.ts                   api.data.gov.my
//   nasa_firms/fetch_nasa_firms.ts             (needs FIRMS_MAP_KEY)
import { writeFileSync } from 'node:fs';

// Kuala Lumpur — one of the 345 locations in the repo's locations.json.
const LAT = 3.1412;
const LON = 101.68653;
const TIMEOUT_MS = 45_000;

const NASA_POWER_PARAMETERS = [
  'WS10M',
  'WD10M',
  'RH2M',
  'QV2M',
  'GWETTOP',
  'GWETROOT',
  'PRECTOTCORR',
  'T2M',
  'T2M_MAX',
  'T2M_MIN',
  'T2MDEW',
  'WS10M_MAX',
  'GWETPROF',
  'WS2M',
  'T2MWET',
  'PS',
  'WS50M',
  'WD50M',
  'TS',
  'EVLAND',
];

const yyyymmdd = (d) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
// NASA POWER daily data lags; ask for a week back so the window is populated.
const POWER_DAY = yyyymmdd(new Date(Date.now() - 7 * 86_400_000));

const openMeteoWind = () => {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', LAT.toFixed(5));
  url.searchParams.set('longitude', LON.toFixed(5));
  url.searchParams.set(
    'hourly',
    'wind_speed_10m,wind_direction_10m,wind_speed_850hPa,wind_direction_850hPa',
  );
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('past_days', '1');
  url.searchParams.set('forecast_days', '3');
  url.searchParams.set('timezone', 'GMT');
  return url.toString();
};

const openMeteoAirQuality = () => {
  const url = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
  url.searchParams.set('latitude', LAT.toFixed(5));
  url.searchParams.set('longitude', LON.toFixed(5));
  url.searchParams.set('hourly', 'pm2_5,pm10');
  url.searchParams.set('past_days', '1');
  url.searchParams.set('forecast_days', '2');
  url.searchParams.set('timezone', 'GMT');
  return url.toString();
};

const nasaPower = () =>
  'https://power.larc.nasa.gov/api/temporal/daily/point' +
  `?parameters=${NASA_POWER_PARAMETERS.join(',')}&community=AG` +
  `&longitude=${LON}&latitude=${LAT}&start=${POWER_DAY}&end=${POWER_DAY}&format=JSON`;

const SOURCES = [
  {
    key: 'open-meteo wind (open_meteo_wind, wind)',
    url: openMeteoWind(),
    kind: 'json',
    validate: (b) => {
      const h = b?.hourly;
      const n = h?.time?.length ?? 0;
      const speeds = h?.wind_speed_10m ?? [];
      const real = speeds.filter((v) => typeof v === 'number').length;
      return {
        ok: n > 0 && real > 0 && h?.wind_direction_10m?.length === n,
        detail: {
          hours: n,
          numeric_wind_speeds: real,
          has_850hPa: Array.isArray(h?.wind_speed_850hPa),
          sample: {
            time: h?.time?.[0],
            wind_speed_10m: speeds?.[0],
            wind_direction_10m: h?.wind_direction_10m?.[0],
          },
        },
      };
    },
  },
  {
    key: 'open-meteo air quality (air_quality, open_meteo_pm25)',
    url: openMeteoAirQuality(),
    kind: 'json',
    validate: (b) => {
      const h = b?.hourly;
      const n = h?.time?.length ?? 0;
      const pm = (h?.pm2_5 ?? []).filter((v) => typeof v === 'number');
      return {
        ok: n > 0 && pm.length > 0,
        detail: {
          hours: n,
          numeric_pm2_5: pm.length,
          pm2_5_min: pm.length ? Math.min(...pm) : null,
          pm2_5_max: pm.length ? Math.max(...pm) : null,
          sample: {
            time: h?.time?.[0],
            pm2_5: h?.pm2_5?.[0],
            pm10: h?.pm10?.[0],
          },
        },
      };
    },
  },
  {
    key: 'NASA POWER daily point (nasa_power)',
    url: nasaPower(),
    kind: 'json',
    validate: (b) => {
      const p = b?.properties?.parameter ?? {};
      const names = Object.keys(p);
      const missing = NASA_POWER_PARAMETERS.filter((x) => !names.includes(x));
      const t2m = p.T2M ? Object.values(p.T2M) : [];
      return {
        ok: names.length > 0 && missing.length === 0 && t2m.length > 0,
        detail: {
          day_requested: POWER_DAY,
          parameters_returned: names.length,
          parameters_missing: missing,
          sample: {
            T2M: t2m[0],
            WS10M: p.WS10M ? Object.values(p.WS10M)[0] : null,
          },
        },
      };
    },
  },
  {
    key: 'data.gov.my weather forecast (weather)',
    url: 'https://api.data.gov.my/weather/forecast/?limit=3',
    kind: 'json',
    validate: (b) => {
      const rows = Array.isArray(b) ? b : (b?.data ?? []);
      return {
        ok: Array.isArray(rows) && rows.length > 0,
        detail: {
          rows: Array.isArray(rows) ? rows.length : null,
          keys: rows?.[0] ? Object.keys(rows[0]).slice(0, 8) : null,
        },
      };
    },
  },
  {
    key: 'NASA FIRMS active fire CSV (nasa_firms)',
    url: process.env.FIRMS_MAP_KEY
      ? `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${process.env.FIRMS_MAP_KEY}/VIIRS_NOAA20_NRT/99.5,1.0,104.5,7.5/1`
      : null,
    kind: 'csv',
    skipReason: 'FIRMS_MAP_KEY not configured',
    validate: (text) => {
      const lines = String(text).trim().split('\n');
      const header = lines[0] ?? '';
      return {
        ok: /latitude/i.test(header) && /longitude/i.test(header),
        detail: {
          header_fields: header.split(',').length,
          data_rows: Math.max(0, lines.length - 1),
          has_expected_columns: [
            'latitude',
            'longitude',
            'acq_date',
            'frp',
          ].every((c) => header.includes(c)),
        },
      };
    },
    redact: true,
  },
];

const results = [];

for (const source of SOURCES) {
  if (!source.url) {
    results.push({
      source: source.key,
      status: 'SKIPPED',
      reason: source.skipReason,
    });
    process.stdout.write(`  skip ${source.key} — ${source.skipReason}\n`);
    continue;
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let entry;
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        accept: source.kind === 'csv' ? 'text/csv' : 'application/json',
      },
    });
    const raw =
      source.kind === 'csv' ? await response.text() : await response.json();
    const { ok, detail } = source.validate(raw);
    entry = {
      source: source.key,
      status: response.ok && ok ? 'LIVE' : 'FAILED',
      http_status: response.status,
      elapsed_ms: Date.now() - started,
      ...detail,
    };
  } catch (error) {
    entry = {
      source: source.key,
      status: 'FAILED',
      elapsed_ms: Date.now() - started,
      error: String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
  // Never let a credentialed URL reach the report.
  if (!source.redact) entry.url = source.url;
  results.push(entry);
  process.stdout.write(
    `  ${entry.status === 'LIVE' ? 'LIVE' : 'FAIL'} ${source.key} (${entry.elapsed_ms}ms)\n       ${JSON.stringify(
      Object.fromEntries(
        Object.entries(entry).filter(
          ([k]) => !['source', 'status', 'url', 'elapsed_ms'].includes(k),
        ),
      ),
    )}\n`,
  );
}

const live = results.filter((r) => r.status === 'LIVE').length;
const failed = results.filter((r) => r.status === 'FAILED').length;
const skipped = results.filter((r) => r.status === 'SKIPPED').length;

const report = {
  probe: 'upstream data source retrieval',
  note: 'Hits each upstream directly with the same endpoint construction the Zetaris source scripts use. Zetaris itself is NOT required for this probe; the scripts normally register these endpoints as Zetaris REST tables.',
  location: { name: 'Kuala Lumpur', latitude: LAT, longitude: LON },
  totals: { total: results.length, live, failed, skipped },
  results,
};
writeFileSync(
  'qa/data-sources-probe.json',
  `${JSON.stringify(report, null, 2)}\n`,
);

process.stdout.write(
  `\nupstreams live=${live} failed=${failed} skipped=${skipped} -> qa/data-sources-probe.json\n`,
);
process.exit(failed ? 1 : 0);
