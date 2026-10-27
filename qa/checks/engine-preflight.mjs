#!/usr/bin/env node
// UC-01: the declared toolchain must not make a clean clone uninstallable.
//
// Fails ONLY when a mismatch would actually BLOCK `npm ci` — that is, when the
// running toolchain falls outside package.json "engines" AND engine-strict is
// enabled. A mismatch without engine-strict is reported as an advisory warning,
// because npm then prints EBADENGINE and installs anyway.
//
// This is the regression test for finding F-01: it fails if an exact, strictly
// enforced pin is reintroduced.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = pkg.engines ?? {};

const haveNode = process.version.replace(/^v/, '');
let haveNpm = 'unknown';
try {
  // execSync (not execFileSync with shell:true, which is deprecated) — npm is a
  // .cmd shim on Windows and needs a shell.
  haveNpm = execSync('npm -v', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  /* leave unknown */
}

// --- minimal semver range support (no dependencies) ---------------------
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const compare = (a, b) => {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};
/** Supports space-separated comparators: >= > <= < = and a bare exact version. */
function satisfies(version, range) {
  const actual = parse(version);
  if (!actual) return false;
  const parts = String(range).trim().split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const m = /^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/.exec(part);
    if (!m) return false; // an operator we do not model -> treat as unmet
    const op = m[1] ?? '=';
    const padded = m[2].split('.').map(Number);
    while (padded.length < 3) padded.push(0);
    const c = compare(actual, padded);
    const ok =
      op === '>='
        ? c >= 0
        : op === '>'
          ? c > 0
          : op === '<='
            ? c <= 0
            : op === '<'
              ? c < 0
              : c === 0;
    if (!ok) return false;
  }
  return parts.length > 0;
}

const isExactPin = (range) => /^v?\d+\.\d+\.\d+$/.test(String(range).trim());

// --- evaluate -----------------------------------------------------------
const npmrc = existsSync('.npmrc') ? readFileSync('.npmrc', 'utf8') : '';
// A commented-out directive must not count as enabled.
const engineStrict = /^\s*engine-strict\s*=\s*true\s*$/m.test(npmrc);

const checks = [
  { tool: 'node', declared: declared.node, actual: haveNode },
  { tool: 'npm', declared: declared.npm, actual: haveNpm },
];

const outside = [];
const exactPins = [];
for (const c of checks) {
  if (!c.declared) continue;
  if (isExactPin(c.declared)) exactPins.push(`${c.tool}="${c.declared}"`);
  if (!satisfies(c.actual, c.declared))
    outside.push(`${c.tool}: declared ${c.declared}, running ${c.actual}`);
}

const blocking = engineStrict && outside.length > 0;

console.log(
  JSON.stringify(
    {
      engines_declared: declared,
      engines_actual: { node: haveNode, npm: haveNpm },
      engine_strict: engineStrict,
      exact_pins: exactPins,
      outside_declared_range: outside,
      install_blocked: blocking,
    },
    null,
    2,
  ),
);

if (blocking) {
  console.error(
    [
      '',
      'INSTALL BLOCKED (F-01 regression): engine-strict=true and the running',
      'toolchain is outside the declared range, so `npm ci` cannot complete:',
      ...outside.map((o) => `  - ${o}`),
      '',
      'Declare "engines" as a range and leave engine-strict disabled, keeping the',
      'exact version in .nvmrc / .node-version as the developer hint.',
    ].join('\n'),
  );
  process.exit(1);
}

if (exactPins.length)
  console.warn(
    `\nWARNING: exact engine pin(s) present (${exactPins.join(', ')}). ` +
      'Harmless while engine-strict is disabled, but re-enabling it would block install.',
  );

if (outside.length) {
  console.warn(
    [
      '',
      'ADVISORY: the running toolchain is outside the declared range:',
      ...outside.map((o) => `  - ${o}`),
      '',
      'npm prints EBADENGINE and installs anyway (engine-strict is disabled).',
      'Use the version in .nvmrc for a fully supported environment.',
    ].join('\n'),
  );
  console.log('\nEngine preflight passed (advisory mismatch only).');
} else {
  console.log(
    '\nEngine preflight passed (toolchain satisfies declared range).',
  );
}
