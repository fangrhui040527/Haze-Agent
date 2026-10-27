// Haze Agent TestRail case catalogue.
//
// The catalogue is DERIVED from the audit artifacts rather than hand-maintained,
// so it cannot drift from what actually runs:
//   qa/findings.json          -> UC-01..UC-30 harness use cases
//   qa/api-e2e.json           -> HTTP API contract checks
//   qa/state-dir-guard.json   -> STATE_DIR marker guard scenarios
//   qa/peer-budget-probe.json -> peer channel budget scenarios
//   qa/review-reserve-probe.json -> reserved review capacity scenarios
//
// CURATED supplies real preconditions/steps/expected text for the high-value
// cases; everything else gets accurate generic text built from its command/name.
import { readFileSync, existsSync } from 'node:fs';

export const SECTIONS = {
  ENVIRONMENT: 'Environment & Toolchain',
  STATIC: 'Static Analysis & Build',
  UNIT: 'Unit & Runtime Integration',
  OFFLINE: 'Offline E2E (fixture mode)',
  DURABILITY: 'Durability & Fault Injection',
  FRONTEND: 'Frontend',
  API: 'HTTP API Contract',
  STORAGE: 'Storage Safety (STATE_DIR guard)',
  PEER: 'Peer Channel Budget',
  RESOURCES: 'Resource Accounting',
  AGENTS: 'Agent Supervision',
  DATA: 'Live Data Retrieval',
  ZETARIS: 'Zetaris Live Platform',
};

const LAYER_TO_SECTION = {
  environment: SECTIONS.ENVIRONMENT,
  static: SECTIONS.STATIC,
  build: SECTIONS.STATIC,
  unit: SECTIONS.UNIT,
  'e2e-offline': SECTIONS.OFFLINE,
  durability: SECTIONS.DURABILITY,
  frontend: SECTIONS.FRONTEND,
  safety: SECTIONS.STORAGE,
  api: SECTIONS.API,
  peer: SECTIONS.PEER,
  resources: SECTIONS.RESOURCES,
  agents: SECTIONS.AGENTS,
  data: SECTIONS.DATA,
  zetaris: SECTIONS.ZETARIS,
};

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

const PRE_REPO = [
  'Repository cloned at the commit under test.',
  'Dependencies installed (`npm ci`; see UC-01 — an engine override may be required).',
  'Node 24.x available on PATH.',
].join('\n');

const PRE_BUILT = `${PRE_REPO}\n\`npm run build\` has been run (dist/ and vendor/ present).`;

/** Real, specific text for the cases worth spelling out. */
const CURATED = {
  'UC-01': {
    preconds: PRE_REPO,
    steps: [
      '1. On a machine whose Node/npm patch differs from .nvmrc, run `npm ci`.',
      '2. Run `node qa/checks/engine-preflight.mjs`.',
    ].join('\n'),
    expected: [
      '`npm ci` completes. The preflight exits 0, reporting install_blocked=false.',
      '',
      'A toolchain outside the declared range is an ADVISORY warning only: npm prints',
      'EBADENGINE and installs anyway. The check FAILS only if a blocking configuration',
      'is reintroduced, i.e. engine-strict=true together with an out-of-range toolchain.',
      '',
      'Regression guard for F-01 (fixed): engines were exact literals',
      '("node":"24.22.1","npm":"11.8.0") with engine-strict=true, which rejected even a',
      'NEWER npm and made a clean clone uninstallable. Now declared as ranges',
      '(">=24.22.1 <25", ">=11.8.0") with engine-strict disabled, and frontend/ declares',
      'the same range so both halves of the repo agree.',
    ].join('\n'),
  },
  'UC-03': {
    preconds: PRE_REPO,
    steps: '1. Run `npm run format:check`.',
    expected:
      'Prettier reports "All matched files use Prettier code style!" and exits 0.\nGenerated qa/*.json and qa/*.txt artifacts are excluded via .prettierignore.',
  },
  'UC-05': {
    preconds: PRE_REPO,
    steps: '1. Run `npm run lint` (eslint . --max-warnings 0).',
    expected:
      'Zero errors and zero warnings, including the architecture import rules that forbid core-to-domain imports (app/composition.ts is the only registration point).',
  },
  'UC-07': {
    preconds: PRE_BUILT,
    steps: '1. Run `npm test` (vitest run --project unit).',
    expected: [
      'All unit and runtime-integration tests pass.',
      '',
      'Regression guard for F-04 (fixed): the parameterized pilot test',
      '"retains an explicit limited pilot when precision_power is unusable" carried a',
      '40_000ms budget and intermittently timed out at ~41s under parallel load, while',
      'taking ~7.5s in isolation. tests/unit/damage-reduction-pilot-integration.test.ts',
      'now sets a 120_000ms budget file-wide (vi.setConfig) because every test there',
      'drives SQLite + LangGraph end to end. A genuine hang still fails, just later.',
    ].join('\n'),
  },
  'UC-08': {
    preconds: PRE_REPO,
    steps: [
      '1. Delete vendor/ so the tree is clean.',
      '2. Run `npm run test:engines` WITHOUT running `npm run build` first.',
    ].join('\n'),
    expected: [
      'The engine conformance checks run and pass (8/8) on a clean tree.',
      '',
      'Regression guard for F-02 (fixed): test:engines consumed vendor:engines output',
      'without declaring it, so standalone it failed with MODULE_NOT_FOUND for',
      'vendor/meterless/engines/hmem/conformance/runner.js and only passed after `build`.',
      '`npm run check` masked it by running build earlier in the chain. The script now',
      'chains `npm run vendor:engines &&` itself.',
    ].join('\n'),
  },
  'UC-10': {
    preconds: PRE_BUILT,
    steps:
      '1. With NO environment configuration and no network, run `npm start`.',
    expected:
      'The bundled example completes offline and exits 0, honouring the documented guarantee that "npm start examples run offline and need no environment configuration".',
  },
  'UC-11': {
    preconds: PRE_BUILT,
    steps:
      '1. With a fresh STATE_DIR, run `node scripts/verify-general.mjs --fixture`.',
    expected:
      'The general task engine admits the objective, runs the Manager/specialist graph to completion in fixture mode and reports accepted/held/completed with no error.',
  },
  'UC-20': {
    preconds: PRE_BUILT,
    steps: '1. With a fresh STATE_DIR, run `npm run test:crashes`.',
    expected:
      'Crash recovery holds: old leases are fenced on restart, completed accepted material is retained, unstarted work can resume, and resume neither replenishes a budget nor extends a deadline.',
  },
  'UC-21': {
    preconds: `${PRE_BUILT}\nA retained legacy dist from the pre-LangGraph build is available.`,
    steps:
      '1. Run `npm run test:rollback -- --legacy-executable /absolute/path/to/retained-dist`.',
    expected: [
      'The rollback verification completes against the retained legacy executable.',
      '',
      'NOTE: the required --legacy-executable argument is mandatory',
      '(scripts/verify-langgraph-rollback.mjs:10). This is a manual cutover tool and is',
      'deliberately NOT part of `npm run check`; invoking it bare is expected to fail.',
    ].join('\n'),
  },
  'UC-30': {
    preconds: `${PRE_REPO}\nOptionally a disposable local PostgreSQL via HAZE_TEST_POSTGRES_URL.`,
    steps: '1. Run `npm run test:postgres`.',
    expected:
      'With HAZE_TEST_POSTGRES_URL set, the postgres-backed suite passes. Without it, the suite skips cleanly rather than failing (recorded as Blocked).',
  },
};

const readJson = (path) => {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  // Probe scripts historically prefixed human-readable lines before the JSON.
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
};

export function loadArtifacts(root = 'qa') {
  return {
    findings: readJson(`${root}/findings.json`),
    api: readJson(`${root}/api-e2e.json`),
    sdg: readJson(`${root}/state-dir-guard.json`),
    peer: readJson(`${root}/peer-budget-probe.json`),
    reserve: readJson(`${root}/review-reserve-probe.json`),
  };
}

/**
 * Build the full case catalogue.
 * Each case: { key, section, title, preconds, steps, expected, refs }
 */
export function buildCatalogue(artifacts = loadArtifacts()) {
  const cases = [];
  const push = (c) => {
    const curated = CURATED[c.key] ?? {};
    cases.push({ ...c, ...curated });
  };

  // --- harness use cases -------------------------------------------------
  for (const r of artifacts.findings?.results ?? []) {
    const negative = r.expect === 'fail';
    push({
      key: r.id,
      section: LAYER_TO_SECTION[r.layer] ?? SECTIONS.STATIC,
      title: `${r.id} ${r.name}`,
      preconds: PRE_BUILT,
      steps: `1. From the repository root run:\n   ${r.command}`,
      expected: negative
        ? 'The command exits NON-ZERO (negative test).'
        : 'The command exits 0 with no unhandled error.',
      refs: 'qa/run-usecases.mjs',
    });
  }

  // --- HTTP API contract -------------------------------------------------
  for (const c of artifacts.api?.checks ?? []) {
    push({
      key: `API/${slug(c.name)}`,
      section: SECTIONS.API,
      title: c.name,
      preconds: `${PRE_BUILT}\nThe task API is served by scripts/serve-tasks.mjs --fixture on a fresh STATE_DIR and a free loopback port.`,
      steps: [
        '1. Run `node qa/checks/api-e2e.mjs` (boots the API itself).',
        `2. Locate the check named "${c.name}" in qa/api-e2e.json.`,
      ].join('\n'),
      expected: `The check reports ok: true.\nError bodies are shaped { error: { code, message } }; successful intake returns HTTP 202 with { task_id, status_url, events_url, reused }.`,
      refs: 'qa/checks/api-e2e.mjs',
    });
  }

  // --- STATE_DIR guard ---------------------------------------------------
  for (const s of artifacts.sdg?.scenarios ?? []) {
    push({
      key: `SDG/${slug(s.scenario)}`,
      section: SECTIONS.STORAGE,
      title: `STATE_DIR guard — ${s.scenario}`,
      preconds: `${PRE_BUILT}\nA temporary directory seeded for this scenario.`,
      steps: [
        '1. Run `node qa/checks/state-dir-guard.mjs`.',
        `2. Locate the scenario "${s.scenario}".`,
      ].join('\n'),
      expected: [
        'For a hostile directory: TaskStore construction throws the documented code',
        '(incompatible_state_directory or migration_incomplete), the seeded payload is',
        'byte-identical afterwards, no new directory entries appear, and NO .sqlite/-wal/-shm',
        'artifact is created — SQLite must never be opened before marker validation.',
        'For a CONTROL scenario: the directory is accepted, storage-format.json is written as',
        '{"format":"haze.general.sqlite.v2","schema_version":2}, and tasks.sqlite is created.',
      ].join('\n'),
      refs: 'app/tasks/store.ts:312-360',
    });
  }

  // --- peer channel budget ----------------------------------------------
  for (const p of artifacts.peer?.results ?? []) {
    push({
      key: `PEER/${slug(p.name)}`,
      section: SECTIONS.PEER,
      title: `Peer budget — ${p.name}`,
      preconds: `${PRE_BUILT}\nA task with two acquired assignments and one granted peer channel.`,
      steps: [
        '1. Run `node qa/checks/peer-budget-probe.mjs`.',
        `2. Locate the scenario "${p.name}".`,
      ].join('\n'),
      expected: [
        'The documented bounds hold exactly: one channel per run/objective revision,',
        'at most 6 messages and 12288 bytes, expiry at min(now+10min, run deadline).',
        'A message that would overshoot the cap is refused with peer_message_limit and the',
        'running total is unchanged; reaching the cap closes the channel.',
      ].join('\n'),
      refs: 'app/tasks/store.ts:5839-5990',
    });
  }

  // --- resource accounting (reserved review capacity) --------------------
  for (const r of artifacts.reserve?.results ?? []) {
    push({
      key: `RESERVE/${slug(r.name)}`,
      section: SECTIONS.RESOURCES,
      title: `Review reserve — ${r.name}`,
      preconds: `${PRE_BUILT}
A run with max_model_calls=4 and reserved_model_calls=2, holding a specialist, an EvidenceCritic and a synthesis assignment.`,
      steps: [
        '1. Run `node qa/checks/review-reserve-probe.mjs`.',
        `2. Locate the scenario "${r.name}".`,
      ].join('\n'),
      expected: [
        'Reserved independent-review capacity is held while a review can still',
        'run, and released to the final synthesis once every registered critic for',
        'the objective revision has terminated without a usable result. Specialist',
        'work must never claim the review reserve, so review and synthesis keep',
        'their capacity ahead of specialists. No model call may be left stranded.',
      ].join('\n'),
      refs: 'app/tasks/store.ts chargeAttempt',
    });
  }

  return cases;
}

/** Group a catalogue into { sectionName: cases[] } preserving order. */
export function bySection(cases) {
  const out = new Map();
  for (const c of cases) {
    if (!out.has(c.section)) out.set(c.section, []);
    out.get(c.section).push(c);
  }
  return out;
}
