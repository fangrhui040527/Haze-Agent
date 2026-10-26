import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import {
  migrateWorldSchema,
  WORLD_SCHEMA_VERSION,
} from '../../app/tasks/world-schema.js';

const databases: DatabaseSync[] = [];
const stores: TaskStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0).reverse())
    if (store.db.isOpen) store.close();
  for (const db of databases.splice(0).reverse()) if (db.isOpen) db.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    const rel = relative(resolve(tmpdir()), target);
    if (!rel || rel.startsWith('..') || resolve(tmpdir()) === target)
      throw new Error('Unsafe test cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
function memoryDatabase() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return db;
}

describe('World Model SQLite schema', () => {
  it('applies the initial schema transactionally and preserves existing task rows', () => {
    const db = memoryDatabase();
    db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      INSERT INTO tasks(id,body) VALUES('existing-task','existing-body');`);

    migrateWorldSchema(db);

    expect(
      db.prepare('SELECT body FROM tasks WHERE id=?').get('existing-task'),
    ).toEqual({ body: 'existing-body' });
    expect(
      db
        .prepare('SELECT MAX(version) AS version FROM world_schema_migrations')
        .get(),
    ).toEqual({ version: WORLD_SCHEMA_VERSION });
    for (const table of [
      'world_events',
      'world_entities',
      'world_relationships',
      'world_assessments',
      'world_acceptances',
      'world_dependencies',
      'world_holds',
      'world_operation_receipts',
    ]) {
      expect(
        db
          .prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?')
          .get('table', table),
      ).toEqual({ name: table });
    }

    migrateWorldSchema(db);
    expect(
      db.prepare('SELECT version FROM world_schema_migrations').all(),
    ).toEqual([{ version: WORLD_SCHEMA_VERSION }]);
  });

  it('rolls back every schema object when a migration statement fails', () => {
    const db = memoryDatabase();
    db.exec(`CREATE TABLE preserved(id TEXT PRIMARY KEY);
      INSERT INTO preserved(id) VALUES('keep');
      CREATE INDEX world_entities ON preserved(id);`);

    expect(() => migrateWorldSchema(db)).toThrow();

    expect(db.prepare('SELECT id FROM preserved').all()).toEqual([
      { id: 'keep' },
    ]);
    for (const name of [
      'world_schema_migrations',
      'world_events',
      'world_entities',
      'world_relationships',
      'world_assessments',
      'world_acceptances',
      'world_dependencies',
      'world_holds',
      'world_operation_receipts',
    ]) {
      expect(
        db
          .prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?')
          .get('table', name),
      ).toBeUndefined();
    }
    expect(
      db
        .prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?')
        .get('index', 'world_entities'),
    ).toEqual({ name: 'world_entities' });
  });

  it('installs the migration when an existing marked task store opens', () => {
    const directory = mkdtempSync(join(tmpdir(), 'haze-world-schema-'));
    directories.push(directory);
    const store = new TaskStore(directory, { recover: false });
    stores.push(store);

    expect(
      store.db
        .prepare('SELECT MAX(version) AS version FROM world_schema_migrations')
        .get(),
    ).toEqual({ version: WORLD_SCHEMA_VERSION });
    expect(
      store.db
        .prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?')
        .get('table', 'tasks'),
    ).toEqual({ name: 'tasks' });
  });
});
