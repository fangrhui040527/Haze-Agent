import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import {
  TaskStore,
  GENERAL_STORAGE_FORMAT,
  STORAGE_MARKER,
  MIGRATION_PENDING,
} from './store.js';

type Body = { body: string };
interface LegacyRun {
  id: string;
  status: string;
}
interface LegacyAssignment {
  status: string;
  lease_token?: string;
}
interface LegacyAttempt {
  status: string;
}
const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const hash = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const inside = (parent: string, child: string) => {
  const part = relative(parent, child);
  return !part || (!part.startsWith('..') && !isAbsolute(part));
};
const rows = <T>(db: DatabaseSync, table: string): T[] =>
  (db.prepare(`SELECT body FROM ${table}`).all() as Body[]).map(
    (row) => JSON.parse(row.body) as T,
  );

export interface MigrationReport {
  source_directory: string;
  target_directory: string;
  storage_format: typeof GENERAL_STORAGE_FORMAT;
  rollback_snapshot: string;
  source_sha256: string;
  source_unchanged: true;
  legacy_runs: number;
  artifacts: number;
  automatic_continuations: 0;
}

/** Explicit, closed-source migration. The source directory is never opened by SQLite. */
export async function migrateGeneralState(options: {
  sourceDirectory: string;
  targetDirectory: string;
}): Promise<MigrationReport> {
  if (!options.sourceDirectory?.trim() || !options.targetDirectory?.trim())
    throw new Error(
      'Migration requires explicit source and target directories.',
    );
  const source = realpathSync(resolve(options.sourceDirectory)),
    requestedTarget = resolve(options.targetDirectory),
    target = join(
      realpathSync(dirname(requestedTarget)),
      basename(requestedTarget),
    );
  if (
    basename(source).toLowerCase() === '.state' ||
    basename(target).toLowerCase() === '.state'
  )
    throw new Error(
      'Select a single state directory; recursive .state migration is prohibited.',
    );
  if (inside(source, target) || inside(target, source))
    throw new Error(
      'Migration target must be separate from and outside the source directory.',
    );
  if (existsSync(target)) throw new Error('Migration target must not exist.');
  if (existsSync(`${source}.owner.lock`))
    throw new Error('Close the runtime owner before migration.');
  const markerPath = join(source, STORAGE_MARKER);
  if (!existsSync(markerPath)) throw new Error('Source has no storage marker.');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
    format?: string;
    schema_version?: number;
  };
  if (marker.format !== 'haze.general.sqlite.v1' || marker.schema_version !== 1)
    throw new Error('Only haze.general.sqlite.v1 sources can be migrated.');
  // Closed SQLite databases have flushed WALs. Refuse to guess whether an owner is alive.
  for (const file of readdirSync(source)) {
    if (/owner|\.lock$/i.test(file))
      throw new Error('Close the runtime owner before migration.');
    if (
      (file.endsWith('-wal') && statSync(join(source, file)).size > 0) ||
      file.endsWith('-shm')
    )
      throw new Error(
        'Source is not quiescent: close SQLite and checkpoint its WAL before migration.',
      );
  }
  const database = join(source, 'tasks.sqlite');
  if (!existsSync(database)) throw new Error('Source tasks.sqlite is missing.');
  const sourceFiles = readdirSync(source).filter((file) =>
    statSync(join(source, file)).isFile(),
  );
  const sourceHashes = new Map(
    sourceFiles.map((file) => [file, hash(join(source, file))]),
  );
  mkdirSync(target, { recursive: false });
  writeFileSync(
    join(target, MIGRATION_PENDING),
    JSON.stringify({ source, started_at: new Date().toISOString() }),
    { flag: 'wx' },
  );
  const archive = join(target, 'legacy-archive');
  mkdirSync(archive);
  const snapshot = join(archive, 'tasks.sqlite');
  copyFileSync(database, snapshot);
  copyFileSync(markerPath, join(archive, STORAGE_MARKER));
  const sourceUnchanged = () => {
    if (
      readdirSync(source).filter((file) =>
        statSync(join(source, file)).isFile(),
      ).length !== sourceHashes.size
    )
      throw new Error(
        'Source changed during migration; target is incomplete and must not be used.',
      );
    for (const [file, expected] of sourceHashes)
      if (hash(join(source, file)) !== expected)
        throw new Error(
          'Source changed during migration; target is incomplete and must not be used.',
        );
  };
  sourceUnchanged();
  // SQLite validates the closed copy, then its online backup API creates the working database.
  const copy = new DatabaseSync(snapshot, { readOnly: true });
  let legacyRuns: number, artifacts: number;
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string;
    };
    if (integrity.integrity_check !== 'ok')
      throw new Error('Source SQLite integrity check failed.');
    const runs = rows<LegacyRun>(copy, 'runs');
    if (
      runs.some((run) => !terminal.has(run.status) && run.status !== 'paused')
    )
      throw new Error(
        'Source is not quiescent: pause or finish every unfinished run.',
      );
    if (
      rows<LegacyAssignment>(copy, 'assignments').some(
        (assignment) =>
          assignment.status === 'running' || assignment.lease_token,
      )
    )
      throw new Error(
        'Source is not quiescent: executable assignment leases remain.',
      );
    if (
      rows<LegacyAttempt>(copy, 'attempts').some(
        (attempt) => attempt.status === 'started',
      )
    )
      throw new Error(
        'Source is not quiescent: unresolved dispatched attempts must be charged unknowns.',
      );
    legacyRuns = runs.length;
    artifacts = Number(
      (
        copy.prepare('SELECT count(*) AS count FROM artifacts').get() as {
          count: number;
        }
      ).count,
    );
    await backup(copy, join(target, 'tasks.sqlite'));
  } finally {
    copy.close();
  }
  for (const file of sourceFiles)
    if (
      file !== 'tasks.sqlite' &&
      file !== STORAGE_MARKER &&
      !file.endsWith('-wal') &&
      !file.endsWith('-shm')
    )
      copyFileSync(join(source, file), join(archive, file));
  // The source marker is only replaced on the new copy after all quiescence checks pass.
  writeFileSync(
    join(target, STORAGE_MARKER),
    JSON.stringify({ format: GENERAL_STORAGE_FORMAT, schema_version: 2 }),
    { flag: 'wx' },
  );
  const store = new TaskStore(target, { recover: false, migration: true });
  try {
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db.exec(
        'INSERT INTO legacy_checkpoint_archive SELECT * FROM checkpoints; DELETE FROM checkpoints;',
      );
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
    // Recovery only fences imported rows and sets the existing public upgrade_required field.
    store.recover();
    const integrity = store.db.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string;
    };
    if (integrity.integrity_check !== 'ok')
      throw new Error('Migrated database integrity check failed.');
    if (store.db.prepare('SELECT id FROM graph_jobs LIMIT 1').get())
      throw new Error('Migration must not schedule execution.');
  } finally {
    store.close();
  }
  sourceUnchanged();
  const report: MigrationReport = {
    source_directory: source,
    target_directory: target,
    storage_format: GENERAL_STORAGE_FORMAT,
    rollback_snapshot: archive,
    source_sha256: sourceHashes.get('tasks.sqlite')!,
    source_unchanged: true,
    legacy_runs: legacyRuns,
    artifacts,
    automatic_continuations: 0,
  };
  writeFileSync(
    join(target, 'migration-report.json'),
    JSON.stringify(report, null, 2),
    { flag: 'wx' },
  );
  unlinkSync(join(target, MIGRATION_PENDING));
  return report;
}
