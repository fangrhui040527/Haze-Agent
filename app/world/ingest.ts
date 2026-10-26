import { createHash } from 'node:crypto';
import type { Artifact } from '../contracts/artifacts.js';
import { boundedJsonSchema } from '../contracts/artifacts.js';
import type { Location } from '../contracts/haze-evidence.js';
import { contractHash } from '../contracts/json.js';
import type { WorldRecord } from '../contracts/world.js';
import type { WorldModelStore } from '../tasks/world-store.js';
import {
  collectionCaptureSchema,
  type CollectionCapture,
} from '../capabilities/evidence-collection/contracts.js';
import type {
  AdapterResult,
  WatcherSpec,
} from '../capabilities/evidence-collection/types.js';
import type { WmEntity, WmFact, WmProvenance, WriteSummary } from './types.js';

export const entityId = (type: string, id: string) => `${type}:haze:${id}`;
export const localId = (id: string) => id.split(':').slice(2).join(':');
export const hazeRecordKind = (type: string) => `haze_${type}`;
export const externalIdentity = (id: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id)
    ? id
    : `haze:${contractHash(id)}`;
type Scope = WorldRecord['scope'];

export function findHazeRecord(
  world: WorldModelStore,
  scope: Scope,
  type: string,
  id: string,
): WorldRecord | undefined {
  return world.lookup(scope, {
    kind: hazeRecordKind(type),
    external_id: externalIdentity(id),
    limit: 1,
  })[0];
}

export function support(
  world: WorldModelStore,
  record: WorldRecord,
  artifact: Artifact | undefined,
): void {
  if (!artifact) return;
  const retained = world.projectArtifact(artifact, record.scope.mode).value;
  world.relate({
    scope: record.scope,
    operation_key: `haze-support:${contractHash({ from: record.ref, to: retained.ref })}`,
    kind: 'supported_by',
    from: record.ref,
    to: retained.ref,
    recorded_at: artifact.created_at,
  });
}

export function putHazeEntity(
  world: WorldModelStore,
  scope: Scope,
  entity: WmEntity,
  artifact?: Artifact,
): { record: WorldRecord; changed: boolean } {
  const prior = findHazeRecord(world, scope, entity.type, entity.id);
  const existing = prior?.payload as unknown as WmEntity | undefined;
  // Repeated polling does not revise identical configuration/evidence metadata.
  const unchanged =
    existing &&
    contractHash({
      attrs: existing.attrs,
      name: existing.name ?? null,
      state: existing.state,
    }) ===
      contractHash({
        attrs: entity.attrs,
        name: entity.name ?? null,
        state: entity.state,
      });
  const record = unchanged
    ? prior!
    : world.putRecord({
        scope,
        operation_key: `haze-entity:${contractHash(entity)}`,
        kind: hazeRecordKind(entity.type),
        external_id: externalIdentity(entity.id),
        payload: boundedJsonSchema.parse(entity),
        producer: { kind: 'service', id: 'HazeOps' },
        observed_at: entity.source.at,
        recorded_at: entity.updatedAt,
      }).value;
  support(world, record, artifact);
  return { record, changed: !unchanged };
}

function upsertEntity(
  world: WorldModelStore,
  scope: Scope,
  type: string,
  id: string,
  name: string,
  attrs: Record<string, unknown>,
  source: WmProvenance,
  artifact?: Artifact,
) {
  const readable = entityId(type, id);
  const prior = findHazeRecord(world, scope, type, readable)
    ?.payload as unknown as WmEntity | undefined;
  return putHazeEntity(
    world,
    scope,
    {
      type,
      id: readable,
      name,
      attrs: { ...prior?.attrs, ...attrs },
      source,
      createdAt: prior?.createdAt ?? source.at,
      updatedAt: source.at,
      aliases: prior?.aliases ?? [name],
      state: 'active',
    },
    artifact,
  );
}

export function syncHazeLocations(
  world: WorldModelStore,
  scope: Scope,
  locations: readonly Location[],
  at: string,
  artifact?: Artifact,
): number {
  let changed = 0;
  for (const { id, name, ...attrs } of locations)
    if (
      upsertEntity(
        world,
        scope,
        'location',
        id,
        name,
        attrs,
        { kind: 'manual', by: 'haze-config', at },
        artifact,
      ).changed
    )
      changed++;
  return changed;
}

export function syncHazeSources(
  world: WorldModelStore,
  scope: Scope,
  specs: readonly WatcherSpec[],
  at: string,
  artifact?: Artifact,
): number {
  let changed = 0;
  for (const spec of specs) {
    const { id, name, ...rest } = spec.source;
    if (
      upsertEntity(
        world,
        scope,
        'source',
        id,
        name,
        {
          ...rest,
          watcherId: spec.id,
          freshnessMinutes: spec.freshnessMinutes,
        },
        { kind: 'manual', by: 'haze-config', at },
        artifact,
      ).changed
    )
      changed++;
  }
  return changed;
}

export function relateEntities(
  world: WorldModelStore,
  scope: Scope,
  from: WorldRecord,
  kind: string,
  to: WorldRecord | undefined,
  at: string,
  attributes?: Record<string, unknown>,
): void {
  if (!to) return;
  world.relate({
    scope,
    kind,
    from: from.ref,
    to: to.ref,
    operation_key: `haze-edge:${contractHash({ kind, from: from.ref, to: to.ref, attributes: attributes ?? null })}`,
    recorded_at: at,
    ...(attributes ? { attributes: boundedJsonSchema.parse(attributes) } : {}),
  });
}

/** Validate all raw material before any caller starts its atomic ingestion. */
export function validateAdapterResult(result: AdapterResult): void {
  const ids = new Set<string>();
  for (const { record, raw } of result.evidence) {
    if (
      record.acceptedAt !== null ||
      record.disposition !== 'pinned_unreviewed'
    )
      throw new Error('HazeOps ingestion cannot grant acceptance or review.');
    if (
      raw.length !== record.rawBytes ||
      createHash('sha256').update(raw).digest('hex') !== record.rawSha256
    )
      throw new Error(
        'Haze evidence does not match its exact pinned raw bytes.',
      );
    if (ids.has(record.evidenceId))
      throw new Error('Duplicate haze evidence ID.');
    ids.add(record.evidenceId);
  }
  for (const fact of result.facts)
    if (!ids.has(fact.evidenceId))
      throw new Error('Haze fact has no exact retained evidence.');
}

export function ingestAdapterResult(
  world: WorldModelStore,
  scope: Scope,
  result: AdapterResult,
  runId: string,
  artifacts: ReadonlyMap<string, Artifact>,
): WriteSummary {
  validateAdapterResult(result);
  const summary: WriteSummary = {
    evidenceWritten: 0,
    factsWritten: 0,
    factsSkipped: 0,
    stationsWritten: 0,
    newestObservation: null,
  };
  for (const { record } of result.evidence) {
    const existing = findHazeRecord(
      world,
      scope,
      'evidence',
      entityId('evidence', record.evidenceId),
    );
    if (
      existing &&
      (existing.payload as unknown as WmEntity).attrs.rawSha256 !==
        record.rawSha256
    )
      throw new Error(
        'Pinned haze evidence identity was reused with different raw bytes.',
      );
    // A pinned evidence ID denotes the first exact capture, including its timestamps.
    const saved = existing
      ? { record: existing, changed: false }
      : upsertEntity(
          world,
          scope,
          'evidence',
          record.evidenceId,
          record.title,
          record as unknown as Record<string, unknown>,
          {
            kind: 'api',
            by: 'hazeops',
            at: record.retrievedAt,
            url: record.locator.url,
            checksum: record.rawSha256,
            runId,
          },
          artifacts.get(record.evidenceId),
        );
    support(world, saved.record, artifacts.get(record.evidenceId));
    if (saved.changed) summary.evidenceWritten++;
    relateEntities(
      world,
      scope,
      saved.record,
      'published_by',
      findHazeRecord(
        world,
        scope,
        'source',
        entityId('source', record.sourceId),
      ),
      record.retrievedAt,
    );
  }
  const first = result.evidence[0];
  for (const { stationId, name, ...attrs } of result.stations) {
    const saved = upsertEntity(
      world,
      scope,
      'station',
      stationId,
      name,
      attrs,
      {
        kind: 'api',
        by: 'hazeops',
        at: first?.record.retrievedAt ?? new Date().toISOString(),
        runId,
      },
      first ? artifacts.get(first.record.evidenceId) : undefined,
    );
    if (saved.changed) summary.stationsWritten++;
    relateEntities(
      world,
      scope,
      saved.record,
      'near',
      findHazeRecord(
        world,
        scope,
        'location',
        entityId('location', attrs.nearestLocationId),
      ),
      saved.record.recorded_at,
      { distanceKm: attrs.distanceKm },
    );
  }
  const byId = new Map(
    result.evidence.map(({ record }) => [record.evidenceId, record]),
  );
  for (const draft of result.facts) {
    const evidence = byId.get(draft.evidenceId)!;
    const about = entityId(draft.about.type, draft.about.id);
    const subject = findHazeRecord(world, scope, draft.about.type, about);
    if (!subject)
      throw new Error(`Haze fact subject is not registered: ${about}`);
    const semantic = {
      about,
      predicate: draft.predicate,
      observedAt: draft.observedAt,
      value: draft.value,
    };
    const id = `fact:haze:${contractHash(semantic)}`;
    const existing = findHazeRecord(world, scope, 'fact', id);
    if (existing) {
      support(world, existing, artifacts.get(draft.evidenceId));
      summary.factsSkipped++;
      continue;
    }
    const fact: WmFact = {
      id,
      about,
      predicate: draft.predicate,
      value: {
        ...draft.value,
        evidenceId: draft.evidenceId,
        dedupeKey: draft.dedupeKey ?? null,
      },
      confidence: 1,
      assertedAt: draft.observedAt,
      source: {
        kind: evidence.sourceKind,
        by: 'hazeops',
        at: draft.observedAt,
        url: evidence.locator.url,
        checksum: evidence.rawSha256,
        runId,
      },
    };
    const retained = world.putRecord({
      scope,
      kind: hazeRecordKind('fact'),
      external_id: id,
      operation_key: `haze-fact:${contractHash(fact)}`,
      payload: boundedJsonSchema.parse(fact),
      producer: { kind: 'service', id: 'HazeOps' },
      observed_at: fact.assertedAt,
      retrieved_at: evidence.retrievedAt,
      recorded_at: evidence.retrievedAt,
    }).value;
    support(world, retained, artifacts.get(draft.evidenceId));
    relateEntities(
      world,
      scope,
      retained,
      'about',
      subject,
      evidence.retrievedAt,
    );
    relateEntities(
      world,
      scope,
      retained,
      'evidenced_by',
      findHazeRecord(
        world,
        scope,
        'evidence',
        entityId('evidence', draft.evidenceId),
      ),
      evidence.retrievedAt,
    );
    summary.factsWritten++;
    if (
      !summary.newestObservation ||
      draft.observedAt > summary.newestObservation
    )
      summary.newestObservation = draft.observedAt;
  }
  return summary;
}

export function ingestCollectionCapture(
  world: WorldModelStore,
  artifact: Artifact,
  mode: Scope['mode'],
): WriteSummary {
  const capture: CollectionCapture = collectionCaptureSchema.parse(
    artifact.content,
  );
  if (capture.mode !== mode)
    throw new Error('Collection capture execution mode mismatch.');
  if (artifact.evidence_origin !== capture.evidence_origin)
    throw new Error('Collection capture evidence origin mismatch.');
  const scope = { ...artifact.identity, mode };
  syncHazeLocations(
    world,
    scope,
    capture.scope.locations,
    capture.collected_at,
    artifact,
  );
  const source = findHazeRecord(
    world,
    scope,
    'source',
    entityId('source', capture.source.id),
  )?.payload as unknown as WmEntity | undefined;
  syncHazeSources(
    world,
    scope,
    [
      {
        id:
          typeof source?.attrs.watcherId === 'string'
            ? source.attrs.watcherId
            : `collection-${capture.scope.provider}`,
        source: capture.source,
        requiresEnv: [],
        query: capture.selection.query,
        placeSelector: capture.selection.place_selector,
        timeSelector: capture.selection.time_selector,
        cadenceSec: 0,
        rateLimit: 'Explicit task collection',
        freshnessMinutes:
          typeof source?.attrs.freshnessMinutes === 'number'
            ? source.attrs.freshnessMinutes
            : 360,
      },
    ],
    capture.collected_at,
    artifact,
  );
  return ingestAdapterResult(
    world,
    scope,
    {
      evidence: capture.evidence.map(({ record, raw_base64 }) => ({
        record,
        raw: Buffer.from(raw_base64, 'base64'),
      })),
      stations: capture.stations,
      facts: capture.facts.map(({ dedupeKey, ...fact }) => ({
        ...fact,
        ...(dedupeKey === undefined ? {} : { dedupeKey }),
      })),
      coverage: capture.coverage,
    },
    artifact.run_id ?? artifact.id,
    new Map(
      capture.evidence.map(({ record }) => [record.evidenceId, artifact]),
    ),
  );
}
