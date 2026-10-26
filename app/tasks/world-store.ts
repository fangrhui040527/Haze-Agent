import type { DatabaseSync } from 'node:sqlite';
import { contractHash } from '../contracts/json.js';
import {
  artifactRefSchema,
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../contracts/artifacts.js';
import {
  worldEventSchema,
  worldAcceptanceOutcomeSchema,
  worldHoldSchema,
  worldOperationReceiptSchema,
  worldRecordSchema,
  worldRelationshipSchema,
  type WorldEvent,
  type WorldAcceptanceOutcome,
  type WorldHold,
  worldLineagePageSchema,
  type WorldOperationReceipt,
  type WorldRecord,
  type WorldRelationship,
} from '../contracts/world.js';
import type {
  WorldContextOutput,
  WorldLineageInput,
  WorldLookupInput,
} from '../contracts/world-services.js';

type WorldScope = WorldRecord['scope'];
type WorldActor = WorldRecord['producer'];
type Transaction = <T>(operation: () => T) => T;
type Row = { body: string };
const acceptanceBase = (outcome: WorldAcceptanceOutcome) =>
  Object.fromEntries(
    Object.entries(outcome).filter(
      ([key]) =>
        ![
          'status',
          'accepted_at',
          'reasons',
          'hold_ids',
          'superseded_by',
        ].includes(key),
    ),
  );

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

export interface WorldAcceptanceInput {
  scope: WorldScope;
  subject: WorldRecord['ref'];
  stated_use: string;
  status: WorldAcceptanceOutcome['status'];
  policy: WorldAcceptanceOutcome['policy'];
  support_revisions: WorldAcceptanceOutcome['support_revisions'];
  reasons?: string[];
  expires_at?: string;
  actor: WorldActor;
  evaluated_at?: string;
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
    private readonly onEvent?: (event: WorldEvent) => void,
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

  projectArtifact(
    artifact: Artifact,
    mode: WorldScope['mode'],
  ): WorldWriteResult<WorldRecord> {
    const { id, version, sha256 } = artifact;
    return this.putRecord({
      scope: {
        principal: artifact.identity.principal,
        workspace: artifact.identity.workspace,
        mode,
      },
      operation_key: `project-artifact:${id}:${version}`,
      kind: 'artifact_reference',
      external_id: `artifact:${id}:${version}`,
      payload: {
        artifact: { id, version, sha256 },
        kind: artifact.kind,
        producer: artifact.producer,
        created_at: artifact.created_at,
        dependencies: artifact.dependencies,
        ...(artifact.evidence_origin === undefined
          ? {}
          : { evidence_origin: artifact.evidence_origin }),
      },
      producer: {
        kind: artifact.producer.kind,
        id: artifact.producer.id,
      },
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
      if (input.kind === 'supported_by' || input.kind === 'depends_on')
        this.db
          .prepare(
            `INSERT OR IGNORE INTO world_dependencies
             (principal,workspace,mode,record_id,support_record_id,support_revision,body)
             VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            input.scope.principal,
            input.scope.workspace,
            input.scope.mode,
            input.from.id,
            input.to.id,
            input.to.revision,
            JSON.stringify(relationship),
          );
      if (input.kind === 'supersedes') {
        const superseded = this.record(
          input.scope,
          input.to.id,
          input.to.revision,
        );
        const artifactRef =
          superseded?.kind === 'artifact_reference' &&
          typeof superseded.payload === 'object' &&
          superseded.payload !== null &&
          !Array.isArray(superseded.payload)
            ? artifactRefSchema.safeParse(superseded.payload.artifact)
            : undefined;
        if (artifactRef?.success)
          this.holdForSupportArtifact(
            input.scope,
            artifactRef.data.id,
            'A newer World Model record explicitly superseded this support.',
            'source_supersession',
          );
        else
          this.hold(
            input.scope,
            input.to,
            'A newer World Model record explicitly superseded this support.',
            'source_supersession',
          );
      }
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

  lookup(scope: WorldScope, input: WorldLookupInput): WorldRecord[] {
    const clauses = ['principal=?', 'workspace=?', 'mode=?'];
    const params: (string | number)[] = [
      scope.principal,
      scope.workspace,
      scope.mode,
    ];
    if (input.kind !== undefined) {
      clauses.push('kind=?');
      params.push(input.kind);
    }
    if (input.external_id !== undefined) {
      clauses.push("json_extract(body,'$.external_id')=?");
      params.push(input.external_id);
    }
    if (input.artifact_kind !== undefined) {
      clauses.push(
        "kind='artifact_reference' AND json_extract(body,'$.payload.kind')=?",
      );
      params.push(input.artifact_kind);
    }
    params.push(input.limit);
    const rows = this.db
      .prepare(
        `SELECT body FROM world_projection_entities
         WHERE ${clauses.join(' AND ')}
         ORDER BY last_sequence DESC,record_id LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map((row) => worldRecordSchema.parse(JSON.parse(row.body)));
  }

  recordsForArtifacts(
    scope: WorldScope,
    refs: ArtifactRef[],
    limit = 50,
  ): { records: WorldRecord[]; truncated: boolean } {
    if (refs.length === 0) return { records: [], truncated: false };
    const refsByIdentity = new Set(
      refs.map((ref) => `${ref.id}:${ref.version}:${ref.sha256}`),
    );
    const ids = [...new Set(refs.map((ref) => ref.id))];
    const artifactRows = this.db
      .prepare(
        `SELECT record_id,body FROM world_entities
         WHERE principal=? AND workspace=? AND mode=?
         AND kind='artifact_reference'
         AND revision=(SELECT MAX(current.revision) FROM world_entities current
           WHERE current.principal=world_entities.principal
           AND current.workspace=world_entities.workspace
           AND current.mode=world_entities.mode
           AND current.record_id=world_entities.record_id)
         AND json_extract(body,'$.payload.artifact.id') IN (${ids.map(() => '?').join(',')})`,
      )
      .all(scope.principal, scope.workspace, scope.mode, ...ids) as (Row & {
      record_id: string;
    })[];
    const pending = artifactRows.flatMap((row) => {
      const artifact = worldRecordSchema.parse(JSON.parse(row.body));
      if (
        typeof artifact.payload !== 'object' ||
        artifact.payload === null ||
        Array.isArray(artifact.payload)
      )
        return [];
      const ref = artifactRefSchema.safeParse(artifact.payload.artifact);
      return ref.success &&
        refsByIdentity.has(
          `${ref.data.id}:${ref.data.version}:${ref.data.sha256}`,
        )
        ? [row.record_id]
        : [];
    });
    const visited = new Set<string>();
    let truncated = false;
    while (pending.length > 0) {
      const supportRecordId = pending.shift()!;
      if (visited.has(supportRecordId)) continue;
      if (visited.size >= limit) {
        truncated = true;
        break;
      }
      visited.add(supportRecordId);
      const dependents = this.db
        .prepare(
          `SELECT record_id FROM world_dependencies
           WHERE principal=? AND workspace=? AND mode=? AND support_record_id=?
           ORDER BY record_id LIMIT ?`,
        )
        .all(
          scope.principal,
          scope.workspace,
          scope.mode,
          supportRecordId,
          limit + 1,
        ) as { record_id: string }[];
      pending.push(...dependents.map(({ record_id }) => record_id));
    }
    const records = [...visited]
      .map((recordId) => this.record(scope, recordId))
      .filter((record): record is WorldRecord => record !== undefined)
      .sort((left, right) => left.ref.id.localeCompare(right.ref.id));
    return { records, truncated };
  }

  context(scope: WorldScope, recordId: string): WorldContextOutput | undefined {
    const record = this.record(scope, recordId);
    if (!record) return undefined;
    const relationships = this.relationships(scope, recordId);
    // Artifact-reference records must enforce access to their own payload too.
    const ownArtifact =
      record.kind === 'artifact_reference' &&
      typeof record.payload === 'object' &&
      record.payload !== null &&
      !Array.isArray(record.payload)
        ? artifactRefSchema.safeParse(record.payload.artifact)
        : undefined;
    const support_artifacts = [
      ...(ownArtifact?.success ? [ownArtifact.data] : []),
      ...relationships.flatMap((relationship) => {
        if (
          relationship.kind !== 'supported_by' ||
          relationship.from.id !== recordId
        )
          return [];
        const support = this.record(scope, relationship.to.id);
        if (!support || support.kind !== 'artifact_reference') return [];
        if (
          typeof support.payload !== 'object' ||
          support.payload === null ||
          Array.isArray(support.payload)
        )
          return [];
        const parsed = artifactRefSchema.safeParse(support.payload.artifact);
        return parsed.success ? [parsed.data] : [];
      }),
    ];
    return {
      schema_version: 'haze.world.context.v1',
      record,
      relationships,
      acceptances: this.acceptancesForRecord(scope, recordId),
      support_artifacts: [
        ...new Map(
          support_artifacts.map((ref) => [
            `${ref.id}:${ref.version}:${ref.sha256}`,
            ref,
          ]),
        ).values(),
      ],
      payload: record.payload,
    };
  }

  lineage(scope: WorldScope, input: WorldLineageInput) {
    const subject = this.record(scope, input.record_id);
    if (!subject) return undefined;
    const limit = input.limit;
    const after = Number(input.cursor ?? 0);
    const scanLimit = Math.min(limit * 20 + 1, 2001);
    const rows = this.db
      .prepare(
        `SELECT event_id,sequence,event_kind,body FROM world_events
         WHERE principal=? AND workspace=? AND mode=? AND sequence>?
         ORDER BY sequence LIMIT ?`,
      )
      .all(
        scope.principal,
        scope.workspace,
        scope.mode,
        after,
        scanLimit,
      ) as (Row & {
      event_id: string;
      sequence: number;
      event_kind: string;
    })[];
    const events = rows.map((row) => this.parseEventRow(row, scope));
    const matching = events.filter((event) => {
      const value = event.value;
      if ('ref' in value) return value.ref.id === input.record_id;
      if ('from' in value && 'to' in value)
        return (
          value.from.id === input.record_id || value.to.id === input.record_id
        );
      if ('subject' in value) return value.subject.id === input.record_id;
      return false;
    });
    const selected = matching.slice(0, limit);
    const entries = selected.map((event) => ({
      event_id: event.event_id,
      event_kind: event.event_kind,
      ...('ref' in event.value
        ? { record: event.value.ref }
        : 'from' in event.value && 'to' in event.value
          ? { relationship: event.value }
          : 'stated_use' in event.value
            ? { acceptance: event.value }
            : { hold: event.value }),
      actor: event.actor,
      recorded_at: event.recorded_at,
    }));
    const hasMore = matching.length > limit || rows.length === scanLimit;
    const cursor = !hasMore
      ? undefined
      : matching.length > limit && selected.length
        ? String(selected.at(-1)!.sequence)
        : String(rows.at(-1)!.sequence);
    const value = {
      schema_version: 'haze.world.lineage-page.v1' as const,
      record: subject.ref,
      entries,
      page: {
        limit,
        has_more: hasMore,
        ...(cursor ? { next_cursor: cursor } : {}),
      },
    };
    return worldLineagePageSchema.parse(value);
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

  evaluateAcceptance(input: WorldAcceptanceInput): WorldAcceptanceOutcome {
    const evaluatedAt = input.evaluated_at ?? this.clock();
    const acceptanceId = `wma:${contractHash({
      scope: input.scope,
      subject: input.subject,
      stated_use: input.stated_use,
    })}`;
    return this.transaction(() => {
      this.requireRecord(input.scope, input.subject);
      const latest = this.db
        .prepare(
          `SELECT body FROM world_acceptances
           WHERE principal=? AND workspace=? AND mode=? AND acceptance_id=?
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(
          input.scope.principal,
          input.scope.workspace,
          input.scope.mode,
          acceptanceId,
        ) as Row | undefined;
      const revisionRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(revision),0) AS revision FROM world_acceptances
           WHERE principal=? AND workspace=? AND mode=? AND acceptance_id=?`,
        )
        .get(
          input.scope.principal,
          input.scope.workspace,
          input.scope.mode,
          acceptanceId,
        ) as { revision: number };
      const revision = revisionRow.revision + 1;
      const base = {
        schema_version: 'haze.world.acceptance.v1' as const,
        id: acceptanceId,
        scope: input.scope,
        subject: input.subject,
        stated_use: input.stated_use,
        policy: input.policy,
        support_revisions: input.support_revisions,
        evaluated_at: evaluatedAt,
        ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      };
      const raw =
        input.status === 'accepted'
          ? { ...base, status: 'accepted' as const, accepted_at: evaluatedAt }
          : input.status === 'held'
            ? {
                ...base,
                status: 'held' as const,
                hold_ids: input.reasons ?? [],
              }
            : {
                ...base,
                status: input.status as 'pending_review' | 'not_eligible',
                reasons: input.reasons ?? ['Review is incomplete.'],
              };
      const outcome = worldAcceptanceOutcomeSchema.parse(raw);
      if (latest) {
        const prior = worldAcceptanceOutcomeSchema.parse(
          JSON.parse(latest.body),
        );
        const semantic = (value: WorldAcceptanceOutcome) =>
          contractHash({
            subject: value.subject,
            stated_use: value.stated_use,
            status: value.status,
            policy: value.policy,
            support_revisions: value.support_revisions.map((support) =>
              Object.fromEntries(
                Object.entries(support).filter(
                  ([key]) => key !== 'schema_version' && key !== 'recorded_at',
                ),
              ),
            ),
            ...(value.status === 'accepted'
              ? {}
              : value.status === 'held'
                ? { hold_ids: value.hold_ids }
                : value.status === 'superseded'
                  ? { superseded_by: value.superseded_by }
                  : { reasons: value.reasons }),
          });
        if (semantic(prior) === semantic(outcome)) return prior;
      }
      this.db
        .prepare(
          `INSERT INTO world_acceptances
           (principal,workspace,mode,acceptance_id,revision,subject_record_id,stated_use,status,policy_id,policy_version,policy_hash,body,evaluated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.scope.principal,
          input.scope.workspace,
          input.scope.mode,
          acceptanceId,
          revision,
          input.subject.id,
          input.stated_use,
          outcome.status,
          outcome.policy.id,
          outcome.policy.version,
          outcome.policy.sha256,
          JSON.stringify(outcome),
          evaluatedAt,
        );
      this.appendEvent(
        input.scope,
        'acceptance_evaluated',
        outcome,
        input.actor,
        evaluatedAt,
      );
      if (outcome.status === 'accepted') {
        const operationKey = `acceptance:${acceptanceId}:${revision}`;
        const receipt = this.receipt(
          input.scope,
          operationKey,
          contractHash(outcome),
          'accepted',
          [outcome.subject],
          evaluatedAt,
        );
        this.saveOperation(receipt);
      }
      return outcome;
    });
  }

  acceptance(
    scope: WorldScope,
    acceptanceId: string,
  ): WorldAcceptanceOutcome | undefined {
    const row = this.db
      .prepare(
        `SELECT body FROM world_acceptances
         WHERE principal=? AND workspace=? AND mode=? AND acceptance_id=?
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(scope.principal, scope.workspace, scope.mode, acceptanceId) as
      Row | undefined;
    return row
      ? worldAcceptanceOutcomeSchema.parse(JSON.parse(row.body))
      : undefined;
  }

  acceptancesForRecord(
    scope: WorldScope,
    recordId: string,
  ): WorldAcceptanceOutcome[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM world_acceptances
         WHERE principal=? AND workspace=? AND mode=? AND subject_record_id=?
         AND revision=(SELECT MAX(current.revision) FROM world_acceptances current
           WHERE current.principal=world_acceptances.principal
           AND current.workspace=world_acceptances.workspace
           AND current.mode=world_acceptances.mode
           AND current.acceptance_id=world_acceptances.acceptance_id)
         ORDER BY stated_use,acceptance_id`,
      )
      .all(scope.principal, scope.workspace, scope.mode, recordId) as Row[];
    return rows.map((row) =>
      worldAcceptanceOutcomeSchema.parse(JSON.parse(row.body)),
    );
  }

  hold(
    scope: WorldScope,
    subject: WorldRecord['ref'],
    reason: string,
    source: WorldHold['source'],
    actor: WorldActor = { kind: 'service', id: 'world-model' },
  ): WorldHold {
    const createdAt = this.clock();
    const id = `wmh:${contractHash({ scope, subject, reason, source })}`;
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          `SELECT body FROM world_holds
           WHERE principal=? AND workspace=? AND mode=? AND hold_id=?
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(scope.principal, scope.workspace, scope.mode, id) as
        Row | undefined;
      if (prior) {
        const existing = worldHoldSchema.parse(JSON.parse(prior.body));
        if (!existing.cleared_at) return existing;
      }
      const hold = worldHoldSchema.parse({
        schema_version: 'haze.world.hold.v1',
        id,
        scope,
        subject,
        reason,
        source,
        created_at: createdAt,
      });
      const revisionRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(revision),0) AS revision FROM world_holds
           WHERE principal=? AND workspace=? AND mode=? AND hold_id=?`,
        )
        .get(scope.principal, scope.workspace, scope.mode, id) as {
        revision: number;
      };
      const revision = revisionRow.revision + 1;
      this.db
        .prepare(
          `INSERT INTO world_holds
           (principal,workspace,mode,hold_id,revision,subject_record_id,status,body,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope.principal,
          scope.workspace,
          scope.mode,
          id,
          revision,
          subject.id,
          'active',
          JSON.stringify(hold),
          createdAt,
        );
      this.appendEvent(scope, 'hold_created', hold, actor, createdAt);
      for (const acceptance of this.acceptancesForRecord(scope, subject.id)) {
        if (acceptance.status !== 'accepted') continue;
        this.evaluateAcceptance({
          scope,
          subject: acceptance.subject,
          stated_use: acceptance.stated_use,
          status: 'held',
          policy: acceptance.policy,
          support_revisions: acceptance.support_revisions,
          reasons: [hold.id],
          actor,
          evaluated_at: createdAt,
          ...(acceptance.expires_at
            ? { expires_at: acceptance.expires_at }
            : {}),
        });
      }
      return hold;
    });
  }

  activeHolds(scope: WorldScope, subjectId: string): WorldHold[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM world_holds
         WHERE principal=? AND workspace=? AND mode=? AND subject_record_id=?
         AND status='active' AND revision=(SELECT MAX(current.revision)
           FROM world_holds current
           WHERE current.principal=world_holds.principal
           AND current.workspace=world_holds.workspace
           AND current.mode=world_holds.mode
           AND current.hold_id=world_holds.hold_id)
         ORDER BY created_at,hold_id`,
      )
      .all(scope.principal, scope.workspace, scope.mode, subjectId) as Row[];
    return rows.map((row) => worldHoldSchema.parse(JSON.parse(row.body)));
  }

  clearHold(
    scope: WorldScope,
    holdId: string,
    reason: string,
    actor: WorldActor = { kind: 'service', id: 'world-model' },
  ): WorldHold {
    if (!reason.trim()) throw new Error('Clearing a hold requires a reason.');
    return this.transaction(() => {
      const priorRow = this.db
        .prepare(
          `SELECT body FROM world_holds
           WHERE principal=? AND workspace=? AND mode=? AND hold_id=?
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(scope.principal, scope.workspace, scope.mode, holdId) as
        Row | undefined;
      if (!priorRow) throw new Error('World Model hold was not found.');
      const prior = worldHoldSchema.parse(JSON.parse(priorRow.body));
      if (prior.cleared_at) return prior;
      const clearedAt = this.clock();
      const hold = worldHoldSchema.parse({
        ...prior,
        cleared_at: clearedAt,
        cleared_reason: reason,
      });
      const revisionRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(revision),0) AS revision FROM world_holds
           WHERE principal=? AND workspace=? AND mode=? AND hold_id=?`,
        )
        .get(scope.principal, scope.workspace, scope.mode, holdId) as {
        revision: number;
      };
      this.db
        .prepare(
          `INSERT INTO world_holds
           (principal,workspace,mode,hold_id,revision,subject_record_id,status,body,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope.principal,
          scope.workspace,
          scope.mode,
          holdId,
          revisionRow.revision + 1,
          hold.subject.id,
          'cleared',
          JSON.stringify(hold),
          hold.created_at,
        );
      this.appendEvent(scope, 'hold_cleared', hold, actor, clearedAt);
      return hold;
    });
  }

  holdPolicyChanges(
    policyHash: string,
    actor: WorldActor = { kind: 'service', id: 'world-model' },
  ): WorldHold[] {
    const scopes = this.db
      .prepare(
        `SELECT DISTINCT principal,workspace,mode FROM world_acceptances
         WHERE status='accepted' AND policy_hash<>?`,
      )
      .all(policyHash) as WorldScope[];
    const holds: WorldHold[] = [];
    for (const scope of scopes) {
      const rows = this.db
        .prepare(
          `SELECT subject_record_id FROM world_acceptances
           WHERE principal=? AND workspace=? AND mode=? AND status='accepted'
           AND policy_hash<>?
           AND revision=(SELECT MAX(current.revision)
             FROM world_acceptances current
             WHERE current.principal=world_acceptances.principal
             AND current.workspace=world_acceptances.workspace
             AND current.mode=world_acceptances.mode
             AND current.acceptance_id=world_acceptances.acceptance_id)`,
        )
        .all(scope.principal, scope.workspace, scope.mode, policyHash) as {
        subject_record_id: string;
      }[];
      for (const { subject_record_id } of rows) {
        const record = this.record(scope, subject_record_id);
        if (record)
          holds.push(
            this.hold(
              scope,
              record.ref,
              'The server acceptance policy changed.',
              'policy_change',
              actor,
            ),
          );
      }
    }
    return holds;
  }

  currentAcceptance(
    scope: WorldScope,
    acceptanceId: string,
    options: {
      now?: string;
      policyHash?: string;
      supportIsCurrent?: (outcome: WorldAcceptanceOutcome) => boolean;
    } = {},
  ): WorldAcceptanceOutcome | undefined {
    const outcome = this.acceptance(scope, acceptanceId);
    if (!outcome || outcome.status !== 'accepted') return outcome;
    const currentSubject = this.record(scope, outcome.subject.id);
    if (!currentSubject)
      return worldAcceptanceOutcomeSchema.parse({
        ...acceptanceBase(outcome),
        status: 'not_eligible',
        reasons: ['The accepted subject no longer exists in this scope.'],
        evaluated_at: options.now ?? this.clock(),
      });
    if (
      currentSubject.ref.revision !== outcome.subject.revision ||
      currentSubject.ref.sha256 !== outcome.subject.sha256
    )
      return worldAcceptanceOutcomeSchema.parse({
        ...acceptanceBase(outcome),
        status: 'superseded',
        superseded_by: currentSubject.ref,
        evaluated_at: options.now ?? this.clock(),
      });
    const holds = this.activeHolds(scope, outcome.subject.id);
    if (holds.length)
      return worldAcceptanceOutcomeSchema.parse({
        ...acceptanceBase(outcome),
        status: 'held',
        hold_ids: holds.map((hold) => hold.id),
        evaluated_at: options.now ?? this.clock(),
      });
    if (
      outcome.expires_at &&
      Date.parse(outcome.expires_at) <= Date.parse(options.now ?? this.clock())
    )
      return worldAcceptanceOutcomeSchema.parse({
        ...acceptanceBase(outcome),
        status: 'not_eligible',
        reasons: ['Acceptance has expired and requires reevaluation.'],
        evaluated_at: options.now ?? this.clock(),
      });
    if (options.policyHash && outcome.policy.sha256 !== options.policyHash)
      return worldAcceptanceOutcomeSchema.parse({
        ...acceptanceBase(outcome),
        status: 'not_eligible',
        reasons: ['The server acceptance policy has changed.'],
        evaluated_at: options.now ?? this.clock(),
      });
    if (options.supportIsCurrent && !options.supportIsCurrent(outcome))
      return worldAcceptanceOutcomeSchema.parse({
        ...acceptanceBase(outcome),
        status: 'held',
        hold_ids: ['support-changed'],
        evaluated_at: options.now ?? this.clock(),
      });
    return outcome;
  }

  holdForSupportArtifact(
    scope: WorldScope,
    artifactId: string,
    reason: string,
    source: WorldHold['source'],
    actor: WorldActor = { kind: 'service', id: 'world-model' },
  ): WorldHold[] {
    const artifacts = (
      this.db
        .prepare(`SELECT body FROM artifacts WHERE principal=? AND workspace=?`)
        .all(scope.principal, scope.workspace) as Row[]
    ).map((row) => artifactSchema.parse(JSON.parse(row.body)));
    const impactedArtifacts = new Set([artifactId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const artifact of artifacts)
        if (
          !impactedArtifacts.has(artifact.id) &&
          artifact.dependencies.some((dependency) =>
            impactedArtifacts.has(dependency.id),
          )
        ) {
          impactedArtifacts.add(artifact.id);
          changed = true;
        }
    }
    const rows = this.db
      .prepare(
        `SELECT subject_record_id,body FROM world_acceptances
         WHERE principal=? AND workspace=? AND mode=? AND status='accepted'
         AND revision=(SELECT MAX(current.revision) FROM world_acceptances current
           WHERE current.principal=world_acceptances.principal
           AND current.workspace=world_acceptances.workspace
           AND current.mode=world_acceptances.mode
           AND current.acceptance_id=world_acceptances.acceptance_id)`,
      )
      .all(scope.principal, scope.workspace, scope.mode) as (Row & {
      subject_record_id: string;
    })[];
    const affected = new Set(
      rows
        .filter((row) => {
          const acceptance = worldAcceptanceOutcomeSchema.parse(
            JSON.parse(row.body),
          );
          return acceptance.support_revisions.some((support) =>
            support.artifact
              ? impactedArtifacts.has(support.artifact.id)
              : false,
          );
        })
        .map((row) => row.subject_record_id),
    );
    const artifactRows = this.db
      .prepare(
        `SELECT record_id FROM world_entities
         WHERE principal=? AND workspace=? AND mode=?
         AND kind='artifact_reference'
         AND revision=(SELECT MAX(current.revision) FROM world_entities current
           WHERE current.principal=world_entities.principal
           AND current.workspace=world_entities.workspace
           AND current.mode=world_entities.mode
           AND current.record_id=world_entities.record_id)
         AND json_extract(body,'$.payload.artifact.id') IN (${[
           ...impactedArtifacts,
         ]
           .map(() => '?')
           .join(',')})`,
      )
      .all(
        scope.principal,
        scope.workspace,
        scope.mode,
        ...impactedArtifacts,
      ) as { record_id: string }[];
    const pending = [...new Set(artifactRows.map((row) => row.record_id))];
    const visited = new Set(pending);
    while (pending.length) {
      const supportId = pending.shift()!;
      const dependents = this.db
        .prepare(
          `SELECT record_id FROM world_dependencies
           WHERE principal=? AND workspace=? AND mode=? AND support_record_id=?`,
        )
        .all(scope.principal, scope.workspace, scope.mode, supportId) as {
        record_id: string;
      }[];
      for (const dependent of dependents)
        if (!visited.has(dependent.record_id)) {
          visited.add(dependent.record_id);
          pending.push(dependent.record_id);
        }
    }
    for (const row of rows)
      if (visited.has(row.subject_record_id))
        affected.add(row.subject_record_id);
    return [...affected].flatMap((recordId) => {
      const record = this.record(scope, recordId);
      return record
        ? [this.hold(scope, record.ref, reason, source, actor)]
        : [];
    });
  }

  holdForTaskGrant(
    scope: WorldScope,
    taskId: string,
    revokedTools: string[],
    reason: string,
    actor: WorldActor = { kind: 'service', id: 'world-model' },
  ): WorldHold[] {
    const revoked = new Set(revokedTools);
    if (!revoked.size) return [];
    const rows = this.db
      .prepare(
        `SELECT subject_record_id,body FROM world_acceptances
         WHERE principal=? AND workspace=? AND mode=? AND status='accepted'
         AND revision=(SELECT MAX(current.revision) FROM world_acceptances current
           WHERE current.principal=world_acceptances.principal
           AND current.workspace=world_acceptances.workspace
           AND current.mode=world_acceptances.mode
           AND current.acceptance_id=world_acceptances.acceptance_id)`,
      )
      .all(scope.principal, scope.workspace, scope.mode) as (Row & {
      subject_record_id: string;
    })[];
    return rows.flatMap((row) => {
      const acceptance = worldAcceptanceOutcomeSchema.parse(
        JSON.parse(row.body),
      );
      const affected = acceptance.support_revisions.some(
        (support) =>
          support.grant?.task_id === taskId &&
          support.grant.tools.some((tool) => revoked.has(tool)),
      );
      if (!affected) return [];
      const record = this.record(scope, row.subject_record_id);
      return record
        ? [this.hold(scope, record.ref, reason, 'grant_revocation', actor)]
        : [];
    });
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
    eventKind:
      | 'record_created'
      | 'record_revised'
      | 'relationship_created'
      | 'acceptance_evaluated'
      | 'hold_created'
      | 'hold_cleared',
    value: WorldRecord | WorldRelationship | WorldAcceptanceOutcome | WorldHold,
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
    this.onEvent?.(event);
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
      (event.event_kind === 'record_created' ||
        event.event_kind === 'record_revised') !==
        'ref' in event.value ||
      (event.event_kind === 'relationship_created' &&
        !('from' in event.value && 'to' in event.value)) ||
      (event.event_kind === 'acceptance_evaluated' &&
        !('subject' in event.value && 'stated_use' in event.value)) ||
      ((event.event_kind === 'hold_created' ||
        event.event_kind === 'hold_cleared') &&
        !('subject' in event.value && 'reason' in event.value))
    )
      throw new Error('World Model event integrity check failed.');
    return event;
  }

  private applyProjection(event: WorldEvent): void {
    const { principal, workspace, mode } = event.scope;
    const cursor = this.projectionCursor(event.scope);
    if (event.sequence !== cursor + 1)
      throw new Error('World Model projection cursor is out of sequence.');

    if (
      event.event_kind === 'record_created' ||
      event.event_kind === 'record_revised'
    ) {
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
    } else if (event.event_kind === 'relationship_created') {
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
