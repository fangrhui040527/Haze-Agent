import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import { HazeWorld, entityId } from '../../app/world/haze-world.js';
import { migrateDashboardState } from '../../app/world/migrate-dashboard.js';
import { createFixtureCollectionAdapter } from '../../app/capabilities/evidence-collection/fixtures.js';
import { pinEvidence } from '../../app/capabilities/evidence-collection/evidence.js';
import {
  collectionCaptureSchema,
  type EvidenceCollectionScope,
} from '../../app/capabilities/evidence-collection/contracts.js';
import type { AdapterResult } from '../../app/capabilities/evidence-collection/types.js';
import type { JsonValue } from '../../app/contracts/artifacts.js';
import { taskRequestSchema } from '../../app/contracts/tasks.js';

const identity = { principal: 'haze-world-user', workspace: 'shared-world' };
const at = '2026-10-24T12:00:00.000Z';
const scope: EvidenceCollectionScope = {
  capability: 'evidence-collection',
  provider: 'open-meteo',
  locations: [
    {
      id: 'klang',
      name: 'Klang',
      country: 'Malaysia',
      countryCode: 'MY',
      region: 'Southeast Asia',
      lat: 3,
      lon: 101,
      timeZone: 'Asia/Kuala_Lumpur',
      aqiStandard: 'Malaysia API',
      populationBand: 'large',
    },
  ],
};
const directories: string[] = [];
const stores: TaskStore[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'haze-shared-world-'));
  directories.push(path);
  return path;
}
function setup() {
  const path = directory();
  const store = new TaskStore(path, { recover: false });
  stores.push(store);
  return { path, store, world: new HazeWorld(store, identity, 'fixture') };
}
async function collected() {
  const adapter = createFixtureCollectionAdapter(scope);
  const result = await adapter.run({
    now: new Date(at),
    signal: new AbortController().signal,
    runId: 'fixture',
  });
  return { adapter, result };
}
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const path of directories.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    if (!rel || rel.startsWith('..'))
      throw new Error('Unsafe test cleanup target.');
    rmSync(path, { recursive: true, force: true });
  }
});

describe('one shared dashboard and task World Model', () => {
  it('retains watcher evidence in SQLite and exposes it to scoped task lookup after restart', async () => {
    const { path, store, world } = setup();
    const { adapter, result } = await collected();
    await world.syncLocations(scope.locations, at);
    await world.syncSources([adapter.spec], at);
    const seen: string[] = [];
    world.onFact((fact) => seen.push(fact.id));
    expect(await world.writeAdapterResult(result, 'watcher-run')).toMatchObject(
      { evidenceWritten: 1, factsWritten: 1 },
    );
    expect(seen).toHaveLength(1);
    const evidence = result.evidence[0]!;
    expect(world.rawEvidence(evidence.record.evidenceId)).toEqual(evidence.raw);
    const records = store.world.lookup(
      { ...identity, mode: 'fixture' },
      { kind: 'haze_fact', limit: 10 },
    );
    expect(records).toHaveLength(1);
    expect(
      store.world.context({ ...identity, mode: 'fixture' }, records[0]!.ref.id)
        ?.support_artifacts,
    ).toHaveLength(1);
    expect(
      store.world.lookup(
        { ...identity, mode: 'live' },
        { kind: 'haze_fact', limit: 10 },
      ),
    ).toEqual([]);
    expect(
      store.world.acceptancesForRecord(
        { ...identity, mode: 'fixture' },
        records[0]!.ref.id,
      ),
    ).toEqual([]);
    const task = store.admit(
      taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective: 'Read the retained source.',
      }),
      identity,
      'consumer',
      { mode: 'fixture' },
    ).task;
    expect(
      store.worldLookup(task.id, identity, 'fixture', {
        kind: 'haze_fact',
        limit: 10,
      }).records,
    ).toHaveLength(1);
    store.close();
    const reopened = new TaskStore(path, { recover: false });
    stores.push(reopened);
    const view = new HazeWorld(reopened, identity, 'fixture');
    expect(
      view.factHistory(entityId('location', 'klang'), 'fixture.pm25'),
    ).toHaveLength(1);
    expect(view.rawEvidence(evidence.record.evidenceId)).toEqual(evidence.raw);
    expect(await view.writeAdapterResult(result, 'retry')).toMatchObject({
      evidenceWritten: 0,
      factsWritten: 0,
      factsSkipped: 1,
    });
  });

  it('automatically normalizes task collection captures for the same dashboard view', async () => {
    const { store, world } = setup();
    const { adapter, result } = await collected();
    const capture = collectionCaptureSchema.parse({
      schema_version: 'haze.evidence.collection.capture.v1',
      mode: 'fixture',
      evidence_origin: 'synthetic_fixture',
      scope,
      collected_at: at,
      source: adapter.spec.source,
      selection: {
        query: adapter.spec.query,
        place_selector: adapter.spec.placeSelector,
        time_selector: adapter.spec.timeSelector,
      },
      evidence: result.evidence.map(({ record, raw }) => ({
        record,
        raw_base64: raw.toString('base64'),
      })),
      stations: result.stations,
      facts: result.facts,
      coverage: result.coverage,
    });
    const task = store.admit(
      taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective: 'Collect evidence.',
      }),
      identity,
      'collector',
      { mode: 'fixture', tools: ['haze-evidence-collect'] },
    ).task;
    const seen: string[] = [];
    world.onFact((fact) => seen.push(fact.id));
    const artifact = store.saveArtifact(task.id, identity, {
      kind: 'evidence.collection.capture',
      content: capture as JsonValue,
      producer: { kind: 'service', id: 'collection-test' },
      generation: 1,
      evidence_origin: 'synthetic_fixture',
    });
    expect(world.entities('location')[0]?.name).toBe('Klang');
    expect(
      world.factHistory(entityId('location', 'klang'), 'fixture.pm25'),
    ).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(world.rawEvidence(result.evidence[0]!.record.evidenceId)).toEqual(
      result.evidence[0]!.raw,
    );
    const fact = store.world.lookup(
      { ...identity, mode: 'fixture' },
      { kind: 'haze_fact', limit: 1 },
    )[0]!;
    expect(
      store.world.context({ ...identity, mode: 'fixture' }, fact.ref.id)
        ?.support_artifacts,
    ).toEqual([
      { id: artifact.id, version: artifact.version, sha256: artifact.sha256 },
    ]);
    const before = store.db
      .prepare('SELECT COUNT(*) AS count FROM artifacts')
      .get();
    const invalid = structuredClone(capture);
    invalid.evidence[0]!.raw_base64 = Buffer.from('changed').toString('base64');
    expect(() =>
      store.saveArtifact(task.id, identity, {
        kind: 'evidence.collection.capture',
        content: invalid as JsonValue,
        producer: { kind: 'service', id: 'collection-test' },
        generation: 1,
        evidence_origin: 'synthetic_fixture',
      }),
    ).toThrow('pinned evidence record');
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM artifacts').get(),
    ).toEqual(before);
    expect(seen).toHaveLength(1);
  });

  it('rolls back artifacts, facts and notifications when any collection fact is invalid', async () => {
    const { store, world } = setup();
    const { result } = await collected();
    await world.syncLocations(scope.locations, at);
    result.facts.push({
      ...result.facts[0]!,
      about: { type: 'location', id: 'missing' },
    });
    const seen: string[] = [];
    world.onFact((fact) => seen.push(fact.id));
    await expect(world.writeAdapterResult(result, 'invalid')).rejects.toThrow(
      'not registered',
    );
    expect(world.entities('evidence')).toEqual([]);
    expect([...world.facts()]).toEqual([]);
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM artifacts').get(),
    ).toEqual({ count: 0 });
    expect(seen).toEqual([]);
  });

  it('chunks raw watcher material above the task artifact bound and reconstructs exact bytes', async () => {
    const { store, world } = setup();
    const { result } = await collected();
    const original = result.evidence[0]!.record;
    const raw = Buffer.alloc(1_200_000, 65);
    const large = pinEvidence({
      raw,
      coverageChecks: [],
      upstream: original.upstream,
      sourceId: original.sourceId,
      sourceKind: original.sourceKind,
      title: original.title,
      sourceOwner: original.sourceOwner,
      locator: original.locator,
      pollutant: original.pollutant,
      unit: original.unit,
      issuedAt: original.issuedAt,
      issuedAtReason: original.issuedAtReason,
      validInterval: original.validInterval,
      retrievedAt: original.retrievedAt,
      nativeTemporalResolution: original.nativeTemporalResolution,
      spatialSupport: original.spatialSupport,
      licenceRef: original.licenceRef,
      permittedUses: original.permittedUses,
      limitations: original.limitations,
    });
    const largeResult: AdapterResult = {
      evidence: [large],
      stations: [],
      facts: [],
      coverage: result.coverage,
    };
    await world.writeAdapterResult(largeResult, 'large');
    expect(world.rawEvidence(large.record.evidenceId)).toEqual(raw);
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM artifacts WHERE json_extract(body,'$.kind')='haze.evidence.raw.chunk'",
        )
        .get(),
    ).toEqual({ count: 5 });
  });
});

describe('explicit legacy dashboard migration', () => {
  async function archive() {
    const path = directory();
    const { result } = await collected();
    const evidence = result.evidence[0]!;
    const source = { kind: 'manual', by: 'legacy-config', at };
    const location = {
      type: 'location',
      id: entityId('location', 'klang'),
      name: 'Klang',
      attrs: { lat: 3, lon: 101 },
      source,
      createdAt: at,
      updatedAt: at,
      aliases: ['Klang'],
      state: 'active',
    };
    const record = {
      type: 'evidence',
      id: entityId('evidence', evidence.record.evidenceId),
      name: evidence.record.title,
      attrs: evidence.record,
      source: { kind: 'api', at },
      createdAt: at,
      updatedAt: at,
      aliases: [],
      state: 'active',
    };
    const fact = {
      id: 'legacy-fact-1',
      about: location.id,
      predicate: 'fixture.pm25',
      value: { pm25: 1, evidenceId: evidence.record.evidenceId },
      confidence: 0.7,
      source: { kind: 'modeled', at },
      assertedAt: at,
    };
    const content = JSON.stringify({
      events: [
        { kind: 'upsertEntity', payload: location },
        { kind: 'upsertEntity', payload: record },
        { kind: 'assertFact', payload: fact },
      ],
    });
    mkdirSync(join(path, 'world', '.world'), { recursive: true });
    mkdirSync(join(path, 'raw'));
    writeFileSync(join(path, 'world', '.world', 'haze.json'), content);
    writeFileSync(
      join(path, 'raw', `${evidence.record.rawSha256}.json`),
      evidence.raw,
    );
    return { path, content, evidence, fact };
  }

  it('preserves original evidence, fact identity and provenance, and is replay-safe', async () => {
    const target = setup();
    const legacy = await archive();
    expect(
      migrateDashboardState(target.store, legacy.path, identity, 'fixture'),
    ).toMatchObject({ entities: 2, facts: 1, evidence: 1, reused: false });
    expect(
      target.world.factHistory(legacy.fact.about, legacy.fact.predicate)[0],
    ).toEqual(legacy.fact);
    expect(target.world.rawEvidence(legacy.evidence.record.evidenceId)).toEqual(
      legacy.evidence.raw,
    );
    expect(
      await target.world.writeAdapterResult(
        (await collected()).result,
        'after-migration',
      ),
    ).toMatchObject({ factsWritten: 0, factsSkipped: 1 });
    expect(
      target.world.factHistory(legacy.fact.about, legacy.fact.predicate),
    ).toHaveLength(1);
    const count = target.store.world.events({
      ...identity,
      mode: 'fixture',
    }).length;
    expect(
      migrateDashboardState(target.store, legacy.path, identity, 'fixture')
        .reused,
    ).toBe(true);
    expect(
      target.store.world.events({ ...identity, mode: 'fixture' }),
    ).toHaveLength(count);
    expect(
      readFileSync(join(legacy.path, 'world', '.world', 'haze.json'), 'utf8'),
    ).toBe(legacy.content);
  });

  it('fails preflight for changed or missing original bytes without importing records', async () => {
    const target = setup();
    const legacy = await archive();
    const rawFile = join(
      legacy.path,
      'raw',
      `${legacy.evidence.record.rawSha256}.json`,
    );
    writeFileSync(rawFile, 'changed bytes');
    expect(() =>
      migrateDashboardState(target.store, legacy.path, identity, 'fixture'),
    ).toThrow('pinned raw bytes');
    expect(target.world.entities('location')).toEqual([]);
    rmSync(rawFile);
    expect(() =>
      migrateDashboardState(target.store, legacy.path, identity, 'fixture'),
    ).toThrow('ENOENT');
    expect(target.store.world.events({ ...identity, mode: 'fixture' })).toEqual(
      [],
    );
  });
});
