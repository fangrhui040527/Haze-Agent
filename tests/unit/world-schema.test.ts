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
      'world_projection_entities',
      'world_projection_relationships',
      'world_projection_cursors',
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
    ).toEqual(
      Array.from({ length: WORLD_SCHEMA_VERSION }, (_, index) => ({
        version: index + 1,
      })),
    );
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
      'world_projection_entities',
      'world_projection_relationships',
      'world_projection_cursors',
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

  it('upgrades an existing version-one database without losing its events', () => {
    const db = memoryDatabase();
    migrateWorldSchema(db);
    db.prepare(
      `INSERT INTO world_events
       (event_id,principal,workspace,mode,sequence,event_kind,body,recorded_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      'event:legacy',
      'test-user',
      'test-workspace',
      'fixture',
      1,
      'record_created',
      '{"archival":"event"}',
      '2026-10-26T00:00:00Z',
    );
    db.exec(`DROP TABLE world_projection_entities;
      DROP TABLE world_projection_relationships;
      DROP TABLE world_projection_cursors;
      DELETE FROM world_schema_migrations WHERE version=2;`);

    migrateWorldSchema(db);

    expect(
      db
        .prepare('SELECT body FROM world_events WHERE event_id=?')
        .get('event:legacy'),
    ).toEqual({ body: '{"archival":"event"}' });
    expect(
      db
        .prepare('SELECT MAX(version) AS version FROM world_schema_migrations')
        .get(),
    ).toEqual({ version: WORLD_SCHEMA_VERSION });
    expect(
      db
        .prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?')
        .get('table', 'world_projection_entities'),
    ).toEqual({ name: 'world_projection_entities' });
  });

  it('rolls back a failed version-two upgrade while preserving version-one data', () => {
    const db = memoryDatabase();
    migrateWorldSchema(db);
    db.prepare(
      `INSERT INTO world_events
       (event_id,principal,workspace,mode,sequence,event_kind,body,recorded_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      'event:version-one',
      'test-user',
      'test-workspace',
      'fixture',
      1,
      'record_created',
      '{"retained":true}',
      '2026-10-26T00:00:00Z',
    );
    db.exec(`DROP TABLE world_projection_entities;
      DROP TABLE world_projection_relationships;
      DROP TABLE world_projection_cursors;
      DELETE FROM world_schema_migrations WHERE version=2;
      CREATE TABLE preserved_projection_name(id TEXT PRIMARY KEY);
      CREATE INDEX world_projection_relationships
        ON preserved_projection_name(id);`);

    expect(() => migrateWorldSchema(db)).toThrow();

    expect(
      db.prepare('SELECT version FROM world_schema_migrations').all(),
    ).toEqual([{ version: 1 }]);
    expect(
      db
        .prepare('SELECT body FROM world_events WHERE event_id=?')
        .get('event:version-one'),
    ).toEqual({ body: '{"retained":true}' });
    expect(
      db
        .prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?')
        .get('table', 'world_projection_entities'),
    ).toBeUndefined();
    expect(
      db
        .prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?')
        .get('index', 'world_projection_relationships'),
    ).toEqual({ name: 'world_projection_relationships' });
  });
});
