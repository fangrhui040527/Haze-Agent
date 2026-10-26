import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TaskIdentity } from '../contracts/tasks.js';
import { boundedJsonSchema } from '../contracts/artifacts.js';
import { contractHash } from '../contracts/json.js';
import type { ExecutionMode } from '../orchestration/ports.js';
import type { TaskStore } from '../tasks/store.js';
import type { EvidenceRecord } from '../capabilities/evidence-collection/types.js';
import {
  entityId,
  externalIdentity,
  findHazeRecord,
  hazeRecordKind,
  putHazeEntity,
  relateEntities,
  support,
  validateAdapterResult,
} from './ingest.js';
import type { WmEntity, WmFact, WmRelationship } from './types.js';

const provenanceSchema = z
  .object({ kind: z.string().min(1), at: z.iso.datetime({ offset: true }) })
  .passthrough();
const entitySchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1),
    attrs: z.record(z.string(), z.unknown()),
    source: provenanceSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    aliases: z.array(z.string()),
    state: z.enum(['emerging', 'active', 'archived']),
    name: z.string().optional(),
  })
  .passthrough();
const factSchema = z
  .object({
    id: z.string().min(1),
    about: z.string().min(1),
    predicate: z.string().min(1),
    value: z.unknown(),
    confidence: z.number(),
    source: provenanceSchema,
    assertedAt: z.iso.datetime({ offset: true }),
  })
  .passthrough();
const relationshipSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    type: z.string().min(1),
    to: z.string().min(1),
    source: provenanceSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .passthrough();
const savedSchema = z
  .object({
    events: z.array(
      z
        .object({
          kind: z.string(),
          payload: z.unknown(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface DashboardMigrationResult {
  source_sha256: string;
  entities: number;
  facts: number;
  relationships: number;
  evidence: number;
  reused: boolean;
}

/** Copies an explicitly selected archive. Source JSON and raw files stay untouched. */
export function migrateDashboardState(
  store: TaskStore,
  sourceDirectory: string,
  identity: TaskIdentity,
  mode: ExecutionMode = 'live',
): DashboardMigrationResult {
  const source = resolve(sourceDirectory);
  if (source === resolve(store.directory))
    throw new Error(
      'Legacy source and shared target directories must be separate.',
    );
  const worldFile = join(source, 'world', '.world', 'haze.json');
  const bytes = readFileSync(worldFile);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const scope = { ...identity, mode };
  const receiptId = `legacy-dashboard:${hash}`;
  const previous = store.world.lookup(scope, {
    kind: 'haze_migration',
    external_id: receiptId,
    limit: 1,
  })[0];
  if (previous)
    return {
      ...(previous.payload as unknown as DashboardMigrationResult),
      reused: true,
    };
  const saved = savedSchema.parse(JSON.parse(bytes.toString('utf8')));
  const entities: WmEntity[] = [];
  const facts: WmFact[] = [];
  const relationships: WmRelationship[] = [];
  const folded = new Map<string, WmEntity>();
  for (const event of saved.events) {
    if (event.kind === 'upsertEntity') {
      const entity = entitySchema.parse(event.payload) as WmEntity;
      const prior = folded.get(entity.id);
      const merged = {
        ...entity,
        attrs: { ...prior?.attrs, ...entity.attrs },
        createdAt: prior?.createdAt ?? entity.createdAt,
      };
      entities.push(merged);
      folded.set(entity.id, merged);
    } else if (event.kind === 'assertFact')
      facts.push(factSchema.parse(event.payload));
    else if (event.kind === 'relate')
      relationships.push(relationshipSchema.parse(event.payload));
    else if (!['snapshot', 'view-rebuild'].includes(event.kind))
      throw new Error(
        `Legacy dashboard event needs an explicit migration rule: ${event.kind}`,
      );
  }
  const evidence = [...folded.values()]
    .filter((entity) => entity.type === 'evidence')
    .map((entity) => {
      const record = entity.attrs as unknown as EvidenceRecord;
      if (!/^[a-f0-9]{64}$/.test(record.rawSha256))
        throw new Error('Invalid legacy raw evidence hash.');
      const raw = readFileSync(join(source, 'raw', `${record.rawSha256}.json`));
      const result = {
        evidence: [{ record, raw }],
        stations: [],
        facts: [],
        coverage: { requested: 0, covered: 0, excluded: [], gaps: [] },
      };
      validateAdapterResult(result);
      return result;
    });
  // Preflight every reference before any target write or acceptance decision.
  for (const fact of facts) {
    if (!folded.has(fact.about))
      throw new Error(`Legacy fact has no entity: ${fact.about}`);
    const id =
      fact.value && typeof fact.value === 'object'
        ? (fact.value as Record<string, unknown>).evidenceId
        : undefined;
    if (typeof id !== 'string' || !folded.has(entityId('evidence', id)))
      throw new Error(`Legacy fact has no pinned evidence: ${fact.id}`);
  }
  for (const relationship of relationships)
    if (!folded.has(relationship.from) || !folded.has(relationship.to))
      throw new Error(
        `Legacy relationship has a missing entity: ${relationship.id}`,
      );

  return store.withWorldTransaction(() => {
    for (const entity of entities) putHazeEntity(store.world, scope, entity);
    for (const result of evidence)
      store.ingestHazeAdapterResult(
        result,
        identity,
        mode,
        `legacy-${hash.slice(0, 16)}`,
      );
    for (const fact of facts) {
      const value = { ...(fact.value as Record<string, unknown>) };
      delete value.evidenceId;
      delete value.dedupeKey;
      const observationId = `fact:haze:${contractHash({
        about: fact.about,
        predicate: fact.predicate,
        observedAt: fact.assertedAt,
        value,
      })}`;
      const retained = store.world.putRecord({
        scope,
        kind: hazeRecordKind('fact'),
        external_id: externalIdentity(observationId),
        operation_key: `legacy-fact:${contractHash(fact)}`,
        payload: boundedJsonSchema.parse(fact),
        producer: { kind: 'service', id: 'HazeOps' },
        observed_at: fact.assertedAt,
        recorded_at: fact.source.at,
      }).value;
      const evidenceId = (fact.value as Record<string, unknown>)
        .evidenceId as string;
      const exactEvidence = findHazeRecord(
        store.world,
        scope,
        'evidence',
        entityId('evidence', evidenceId),
      )!;
      for (const ref of store.world.context(scope, exactEvidence.ref.id)
        ?.support_artifacts ?? [])
        support(store.world, retained, store.artifact(ref.id, identity, ref));
      relateEntities(
        store.world,
        scope,
        retained,
        'about',
        findHazeRecord(
          store.world,
          scope,
          fact.about.split(':')[0]!,
          fact.about,
        ),
        fact.source.at,
      );
      relateEntities(
        store.world,
        scope,
        retained,
        'evidenced_by',
        exactEvidence,
        fact.source.at,
      );
    }
    for (const relationship of relationships) {
      const from = findHazeRecord(
        store.world,
        scope,
        relationship.from.split(':')[0]!,
        relationship.from,
      )!;
      const to = findHazeRecord(
        store.world,
        scope,
        relationship.to.split(':')[0]!,
        relationship.to,
      )!;
      relateEntities(
        store.world,
        scope,
        from,
        relationship.type,
        to,
        relationship.createdAt,
        { ...relationship.attrs, legacy_relationship: relationship },
      );
    }
    const result: DashboardMigrationResult = {
      source_sha256: hash,
      entities: entities.length,
      facts: facts.length,
      relationships: relationships.length,
      evidence: evidence.length,
      reused: false,
    };
    store.world.putRecord({
      scope,
      kind: 'haze_migration',
      external_id: receiptId,
      operation_key: receiptId,
      payload: boundedJsonSchema.parse(result),
      producer: { kind: 'service', id: 'dashboard-migration' },
    });
    return result;
  });
}
