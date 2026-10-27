import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts/json.js';
import { TaskError, type TaskIdentity } from '../contracts/tasks.js';
import type { TaskStore } from './store.js';

export interface ConversationTurnIdentity {
  conversation_id: string;
  turn_id: string;
}
interface TurnRow {
  fingerprint: string;
  resolution: string | null;
  response: string | null;
}

/** Conversation receipts share the task owner's connection and commit boundary. */
export class ConversationTurnStore {
  constructor(private readonly store: TaskStore) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS manager_chat_turns(
        principal TEXT NOT NULL, workspace TEXT NOT NULL,
        conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, request TEXT NOT NULL,
        resolution TEXT, response TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(principal,workspace,conversation_id,turn_id)
      );
      CREATE TABLE IF NOT EXISTS manager_chat_delivery_keys(
        principal TEXT NOT NULL, workspace TEXT NOT NULL, key TEXT NOT NULL,
        conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        PRIMARY KEY(principal,workspace,key)
      );
      CREATE TABLE IF NOT EXISTS manager_chat_diagnostics(
        id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL,
        detail TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS manager_chat_permissions(
        principal TEXT NOT NULL, workspace TEXT NOT NULL, grant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        PRIMARY KEY(principal,workspace,grant_id)
      );
    `);
  }

  private params(turn: ConversationTurnIdentity, identity: TaskIdentity) {
    return [
      identity.principal,
      identity.workspace,
      turn.conversation_id,
      turn.turn_id,
    ];
  }
  read(
    turn: ConversationTurnIdentity,
    identity: TaskIdentity,
  ): TurnRow | undefined {
    return this.store.db
      .prepare(
        `SELECT fingerprint,resolution,response
      FROM manager_chat_turns WHERE principal=? AND workspace=? AND conversation_id=? AND turn_id=?`,
      )
      .get(...this.params(turn, identity)) as unknown as TurnRow | undefined;
  }

  /** Bind every delivery key, including retries with a new transport key. */
  begin(
    turn: ConversationTurnIdentity,
    request: unknown,
    key: string,
    identity: TaskIdentity,
  ) {
    const fingerprint = createHash('sha256')
      .update(canonicalJson(request))
      .digest('hex');
    return this.store.transaction(() => {
      const delivery = this.store.db
        .prepare(
          `SELECT conversation_id,turn_id
        FROM manager_chat_delivery_keys WHERE principal=? AND workspace=? AND key=?`,
        )
        .get(identity.principal, identity.workspace, key) as
        ConversationTurnIdentity | undefined;
      if (
        delivery &&
        (delivery.conversation_id !== turn.conversation_id ||
          delivery.turn_id !== turn.turn_id)
      )
        throw new TaskError(
          409,
          'chat_idempotency_conflict',
          'This delivery key already belongs to another conversation turn.',
        );
      const previous = this.read(turn, identity);
      if (previous && previous.fingerprint !== fingerprint)
        throw new TaskError(
          409,
          'chat_turn_conflict',
          'This conversation turn was already delivered with different content. Retry the original turn or send a new message.',
        );
      if (!previous)
        this.store.db
          .prepare(
            `INSERT INTO manager_chat_turns
        (principal,workspace,conversation_id,turn_id,fingerprint,request,created_at) VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            ...this.params(turn, identity),
            fingerprint,
            JSON.stringify(request),
            new Date().toISOString(),
          );
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO manager_chat_delivery_keys
        (principal,workspace,key,conversation_id,turn_id) VALUES(?,?,?,?,?)`,
        )
        .run(
          identity.principal,
          identity.workspace,
          key,
          turn.conversation_id,
          turn.turn_id,
        );
      return this.read(turn, identity)!;
    });
  }

  resolve(
    turn: ConversationTurnIdentity,
    identity: TaskIdentity,
    resolution: unknown,
  ) {
    this.store.db
      .prepare(
        `UPDATE manager_chat_turns SET resolution=?
      WHERE principal=? AND workspace=? AND conversation_id=? AND turn_id=? AND resolution IS NULL`,
      )
      .run(JSON.stringify(resolution), ...this.params(turn, identity));
  }

  /** Admission/update and its conversational receipt either both commit or both roll back. */
  finish<T>(
    turn: ConversationTurnIdentity,
    identity: TaskIdentity,
    produce: () => T,
  ): T {
    return this.store.transaction(() => {
      const current = this.read(turn, identity);
      if (!current)
        throw new Error('Conversation turn must be bound before completion.');
      if (current.response !== null) return JSON.parse(current.response) as T;
      const response = produce();
      this.store.db
        .prepare(
          `UPDATE manager_chat_turns SET response=?
        WHERE principal=? AND workspace=? AND conversation_id=? AND turn_id=?`,
        )
        .run(JSON.stringify(response), ...this.params(turn, identity));
      return response;
    });
  }

  diagnostic(category: string, error: unknown) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error);
    this.store.db
      .prepare(
        'INSERT INTO manager_chat_diagnostics(category,detail,created_at) VALUES(?,?,?)',
      )
      .run(category, detail.slice(0, 16384), new Date().toISOString());
  }

  /** Called inside finish: a lost admission response cannot reuse a workspace grant. */
  claimPermission(
    grantId: string,
    turn: ConversationTurnIdentity,
    identity: TaskIdentity,
  ): boolean {
    const inserted = this.store.db
      .prepare(
        `INSERT OR IGNORE INTO manager_chat_permissions
      (principal,workspace,grant_id,conversation_id,turn_id) VALUES(?,?,?,?,?)`,
      )
      .run(
        identity.principal,
        identity.workspace,
        grantId,
        turn.conversation_id,
        turn.turn_id,
      );
    return Number(inserted.changes) === 1;
  }
}
