#!/usr/bin/env node
// UC-29: STATE_DIR safety contract, exercised directly against TaskStore.
//
// Documented promises (docs/orchestration/general-engine.md + app/tasks/store.ts:312-360):
//   - "storage-format.json must identify haze.general.sqlite.v2 before the runtime opens SQLite"
//   - "A nonempty unmarked or incompatible directory fails without modification"
//   - "SQLite and its WAL sidecars must never be opened before marker validation"
//   - an incomplete migration marker must be preserved for inspection
//
// NOTE: an earlier version of this check drove scripts/verify-general.mjs with a
// hostile STATE_DIR. That was invalid -- verify-general.mjs:17-18 nests a fresh
// `general-verification` subdirectory under STATE_DIR, so the guard never saw the
// payload. Constructing TaskStore on the directory itself is the real test.
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../dist/tasks/store.js';

const MARKER = 'storage-format.json';
const MIGRATION = 'migration-in-progress.json';
const GOOD = { format: 'haze.general.sqlite.v2', schema_version: 2 };

const negative = [
  {
    name: 'nonempty unmarked directory',
    expect_code: 'incompatible_state_directory',
    payload: 'legacy-notes.txt',
    seed: (d) =>
      writeFileSync(join(d, 'legacy-notes.txt'), 'historical payload\n'),
  },
  {
    name: 'invalid marker JSON',
    expect_code: 'incompatible_state_directory',
    payload: MARKER,
    seed: (d) => writeFileSync(join(d, MARKER), '{not json'),
  },
  {
    name: 'incompatible marker format (v1)',
    expect_code: 'incompatible_state_directory',
    payload: MARKER,
    seed: (d) =>
      writeFileSync(
        join(d, MARKER),
        JSON.stringify({ format: 'haze.general.sqlite.v1', schema_version: 1 }),
      ),
  },
  {
    name: 'marker with extra unexpected field',
    expect_code: 'incompatible_state_directory',
    payload: MARKER,
    seed: (d) =>
      writeFileSync(
        join(d, MARKER),
        JSON.stringify({ ...GOOD, injected: 'surprise' }),
      ),
  },
  {
    name: 'marker with wrong schema_version',
    expect_code: 'incompatible_state_directory',
    payload: MARKER,
    seed: (d) =>
      writeFileSync(
        join(d, MARKER),
        JSON.stringify({ format: GOOD.format, schema_version: 99 }),
      ),
  },
  {
    name: 'incomplete migration marker present',
    expect_code: 'migration_incomplete',
    payload: MIGRATION,
    seed: (d) => {
      writeFileSync(join(d, MARKER), JSON.stringify(GOOD));
      writeFileSync(join(d, MIGRATION), JSON.stringify({ started: true }));
    },
  },
];

const findings = [];
let failed = 0;
const roots = [];

function record(name, ok, detail) {
  findings.push({ scenario: name, ok, ...detail });
  if (!ok) failed += 1;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
  process.stdout.write(`       ${JSON.stringify(detail)}\n`);
}

for (const sc of negative) {
  const dir = mkdtempSync(join(tmpdir(), 'haze-stateguard-'));
  roots.push(dir);
  sc.seed(dir);
  const before = readFileSync(join(dir, sc.payload));
  const beforeList = readdirSync(dir).sort();

  let code = null;
  let threw = false;
  let store = null;
  try {
    store = new TaskStore(dir, { recover: true });
  } catch (error) {
    threw = true;
    code = error?.code ?? String(error?.message ?? error);
  }
  if (store?.db?.isOpen) store.close();

  const afterList = readdirSync(dir).sort();
  const after = readFileSync(join(dir, sc.payload));
  const newEntries = afterList.filter((e) => !beforeList.includes(e));
  const dbArtifacts = afterList.filter((e) => /\.sqlite(-wal|-shm)?$/.test(e));

  record(
    sc.name,
    threw &&
      code === sc.expect_code &&
      before.equals(after) &&
      newEntries.length === 0 &&
      dbArtifacts.length === 0,
    {
      threw,
      code,
      expected_code: sc.expect_code,
      payload_intact: before.equals(after),
      new_entries: newEntries,
      sqlite_artifacts: dbArtifacts,
    },
  );
}

// --- POSITIVE CONTROL: a fresh empty directory must be accepted and marked ---
{
  const dir = mkdtempSync(join(tmpdir(), 'haze-stateguard-ok-'));
  roots.push(dir);
  let ok = false;
  let detail = {};
  try {
    const store = new TaskStore(dir, { recover: true });
    const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'));
    const hasDb = existsSync(join(dir, 'tasks.sqlite'));
    ok =
      marker.format === GOOD.format &&
      marker.schema_version === GOOD.schema_version &&
      hasDb;
    detail = { marker, tasks_sqlite_created: hasDb };
    store.close();
  } catch (error) {
    detail = {
      unexpected_error: error?.code ?? String(error?.message ?? error),
    };
  }
  record(
    'CONTROL: empty directory accepted, marker written, SQLite opened',
    ok,
    detail,
  );
}

// --- POSITIVE CONTROL: reopening a correctly marked directory must succeed ---
{
  const dir = mkdtempSync(join(tmpdir(), 'haze-stateguard-reopen-'));
  roots.push(dir);
  let ok = false;
  let detail = {};
  try {
    const first = new TaskStore(dir, { recover: true });
    first.close();
    const second = new TaskStore(dir, { recover: true });
    ok = Boolean(second.db);
    second.close();
    detail = { reopened: ok };
  } catch (error) {
    detail = {
      unexpected_error: error?.code ?? String(error?.message ?? error),
    };
  }
  record('CONTROL: correctly marked directory reopens cleanly', ok, detail);
}

for (const dir of roots) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const total = findings.length;
const report = {
  use_case: 'UC-29 STATE_DIR marker guard',
  totals: { total, pass: total - failed, fail: failed },
  scenarios: findings,
};
// Write a clean machine-readable artifact; stdout stays human-readable.
writeFileSync(
  'qa/state-dir-guard.json',
  `${JSON.stringify(report, null, 2)}
`,
);
console.log(`
wrote qa/state-dir-guard.json`);
if (failed) {
  console.error(
    `\n${failed}/${total} STATE_DIR guard scenarios violated the contract.`,
  );
  process.exit(1);
}
console.log(`\nAll ${total} STATE_DIR guard scenarios held.`);
