import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { streamSSE } from 'hono/streaming';
import type { AskRequest } from '../../../frontend/src/shared/types/agents.ts';
import type {
  HazeItem,
  Location,
  Source,
} from '../../../frontend/src/shared/types/domain.ts';
import type { EngineProvenanceSummary } from '../engines.ts';
import type { HazeOps } from '../hazeops/hazeops.ts';
import type { Manager } from '../manager/manager.ts';
import type { ChatMemory } from '../memory/memory.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { RunService } from '../runs/runs.ts';
import type { TaskService } from '../tasks/tasks.ts';
import { FALLBACK_LOCATION_ID } from '../locations.ts';
import { entityId, type HazeWorld } from '../world/hazeWorld.ts';
import { projectDetail } from '../world/projection.ts';

/**
 * HTTP + SSE API. Mirrors the frontend's DataService and AgentService contracts
 * (frontend/src/services). Spec §15.2's /health and /heartbeat/tick keep their names
 * under /api. SSE is a HazeWatch addition: the spec defines polling only.
 */

export interface AppDependencies {
  world: HazeWorld;
  hazeops: HazeOps;
  manager: Manager;
  runtime: Runtime;
  runs: RunService;
  tasks: TaskService;
  memory: ChatMemory;
  provenance: EngineProvenanceSummary[];
  snapshot: () => {
    items: HazeItem[];
    locations: Location[];
    sources: Source[];
  };
  onItemsChanged: (listener: (items: HazeItem[]) => void) => () => void;
  tick: () => string[];
  config: {
    coverage: string;
    sampleMode: boolean;
    operatorToken: string | null;
  };
  startedAt: string;
}

const KEEP_ALIVE_MS = 15_000;

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => {
    const watchers = deps.hazeops.watchers();
    return c.json({
      ok: true,
      service: 'hazewatch-server',
      startedAt: deps.startedAt,
      coverage: deps.config.coverage,
      sampleMode: deps.config.sampleMode,
      engines: deps.provenance,
      watchers: watchers.map(({ spec, state }) => ({
        id: spec.id,
        source: spec.source.name,
        enabled: state.enabled,
        disabledReason: state.disabledReason,
        lastOutcome: state.lastOutcome,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        nextDueAt: state.nextDueAt,
      })),
      agents: {
        manager: 'connected (coordinator in plain code, not an AI)',
        hazeops: 'connected',
        worldmodel: 'connected (pinned Meterless reference)',
        hmem: 'connected (pinned Meterless reference)',
        evidencecritic: 'not connected',
        workershield: 'not connected',
      },
    });
  });

  app.get('/api/snapshot', (c) => {
    const { items, locations, sources } = deps.snapshot();
    return c.json({
      items,
      locations,
      sources,
      asOf: new Date().toISOString(),
      fictional: false,
    });
  });

  app.get('/api/items/:id', (c) => {
    const { items, locations, sources } = deps.snapshot();
    const detail = projectDetail(items, c.req.param('id'), locations, sources);
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/evidence/:id', (c) => {
    const record = deps.world.evidence(c.req.param('id'));
    if (!record) return c.json({ error: 'not found' }, 404);
    const entity = deps.world.entity(entityId('evidence', record.evidenceId));
    return c.json({ record, provenance: entity?.source ?? null });
  });

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const unsubscribe = deps.onItemsChanged((items) => {
        void stream.writeSSE({
          event: 'upsert',
          data: JSON.stringify({
            kind: 'upsert',
            items,
            asOf: new Date().toISOString(),
          }),
        });
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ at: new Date().toISOString() }),
      });
      while (open) {
        await stream.sleep(KEEP_ALIVE_MS);
        if (open) await stream.writeSSE({ event: 'ping', data: '' });
      }
    }),
  );

  app.get('/api/hazeops/watchers', (c) => c.json(deps.hazeops.watchers()));
  app.get('/api/manager/assignments', (c) =>
    c.json(deps.manager.assignments()),
  );
  app.get('/api/runtime/jobs', (c) => c.json(deps.runtime.jobs()));

  // Spec §15.2: operator/service-only bounded scan.
  app.post('/api/heartbeat/tick', (c) => {
    const token = deps.config.operatorToken;
    if (token) {
      if (c.req.header('X-Operator-Token') !== token)
        return c.json({ error: 'operator token required' }, 401);
    } else {
      const address = getConnInfo(c).remote.address ?? '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
        return c.json(
          {
            error:
              'operator endpoint is loopback-only without HAZE_OPERATOR_TOKEN',
          },
          403,
        );
      }
    }
    return c.json({ admitted: deps.tick() }, 202);
  });

  app.post('/api/runs', async (c) => {
    const body = (await c.req
      .json()
      .catch(() => null)) as Partial<AskRequest> | null;
    const question =
      typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > 2000) {
      return c.json({ error: 'question must be 1–2000 characters' }, 400);
    }
    const runId = deps.runs.start({
      question,
      focusItemId:
        typeof body?.focusItemId === 'string' ? body.focusItemId : null,
    });
    return c.json({ runId, events: `/api/runs/${runId}/events` }, 202);
  });

  app.get('/api/runs/:id/events', (c) => {
    const id = c.req.param('id');
    if (!deps.runs.exists(id)) return c.json({ error: 'not found' }, 404);
    return streamSSE(c, async (stream) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      let seq = 0;
      const unsubscribe = deps.runs.subscribe(id, (message) => {
        seq += 1;
        void stream.writeSSE({
          id: String(seq),
          event: message.kind === 'answer' ? 'answer' : 'agent',
          data: JSON.stringify(
            message.kind === 'answer' ? message.answer : message.event,
          ),
        });
        if (
          message.kind === 'event' &&
          ['run_failed', 'run_cancelled'].includes(message.event.type)
        ) {
          resolveDone();
        }
        if (message.kind === 'answer') resolveDone();
      });
      stream.onAbort(() => {
        unsubscribe();
        resolveDone();
      });
      if (deps.runs.isDone(id)) resolveDone();
      await done;
      await stream.writeSSE({ event: 'end', data: '' });
    });
  });

  app.post('/api/runs/:id/cancel', (c) =>
    deps.runs.cancel(c.req.param('id'))
      ? c.body(null, 204)
      : c.json({ error: 'not running' }, 409),
  );

  // v0.14 §16: open a task report directly. Only scheduling and revenue recovery
  // requests are task kinds for now; anything else belongs in the chat (/api/runs).
  app.post('/api/tasks', async (c) => {
    const body = (await c.req
      .json()
      .catch(() => null)) as Partial<AskRequest> | null;
    const question =
      typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > 2000) {
      return c.json(
        {
          error: 'malformed_input',
          message: 'question must be 1–2000 characters',
        },
        400,
      );
    }
    const { items, locations } = deps.snapshot();
    const focusItemId =
      typeof body?.focusItemId === 'string' ? body.focusItemId : null;
    const framing = deps.manager.frame({ question, focusItemId }, locations, {
      focusLocationId: items.find((i) => i.id === focusItemId)?.locationId,
      fallbackLocationId: FALLBACK_LOCATION_ID,
    });
    if (framing.kind === 'general') {
      return c.json(
        {
          error: 'unsupported_capability',
          message:
            'Only scheduling and revenue recovery requests open a task report. Ask other questions in the chat (POST /api/runs).',
        },
        422,
      );
    }
    const task = deps.tasks.start({ ...framing, kind: framing.kind });
    return c.json({ ...task, events: `/api/tasks/${task.taskId}/events` }, 202);
  });

  app.get('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    if (!deps.tasks.exists(id)) return c.json({ error: 'not found' }, 404);
    const result = deps.tasks.result(id);
    return result
      ? c.json(result)
      : c.json({ taskId: id, state: 'running' }, 202);
  });

  app.get('/api/tasks/:id/events', (c) => {
    const id = c.req.param('id');
    if (!deps.tasks.exists(id)) return c.json({ error: 'not found' }, 404);
    return streamSSE(c, async (stream) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      let seq = 0;
      const unsubscribe = deps.tasks.subscribe(id, (event) => {
        seq += 1;
        void stream.writeSSE({
          id: String(seq),
          event: event.type,
          data: JSON.stringify(event),
        });
        if (event.type === 'result' || event.type === 'failed') resolveDone();
      });
      stream.onAbort(() => {
        unsubscribe();
        resolveDone();
      });
      if (deps.tasks.isDone(id)) resolveDone();
      await done;
      await stream.writeSSE({ event: 'end', data: '' });
    });
  });

  app.post('/api/tasks/:id/cancel', (c) =>
    deps.tasks.cancel(c.req.param('id'))
      ? c.body(null, 204)
      : c.json({ error: 'not running' }, 409),
  );

  app.post('/api/runs/:id/feedback', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      kind?: string;
    } | null;
    const kind = body?.kind;
    if (kind !== 'helpful' && kind !== 'not_helpful' && kind !== 'wrong') {
      return c.json(
        { error: 'kind must be helpful, not_helpful or wrong' },
        400,
      );
    }
    const memoryId = deps.runs.memoryIdFor(c.req.param('id'));
    if (!memoryId) return c.json({ error: 'no memory for this run' }, 404);
    deps.memory.feedback(memoryId, kind);
    return c.body(null, 204);
  });

  return app;
}
