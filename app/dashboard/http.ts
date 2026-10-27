import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  DataSnapshot,
  ItemDetail,
  LiveUpdate,
} from '../contracts/dashboard.js';
import type { ExecutionMode } from '../orchestration/ports.js';
import type { WatcherSpec } from '../capabilities/evidence-collection/types.js';
import { entityId, type HazeWorld } from '../world/haze-world.js';
import { createLiveUpdateTracker } from './live-updates.js';
import {
  projectDetail,
  projectItems,
  projectLocations,
  projectSources,
} from './projection.js';

export type DashboardWorld = Pick<
  HazeWorld,
  'entity' | 'entities' | 'evidence' | 'facts' | 'onFact'
>;

export interface DashboardHazeOps {
  specs(): WatcherSpec[];
  watchers(): readonly { spec: WatcherSpec; state: unknown }[];
  lastRunMs(): Map<string, number>;
  jobs(): unknown[];
  status?(): {
    scheduler: 'running' | 'starting' | 'disabled' | 'stopped';
    reason: string | null;
  };
  tick(key?: string): string[] | Promise<string[]>;
}

export interface DashboardOptions {
  world: DashboardWorld;
  hazeops: DashboardHazeOps;
  config: {
    coverage: string;
    sampleMode: boolean;
    operatorToken?: string | null;
  };
  mode: ExecutionMode;
  clock?: () => Date;
  assignments?: () => unknown[];
}

const KEEP_ALIVE_MS = 15_000;
const STATUS_RECHECK_MS = 30_000;
const CHANGE_DEBOUNCE_MS = 50;
const retiredMessage =
  'Dashboard template runs and reports have moved to the general task engine. Start a new task through POST /api/tasks using haze.task.request.v3. Historical dashboard reports were process-memory records. Saved dashboard evidence can be imported through the explicit dashboard-state migration.';

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

/** Dashboard views and streams over the same World Model used by agent tasks. */
export class DashboardService {
  private readonly clock: () => Date;
  private readonly startedAt: string;
  private readonly listeners = new Set<(update: LiveUpdate) => void>();
  private readonly streams = new Set<() => void>();
  private readonly trackUpdates: ReturnType<typeof createLiveUpdateTracker>;
  private readonly unsubscribeWorld: () => void;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private readonly options: DashboardOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.startedAt = this.clock().toISOString();
    this.trackUpdates = createLiveUpdateTracker(this.snapshot(), this.clock);
    this.unsubscribeWorld = options.world.onFact(() => {
      if (this.closed || this.pending) return;
      this.pending = setTimeout(() => {
        this.pending = undefined;
        this.publishChanges();
      }, CHANGE_DEBOUNCE_MS);
      this.pending.unref();
    });
  }

  start(): void {
    if (this.closed || this.refreshTimer) return;
    // Freshness changes even when no collection or task writes a new observation.
    this.refreshTimer = setInterval(
      () => this.publishChanges(),
      STATUS_RECHECK_MS,
    );
    this.refreshTimer.unref();
  }

  snapshot(): DataSnapshot {
    const { world, hazeops, mode } = this.options;
    const specs = hazeops.specs();
    const now = this.clock();
    const fictional = mode === 'fixture';
    return {
      items: projectItems({
        world,
        specsBySource: new Map(specs.map((spec) => [spec.source.id, spec])),
        lastRunMs: hazeops.lastRunMs(),
        now,
        fictional,
      }),
      locations: projectLocations(world),
      sources: projectSources(specs, world),
      asOf: now.toISOString(),
      fictional,
    };
  }

  detail(id: string): ItemDetail | null {
    const { items, locations, sources } = this.snapshot();
    return projectDetail(items, id, locations, sources);
  }

  evidence(id: string) {
    const record = this.options.world.evidence(id);
    if (!record) return null;
    const entity = this.options.world.entity(entityId('evidence', id));
    return { record, provenance: entity?.source ?? null };
  }

  subscribe(listener: (update: LiveUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishChanges(): void {
    if (this.closed) return;
    const update = this.trackUpdates(this.snapshot());
    if (update) for (const listener of this.listeners) listener(update);
  }

  private openStream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    let blocked = false;
    let needsReset = false;
    let helloPending = true;
    let stopped = false;
    const write = (event: string, data: unknown) => {
      if (stopped || response.destroyed || response.writableEnded) return;
      blocked = !response.write(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    };
    const unsubscribe = this.subscribe((update) => {
      if (blocked) {
        // A slow client receives one coherent replacement after draining.
        needsReset = true;
        return;
      }
      write(update.kind, update);
    });
    const onDrain = () => {
      blocked = false;
      if (helloPending) {
        helloPending = false;
        write('hello', { at: this.clock().toISOString() });
      }
      if (!needsReset || blocked) return;
      needsReset = false;
      write('reset', { kind: 'reset', snapshot: this.snapshot() });
    };
    response.on('drain', onDrain);
    const heartbeat = setInterval(() => {
      if (!blocked) write('ping', '');
    }, KEEP_ALIVE_MS);
    heartbeat.unref();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(stop);
      response.off('drain', onDrain);
      response.off('close', stop);
      response.off('error', stop);
      request.off('aborted', stop);
      if (!response.writableEnded) response.end();
    };
    this.streams.add(stop);
    response.on('close', stop);
    response.on('error', stop);
    request.on('aborted', stop);
    write('reset', { kind: 'reset', snapshot: this.snapshot() });
    if (!blocked) {
      helloPending = false;
      write('hello', { at: this.clock().toISOString() });
    }
  }

  /** Called after the common local/same-origin authorization boundary. */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    if (/^\/api\/(?:runs|reports)(?:\/|$)/.test(path)) {
      response.setHeader('Link', '</api/tasks>; rel="successor-version"');
      if (
        request.method === 'GET' &&
        /^\/api\/reports\/[^/]+\/events$/.test(path)
      ) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(
          `event: failed\ndata: ${JSON.stringify({ type: 'failed', error: retiredMessage })}\n\nevent: end\ndata: {}\n\n`,
        );
      } else {
        send(response, 410, {
          error: {
            code: 'dashboard_protocol_retired',
            message: retiredMessage,
          },
          successor: '/api/tasks',
          schema_version: 'haze.task.request.v3',
        });
      }
      return true;
    }
    const item = /^\/api\/items\/([^/]+)$/.exec(path);
    const evidence = /^\/api\/evidence\/([^/]+)$/.exec(path);
    const known = [
      '/api/health',
      '/api/snapshot',
      '/api/stream',
      '/api/hazeops/watchers',
      '/api/runtime/jobs',
      '/api/manager/assignments',
      '/api/heartbeat/tick',
    ].includes(path);
    if (!known && !item && !evidence) return false;
    const expectedMethod = path === '/api/heartbeat/tick' ? 'POST' : 'GET';
    if (request.method !== expectedMethod) {
      response.setHeader('Allow', expectedMethod);
      send(response, 405, {
        error: { code: 'method_not_allowed', message: 'Method not allowed.' },
      });
      return true;
    }
    if (path === '/api/health') {
      const { config, hazeops, mode } = this.options;
      send(response, 200, {
        ok: true,
        service: 'haze-app',
        startedAt: this.startedAt,
        coverage: config.coverage,
        sampleMode: config.sampleMode,
        mode,
        engines: [],
        worldModel: { backend: 'sqlite', shared: true },
        watchers: hazeops.watchers().map(({ spec, state }) => ({
          ...(state && typeof state === 'object' ? state : {}),
          id: spec.id,
          source: spec.source.name,
        })),
        hazeops: hazeops.status?.() ?? null,
        agents: {
          manager: 'registered in task engine',
          hazeops: 'registered; shared collector and watchers',
          worldmodel: 'shared SQLite World Model',
          hmem: 'not enabled; dashboard memory remains archival',
          evidencecritic:
            'registered in task engine; collection remains unreviewed',
          workershield: 'registered in task engine',
        },
      });
    } else if (path === '/api/snapshot') {
      send(response, 200, this.snapshot());
    } else if (item || evidence) {
      let id: string;
      try {
        id = decodeURIComponent((item ?? evidence)![1]!);
      } catch {
        send(response, 400, {
          error: { code: 'invalid_id', message: 'Invalid record ID.' },
        });
        return true;
      }
      const detail = item ? this.detail(id) : this.evidence(id);
      send(response, detail ? 200 : 404, detail ?? { error: 'not found' });
    } else if (path === '/api/stream') {
      this.openStream(request, response);
    } else if (path === '/api/hazeops/watchers') {
      send(response, 200, this.options.hazeops.watchers());
    } else if (path === '/api/runtime/jobs') {
      send(response, 200, this.options.hazeops.jobs());
    } else if (path === '/api/manager/assignments') {
      send(response, 200, this.options.assignments?.() ?? []);
    } else if (path === '/api/heartbeat/tick') {
      const token = this.options.config.operatorToken;
      if (token && request.headers['x-operator-token'] !== token) {
        send(response, 401, { error: 'operator token required' });
        return true;
      }
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string') {
        send(response, 400, { error: 'Idempotency-Key required' });
        return true;
      }
      send(response, 202, { admitted: await this.options.hazeops.tick(key) });
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeWorld();
    if (this.pending) clearTimeout(this.pending);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const stop of this.streams) stop();
    this.listeners.clear();
  }
}
