#!/usr/bin/env node
// Live verification of the haze-web-search tool against the real Tavily API.
//
// Drives the registered tool exactly as an admitted HazeOps assignment would —
// no reimplementation of the request. Requires TAVILY_API_KEY; skips cleanly
// without one so the harness records WARN rather than a false failure.
import { writeFileSync } from 'node:fs';
import { createWebSearchTools } from '../../dist/capabilities/evidence-collection/web-search.js';

const KEY = process.env.TAVILY_API_KEY?.trim();
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, ...detail });
  process.stdout.write(
    `  ${ok ? 'ok  ' : 'FAIL'} ${name}\n       ${JSON.stringify(detail)}\n`,
  );
};

const context = () => ({
  taskId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
  assignmentId: '00000000-0000-4000-8000-000000000003',
  assignmentRevision: 1,
  objectiveRevision: 1,
  generation: 1,
  identity: { principal: 'qa-user', workspace: 'qa-workspace' },
  deadline: new Date(Date.now() + 120_000).toISOString(),
  signal: AbortSignal.timeout(90_000),
  inputs: [],
  peers: [],
  outputs: [],
});

const query = {
  schema_version: 'haze.websearch.query.v1',
  query: 'Malaysia transboundary haze air quality October 2026',
  max_results: 4,
  recency_days: 30,
};

let report;
if (!KEY) {
  process.stdout.write('  skip — TAVILY_API_KEY not configured\n');
  report = { probe: 'haze-web-search live', skipped: true, results: [] };
} else {
  // Fixture mode must stay offline even when a key is present.
  const fixture = createWebSearchTools({
    mode: 'fixture',
    env: process.env,
  })[0];
  const fixtureCapture = await fixture.execute(query, context());
  record(
    'fixture mode stays synthetic even with a key present',
    fixtureCapture.evidence_origin === 'synthetic_fixture',
    {
      evidence_origin: fixtureCapture.evidence_origin,
      retrieved_at: fixtureCapture.retrieved_at,
    },
  );

  const tool = createWebSearchTools({ mode: 'live', env: process.env })[0];
  const started = Date.now();
  try {
    const capture = await tool.execute(query, context());
    const elapsed = Date.now() - started;
    record(
      'live Tavily search returns usable evidence',
      capture.result_count > 0 &&
        /^[a-f0-9]{64}$/.test(capture.response_sha256),
      {
        provider: capture.provider,
        evidence_origin: capture.evidence_origin,
        result_count: capture.result_count,
        response_sha256: `${capture.response_sha256.slice(0, 12)}…`,
        retrieved_at: capture.retrieved_at,
        elapsed_ms: elapsed,
      },
    );
    record(
      'every result carries a title, absolute URL and snippet',
      capture.results.every(
        (r) => r.title && /^https?:\/\//.test(r.url) && r.snippet,
      ),
      {
        urls: capture.results.map((r) => r.url),
      },
    );
    record(
      'the requested result cap is respected',
      capture.results.length <= query.max_results,
      {
        requested: query.max_results,
        returned: capture.results.length,
      },
    );
    record(
      'the provider key never appears in the retained capture',
      !JSON.stringify(capture).includes(KEY),
      {
        key_leaked: JSON.stringify(capture).includes(KEY),
      },
    );
    process.stdout.write('\n  retrieved documents:\n');
    for (const r of capture.results)
      process.stdout.write(
        `    - ${r.title}\n      ${r.url}\n      ${r.snippet.slice(0, 160)}…\n`,
      );
    report = {
      probe: 'haze-web-search live',
      skipped: false,
      query,
      capture,
      results,
    };
  } catch (error) {
    const message = String(error?.message ?? error)
      .split(KEY)
      .join('<redacted>');
    record('live Tavily search returns usable evidence', false, {
      error: message,
    });
    report = {
      probe: 'haze-web-search live',
      skipped: false,
      query,
      error: message,
      results,
    };
  }
}

writeFileSync(
  'qa/web-search-live.json',
  `${JSON.stringify(report, null, 2)}\n`,
);
const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} checks passed -> qa/web-search-live.json\n`,
);
process.exit(failed.length ? 1 : 0);
