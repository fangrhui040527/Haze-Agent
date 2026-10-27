#!/usr/bin/env node
// UC-26: the damage-account demo must reach its completed, independently
// reviewed state.
//
// `npm run damage:demo` is a LONG-RUNNING demo server, not a batch script: it
// boots Vite, seeds a synthetic World Model, builds and checks the account, then
// prints "Keep this process running to browse the demo." and stays up by design.
// An earlier version of this use case asserted `exit 0` and so always recorded a
// timeout — a tester error, not a product defect (record item I-01).
//
// The real assertion is that the demo reaches its success markers. This probe
// waits for them, then stops the process tree.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 240_000;
// A free-ish port so a developer's own demo on the default 5174 is untouched.
const PORT = String(5300 + Math.floor(Math.random() * 300));
const stateDir = mkdtempSync(join(tmpdir(), 'haze-damage-demo-'));

const REQUIRED = [
  {
    key: 'retains the synthetic example in the demo World Model',
    pattern: /Retaining the complete example in the demo World Model/i,
  },
  {
    key: 'builds and independently checks a request-only account',
    pattern: /Building and independently checking a request-only account/i,
  },
  {
    key: 'serves a completed damage-account URL',
    pattern: /Open the completed demo: (http:\/\/\S+)/i,
  },
  {
    key: 'reports a supported independent review',
    pattern: /Independent review:\s*supported/i,
  },
  {
    key: 'reports the expected benefit\/cost ratio',
    pattern: /Benefit\/cost ratio:\s*([0-9.]+)/i,
  },
  {
    key: 'stays up for browsing rather than exiting',
    pattern: /Keep this process running to browse the demo/i,
  },
];

// One command string, not (file, args) — passing an args array together with
// shell:true is deprecated (DEP0190) because the args are concatenated unescaped.
const child = spawn('npm run damage:demo', {
  cwd: process.cwd(),
  shell: true,
  windowsHide: true,
  env: {
    ...process.env,
    STATE_DIR: stateDir,
    HAZE_TASK_STATE_DIR: stateDir,
    HAZE_DAMAGE_DEMO_PORT: PORT,
  },
});

let output = '';
const started = Date.now();
child.stdout.on('data', (d) => (output += d.toString()));
child.stderr.on('data', (d) => (output += d.toString()));

const allSeen = () => REQUIRED.every((r) => r.pattern.test(output));

const outcome = await new Promise((resolve) => {
  const poll = setInterval(() => {
    if (allSeen()) {
      clearInterval(poll);
      resolve('complete');
    } else if (child.exitCode !== null) {
      clearInterval(poll);
      resolve(`exited_early:${child.exitCode}`);
    } else if (Date.now() - started > TIMEOUT_MS) {
      clearInterval(poll);
      resolve('timeout');
    }
  }, 500);
});

// Stop the tree. child.kill() alone leaves npm/node/vite grandchildren alive on
// Windows, which would hold the port and the state directory.
if (process.platform === 'win32' && child.pid)
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
else child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 2000));

const checks = REQUIRED.map((r) => {
  const match = r.pattern.exec(output);
  return { name: r.key, ok: Boolean(match), captured: match?.[1] ?? null };
});
const failed = checks.filter((c) => !c.ok);

for (const c of checks)
  process.stdout.write(
    `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.captured ? ` -> ${c.captured}` : ''}\n`,
  );

const report = {
  use_case: 'UC-26 damage-account demo reaches its reviewed state',
  outcome,
  elapsed_ms: Date.now() - started,
  port: Number(PORT),
  totals: {
    total: checks.length,
    pass: checks.length - failed.length,
    fail: failed.length,
  },
  checks,
  output_tail: output.slice(-3000),
};
writeFileSync(
  'qa/damage-demo-probe.json',
  `${JSON.stringify(report, null, 2)}\n`,
);
try {
  rmSync(stateDir, { recursive: true, force: true });
} catch {
  /* best effort */
}

process.stdout.write(
  `\noutcome=${outcome} in ${Math.round(report.elapsed_ms / 1000)}s -> qa/damage-demo-probe.json\n`,
);
if (outcome !== 'complete' || failed.length) {
  process.stderr.write(
    '\nThe demo did not reach its completed reviewed state.\n',
  );
  process.exit(1);
}
process.stdout.write(
  'Demo reached its completed, independently reviewed state.\n',
);
