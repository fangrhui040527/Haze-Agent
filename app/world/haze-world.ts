import { createHash } from 'node:crypto';
import type { TaskIdentity } from '../contracts/tasks.js';
import type { Location } from '../contracts/haze-evidence.js';
import type { WorldRecord } from '../contracts/world.js';
import type { TaskStore } from '../tasks/store.js';
import type { ExecutionMode } from '../orchestration/ports.js';
import type {
  AdapterResult,
  EvidenceRecord,
  WatcherSpec,
} from '../capabilities/evidence-collection/types.js';
import { collectionCaptureSchema } from '../capabilities/evidence-collection/contracts.js';
import {
  entityId,
  findHazeRecord,
  hazeRecordKind,
  syncHazeLocations,
  syncHazeSources,
} from './ingest.js';
import type { WmEntity, WmFact, WriteSummary } from './types.js';

export { entityId, localId } from './ingest.js';
export type { WriteSummary } from './types.js';

/** Compatibility projection, never a second store or a second engine instance. */
export class HazeWorld {
  readonly world;
  readonly scope: WorldRecord['scope'];

  constructor(
    private readonly store: TaskStore,
    private readonly identity: TaskIdentity,
    mode: ExecutionMode,
  ) {
    this.world = store.world;
    this.scope = { ...identity, mode };
  }

  private records(type: string): WorldRecord[] {
    return (
      this.store.db
        .prepare(
          `SELECT body FROM world_projection_entities
      WHERE principal=? AND workspace=? AND mode=? AND kind=?
      ORDER BY last_sequence,record_id`,
        )
        .all(
          this.scope.principal,
          this.scope.workspace,
          this.scope.mode,
          hazeRecordKind(type),
        ) as { body: string }[]
    ).map(({ body }) => JSON.parse(body) as WorldRecord);
  }

  entity(id: string): WmEntity | undefined {
    const type = id.split(':')[0];
    if (!type) return undefined;
    return findHazeRecord(this.world, this.scope, type, id)
      ?.payload as unknown as WmEntity | undefined;
  }

  entities(type: string): WmEntity[] {
    return this.records(type).map(
      (record) => record.payload as unknown as WmEntity,
    );
  }

  evidence(id: string): EvidenceRecord | null {
    const entity = this.entity(entityId('evidence', id));
    return entity ? (entity.attrs as unknown as EvidenceRecord) : null;
  }

  *facts(): Generator<{ about: string; predicate: string; history: WmFact[] }> {
    const histories = new Map<
      string,
      { about: string; predicate: string; history: WmFact[] }
    >();
    for (const record of this.records('fact')) {
      const fact = record.payload as unknown as WmFact;
      const key = JSON.stringify([fact.about, fact.predicate]);
      const group = histories.get(key) ?? {
        about: fact.about,
        predicate: fact.predicate,
        history: [],
      };
      group.history.push(fact);
      histories.set(key, group);
    }
    for (const group of histories.values()) {
      group.history.sort((a, b) => a.assertedAt.localeCompare(b.assertedAt));
      yield group;
    }
  }

  factHistory(about: string, predicate: string): WmFact[] {
    return (
      [...this.facts()].find(
        (group) => group.about === about && group.predicate === predicate,
      )?.history ?? []
    );
  }

  onFact(listener: (fact: WmFact) => void): () => void {
    return this.store.subscribeWorld((event) => {
      if (
        event.scope.principal !== this.scope.principal ||
        event.scope.workspace !== this.scope.workspace ||
        event.scope.mode !== this.scope.mode
      )
        return;
      if (
        (event.event_kind === 'record_created' ||
          event.event_kind === 'record_revised') &&
        event.value.kind === hazeRecordKind('fact')
      )
        listener(event.value.payload as unknown as WmFact);
    });
  }

  syncLocations(locations: readonly Location[], at: string): Promise<number> {
    return Promise.resolve().then(() =>
      syncHazeLocations(this.world, this.scope, locations, at),
    );
  }

  syncSources(specs: readonly WatcherSpec[], at: string): Promise<number> {
    return Promise.resolve().then(() =>
      syncHazeSources(this.world, this.scope, specs, at),
    );
  }

  writeAdapterResult(
    result: AdapterResult,
    runId: string,
  ): Promise<WriteSummary> {
    return Promise.resolve().then(() =>
      this.store.ingestHazeAdapterResult(
        result,
        this.identity,
        this.scope.mode,
        runId,
      ),
    );
  }

  /** Reconstruct the original bytes through immutable artifact references. */
  rawEvidence(id: string): Buffer | null {
    const record = findHazeRecord(
      this.world,
      this.scope,
      'evidence',
      entityId('evidence', id),
    );
    if (!record) return null;
    const expected = this.evidence(id)!;
    for (const ref of this.world.context(this.scope, record.ref.id)
      ?.support_artifacts ?? []) {
      const artifact = this.store.artifact(ref.id, this.identity, ref);
      let raw: Buffer | undefined;
      if (artifact.kind === 'evidence.collection.capture') {
        const capture = collectionCaptureSchema.parse(artifact.content);
        const entry = capture.evidence.find(
          ({ record: evidence }) => evidence.evidenceId === id,
        );
        if (entry) raw = Buffer.from(entry.raw_base64, 'base64');
      } else if (artifact.kind === 'haze.evidence.capture') {
        const pieces = artifact.dependencies.map((dependency) => {
          const child = this.store.artifact(
            dependency.id,
            this.identity,
            dependency,
          );
          const content = child.content as Record<string, unknown>;
          if (
            child.kind !== 'haze.evidence.raw.chunk' ||
            typeof content.raw_base64 !== 'string'
          )
            throw new Error('Retained raw evidence chunk is invalid.');
          const bytes = Buffer.from(content.raw_base64, 'base64');
          if (bytes.toString('base64') !== content.raw_base64)
            throw new Error(
              'Retained raw evidence chunk is not canonical base64.',
            );
          return bytes;
        });
        raw = Buffer.concat(pieces);
      }
      if (raw) {
        if (
          raw.length !== expected.rawBytes ||
          createHash('sha256').update(raw).digest('hex') !== expected.rawSha256
        )
          throw new Error(
            'Retained raw evidence does not match its pinned hash.',
          );
        return raw;
      }
    }
    return null;
  }
}
