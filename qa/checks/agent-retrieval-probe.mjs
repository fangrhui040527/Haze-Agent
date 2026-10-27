#!/usr/bin/env node
// Does the AGENT's own data retrieval actually work against the live network?
//
// This is a different path from the Zetaris source scripts. The agent's
// evidence-collection capability fetches through app/adapters/haze-sources/
// (boundedFetch -> fetchOpenMeteo / fetchFirmsArea), which enforce byte bounds,
// timeouts and content hashing, and return { raw, sha256, status, retrievedAt }.
// Those adapters are what an admitted task actually calls, so they are the real
// proof that the agent can retrieve evidence.
//
// FIRMS needs FIRMS_MAP_KEY; its scenario is skipped (not failed) without one.
import { writeFileSync } from 'node:fs';
import { fetchOpenMeteo } from '../../dist/adapters/haze-sources/openMeteo.js';
import { fetchFirmsArea } from '../../dist/adapters/haze-sources/firms.js';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, ...detail });
  process.stdout.write(
    `  ${ok ? 'ok  ' : 'FAIL'} ${name}\n       ${JSON.stringify(detail)}\n`,
  );
};

const timeout = (ms) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
};

const SHA256 = /^[a-f0-9]{64}$/;

// --- 1. Open-Meteo air quality through the agent's adapter -------------
{
  const params = new URLSearchParams({
    latitude: '3.14120',
    longitude: '101.68653',
    hourly: 'pm2_5',
    past_days: '1',
    forecast_days: '1',
    timezone: 'GMT',
  });
  const t = timeout(45_000);
  try {
    const fetched = await fetchOpenMeteo(params, t.signal);
    const body = JSON.parse(fetched.raw.toString('utf8'));
    const pm = (body?.hourly?.pm2_5 ?? []).filter((v) => typeof v === 'number');
    record(
      'agent adapter retrieves live Open-Meteo PM2.5',
      fetched.status === 200 && pm.length > 0 && SHA256.test(fetched.sha256),
      {
        http_status: fetched.status,
        bytes: fetched.raw.length,
        sha256_well_formed: SHA256.test(fetched.sha256),
        has_retrievedAt: Boolean(fetched.retrievedAt),
        numeric_pm2_5: pm.length,
        pm2_5_range: pm.length ? [Math.min(...pm), Math.max(...pm)] : null,
      },
    );

    // Content hashing must be deterministic for identical bytes — the agent
    // relies on it for exact artifact identity.
    const second = await fetchOpenMeteo(params, timeout(45_000).signal);
    const sameBytes = second.raw.equals(fetched.raw);
    record(
      'content hash is deterministic for identical bytes',
      !sameBytes || second.sha256 === fetched.sha256,
      {
        second_bytes: second.raw.length,
        byte_identical: sameBytes,
        hash_matches: second.sha256 === fetched.sha256,
        note: sameBytes
          ? 'identical payload, hashes compared'
          : 'upstream payload changed between calls; hash equality not asserted',
      },
    );
  } catch (error) {
    record('agent adapter retrieves live Open-Meteo PM2.5', false, {
      error: String(error?.message ?? error),
    });
  } finally {
    t.done();
  }
}

// --- 2. Abort/timeout handling -----------------------------------------
{
  const controller = new AbortController();
  controller.abort();
  try {
    await fetchOpenMeteo(
      new URLSearchParams({
        latitude: '3.1',
        longitude: '101.7',
        hourly: 'pm2_5',
      }),
      controller.signal,
    );
    record('an already-aborted signal is refused', false, {
      note: 'the call resolved instead of rejecting',
    });
  } catch (error) {
    record('an already-aborted signal is refused', true, {
      rejected_with: String(error?.message ?? error).slice(0, 120),
    });
  }
}

// --- 3. NASA FIRMS through the agent's adapter -------------------------
if (process.env.FIRMS_MAP_KEY) {
  const t = timeout(60_000);
  try {
    const fetched = await fetchFirmsArea(
      process.env.FIRMS_MAP_KEY,
      'VIIRS_NOAA20_NRT',
      '99.5,1.0,104.5,7.5',
      t.signal,
    );
    const text = fetched.raw.toString('utf8');
    const header = text.trim().split('\n')[0] ?? '';
    record(
      'agent adapter retrieves live NASA FIRMS CSV',
      fetched.status === 200 &&
        header.includes('latitude') &&
        SHA256.test(fetched.sha256),
      {
        http_status: fetched.status,
        bytes: fetched.raw.length,
        sha256_well_formed: SHA256.test(fetched.sha256),
        header_fields: header.split(',').length,
        data_rows: Math.max(0, text.trim().split('\n').length - 1),
      },
    );
    record(
      'the map key never appears in the returned payload',
      !text.includes(process.env.FIRMS_MAP_KEY),
      {
        key_leaked: text.includes(process.env.FIRMS_MAP_KEY),
      },
    );
  } catch (error) {
    const message = String(error?.message ?? error);
    record('agent adapter retrieves live NASA FIRMS CSV', false, {
      error: message.replace(process.env.FIRMS_MAP_KEY, '<redacted>'),
    });
  } finally {
    t.done();
  }
} else {
  results.push({
    name: 'agent adapter retrieves live NASA FIRMS CSV',
    ok: true,
    skipped: 'FIRMS_MAP_KEY not configured',
  });
  process.stdout.write(
    '  skip agent FIRMS retrieval — FIRMS_MAP_KEY not configured\n',
  );
}

const failed = results.filter((r) => !r.ok);
const report = {
  probe:
    'agent evidence retrieval (live network, through app/adapters/haze-sources)',
  totals: {
    total: results.length,
    pass: results.length - failed.length,
    fail: failed.length,
  },
  results,
};
writeFileSync(
  'qa/agent-retrieval-probe.json',
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
  `\nagent retrieval: ${report.totals.pass}/${report.totals.total} -> qa/agent-retrieval-probe.json\n`,
);
process.exit(failed.length ? 1 : 0);
