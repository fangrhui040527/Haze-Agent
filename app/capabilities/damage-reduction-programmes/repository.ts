import type { DatabaseSync } from 'node:sqlite';
import {
  reductionProgrammeAttemptSchema,
  reductionProgrammeMutationReceiptSchema,
  reductionProgrammeRecordSchema,
  reductionProgrammeRevisionSchema,
  reductionProgrammeSnapshotSchema,
  type ReductionProgrammeAttempt,
  type ReductionProgrammeMutationReceipt,
  type ReductionProgrammeRecord,
  type ReductionProgrammeRevision,
  type ReductionProgrammeSnapshot,
} from '../../contracts/damage-reduction-programme.js';
import { canonicalJson, parseContractJson } from '../../contracts/json.js';
import { TaskError } from '../../contracts/tasks.js';
import {
  controlReceiptSchema,
  type ControlReceipt,
} from '../../contracts/controls.js';
import type { ProgrammeScope } from './ports.js';

type BodyRow = { body: string };
export class ReductionProgrammeRepository {
  constructor(private readonly db: DatabaseSync) {
    db.exec('SAVEPOINT reduction_programme_migration');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reduction_programme_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reduction_programmes(id TEXT PRIMARY KEY,principal TEXT NOT NULL,workspace TEXT NOT NULL,mode TEXT NOT NULL,current_revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS reduction_programme_revisions(programme_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(programme_id,revision));
        CREATE TABLE IF NOT EXISTS reduction_programme_attempts(id TEXT PRIMARY KEY,programme_id TEXT NOT NULL,programme_revision INTEGER NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(task_id,run_id));
        CREATE TABLE IF NOT EXISTS reduction_programme_records(id TEXT PRIMARY KEY,programme_id TEXT NOT NULL,programme_revision INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reduction_programme_operations(principal TEXT NOT NULL,workspace TEXT NOT NULL,mode TEXT NOT NULL,operation_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(principal,workspace,mode,operation_key));
        CREATE INDEX IF NOT EXISTS reduction_programme_partition ON reduction_programmes(principal,workspace,mode);
        CREATE INDEX IF NOT EXISTS reduction_programme_attempt_task ON reduction_programme_attempts(task_id,programme_id);
        CREATE TRIGGER IF NOT EXISTS reduction_programme_partition_immutable BEFORE UPDATE ON reduction_programmes WHEN NEW.id != OLD.id OR NEW.principal != OLD.principal OR NEW.workspace != OLD.workspace OR NEW.mode != OLD.mode BEGIN SELECT RAISE(ABORT,'Programme partition identity is immutable'); END;
      `);
      for (const table of [
        'reduction_programme_revisions',
        'reduction_programme_attempts',
        'reduction_programme_records',
        'reduction_programme_operations',
      ]) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Programme history is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Programme history is immutable'); END;`);
      }
      const versions = db
        .prepare('SELECT version FROM reduction_programme_migrations')
        .all() as { version: number }[];
      if (versions.some((item) => item.version !== 1))
        throw new TaskError(
          409,
          'programme_schema_incompatible',
          'Programme migration version is unsupported.',
        );
      db.prepare(
        'INSERT OR IGNORE INTO reduction_programme_migrations(version,applied_at) VALUES(1,?)',
      ).run(new Date().toISOString());
      db.exec('RELEASE reduction_programme_migration');
    } catch (error) {
      db.exec('ROLLBACK TO reduction_programme_migration');
      db.exec('RELEASE reduction_programme_migration');
      throw error;
    }
  }
  private scopeArgs(scope: ProgrammeScope) {
    return [scope.principal, scope.workspace, scope.mode];
  }
  get(scope: ProgrammeScope, id: string): ReductionProgrammeSnapshot {
    const row = this.db
      .prepare(
        'SELECT r.body FROM reduction_programmes p JOIN reduction_programme_revisions r ON r.programme_id=p.id AND r.revision=p.current_revision WHERE p.id=? AND p.principal=? AND p.workspace=? AND p.mode=?',
      )
      .get(id, ...this.scopeArgs(scope)) as BodyRow | undefined;
    if (!row)
      throw new TaskError(
        404,
        'programme_not_found',
        'Programme is unavailable in this principal, workspace or execution mode.',
      );
    return reductionProgrammeRevisionSchema.parse(parseContractJson(row.body))
      .snapshot;
  }
  list(
    scope: ProgrammeScope,
    limit = 50,
    offset = 0,
  ): ReductionProgrammeSnapshot[] {
    const rows = this.db
      .prepare(
        'SELECT r.body FROM reduction_programmes p JOIN reduction_programme_revisions r ON r.programme_id=p.id AND r.revision=p.current_revision WHERE p.principal=? AND p.workspace=? AND p.mode=? ORDER BY p.rowid DESC LIMIT ? OFFSET ?',
      )
      .all(...this.scopeArgs(scope), limit, offset) as BodyRow[];
    return rows.map(
      (row) =>
        reductionProgrammeRevisionSchema.parse(parseContractJson(row.body))
          .snapshot,
    );
  }
  create(scope: ProgrammeScope, value: ReductionProgrammeRevision): void {
    const revision = reductionProgrammeRevisionSchema.parse(value);
    this.db
      .prepare(
        'INSERT INTO reduction_programmes(id,principal,workspace,mode,current_revision) VALUES(?,?,?,?,?)',
      )
      .run(revision.programme_id, ...this.scopeArgs(scope), revision.revision);
    this.insertRevision(revision);
  }
  append(
    scope: ProgrammeScope,
    expected: number,
    value: ReductionProgrammeRevision,
  ): void {
    const revision = reductionProgrammeRevisionSchema.parse(value);
    if (
      revision.revision !== expected + 1 ||
      revision.previous_revision !== expected
    )
      throw new TaskError(
        409,
        'programme_revision_conflict',
        'Programme revision must advance exactly once.',
      );
    const result = this.db
      .prepare(
        'UPDATE reduction_programmes SET current_revision=? WHERE id=? AND principal=? AND workspace=? AND mode=? AND current_revision=?',
      )
      .run(
        revision.revision,
        revision.programme_id,
        ...this.scopeArgs(scope),
        expected,
      );
    if (!result.changes)
      throw new TaskError(
        409,
        'programme_revision_conflict',
        'Programme changed; read its current revision before retrying.',
      );
    this.insertRevision(revision);
  }
  private insertRevision(value: ReductionProgrammeRevision) {
    reductionProgrammeSnapshotSchema.parse(value.snapshot);
    this.db
      .prepare(
        'INSERT INTO reduction_programme_revisions(programme_id,revision,body) VALUES(?,?,?)',
      )
      .run(value.programme_id, value.revision, canonicalJson(value));
  }
  revisions(
    scope: ProgrammeScope,
    id: string,
    limit = 50,
    offset = 0,
  ): ReductionProgrammeRevision[] {
    this.get(scope, id);
    return (
      this.db
        .prepare(
          'SELECT body FROM reduction_programme_revisions WHERE programme_id=? ORDER BY revision DESC LIMIT ? OFFSET ?',
        )
        .all(id, limit, offset) as BodyRow[]
    ).map((row) =>
      reductionProgrammeRevisionSchema.parse(parseContractJson(row.body)),
    );
  }
  attempts(scope: ProgrammeScope, id: string): ReductionProgrammeAttempt[] {
    this.get(scope, id);
    return (
      this.db
        .prepare(
          'SELECT body FROM reduction_programme_attempts WHERE programme_id=? ORDER BY rowid',
        )
        .all(id) as BodyRow[]
    ).map((row) =>
      reductionProgrammeAttemptSchema.parse(parseContractJson(row.body)),
    );
  }
  bind(scope: ProgrammeScope, value: ReductionProgrammeAttempt): void {
    this.get(scope, value.programme_id);
    const attempt = reductionProgrammeAttemptSchema.parse(value);
    this.db
      .prepare(
        'INSERT INTO reduction_programme_attempts(id,programme_id,programme_revision,task_id,run_id,body) VALUES(?,?,?,?,?,?)',
      )
      .run(
        attempt.id,
        attempt.programme_id,
        attempt.programme_revision,
        attempt.task_id,
        attempt.run_id,
        canonicalJson(attempt),
      );
  }
  bindings(scope: ProgrammeScope, taskId: string): ReductionProgrammeAttempt[] {
    return (
      this.db
        .prepare(
          'SELECT a.body FROM reduction_programme_attempts a JOIN reduction_programmes p ON p.id=a.programme_id WHERE a.task_id=? AND p.principal=? AND p.workspace=? AND p.mode=? ORDER BY a.rowid',
        )
        .all(taskId, ...this.scopeArgs(scope)) as BodyRow[]
    ).map((row) =>
      reductionProgrammeAttemptSchema.parse(parseContractJson(row.body)),
    );
  }
  records(scope: ProgrammeScope, id: string): ReductionProgrammeRecord[] {
    this.get(scope, id);
    return (
      this.db
        .prepare(
          'SELECT body FROM reduction_programme_records WHERE programme_id=? ORDER BY rowid',
        )
        .all(id) as BodyRow[]
    ).map((row) =>
      reductionProgrammeRecordSchema.parse(parseContractJson(row.body)),
    );
  }
  record(scope: ProgrammeScope, value: ReductionProgrammeRecord): void {
    this.get(scope, value.programme_id);
    const record = reductionProgrammeRecordSchema.parse(value);
    this.db
      .prepare(
        'INSERT INTO reduction_programme_records(id,programme_id,programme_revision,body) VALUES(?,?,?,?)',
      )
      .run(
        record.id,
        record.programme_id,
        record.programme_revision,
        canonicalJson(record),
      );
  }
  receipt(
    scope: ProgrammeScope,
    key: string,
    fingerprint: string,
  ): ReductionProgrammeMutationReceipt | undefined {
    const row = this.db
      .prepare(
        'SELECT body,request_sha256 FROM reduction_programme_operations WHERE principal=? AND workspace=? AND mode=? AND operation_key=?',
      )
      .get(...this.scopeArgs(scope), key) as
      (BodyRow & { request_sha256: string }) | undefined;
    if (!row) return undefined;
    if (row.request_sha256 !== fingerprint)
      throw new TaskError(
        409,
        'programme_idempotency_conflict',
        'Idempotency key was already used for different programme inputs.',
      );
    return reductionProgrammeMutationReceiptSchema.parse(
      parseContractJson(row.body),
    );
  }
  saveReceipt(
    scope: ProgrammeScope,
    key: string,
    fingerprint: string,
    value: ReductionProgrammeMutationReceipt,
  ): void {
    this.db
      .prepare(
        'INSERT INTO reduction_programme_operations(principal,workspace,mode,operation_key,request_sha256,body) VALUES(?,?,?,?,?,?)',
      )
      .run(
        ...this.scopeArgs(scope),
        key,
        fingerprint,
        canonicalJson(reductionProgrammeMutationReceiptSchema.parse(value)),
      );
  }
  taskMutationReceipt(
    scope: ProgrammeScope,
    key: string,
    fingerprint: string,
  ): ControlReceipt | undefined {
    const row = this.db
      .prepare(
        'SELECT body,request_sha256 FROM reduction_programme_operations WHERE principal=? AND workspace=? AND mode=? AND operation_key=?',
      )
      .get(...this.scopeArgs(scope), key) as
      (BodyRow & { request_sha256: string }) | undefined;
    if (!row) return undefined;
    if (row.request_sha256 !== fingerprint)
      throw new TaskError(
        409,
        'programme_idempotency_conflict',
        'Task mutation key was already used for different inputs.',
      );
    return controlReceiptSchema.parse(parseContractJson(row.body));
  }
  saveTaskMutationReceipt(
    scope: ProgrammeScope,
    key: string,
    fingerprint: string,
    receipt: ControlReceipt,
  ): void {
    this.db
      .prepare(
        'INSERT INTO reduction_programme_operations(principal,workspace,mode,operation_key,request_sha256,body) VALUES(?,?,?,?,?,?)',
      )
      .run(
        ...this.scopeArgs(scope),
        key,
        fingerprint,
        canonicalJson(controlReceiptSchema.parse(receipt)),
      );
  }
}
