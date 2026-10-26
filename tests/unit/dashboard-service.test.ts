import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import type { Source } from '../../app/contracts/dashboard.js';
import type { EvidenceRecord } from '../../app/capabilities/evidence-collection/types.js';
import { pinEvidence } from '../../app/capabilities/evidence-collection/evidence.js';
import {
  DashboardService,
  type DashboardWorld,
} from '../../app/dashboard/http.js';
import type { WmEntity, WmFact } from '../../app/world/types.js';

const observedAt = '2026-10-24T12:00:00.000Z';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function retainedWorld() {
  const source: Source = {
    id: 'task-source',
    name: 'Source retained by a task',
    kind: 'forecast_model',
    evidenceKind: 'modeled',
    organisation: 'Test fixture',
    cadence: 'hourly',
    licenceNote: 'Synthetic test data',
    reliabilityNote: 'No scientific readiness',
    url: 'https://example.invalid/source',
  };
  const { record } = pinEvidence({
    raw: Buffer.from('{"pm25":12}'),
    sourceId: source.id,
    sourceKind: 'modeled',
    upstream: { system: 'test', id: 'one' },
    title: 'Exact retained evidence',
    sourceOwner: 'Test fixture',
    locator: { kind: 'data', url: source.url, selection: 'Klang' },
    pollutant: 'pm25',
    unit: 'µg/m³',
    issuedAt: null,
    issuedAtReason: 'Test fixture',
    validInterval: null,
    retrievedAt: observedAt,
    nativeTemporalResolution: 'hourly',
    spatialSupport: 'model cell',
    licenceRef: 'Test fixture',
    permittedUses: ['offline test'],
    limitations: ['Synthetic test fixture'],
    coverageChecks: [],
  });
  const entity = (
    type: string,
    id: string,
    attrs: Record<string, unknown>,
    name: string,
  ): WmEntity => ({
    type,
    id: `${type}:haze:${id}`,
    name,
    attrs,
    source: { kind: 'manual', at: observedAt },
    createdAt: observedAt,
    updatedAt: observedAt,
    aliases: [],
    state: 'active',
  });
  const entities = [
    entity(
      'location',
      'klang',
      {
        region: 'Southeast Asia',
        country: 'Malaysia',
        countryCode: 'MY',
        lat: 3.03,
        lon: 101.45,
        timeZone: 'Asia/Kuala_Lumpur',
        aqiStandard: 'Malaysia API',
        populationBand: 'large',
      },
      'Klang',
    ),
    entity('source', source.id, { ...source }, source.name),
    entity('evidence', record.evidenceId, { ...record }, record.title),
  ];
  const listeners = new Set<(fact: WmFact) => void>();
  const history: WmFact[] = [
    {
      id: 'fact-one',
      about: 'location:haze:klang',
      predicate: 'pm25_modeled',
      value: {
        value: 12,
        evidenceId: record.evidenceId,
        gridLat: 3,
        gridLon: 101.5,
      },
      confidence: 1,
      source: { kind: 'modeled', at: observedAt },
      assertedAt: observedAt,
    },
  ];
  const world: DashboardWorld = {
    entity: (id) => entities.find((value) => value.id === id),
    entities: (type) => entities.filter((value) => value.type === type),
    evidence: (id): EvidenceRecord | null =>
      id === record.evidenceId ? record : null,
    *facts() {
      yield {
        about: history[0]!.about,
        predicate: history[0]!.predicate,
        history,
      };
    },
    onFact(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { world, source, record, history, listeners };
}

function dashboard() {
  const retained = retainedWorld();
  let currentTime = new Date('2026-10-24T13:00:00.000Z');
  const tickKeys: (string | undefined)[] = [];
  const service = new DashboardService({
    world: retained.world,
    mode: 'fixture',
    config: {
      coverage: 'asean',
      sampleMode: true,
      operatorToken: 'test-token',
    },
    clock: () => currentTime,
    hazeops: {
      specs: () => [],
      watchers: () => [],
      lastRunMs: () => new Map(),
      jobs: () => [],
      tick: (key) => {
        tickKeys.push(key);
        return ['watcher-one'];
      },
    },
  });
  cleanups.push(() => service.close());
  return {
    ...retained,
    service,
    tickKeys,
    setTime: (time: string) => {
      currentTime = new Date(time);
    },
  };
}

it('shows retained task sources and observations without a configured watcher', () => {
  const { service, source, record } = dashboard();
  const view = service.snapshot();
  expect(view.sources).toEqual([source]);
  expect(view.items).toHaveLength(1);
  expect(view.items[0]).toMatchObject({
    id: 'hz-modeled-klang',
    fictional: true,
    status: 'partial',
    measurements: [
      { pollutant: 'pm25', value: 12 },
      { pollutant: 'pm10', value: null },
    ],
    tags: ['synthetic', 'modeled', 'cams'],
  });
  expect(service.detail('hz-modeled-klang')?.sources).toEqual([source]);
  expect(service.evidence(record.evidenceId)?.record.rawSha256).toBe(
    record.rawSha256,
  );
});

it('publishes stale status without changing or recollecting the retained observation', () => {
  const { service, setTime, history, listeners } = dashboard();
  const changes: unknown[] = [];
  service.subscribe((change) => changes.push(change));
  setTime('2026-10-24T16:00:00.000Z');
  service.publishChanges();
  expect(service.snapshot().items[0]?.status).toBe('stale');
  expect(changes).toHaveLength(1);
  expect(history).toHaveLength(1);
  service.close();
  expect(listeners.size).toBe(0);
});

it('labels fixture collection values explicitly without atmospheric model claims', () => {
  const { service, history, record } = dashboard();
  history[0]!.predicate = 'fixture.pm25';
  history[0]!.value = {
    pm25: 3,
    evidenceId: record.evidenceId,
  };
  const item = service.snapshot().items[0];
  expect(item).toMatchObject({
    id: 'hz-fixture-klang',
    fictional: true,
    headline: 'Synthetic PM2.5 fixture for Klang',
    tags: ['synthetic', 'fixture'],
  });
  expect(JSON.stringify(item)).not.toContain('CAMS');
  expect(item?.details).toContain(
    'It is not an observation, forecast or atmospheric model result and establishes no live or scientific readiness.',
  );
});

it('serves the shared backend and gives old report pages actionable retirement events', async () => {
  const { service, tickKeys } = dashboard();
  const server = createServer((request, response) => {
    void service
      .handle(
        request,
        response,
        new URL(request.url ?? '/', 'http://localhost'),
      )
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(async () => {
    service.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No local server');
  const origin = `http://127.0.0.1:${address.port}`;
  const health = (await fetch(`${origin}/api/health`).then((value) =>
    value.json(),
  )) as { worldModel: unknown };
  expect(health.worldModel).toEqual({ backend: 'sqlite', shared: true });
  const retired = await fetch(`${origin}/api/reports/task_old/events`);
  expect(await retired.text()).toContain('event: failed');
  expect((await fetch(`${origin}/api/runs`, { method: 'POST' })).status).toBe(
    410,
  );
  const headers = { 'idempotency-key': 'tick-once' };
  expect(
    (await fetch(`${origin}/api/heartbeat/tick`, { method: 'POST', headers }))
      .status,
  ).toBe(401);
  const tick = await fetch(`${origin}/api/heartbeat/tick`, {
    method: 'POST',
    headers: { ...headers, 'x-operator-token': 'test-token' },
  });
  expect(tick.status).toBe(202);
  expect(tickKeys).toEqual(['tick-once']);
  expect(
    (await fetch(`${origin}/api/snapshot`, { method: 'POST' })).status,
  ).toBe(405);
});
