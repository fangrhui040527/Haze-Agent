import type { DatabaseSync } from 'node:sqlite';
import { contractHash } from '../contracts/json.js';
import {
  worldEventSchema,
  worldOperationReceiptSchema,
  worldRecordSchema,
  worldRelationshipSchema,
  type WorldEvent,
  type WorldOperationReceipt,
  type WorldRecord,
  type WorldRelationship,
} from '../contracts/world.js';

type WorldScope = WorldRecord['scope'];
type WorldActor = WorldRecord['producer'];
type Transaction = <T>(operation: () => T) => T;
type Row = { body: string };

export interface PutWorldRecordInput {
  scope: WorldScope;
  operation_key: string;
  kind: string;
  external_id: string;
  payload: WorldRecord['payload'];
  producer: WorldActor;
  observed_at?: string;
  retrieved_at?: string;
  recorded_at?: string;
}

export interface RelateWorldRecordsInput {
  scope: WorldScope;
  operation_key: string;
  kind: string;
  from: WorldRecord['ref'];
  to: WorldRecord['ref'];
  attributes?: WorldRelationship['attributes'];
  recorded_at?: string;
}

export interface WorldWriteResult<T> {
  value: T;
  receipt: WorldOperationReceipt;
  changed: boolean;
}

interface StoredOperation {
  fingerprint: string;
  receipt: string;
}

interface StoredEvent {
  event_id: string;
  principal: string;
  workspace: string;
  mode: WorldScope['mode'];
  sequence: number;
  event_kind: string;
  body: string;
  recorded_at: string;
}

export class WorldModelStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: Transaction,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    this.replayPendingProjections();
  }

  putRecord(input: PutWorldRecordInput): WorldWriteResult<WorldRecord> {
    const recordedAt = input.recorded_at ?? this.clock();
    const content = {
      kind: input.kind,
      external_id: input.external_id,
      payload: input.payload,
      producer: input.producer,
      ...(input.observed_at === undefined
        ? {}
        : { observed_at: input.observed_at }),
      ...(input.retrieved_at === undefined
        ? {}
        : { retrieved_at: input.retrieved_at }),
    };
    const fingerprint = contractHash(content);
    const recordId = `wm:${contractHash({
      scope: input.scope,
      kind: input.kind,
      external_id: input.external_id,
    })}`;
    const operationFingerprint = contractHash({
      action: 'put_record',
      record_id: recordId,
      content,
    });

    return this.transaction(() => {
      const replay = this.replay<WorldRecord>(
        input.scope,
        input.operation_key,
        operationFingerprint,
        (receipt) => {
          const ref = receipt.records[0];
          return ref
            ? this.record(input.scope, ref.id, ref.revision)
            : undefined;
        },
      );
      if (replay) return replay;

      const prior = this.db
        .prepare(
          `SELECT body FROM world_entities
           WHERE principal=? AND workspace=? AND mode=? AND record_id=?
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(
          input.scope.principal,
          input.scope.workspace,
          input.scope.mode,
          recordId,
        ) as Row | undefined;
      if (prior) {
        const current = worldRecordSchema.parse(JSON.parse(prior.body));
        if (current.ref.sha256 === fingerprint) {
          const receipt = this.receipt(
            input.scope,
            input.operation_key,
            operationFingerprint,
            'no_change',
            [current.ref],
            recordedAt,
          );
          this.saveOperation(receipt);
          return { value: current, receipt, changed: false };
        }
      }

      const revision = this.nextRevision(
        'world_entities',
        'record_id',
        input.scope,
        recordId,
      );
      const record = worldRecordSchema.parse({
        schema_version: 'haze.world.record.v1',
        ref: { id: recordId, revision, sha256: fingerprint },
        scope: input.scope,
        ...content,
        recorded_at: recordedAt,
      });
      this.db
        .prepare(
          `INSERT INTO world_entities
           (principal,workspace,mode,record_id,revision,record_hash,kind,body,recorded_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.scope.principal,
          input.scope.workspace,
          input.scope.mode,
          recordId,
          revision,
          fingerprint,
          input.kind,
          JSON.stringify(record),
          record.recorded_at,
        );
      this.appendEvent(
        input.scope,
        revision === 1 ? 'record_created' : 'record_revised',
        record,
        input.producer,
        recordedAt,
      );
      const receipt = this.receipt(
        input.scope,
        input.operation_key,
        operationFingerprint,
        revision === 1 ? 'created' : 'updated',
        [record.ref],
        recordedAt,
      );
      this.saveOperation(receipt);
      return { value: record, receipt, changed: true };
    });
  }

  relate(input: RelateWorldRecordsInput): WorldWriteResult<WorldRelationship> {
    const recordedAt = input.recorded_at ?? this.clock();
    const content = {
      kind: input.kind,
      from: input.from,
      to: input.to,
      ...(input.attributes === undefined
        ? {}
        : { attributes: input.attributes }),
    };
    const relationshipId = `wmr:${contractHash({
      scope: input.scope,
      ...content,
    })}`;
    const operationFingerprint = contractHash({
      action: 'relate_records',
      relationship_id: relationshipId,
      content,
    });

    return this.transaction(() => {
      const replay = this.replay<WorldRelationship>(
        input.scope,
        input.operation_key,
        operationFingerprint,
        () => this.relationship(input.scope, relationshipId),
      );
      if (replay) return replay;

      this.requireRecord(input.scope, input.from);
      this.requireRecord(input.scope, input.to);
      const prior = this.db
        .prepare(
          `SELECT body FROM world_relationships
           WHERE principal=? AND workspace=? AND mode=? AND relationship_id=?`,
        )
        .get(
          input.scope.principal,
          input.scope.workspace,
          input.scope.mode,
          relationshipId,
        ) as Row | undefined;
      if (prior) {
        const current = worldRelationshipSchema.parse(JSON.parse(prior.body));
        const receipt = this.receipt(
          input.scope,
          input.operation_key,
          operationFingerprint,
          'no_change',
          [current.from, current.to],
          recordedAt,
        );
        this.saveOperation(receipt);
        return { value: current, receipt, changed: false };
      }

      const relationship = worldRelationshipSchema.parse({
        schema_version: 'haze.world.relationship.v1',
        id: relationshipId,
        scope: input.scope,
        ...content,
        recorded_at: recordedAt,
      });
      this.db
        .prepare(
          `INSERT INTO world_relationships
           (principal,workspace,mode,relationship_id,revision,from_record_id,to_record_id,kind,body,recorded_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.scope.principal,
          input.scope.workspace,
          input.scope.mode,
          relationshipId,
          1,
          input.from.id,
          input.to.id,
          input.kind,
          JSON.stringify(relationship),
          recordedAt,
        );
      this.appendEvent(
        input.scope,
        'relationship_created',
        relationship,
        { kind: 'service', id: 'world-model' },
        recordedAt,
      );
      const receipt = this.receipt(
        input.scope,
        input.operation_key,
        operationFingerprint,
        'created',
        [relationship.from, relationship.to],
        recordedAt,
      );
      this.saveOperation(receipt);
      return { value: relationship, receipt, changed: true };
    });
  }

  record(
    scope: WorldScope,
    recordId: string,
    revision?: number,
  ): WorldRecord | undefined {
    const row =
      revision === undefined
        ? (this.db
            .prepare(
              `SELECT body FROM world_projection_entities
             WHERE principal=? AND workspace=? AND mode=? AND record_id=?`,
            )
            .get(scope.principal, scope.workspace, scope.mode, recordId) as
            Row | undefined)
        : (this.db
            .prepare(
              `SELECT body FROM world_entities
             WHERE principal=? AND workspace=? AND mode=? AND record_id=? AND revision=?`,
            )
            .get(
              scope.principal,
              scope.workspace,
              scope.mode,
              recordId,
              revision,
            ) as Row | undefined);
    return row ? worldRecordSchema.parse(JSON.parse(row.body)) : undefined;
  }

  events(scope: WorldScope, afterSequence = 0): WorldEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new Error(
        'World Model event cursor must be a nonnegative integer.',
      );
    const rows = this.db
      .prepare(
        `SELECT event_id,sequence,event_kind,body FROM world_events
         WHERE principal=? AND workspace=? AND mode=? AND sequence>?
         ORDER BY sequence`,
      )
      .all(
        scope.principal,
        scope.workspace,
        scope.mode,
        afterSequence,
      ) as (Row & {
      event_id: string;
      sequence: number;
      event_kind: string;
    })[];
    return rows.map((row) => this.parseEventRow(row, scope));
  }

  projectionCursor(scope: WorldScope): number {
    const row = this.db
      .prepare(
        `SELECT sequence FROM world_projection_cursors
         WHERE principal=? AND workspace=? AND mode=?`,
      )
      .get(scope.principal, scope.workspace, scope.mode) as
      { sequence: number } | undefined;
    return row?.sequence ?? 0;
  }

  rebuildProjections(scope: WorldScope): number {
    return this.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM world_projection_entities
           WHERE principal=? AND workspace=? AND mode=?`,
        )
        .run(scope.principal, scope.workspace, scope.mode);
      this.db
        .prepare(
          `DELETE FROM world_projection_relationships
           WHERE principal=? AND workspace=? AND mode=?`,
        )
        .run(scope.principal, scope.workspace, scope.mode);
      this.db
        .prepare(
          `DELETE FROM world_projection_cursors
           WHERE principal=? AND workspace=? AND mode=?`,
        )
        .run(scope.principal, scope.workspace, scope.mode);

      let cursor = 0;
      for (const event of this.events(scope)) {
        if (event.sequence !== cursor + 1)
          throw new Error('World Model event sequence contains a gap.');
        this.applyProjection(event);
        cursor = event.sequence;
      }
      return cursor;
    });
  }

  private replayPendingProjections(): void {
    const scopes = this.db
      .prepare(
        `SELECT DISTINCT principal,workspace,mode FROM world_events
         ORDER BY principal,workspace,mode`,
      )
      .all() as Pick<WorldScope, 'principal' | 'workspace' | 'mode'>[];
    for (const scope of scopes) {
      this.transaction(() => {
        const cursor = this.projectionCursor(scope);
        for (const event of this.events(scope, cursor)) {
          if (event.sequence !== this.projectionCursor(scope) + 1)
            throw new Error('World Model event sequence contains a gap.');
          this.applyProjection(event);
        }
      });
    }
  }

  relationships(scope: WorldScope, recordId: string): WorldRelationship[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM world_projection_relationships
         WHERE principal=? AND workspace=? AND mode=?
         AND relationship_id IN (
           SELECT relationship_id FROM world_relationships
           WHERE principal=? AND workspace=? AND mode=?
           AND (from_record_id=? OR to_record_id=?)
         )
         ORDER BY last_sequence,relationship_id`,
      )
      .all(
        scope.principal,
        scope.workspace,
        scope.mode,
        scope.principal,
        scope.workspace,
        scope.mode,
        recordId,
        recordId,
      ) as Row[];
    return rows.map((row) =>
      worldRelationshipSchema.parse(JSON.parse(row.body)),
    );
  }

  private relationship(
    scope: WorldScope,
    relationshipId: string,
  ): WorldRelationship | undefined {
    const row = this.db
      .prepare(
        `SELECT body FROM world_relationships
         WHERE principal=? AND workspace=? AND mode=? AND relationship_id=?`,
      )
      .get(scope.principal, scope.workspace, scope.mode, relationshipId) as
      Row | undefined;
    return row
      ? worldRelationshipSchema.parse(JSON.parse(row.body))
      : undefined;
  }

  private requireRecord(scope: WorldScope, ref: WorldRecord['ref']): void {
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM world_entities
         WHERE principal=? AND workspace=? AND mode=?
         AND record_id=? AND revision=? AND record_hash=?`,
      )
      .get(
        scope.principal,
        scope.workspace,
        scope.mode,
        ref.id,
        ref.revision,
        ref.sha256,
      ) as { found: number } | undefined;
    if (!row)
      throw new Error(
        'World Model relationship endpoint is not available in this scope.',
      );
  }

  private nextRevision(
    table: 'world_entities' | 'world_relationships',
    identityColumn: 'record_id' | 'relationship_id',
    scope: WorldScope,
    id: string,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(revision),0) AS revision FROM ${table}
         WHERE principal=? AND workspace=? AND mode=? AND ${identityColumn}=?`,
      )
      .get(scope.principal, scope.workspace, scope.mode, id) as {
      revision: number;
    };
    return row.revision + 1;
  }

  private appendEvent(
    scope: WorldScope,
    eventKind: string,
    value: WorldRecord | WorldRelationship,
    actor: WorldActor,
    recordedAt: string,
  ): void {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence),0) AS sequence FROM world_events
         WHERE principal=? AND workspace=? AND mode=?`,
      )
      .get(scope.principal, scope.workspace, scope.mode) as {
      sequence: number;
    };
    const sequence = row.sequence + 1;
    const event = worldEventSchema.parse({
      schema_version: 'haze.world.event.v1',
      event_id: `wme:${contractHash({ scope, sequence, event_kind: eventKind, value })}`,
      scope,
      sequence,
      event_kind: eventKind,
      value,
      actor,
      recorded_at: recordedAt,
    });
    const stored: StoredEvent = {
      event_id: event.event_id,
      principal: scope.principal,
      workspace: scope.workspace,
      mode: scope.mode,
      sequence,
      event_kind: eventKind,
      body: JSON.stringify(event),
      recorded_at: recordedAt,
    };
    this.db
      .prepare(
        `INSERT INTO world_events
         (event_id,principal,workspace,mode,sequence,event_kind,body,recorded_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        stored.event_id,
        stored.principal,
        stored.workspace,
        stored.mode,
        stored.sequence,
        stored.event_kind,
        stored.body,
        stored.recorded_at,
      );
    this.applyProjection(event);
  }

  private parseEventRow(
    row: {
      event_id: string;
      sequence: number;
      event_kind: string;
      body: string;
    },
    scope: WorldScope,
  ): WorldEvent {
    const event = worldEventSchema.parse(JSON.parse(row.body));
    const expectedId = `wme:${contractHash({
      scope,
      sequence: event.sequence,
      event_kind: event.event_kind,
      value: event.value,
    })}`;
    if (
      event.scope.principal !== scope.principal ||
      event.scope.workspace !== scope.workspace ||
      event.scope.mode !== scope.mode ||
      event.sequence !== row.sequence ||
      event.event_kind !== row.event_kind ||
      event.event_id !== row.event_id ||
      event.event_id !== expectedId ||
      (event.event_kind === 'relationship_created') !== 'id' in event.value
    )
      throw new Error('World Model event integrity check failed.');
    return event;
  }

  private applyProjection(event: WorldEvent): void {
    const { principal, workspace, mode } = event.scope;
    const cursor = this.projectionCursor(event.scope);
    if (event.sequence !== cursor + 1)
      throw new Error('World Model projection cursor is out of sequence.');

    if ('ref' in event.value) {
      const record = event.value;
      this.db
        .prepare(
          `INSERT INTO world_projection_entities
           (principal,workspace,mode,record_id,revision,record_hash,kind,body,last_sequence)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(principal,workspace,mode,record_id) DO UPDATE SET
             revision=excluded.revision,
             record_hash=excluded.record_hash,
             kind=excluded.kind,
             body=excluded.body,
             last_sequence=excluded.last_sequence
           WHERE excluded.last_sequence>world_projection_entities.last_sequence`,
        )
        .run(
          principal,
          workspace,
          mode,
          record.ref.id,
          record.ref.revision,
          record.ref.sha256,
          record.kind,
          JSON.stringify(record),
          event.sequence,
        );
    } else {
      const relationship = event.value;
      this.db
        .prepare(
          `INSERT INTO world_projection_relationships
           (principal,workspace,mode,relationship_id,body,last_sequence)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(principal,workspace,mode,relationship_id) DO NOTHING`,
        )
        .run(
          principal,
          workspace,
          mode,
          relationship.id,
          JSON.stringify(relationship),
          event.sequence,
        );
    }

    this.db
      .prepare(
        `INSERT INTO world_projection_cursors(principal,workspace,mode,sequence)
         VALUES(?,?,?,?)
         ON CONFLICT(principal,workspace,mode) DO UPDATE SET sequence=excluded.sequence`,
      )
      .run(principal, workspace, mode, event.sequence);
  }

  private replay<T extends WorldRecord | WorldRelationship>(
    scope: WorldScope,
    key: string,
    fingerprint: string,
    resolveValue: (receipt: WorldOperationReceipt) => T | undefined,
  ): WorldWriteResult<T> | undefined {
    const prior = this.db
      .prepare(
        `SELECT fingerprint,receipt FROM world_operation_receipts
         WHERE principal=? AND workspace=? AND mode=? AND operation_key=?`,
      )
      .get(scope.principal, scope.workspace, scope.mode, key) as
      StoredOperation | undefined;
    if (!prior) return undefined;
    if (prior.fingerprint !== fingerprint)
      throw new Error(
        'World Model operation key was reused with different content.',
      );
    const receipt = worldOperationReceiptSchema.parse(
      JSON.parse(prior.receipt),
    );
    const value = resolveValue(receipt);
    if (!value)
      throw new Error('World Model operation receipt has no readable record.');
    return { value, receipt, changed: false };
  }

  private receipt(
    scope: WorldScope,
    key: string,
    fingerprint: string,
    outcome: WorldOperationReceipt['outcome'],
    records: WorldOperationReceipt['records'],
    recordedAt: string,
  ): WorldOperationReceipt {
    return worldOperationReceiptSchema.parse({
      schema_version: 'haze.world.operation-receipt.v1',
      id: `wmop:${contractHash({ scope, key }).slice(0, 48)}`,
      scope,
      operation_key: key,
      fingerprint,
      outcome,
      records,
      recorded_at: recordedAt,
    });
  }

  private saveOperation(receipt: WorldOperationReceipt): void {
    this.db
      .prepare(
        `INSERT INTO world_operation_receipts
         (principal,workspace,mode,operation_key,fingerprint,receipt,recorded_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        receipt.scope.principal,
        receipt.scope.workspace,
        receipt.scope.mode,
        receipt.operation_key,
        receipt.fingerprint,
        JSON.stringify(receipt),
        receipt.recorded_at,
      );
  }
}
