import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Location } from '../../../frontend/src/shared/types/domain.ts';
import type {
  WmEntity,
  WmEvent,
  WmFact,
  WmProvenance,
  WorldModelEngine,
} from '../engines.ts';
import type {
  AdapterResult,
  EvidenceRecord,
  StationDraft,
  WatcherSpec,
} from '../hazeops/types.ts';

/**
 * The HazeWatch data model on top of the Meterless World Model
 * (documented in docs/05-world-model-data-model.md).
 *
 * Entities (all keyed by externalKey, so the name-similarity resolver never merges them):
 *   location:hazewatch:<id>   station:hazewatch:<id>
 *   source:hazewatch:<id>     evidence:hazewatch:<evidenceId>
 * Facts carry the values (pm25_modeled, pm25_observed, pm25_forecast_24h,
 * fire_hotspots_24h). Relationships: evidence -published_by-> source,
 * station -near-> location.
 *
 * The reference World Model rewrites its JSON file on every write, so this class only
 * writes what changed. Raw response bytes are archived outside it, by content hash.
 */

export const SYSTEM = 'hazewatch';
export const entityId = (type: string, id: string) => `${type}:${SYSTEM}:${id}`;
export const localId = (id: string) => id.split(':').slice(2).join(':');

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );

function withoutEvidence(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const rest: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  delete rest.evidenceId;
  return rest;
}

export interface WriteSummary {
  evidenceWritten: number;
  factsWritten: number;
  factsSkipped: number;
  stationsWritten: number;
  newestObservation: string | null;
}

export class HazeWorld {
  readonly world: WorldModelEngine;
  private readonly rawDir: string;
  /** Fact history per subject and predicate, oldest first (a projection of the event log). */
  private readonly history = new Map<string, Map<string, WmFact[]>>();
  private readonly listeners = new Set<(fact: WmFact) => void>();

  constructor(world: WorldModelEngine, stateDir: string) {
    this.world = world;
    this.rawDir = join(stateDir, 'raw');
    mkdirSync(this.rawDir, { recursive: true });
    for (const event of world.events()) this.index(event);
    world.subscribeEvents((event) => {
      const fact = this.index(event);
      if (fact) for (const listener of this.listeners) listener(fact);
    });
  }

  private index(event: WmEvent): WmFact | null {
    if (event.kind !== 'assertFact') return null;
    const fact = event.payload as WmFact;
    let byPredicate = this.history.get(fact.about);
    if (!byPredicate) {
      byPredicate = new Map();
      this.history.set(fact.about, byPredicate);
    }
    const list = byPredicate.get(fact.predicate) ?? [];
    list.push(fact);
    list.sort((a, b) => a.assertedAt.localeCompare(b.assertedAt));
    byPredicate.set(fact.predicate, list);
    return fact;
  }

  onFact(listener: (fact: WmFact) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every (subject, predicate) pair with its fact history. */
  *facts(): Generator<{ about: string; predicate: string; history: WmFact[] }> {
    for (const [about, byPredicate] of this.history) {
      for (const [predicate, history] of byPredicate) {
        yield { about, predicate, history };
      }
    }
  }

  factHistory(about: string, predicate: string): WmFact[] {
    return this.history.get(about)?.get(predicate) ?? [];
  }

  entity(id: string): WmEntity | undefined {
    return this.world.view('graph').entity(id);
  }

  entities(type: string): WmEntity[] {
    return this.world.view('graph').query({ type });
  }

  evidence(evidenceId: string): EvidenceRecord | null {
    const entity = this.entity(entityId('evidence', evidenceId));
    return entity ? (entity.attrs as unknown as EvidenceRecord) : null;
  }

  private async upsertIfChanged(
    type: string,
    id: string,
    name: string,
    attrs: Record<string, unknown>,
    source: WmProvenance,
  ): Promise<boolean> {
    const existing = this.entity(entityId(type, id));
    if (existing) {
      const merged = { ...existing.attrs, ...attrs };
      if (stable(merged) === stable(existing.attrs) && existing.name === name) {
        return false;
      }
    }
    await this.world.upsertEntity({
      type,
      externalKey: { system: SYSTEM, id },
      name,
      attrs,
      source,
    });
    return true;
  }

  /** Relate once: skip when the same open edge already exists. */
  private async relateOnce(
    from: string,
    type: string,
    to: string,
    source: WmProvenance,
    attrs?: Record<string, unknown>,
  ): Promise<void> {
    const open = this.world.view('graph').neighborsOf(from, { via: type });
    if (open.some((e) => e.id === to)) return;
    await this.world.relate({ from, type, to, attrs, source });
  }

  async syncLocations(
    locations: readonly Location[],
    at: string,
  ): Promise<number> {
    let changed = 0;
    for (const location of locations) {
      const { id, name, ...rest } = location;
      if (
        await this.upsertIfChanged('location', id, name, rest, {
          kind: 'manual',
          by: 'hazewatch-config',
          at,
        })
      )
        changed++;
    }
    return changed;
  }

  async syncSources(
    specs: readonly WatcherSpec[],
    at: string,
  ): Promise<number> {
    let changed = 0;
    for (const spec of specs) {
      const { id, name, ...rest } = spec.source;
      if (
        await this.upsertIfChanged(
          'source',
          id,
          name,
          {
            ...rest,
            watcherId: spec.id,
            freshnessMinutes: spec.freshnessMinutes,
          },
          { kind: 'manual', by: 'hazewatch-config', at },
        )
      )
        changed++;
    }
    return changed;
  }

  private archiveRaw(sha: string, raw: Buffer): void {
    const file = join(this.rawDir, `${sha}.json`);
    if (!existsSync(file)) writeFileSync(file, raw);
  }

  private async writeStation(
    station: StationDraft,
    source: WmProvenance,
  ): Promise<boolean> {
    const { stationId, name, ...rest } = station;
    const changed = await this.upsertIfChanged(
      'station',
      stationId,
      name,
      rest,
      source,
    );
    await this.relateOnce(
      entityId('station', stationId),
      'near',
      entityId('location', station.nearestLocationId),
      source,
      { distanceKm: station.distanceKm },
    );
    return changed;
  }

  /** Write one HazeOps run: archive raw bytes, pin evidence, then assert changed facts. */
  async writeAdapterResult(
    result: AdapterResult,
    runId: string,
  ): Promise<WriteSummary> {
    const summary: WriteSummary = {
      evidenceWritten: 0,
      factsWritten: 0,
      factsSkipped: 0,
      stationsWritten: 0,
      newestObservation: null,
    };
    const byEvidence = new Map<string, EvidenceRecord>();

    for (const { record, raw } of result.evidence) {
      byEvidence.set(record.evidenceId, record);
      this.archiveRaw(record.rawSha256, raw);
      const id = entityId('evidence', record.evidenceId);
      if (this.entity(id)) continue; // immutable: same bytes, same record
      const provenance: WmProvenance = {
        kind: 'api',
        by: 'hazeops',
        at: record.retrievedAt,
        url: record.locator.url,
        checksum: record.rawSha256,
        runId,
      };
      await this.world.upsertEntity({
        type: 'evidence',
        externalKey: { system: SYSTEM, id: record.evidenceId },
        name: record.title,
        attrs: record as unknown as Record<string, unknown>,
        source: provenance,
      });
      await this.relateOnce(
        id,
        'published_by',
        entityId('source', record.sourceId),
        provenance,
      );
      summary.evidenceWritten++;
    }

    for (const station of result.stations) {
      const record = [...byEvidence.values()][0];
      if (
        await this.writeStation(station, {
          kind: 'api',
          by: 'hazeops',
          at: record?.retrievedAt ?? new Date().toISOString(),
          runId,
        })
      )
        summary.stationsWritten++;
    }

    for (const draft of result.facts) {
      const record = byEvidence.get(draft.evidenceId);
      if (!record) continue;
      const about = entityId(draft.about.type, draft.about.id);
      const value = {
        ...draft.value,
        evidenceId: draft.evidenceId,
        dedupeKey: draft.dedupeKey ?? null,
      };
      const previous = this.factHistory(about, draft.predicate).at(-1);
      if (previous) {
        const prev = previous.value as Record<string, unknown>;
        const sameKey =
          draft.dedupeKey !== undefined && prev.dedupeKey === draft.dedupeKey;
        const sameValue =
          previous.assertedAt === draft.observedAt &&
          stable(withoutEvidence(prev)) === stable(withoutEvidence(value));
        if (sameKey || sameValue) {
          summary.factsSkipped++;
          continue;
        }
      }
      await this.world.assertFact({
        about,
        predicate: draft.predicate,
        value,
        source: {
          kind: record.sourceKind,
          by: 'hazeops',
          at: draft.observedAt,
          url: record.locator.url,
          checksum: record.rawSha256,
          runId,
        },
      });
      summary.factsWritten++;
      if (
        !summary.newestObservation ||
        draft.observedAt > summary.newestObservation
      ) {
        summary.newestObservation = draft.observedAt;
      }
    }
    return summary;
  }
}
