// Map Haze audit artifacts and vitest output onto TestRail results.
import { existsSync, readFileSync } from 'node:fs';
import { STATUS, formatElapsed } from './client.mjs';
import { slug, loadArtifacts } from './cases.mjs';

/**
 * The vitest <-> TestRail bridge.
 *
 * Playwright's `test.info().annotations` does not exist in vitest, so a linked
 * test declares its case id in the title instead:
 *
 *   it('[C12345] rejects a nonempty unmarked state directory', ...)
 *
 * `task.meta.testrail` is also honoured for anyone who prefers metadata:
 *
 *   it('rejects ...', (ctx) => { ctx.task.meta.testrail = 'C12345'; ... })
 */
export const CASE_ID_PATTERN = /\bC(\d{1,9})\b/g;

export function extractCaseIds(text) {
  const ids = new Set();
  for (const match of String(text ?? '').matchAll(CASE_ID_PATTERN))
    ids.add(Number(match[1]));
  return [...ids];
}

const clip = (s, n = 1500) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}\n...[truncated]` : t;
};

/** Results keyed by catalogue key, for cases imported from the artifacts. */
export function collectArtifactResults(artifacts = loadArtifacts()) {
  const results = [];

  for (const r of artifacts.findings?.results ?? []) {
    const status =
      r.status === 'PASS'
        ? STATUS.PASSED
        : r.status === 'WARN'
          ? STATUS.BLOCKED
          : STATUS.FAILED;
    const lines = [
      `harness use case ${r.id} (${r.layer})`,
      `command: ${r.command}`,
      `exit code: ${r.exitCode} (expected ${r.expect})`,
      `duration: ${Math.round(r.durationMs / 1000)}s`,
    ];
    if (status !== STATUS.PASSED) {
      const tail = `${r.stderrTail ?? ''}\n${r.stdoutTail ?? ''}`.trim();
      if (tail) lines.push('', 'output tail:', clip(tail));
    }
    results.push({
      key: r.id,
      status_id: status,
      comment: lines.join('\n'),
      elapsed: formatElapsed(r.durationMs),
    });
  }

  for (const c of artifacts.api?.checks ?? []) {
    const { name, ok, ...detail } = c;
    results.push({
      key: `API/${slug(name)}`,
      status_id: ok ? STATUS.PASSED : STATUS.FAILED,
      comment: [
        `HTTP API contract check: ${name}`,
        `observed: ${JSON.stringify(detail)}`,
      ].join('\n'),
    });
  }

  for (const s of artifacts.sdg?.scenarios ?? []) {
    const { scenario, ok, ...detail } = s;
    results.push({
      key: `SDG/${slug(scenario)}`,
      status_id: ok ? STATUS.PASSED : STATUS.FAILED,
      comment: [
        `STATE_DIR guard scenario: ${scenario}`,
        `observed: ${JSON.stringify(detail)}`,
      ].join('\n'),
    });
  }

  for (const p of artifacts.peer?.results ?? []) {
    const { name, ok, ...detail } = p;
    results.push({
      key: `PEER/${slug(name)}`,
      status_id: ok ? STATUS.PASSED : STATUS.FAILED,
      comment: [
        `Peer channel budget scenario: ${name}`,
        `observed: ${JSON.stringify(detail)}`,
      ].join('\n'),
    });
  }

  for (const r of artifacts.reserve?.results ?? []) {
    const { name, ok, ...detail } = r;
    results.push({
      key: `RESERVE/${slug(name)}`,
      status_id: ok ? STATUS.PASSED : STATUS.FAILED,
      comment: [
        `Review reserve scenario: ${name}`,
        `observed: ${JSON.stringify(detail)}`,
      ].join('\n'),
    });
  }

  return results;
}

/**
 * Results for vitest tests that carry an explicit TestRail case id.
 * Returns { linked, unlinked, totals } — unlinked tests are reported so the
 * coverage gap is visible rather than silently dropped.
 */
export function collectVitestResults(reportPath = 'qa/vitest-results.json') {
  if (!existsSync(reportPath))
    return {
      linked: [],
      unlinked: [],
      totals: { total: 0, linked: 0 },
      missing: true,
    };

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const linked = [];
  const unlinked = [];

  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      const ids = [
        ...extractCaseIds(t.fullName),
        ...extractCaseIds(t.meta?.testrail),
      ];
      const status =
        t.status === 'passed'
          ? STATUS.PASSED
          : t.status === 'failed'
            ? STATUS.FAILED
            : STATUS.BLOCKED;
      if (!ids.length) {
        unlinked.push({ file: file.name, name: t.fullName, status: t.status });
        continue;
      }
      const comment = [
        `vitest: ${t.fullName}`,
        `file: ${file.name}`,
        `status: ${t.status}`,
        ...(t.failureMessages?.length
          ? ['', 'failure:', clip(t.failureMessages.join('\n\n'))]
          : []),
      ].join('\n');
      for (const case_id of new Set(ids))
        linked.push({
          case_id,
          status_id: status,
          comment,
          elapsed: formatElapsed(t.duration),
        });
    }
  }

  const total = (report.testResults ?? []).reduce(
    (n, f) => n + (f.assertionResults?.length ?? 0),
    0,
  );
  return {
    linked,
    unlinked,
    totals: { total, linked: linked.length, unlinked: unlinked.length },
    missing: false,
  };
}
