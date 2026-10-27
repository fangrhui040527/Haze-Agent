#!/usr/bin/env node
// System test harness. Runs E2E use cases, logs structured findings.
// Usage: node qa/run-usecases.mjs [--only UC-01,UC-07] [--skip-slow]
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const QA = join(ROOT, 'qa');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(QA, { recursive: true });

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1].split(',') : null;
const SKIP_SLOW = argv.includes('--skip-slow');

/**
 * expect: 'pass'  -> exit 0 required
 *         'fail'  -> non-zero exit required (negative test)
 * slow: excluded by --skip-slow
 */
const USE_CASES = [
  // --- Layer 0: environment / repo hygiene ---
  {
    id: 'UC-01',
    name: 'Engine pin preflight (node/npm match package.json engines)',
    layer: 'environment',
    cmd: 'node qa/checks/engine-preflight.mjs',
    expect: 'pass',
  },
  {
    id: 'UC-02',
    name: 'Vendored engine pins verify',
    layer: 'environment',
    cmd: 'npm run verify:pins',
    expect: 'pass',
  },
  {
    id: 'UC-03',
    name: 'Prettier format check',
    layer: 'static',
    cmd: 'npm run format:check',
    expect: 'pass',
  },
  {
    id: 'UC-04',
    name: 'TypeScript typecheck (root + zetaris project)',
    layer: 'static',
    cmd: 'npm run typecheck',
    expect: 'pass',
    slow: true,
  },
  {
    id: 'UC-05',
    name: 'ESLint zero-warnings (incl. architecture import rules)',
    layer: 'static',
    cmd: 'npm run lint',
    expect: 'pass',
    slow: true,
  },
  {
    id: 'UC-06',
    name: 'Backend build (vendor:engines + build)',
    layer: 'build',
    cmd: 'npm run build',
    expect: 'pass',
    slow: true,
  },

  // --- Layer 1: unit / contract ---
  {
    id: 'UC-07',
    name: 'Unit + runtime integration suite (vitest unit project)',
    layer: 'unit',
    cmd: 'npm test',
    expect: 'pass',
    slow: true,
  },
  {
    id: 'UC-08',
    name: 'Engine source tests',
    layer: 'unit',
    cmd: 'npm run test:engines',
    expect: 'pass',
  },
  {
    id: 'UC-09',
    name: 'Model route evaluation + nightshift strict unit tests',
    layer: 'unit',
    cmd: 'npm run routes:test',
    expect: 'pass',
  },

  // --- Layer 2: offline example / demos ---
  {
    id: 'UC-10',
    name: 'Offline example run (npm start, no env required)',
    layer: 'e2e-offline',
    cmd: 'npm start',
    expect: 'pass',
  },
  {
    id: 'UC-11',
    name: 'General engine fixture verification (task lifecycle E2E)',
    layer: 'e2e-offline',
    cmd: 'node scripts/verify-general.mjs --fixture',
    expect: 'pass',
    freshState: true,
    slow: true,
  },
  {
    id: 'UC-12',
    name: 'Damage account fixture verification',
    layer: 'e2e-offline',
    cmd: 'node scripts/verify-damage-account.mjs --fixture',
    expect: 'pass',
    freshState: true,
  },
  {
    id: 'UC-13',
    name: 'Damage reduction method verification',
    layer: 'e2e-offline',
    cmd: 'node scripts/verify-damage-reduction.mjs --fixture',
    expect: 'pass',
    freshState: true,
  },
  {
    id: 'UC-14',
    name: 'Damage reduction capacity variant',
    layer: 'e2e-offline',
    cmd: 'node scripts/verify-damage-reduction.mjs --fixture --capacity',
    expect: 'pass',
    freshState: true,
  },
  {
    id: 'UC-15',
    name: 'Reduction planning preview verification',
    layer: 'e2e-offline',
    cmd: 'node scripts/verify-damage-reduction-preview.mjs --fixture',
    expect: 'pass',
    freshState: true,
  },
  {
    id: 'UC-16',
    name: 'Reduction programmes verification',
    layer: 'e2e-offline',
    cmd: 'node scripts/verify-damage-reduction-programmes.mjs --fixture',
    expect: 'pass',
    freshState: true,
  },
  {
    id: 'UC-17',
    name: 'Reduction programme envelope (capacity)',
    layer: 'e2e-offline',
    cmd: 'node scripts/verify-damage-reduction-programme-envelope.mjs --fixture --capacity',
    expect: 'pass',
    freshState: true,
  },
  {
    id: 'UC-18',
    name: 'Reduction pilot verification',
    layer: 'e2e-offline',
    cmd: 'node scripts/verify-damage-reduction-pilot.mjs --fixture',
    expect: 'pass',
    freshState: true,
  },
  {
    id: 'UC-19',
    name: 'Reduction evaluation verification',
    layer: 'e2e-offline',
    cmd: 'node scripts/verify-damage-reduction-evaluation.mjs --fixture',
    expect: 'pass',
    freshState: true,
  },

  // --- Layer 3: durability / fault injection ---
  {
    id: 'UC-20',
    name: 'LangGraph crash recovery (fencing, resume, no budget replenish)',
    layer: 'durability',
    cmd: 'npm run test:crashes',
    expect: 'pass',
    freshState: true,
    slow: true,
  },
  {
    // Requires a retained pre-LangGraph dist passed as
    // `--legacy-executable /absolute/path` (scripts/verify-langgraph-rollback.mjs:10).
    // It is a manual cutover tool, deliberately excluded from `npm run check`,
    // and cannot run unattended here — recorded as optional (WARN), not a defect.
    id: 'UC-21',
    name: 'LangGraph rollback (needs --legacy-executable retained dist)',
    layer: 'durability',
    cmd: 'npm run test:rollback',
    expect: 'pass',
    freshState: true,
    slow: true,
    optional: true,
  },
  {
    id: 'UC-22',
    name: 'Nightshift strict contract tests',
    layer: 'durability',
    cmd: 'npm run nightshift:contract:test',
    expect: 'pass',
  },
  {
    id: 'UC-23',
    name: 'Nightshift crash handling',
    layer: 'durability',
    cmd: 'npm run nightshift:test:crashes',
    expect: 'pass',
    freshState: true,
  },
  {
    id: 'UC-24',
    name: 'Nightshift wait-crash handling',
    layer: 'durability',
    cmd: 'npm run nightshift:test:wait-crashes',
    expect: 'pass',
    freshState: true,
  },
  {
    id: 'UC-25',
    name: 'Nightshift chain-crash handling',
    layer: 'durability',
    cmd: 'npm run nightshift:test:chain-crashes',
    expect: 'pass',
    freshState: true,
  },
  {
    // `npm run damage:demo` is a long-running demo SERVER that stays up by
    // design, so asserting `exit 0` on it always timed out. The probe waits for
    // the demo's completed/reviewed markers and then stops the process tree.
    id: 'UC-26',
    name: 'Demo: damage account reaches its independently reviewed state',
    layer: 'e2e-offline',
    cmd: 'node qa/checks/damage-demo-probe.mjs',
    expect: 'pass',
    slow: true,
  },
  {
    id: 'UC-27',
    name: 'Demo: nightshift',
    layer: 'e2e-offline',
    cmd: 'npm run nightshift:demo',
    expect: 'pass',
  },

  // --- Layer 4: frontend ---
  {
    id: 'UC-28',
    name: 'Frontend build + tests',
    layer: 'frontend',
    cmd: 'npm run frontend:check',
    expect: 'pass',
    slow: true,
  },

  // --- Layer 5: state-dir safety (negative tests) ---
  {
    id: 'UC-29',
    name: 'NEGATIVE: nonempty unmarked STATE_DIR must fail without modifying it',
    layer: 'safety',
    cmd: 'node qa/checks/state-dir-guard.mjs',
    expect: 'pass',
  },
  {
    id: 'UC-30',
    name: 'Postgres-backed suite (skips cleanly when no HAZE_TEST_POSTGRES_URL)',
    layer: 'unit',
    cmd: 'npm run test:postgres',
    expect: 'pass',
    optional: true,
  },

  // --- Layer 6: contract & accounting probes ---
  {
    id: 'UC-31',
    name: 'HTTP API contract (origin/idempotency/v3-only/bounds/query strictness)',
    layer: 'api',
    cmd: 'node qa/checks/api-e2e.mjs',
    expect: 'pass',
  },
  {
    id: 'UC-32',
    name: 'Peer channel message/byte budget bounds',
    layer: 'peer',
    cmd: 'node qa/checks/peer-budget-probe.mjs',
    expect: 'pass',
  },
  {
    id: 'UC-33',
    name: 'Reserved review capacity is released when review cannot run',
    layer: 'resources',
    cmd: 'node qa/checks/review-reserve-probe.mjs',
    expect: 'pass',
  },

  // --- Layer 7: agent supervision (offline/scripted, no provider needed) ---
  {
    // 12 scripted Manager supervision scenarios: clarification, single and
    // parallel dispatch, known failure, rejected review, conflicting evidence,
    // unavailable, peer request, partial, correction, injected document.
    // Each case also asserts role isolation (specialists make no direct model
    // or tool calls). `--scripted` is required; a bare invocation prints usage.
    id: 'UC-34',
    name: 'Manager supervision scenarios (scripted, offline) + role isolation',
    layer: 'agents',
    cmd: 'npm run manager:test -- --scripted',
    expect: 'pass',
    slow: true,
  },
  {
    // Requires an explicit STATE_DIR (asserted by the script) and reports
    // local-passed-provider-skipped when HAZE_PROVIDER is offline.
    id: 'UC-35',
    name: 'Compatibility probe (local checks pass, provider skipped offline)',
    layer: 'agents',
    cmd: 'npm run probe:compatibility',
    expect: 'pass',
    freshState: true,
    slow: true,
  },
  {
    // --inspect is the offline mode; --live needs a configured provider.
    id: 'UC-36',
    name: 'Model route evaluation inspection (offline)',
    layer: 'agents',
    cmd: 'npm run routes:evaluate -- --inspect',
    expect: 'pass',
    freshState: true,
  },

  // --- Layer 8: live data retrieval ---------------------------------------
  // Marked optional so an offline or rate-limited run records WARN rather than
  // a false FAIL. Both probes reach the public internet; the FIRMS scenarios
  // self-skip when FIRMS_MAP_KEY is absent.
  {
    id: 'UC-37',
    name: 'Upstream data sources return live data (network)',
    layer: 'data',
    cmd: 'node qa/checks/data-sources-probe.mjs',
    expect: 'pass',
    optional: true,
  },
  {
    id: 'UC-38',
    name: "Agent's own evidence adapters retrieve live data (network)",
    layer: 'data',
    cmd: 'node qa/checks/agent-retrieval-probe.mjs',
    expect: 'pass',
    optional: true,
  },

  // --- Layer 9: live Zetaris -----------------------------------------------
  // Requires the stack up (docker compose up --detach) plus the FIRMS and
  // PM2.5 sources registered. Optional so a run without Zetaris records WARN.
  {
    id: 'UC-39',
    name: 'Zetaris live real-world haze use cases (10 scenarios)',
    layer: 'zetaris',
    cmd: 'node qa/checks/zetaris-usecases.mjs',
    expect: 'pass',
    optional: true,
    slow: true,
  },
  {
    // The Zetaris operator scripts are Python and were never run by any suite.
    // Covers env resolution and REST token refresh; offline, no stack needed.
    id: 'UC-43',
    name: 'Zetaris operator script tests (python unittest)',
    layer: 'unit',
    cmd: 'npm run test:zetaris-scripts',
    expect: 'pass',
  },
  {
    // Cross-system scenarios: live Zetaris warehouse + live upstream APIs +
    // live web search. Needs the Zetaris stack up with FIRMS and PM2.5
    // registered, so it is optional and records WARN when unavailable.
    id: 'UC-42',
    name: 'Live cross-system real-world haze scenarios (7 questions)',
    layer: 'zetaris',
    cmd: 'node --env-file-if-exists=.env qa/checks/scenarios-live.mjs',
    expect: 'pass',
    optional: true,
    slow: true,
  },
  {
    // Needs TAVILY_API_KEY and network; the probe skips cleanly without a key,
    // so an unconfigured run records WARN rather than a false FAIL.
    id: 'UC-41',
    name: 'Live web-search evidence tool returns usable documents (network)',
    layer: 'data',
    cmd: 'node --env-file-if-exists=.env qa/checks/web-search-live-probe.mjs',
    expect: 'pass',
    optional: true,
  },
  {
    // Reports every agent's registration, model route and capability backing
    // from the runtime's own endpoints. Passes when all five roles are
    // registered and routed; it does NOT require a reachable model provider,
    // and records inference_available separately.
    id: 'UC-40',
    name: 'Agent health: all roles registered, routed and capability-backed',
    layer: 'agents',
    cmd: 'node qa/checks/agent-health-probe.mjs --live',
    expect: 'pass',
  },
];

function runOne(uc) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env };
    let stateDir = null;
    if (uc.freshState) {
      stateDir = join(
        ROOT,
        '.state',
        `qa-${uc.id}-${Math.random().toString(36).slice(2, 8)}`,
      );
      env.STATE_DIR = stateDir;
    }
    const child = spawn(uc.cmd, {
      cwd: ROOT,
      shell: true,
      env,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const LIMIT = 200_000;
    child.stdout.on('data', (d) => {
      if (out.length < LIMIT) out += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (err.length < LIMIT) err += d.toString();
    });
    const TIMEOUT_MS = uc.slow ? 900_000 : 300_000;
    const timer = setTimeout(() => {
      // child.kill() on a shell:true process kills only the shell. On Windows the
      // npm/node grandchildren survive, keep the stdio pipes open, and 'close'
      // never fires -- so the timeout silently has no effect. Kill the tree.
      if (process.platform === 'win32' && child.pid)
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      else child.kill('SIGKILL');
      err += `\n[harness] TIMEOUT after ${TIMEOUT_MS}ms (process tree killed)\n`;
    }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const exitCode = code === null ? -1 : code;
      const passed = uc.expect === 'fail' ? exitCode !== 0 : exitCode === 0;
      if (stateDir) {
        try {
          rmSync(stateDir, { recursive: true, force: true });
        } catch {
          /* leave for inspection */
        }
      }
      resolve({
        id: uc.id,
        name: uc.name,
        layer: uc.layer,
        command: uc.cmd,
        expect: uc.expect,
        optional: Boolean(uc.optional),
        exitCode,
        durationMs,
        status: passed ? 'PASS' : uc.optional ? 'WARN' : 'FAIL',
        stdoutTail: out.slice(-6000),
        stderrTail: err.slice(-6000),
      });
    });
  });
}

const selected = USE_CASES.filter(
  (uc) => (!ONLY || ONLY.includes(uc.id)) && !(SKIP_SLOW && uc.slow),
);

// --merge keeps previously recorded results for use cases NOT selected in this
// run, so a single case can be re-run without discarding the rest of the report.
const MERGE = argv.includes('--merge');
const carried = [];
if (MERGE && existsSync(join(QA, 'findings.json'))) {
  try {
    const prior = JSON.parse(readFileSync(join(QA, 'findings.json'), 'utf8'));
    const selectedIds = new Set(selected.map((uc) => uc.id));
    for (const r of prior.results ?? [])
      if (!selectedIds.has(r.id)) carried.push(r);
    process.stdout.write(
      `[harness] --merge: carrying ${carried.length} prior result(s)\n`,
    );
  } catch {
    process.stdout.write('[harness] --merge: prior findings.json unreadable\n');
  }
}

const order = new Map(USE_CASES.map((uc, i) => [uc.id, i]));
const merge = (fresh) =>
  [...carried, ...fresh].sort(
    (a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999),
  );

const results = [];
for (const uc of selected) {
  process.stdout.write(`\n>>> ${uc.id} ${uc.name}\n    $ ${uc.cmd}\n`);
  const r = await runOne(uc);
  results.push(r);
  process.stdout.write(
    `    ${r.status} exit=${r.exitCode} ${Math.round(r.durationMs / 1000)}s\n`,
  );
  writeFileSync(
    join(QA, 'findings.json'),
    JSON.stringify(buildReport(merge(results)), null, 2),
  );
}

function buildReport(rs) {
  return {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: ROOT,
    },
    totals: {
      total: rs.length,
      pass: rs.filter((r) => r.status === 'PASS').length,
      fail: rs.filter((r) => r.status === 'FAIL').length,
      warn: rs.filter((r) => r.status === 'WARN').length,
    },
    results: rs,
  };
}

const report = buildReport(merge(results));
writeFileSync(join(QA, 'findings.json'), JSON.stringify(report, null, 2));

const lines = [
  `Haze Agent — system test run ${RUN_ID}`,
  `node=${process.version} platform=${process.platform}`,
  `total=${report.totals.total} pass=${report.totals.pass} fail=${report.totals.fail} warn=${report.totals.warn}`,
  '',
];
for (const r of report.results) {
  lines.push(
    `[${r.status}] ${r.id} ${r.name}`,
    `    cmd: ${r.command}`,
    `    exit=${r.exitCode} duration=${Math.round(r.durationMs / 1000)}s`,
  );
  if (r.status !== 'PASS') {
    const blob = (r.stderrTail + '\n' + r.stdoutTail).trim().split('\n');
    lines.push('    --- output tail ---');
    for (const l of blob.slice(-25)) lines.push(`    ${l}`);
  }
  lines.push('');
}
writeFileSync(join(QA, 'findings.txt'), lines.join('\n'));
process.stdout.write(
  `\n=== wrote qa/findings.json + qa/findings.txt ===\npass=${report.totals.pass} fail=${report.totals.fail} warn=${report.totals.warn}\n`,
);
