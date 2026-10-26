import type { DatabaseSync } from 'node:sqlite';

export const WORLD_SCHEMA_VERSION = 1;

const migrationStatements = [
  `CREATE TABLE world_events(
    event_id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','fixture','replay')),
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    event_kind TEXT NOT NULL,
    body TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE(principal,workspace,mode,sequence)
  )`,
  `CREATE INDEX world_events_scope_cursor
    ON world_events(principal,workspace,mode,sequence)`,
  `CREATE TABLE world_entities(
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','fixture','replay')),
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    record_hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY(principal,workspace,mode,record_id,revision)
  )`,
  `CREATE INDEX world_entities_kind
    ON world_entities(principal,workspace,mode,kind,record_id,revision)`,
  `CREATE TABLE world_relationships(
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','fixture','replay')),
    relationship_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    from_record_id TEXT NOT NULL,
    to_record_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY(principal,workspace,mode,relationship_id,revision)
  )`,
  `CREATE INDEX world_relationships_from
    ON world_relationships(principal,workspace,mode,from_record_id,kind)`,
  `CREATE INDEX world_relationships_to
    ON world_relationships(principal,workspace,mode,to_record_id,kind)`,
  `CREATE TABLE world_assessments(
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','fixture','replay')),
    assessment_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    subject_record_id TEXT NOT NULL,
    body TEXT NOT NULL,
    assessed_at TEXT NOT NULL,
    PRIMARY KEY(principal,workspace,mode,assessment_id,revision)
  )`,
  `CREATE INDEX world_assessments_subject
    ON world_assessments(principal,workspace,mode,subject_record_id,assessment_id,revision)`,
  `CREATE TABLE world_acceptances(
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','fixture','replay')),
    acceptance_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    subject_record_id TEXT NOT NULL,
    stated_use TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('accepted','pending_review','held','superseded','not_eligible')),
    policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    body TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    PRIMARY KEY(principal,workspace,mode,acceptance_id,revision)
  )`,
  `CREATE INDEX world_acceptances_subject
    ON world_acceptances(principal,workspace,mode,subject_record_id,stated_use,revision)`,
  `CREATE TABLE world_dependencies(
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','fixture','replay')),
    record_id TEXT NOT NULL,
    support_record_id TEXT NOT NULL,
    support_revision INTEGER NOT NULL CHECK(support_revision > 0),
    body TEXT NOT NULL,
    PRIMARY KEY(principal,workspace,mode,record_id,support_record_id,support_revision)
  )`,
  `CREATE INDEX world_dependencies_support
    ON world_dependencies(principal,workspace,mode,support_record_id,support_revision)`,
  `CREATE TABLE world_holds(
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','fixture','replay')),
    hold_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    subject_record_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','cleared')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(principal,workspace,mode,hold_id,revision)
  )`,
  `CREATE INDEX world_holds_subject_status
    ON world_holds(principal,workspace,mode,subject_record_id,status)`,
  `CREATE TABLE world_operation_receipts(
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','fixture','replay')),
    operation_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    receipt TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY(principal,workspace,mode,operation_key)
  )`,
];

/** Apply additive World Model schema changes as one SQLite transaction. */
export function migrateWorldSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS world_schema_migrations(
      version INTEGER PRIMARY KEY CHECK(version > 0),
      applied_at TEXT NOT NULL
    )`);
    const row = db
      .prepare(
        'SELECT COALESCE(MAX(version),0) AS version FROM world_schema_migrations',
      )
      .get() as { version: number };
    if (row.version > WORLD_SCHEMA_VERSION)
      throw new Error(
        `World Model schema ${row.version} is newer than supported schema ${WORLD_SCHEMA_VERSION}.`,
      );
    if (row.version === 0) {
      for (const statement of migrationStatements) db.exec(statement);
      db.prepare(
        'INSERT INTO world_schema_migrations(version,applied_at) VALUES(?,?)',
      ).run(WORLD_SCHEMA_VERSION, new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
