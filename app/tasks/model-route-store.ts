import type { DatabaseSync } from 'node:sqlite';
import {
  modelRouteSnapshotSchema,
  type EffectiveModelRoute,
  type ModelRouteSnapshot,
} from '../contracts/model-routes.js';
import { canonicalJson } from '../contracts/json.js';
import { TaskError, type Assignment } from '../contracts/tasks.js';

export const MODEL_ROUTE_SCHEMA_VERSION = 1;

/** Route authority lives in the task database, never in graph checkpoints. */
export class ModelRouteStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS model_route_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)',
      );
      const versions = db
        .prepare('SELECT version FROM model_route_migrations ORDER BY version')
        .all() as { version: number }[];
      if (versions.some((row) => row.version !== MODEL_ROUTE_SCHEMA_VERSION))
        throw new TaskError(
          409,
          'model_route_schema_incompatible',
          'The model route database uses an unsupported migration version.',
        );
      db.exec(`
      CREATE TABLE IF NOT EXISTS run_model_routes(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,snapshot_version INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assignment_model_routes(assignment_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,role TEXT NOT NULL,route_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_model_routes(operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,route_id TEXT NOT NULL,capability_contract TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS run_model_routes_immutable_update BEFORE UPDATE ON run_model_routes BEGIN SELECT RAISE(ABORT,'Admitted model routes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS run_model_routes_immutable_delete BEFORE DELETE ON run_model_routes BEGIN SELECT RAISE(ABORT,'Admitted model routes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS assignment_model_routes_immutable_update BEFORE UPDATE ON assignment_model_routes BEGIN SELECT RAISE(ABORT,'Assignment model route is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS assignment_model_routes_immutable_delete BEFORE DELETE ON assignment_model_routes BEGIN SELECT RAISE(ABORT,'Assignment model route is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS operation_model_routes_immutable_update BEFORE UPDATE ON operation_model_routes BEGIN SELECT RAISE(ABORT,'Operation model route is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS operation_model_routes_immutable_delete BEFORE DELETE ON operation_model_routes BEGIN SELECT RAISE(ABORT,'Operation model route is immutable'); END;
      `);
      const tables: Record<string, Record<string, string>> = {
        model_route_migrations: { version: 'INTEGER', applied_at: 'TEXT' },
        run_model_routes: {
          run_id: 'TEXT',
          task_id: 'TEXT',
          snapshot_version: 'INTEGER',
          body: 'TEXT',
        },
        assignment_model_routes: {
          assignment_id: 'TEXT',
          run_id: 'TEXT',
          role: 'TEXT',
          route_id: 'TEXT',
        },
        operation_model_routes: {
          operation_id: 'TEXT',
          run_id: 'TEXT',
          route_id: 'TEXT',
          capability_contract: 'TEXT',
        },
      };
      for (const [table, expected] of Object.entries(tables)) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
          type: string;
          pk: number;
          notnull: number;
        }[];
        if (
          columns.length !== Object.keys(expected).length ||
          columns.some(
            (column, index) =>
              column.name !== Object.keys(expected)[index] ||
              expected[column.name] !== column.type.toUpperCase() ||
              column.pk !== (index === 0 ? 1 : 0) ||
              (index > 0 && column.notnull !== 1),
          )
        )
          throw new TaskError(
            409,
            'model_route_schema_incompatible',
            'The model route database schema is incompatible. Preserve this state for inspection.',
          );
      }
      db.prepare(
        'INSERT OR IGNORE INTO model_route_migrations VALUES(?,?)',
      ).run(MODEL_ROUTE_SCHEMA_VERSION, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  snapshot(runId: string): ModelRouteSnapshot | null {
    const row = this.db
      .prepare('SELECT body FROM run_model_routes WHERE run_id=?')
      .get(runId) as { body: string } | undefined;
    // Historical runs remain unknown. Today's configuration cannot fill them in.
    return row ? modelRouteSnapshotSchema.parse(JSON.parse(row.body)) : null;
  }
  admit(taskId: string, runId: string, value: ModelRouteSnapshot): void {
    const snapshot = modelRouteSnapshotSchema.parse(value);
    this.db
      .prepare('INSERT INTO run_model_routes VALUES(?,?,?,?)')
      .run(runId, taskId, snapshot.version, JSON.stringify(snapshot));
  }
  bindAssignment(assignment: Assignment): void {
    const snapshot = this.snapshot(assignment.run_id);
    if (!snapshot) return;
    const route = snapshot.routes[assignment.role];
    this.db
      .prepare('INSERT INTO assignment_model_routes VALUES(?,?,?,?)')
      .run(assignment.id, assignment.run_id, assignment.role, route.route_id);
  }
  assignmentRoute(assignment: Assignment): EffectiveModelRoute {
    const snapshot = this.snapshot(assignment.run_id);
    if (!snapshot)
      throw new TaskError(
        409,
        'model_route_upgrade_required',
        'This run predates immutable model routes. Explicitly Continue to admit a linked run with a new route snapshot.',
      );
    const row = this.db
      .prepare(
        'SELECT run_id,role,route_id FROM assignment_model_routes WHERE assignment_id=?',
      )
      .get(assignment.id) as
      { run_id: string; role: string; route_id: string } | undefined;
    const route = snapshot.routes[assignment.role];
    if (
      !row ||
      row.run_id !== assignment.run_id ||
      row.role !== assignment.role ||
      row.route_id !== route.route_id
    )
      throw new TaskError(
        409,
        'model_route_authority_invalid',
        'Assignment does not reference its admitted model route. Explicit continuation is required.',
      );
    return route;
  }
  bindOperation(
    operationId: string,
    runId: string,
    route: EffectiveModelRoute,
  ): void {
    const contract = canonicalJson(route.capability_contract);
    const prior = this.operationRoute(operationId);
    if (prior) {
      if (
        prior.run_id !== runId ||
        prior.route_id !== route.route_id ||
        prior.capability_contract !== contract
      )
        throw new TaskError(
          409,
          'model_route_operation_conflict',
          'Operation route differs from its admitted authority.',
        );
      return;
    }
    this.db
      .prepare('INSERT INTO operation_model_routes VALUES(?,?,?,?)')
      .run(operationId, runId, route.route_id, contract);
  }
  operationRoute(operationId: string) {
    return (
      (this.db
        .prepare(
          'SELECT run_id,route_id,capability_contract FROM operation_model_routes WHERE operation_id=?',
        )
        .get(operationId) as
        | { run_id: string; route_id: string; capability_contract: string }
        | undefined) ?? null
    );
  }
}
