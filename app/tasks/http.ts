import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseContractJson } from '../contracts/json.js';
import { TaskError, type TaskIdentity } from '../contracts/tasks.js';
import {
  worldApiBrowseQuerySchema,
  worldApiRecordParamsSchema,
  worldApiRecordReadQuerySchema,
  worldRecordHistoryResponseSchema,
  worldRecordLineageResponseSchema,
  worldRecordReadResponseSchema,
  worldTaskResponseSchema,
  worldProjectionRebuildRequestSchema,
} from '../contracts/world-api.js';
import { worldLineageInputSchema } from '../contracts/world-services.js';
import {
  createDashboardServices,
  createExecutionRegistry,
  createModelRouteRegistry,
  createManagerConversation,
  createNightshiftJobAdapter,
} from '../composition.js';
import {
  TaskRuntime,
  localTaskIdentity,
  type TaskRuntimeOptions,
} from './runtime.js';
import { browseWorldRecords } from './world-control-plane.js';
import { handleNightshiftHttp } from './nightshift-http.js';
import {
  createNightshiftReleasePolicy,
  currentReleaseBindings,
} from './nightshift-release.js';

const loopback = (value: string | undefined) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value ?? '');
const localHost = (value: string) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(value);
function authorize(request: IncomingMessage): {
  url: URL;
  identity: TaskIdentity;
} {
  if (!loopback(request.socket.remoteAddress))
    throw new TaskError(
      403,
      'local_only',
      'This API is available only on this computer.',
    );
  let url: URL;
  try {
    const host = new URL(`http://${request.headers.host ?? ''}`);
    if (
      !localHost(host.hostname) ||
      host.pathname !== '/' ||
      host.username ||
      host.password
    )
      throw new Error();
    url = new URL(request.url ?? '/', host);
    if (url.host !== host.host) throw new Error();
  } catch {
    throw new TaskError(403, 'local_only', 'Use a localhost address.');
  }
  if (
    request.headers['sec-fetch-site'] === 'cross-site' ||
    (request.headers.origin !== undefined &&
      request.headers.origin !== url.origin) ||
    (request.method === 'POST' && request.headers.origin !== url.origin)
  )
    throw new TaskError(
      403,
      'same_origin_required',
      'Origin must match this local application.',
    );
  return { url, identity: localTaskIdentity };
}
async function readBody(
  request: IncomingMessage,
  maximum: number,
): Promise<unknown> {
  if (
    request.headers['content-type']?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new TaskError(415, 'json_required', 'Send application/json.');
  const length = Number(request.headers['content-length'] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum)
    throw new TaskError(
      413,
      'request_too_large',
      'Request exceeds its bounded byte limit.',
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const data of request) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
    bytes += chunk.length;
    if (bytes > maximum)
      throw new TaskError(
        413,
        'request_too_large',
        'Request exceeds its bounded byte limit.',
      );
    chunks.push(chunk);
  }
  try {
    return parseContractJson(Buffer.concat(chunks).toString('utf8'), maximum);
  } catch {
    throw new TaskError(
      400,
      'invalid_json',
      'JSON must be valid and contain no duplicate keys.',
    );
  }
}
function idempotencyKey(request: IncomingMessage): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key))
    throw new TaskError(
      400,
      'idempotency_key_required',
      'Provide a bounded Idempotency-Key header for every mutation.',
    );
  return key;
}
export function createTaskHandler(
  options: Omit<TaskRuntimeOptions, 'registry'> & {
    registry?: TaskRuntimeOptions['registry'];
  },
) {
  const modelRoutes =
    options.modelRoutes ?? createModelRouteRegistry(options.env ?? process.env);
  const nightshiftJobs =
    options.nightshiftJobs ??
    createNightshiftJobAdapter(options.env ?? process.env);
  const registry =
    options.registry ??
    createExecutionRegistry({
      mode: options.mode ?? 'live',
      ...(options.env ? { env: options.env } : {}),
    });
  const runtime = new TaskRuntime({
    ...options,
    conversationFactory:
      options.conversationFactory ?? createManagerConversation,
    modelRoutes,
    nightshiftJobs,
    registry,
    // Live servers load release evidence from their own state directory only.
    ...(options.nightshiftAutomaticRelease || (options.mode ?? 'live') !== 'live'
      ? {}
      : {
          nightshiftAutomaticRelease: createNightshiftReleasePolicy({
            stateDirectory: options.stateDirectory,
            bindings: () =>
              currentReleaseBindings({
                registry,
                modelRoutes,
                nightshiftJobs,
                signal: AbortSignal.timeout(8_000),
              }),
          }),
        }),
  });
  let dashboard: ReturnType<typeof createDashboardServices> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify(data));
    };
    const handle = async () => {
      if (closed)
        throw new TaskError(
          503,
          'runtime_closed',
          'The application is closing.',
        );
      const { url, identity } = authorize(request);
      if (url.pathname === '/api/manager/chat') {
        if (request.method !== 'POST')
          throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
        if (url.searchParams.size)
          throw new TaskError(
            400,
            'invalid_query',
            'Chat accepts no query parameters.',
          );
        const key = idempotencyKey(request);
        send(
          200,
          await runtime.managerChat(
            await readBody(request, 65536),
            key,
            identity,
          ),
        );
        return;
      }
      if (runtime.handlesExtensionHttp(url.pathname)) {
        const mutation = request.method === 'POST';
        const handled = runtime.handleExtensionHttp({
          method: request.method ?? 'GET',
          pathname: url.pathname,
          query: url.searchParams,
          body: mutation ? await readBody(request, 65536) : undefined,
          ...(mutation ? { key: idempotencyKey(request) } : {}),
          identity,
        });
        send(handled.status, handled.body);
        return;
      }
      if (url.pathname === '/api/nightshift/readiness') {
        if (request.method !== 'GET')
          throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
        if (url.searchParams.size > 0)
          throw new TaskError(400, 'invalid_query', 'Unsupported query key.');
        send(200, await runtime.modelReadiness(identity));
        return;
      }
      if (
        await handleNightshiftHttp({
          request,
          url,
          identity,
          service: runtime.nightshift,
          externalWaitView: (id, owner) =>
            runtime.store.externalWaits.view(id, owner),
          readBody,
          idempotencyKey,
          send,
        })
      )
        return;
      if (
        /^\/api\/(?:health|snapshot|items|evidence|stream|hazeops|manager|runtime|heartbeat|runs|reports)(?:\/|$)/.test(
          url.pathname,
        )
      ) {
        if (
          url.pathname === '/api/heartbeat/tick' &&
          request.method === 'POST'
        ) {
          idempotencyKey(request);
          const body = await readBody(request, 1024);
          if (
            body === null ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).length !== 0
          )
            throw new TaskError(
              400,
              'invalid_heartbeat',
              'Heartbeat expects an empty JSON object.',
            );
        }
        if (closed)
          throw new TaskError(
            503,
            'runtime_closed',
            'The application is closing.',
          );
        dashboard ??= createDashboardServices({
          store: runtime.store,
          identity,
          mode: runtime.executionMode,
          env: options.env ?? {},
        });
        await dashboard.hazeops.ready;
        if (closed)
          throw new TaskError(
            503,
            'runtime_closed',
            'The application is closing.',
          );
        dashboard.view.start();
        dashboard.hazeops.start();
        if (await dashboard.view.handle(request, response, url)) return;
        throw new TaskError(
          404,
          'route_not_found',
          'Application API route not found.',
        );
      }
      if (url.pathname === '/api/capabilities' && request.method === 'GET') {
        if (url.searchParams.size)
          throw new TaskError(400, 'invalid_query', 'Unsupported query key.');
        send(200, runtime.capabilities(identity));
        return;
      }
      if (url.pathname === '/api/agents') {
        if (request.method !== 'GET')
          throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
        if (url.searchParams.size)
          throw new TaskError(400, 'invalid_query', 'Unsupported query key.');
        send(200, await runtime.agentStatus(identity));
        return;
      }
      if (url.pathname === '/api/tasks' && request.method === 'GET') {
        for (const key of url.searchParams.keys())
          if (
            !['limit', 'cursor', 'status'].includes(key) ||
            url.searchParams.getAll(key).length !== 1
          )
            throw new TaskError(
              400,
              'invalid_query',
              'Unsupported or duplicate query key.',
            );
        send(
          200,
          runtime.store.listTaskSummaries(identity, {
            ...(url.searchParams.has('limit')
              ? { limit: Number(url.searchParams.get('limit')) }
              : {}),
            ...(url.searchParams.has('cursor')
              ? { cursor: url.searchParams.get('cursor')! }
              : {}),
            ...(url.searchParams.has('status')
              ? { status: url.searchParams.get('status')! }
              : {}),
          }),
        );
        return;
      }
      const taskView =
        /^\/api\/tasks\/([A-Za-z0-9-]+)\/views\/([A-Za-z0-9-]+)$/.exec(
          url.pathname,
        );
      if (taskView) {
        if (request.method !== 'GET')
          throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
        if (url.searchParams.size)
          throw new TaskError(
            400,
            'invalid_query',
            'Task views accept no query parameters.',
          );
        send(200, runtime.readTaskView(taskView[1]!, taskView[2]!, identity));
        return;
      }
      if (url.pathname === '/api/tasks' && request.method === 'POST') {
        send(
          202,
          runtime.admit(
            await readBody(request, 65536),
            idempotencyKey(request),
            identity,
          ),
        );
        return;
      }
      if (url.pathname === '/api/artifacts' && request.method === 'POST') {
        send(
          201,
          runtime.importArtifact(
            await readBody(request, 2 * 1024 * 1024),
            idempotencyKey(request),
            identity,
          ),
        );
        return;
      }
      const artifact = /^\/api\/artifacts\/([A-Za-z0-9-]+)$/.exec(url.pathname);
      if (artifact && request.method === 'GET') {
        if (url.searchParams.size)
          throw new TaskError(400, 'invalid_query', 'Unsupported query key.');
        send(200, runtime.store.artifact(artifact[1]!, identity));
        return;
      }
      if (url.pathname === '/api/world/records') {
        if (request.method !== 'GET')
          throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
        const queryValues: Record<string, string> = {};
        for (const [key, value] of url.searchParams) {
          if (Object.hasOwn(queryValues, key))
            throw new TaskError(400, 'invalid_query', 'Duplicate query key.');
          Object.defineProperty(queryValues, key, {
            value,
            enumerable: true,
          });
        }
        const query = worldApiBrowseQuerySchema.safeParse(queryValues);
        if (!query.success)
          throw new TaskError(
            400,
            'invalid_world_query',
            'World Model query parameters are invalid.',
          );
        send(
          200,
          browseWorldRecords(
            runtime.store,
            identity,
            runtime.executionMode,
            query.data,
          ),
        );
        return;
      }
      if (url.pathname === '/api/world/projections/rebuild') {
        if (request.method !== 'POST')
          throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
        if (url.searchParams.size > 0)
          throw new TaskError(400, 'invalid_query', 'Unsupported query key.');
        const key = idempotencyKey(request);
        const body = worldProjectionRebuildRequestSchema.safeParse(
          await readBody(request, 1024),
        );
        if (!body.success)
          throw new TaskError(
            400,
            'invalid_world_rebuild',
            'Projection rebuild expects an empty JSON object.',
          );
        send(
          200,
          runtime.store.worldRebuildProjections(
            identity,
            runtime.executionMode,
            key,
            body.data,
          ),
        );
        return;
      }
      const worldRecord = /^\/api\/world\/records\/([^/]+)$/.exec(url.pathname);
      if (worldRecord && request.method === 'GET') {
        let recordId: string;
        try {
          recordId = decodeURIComponent(worldRecord[1]!);
        } catch {
          throw new TaskError(400, 'invalid_record_id', 'Invalid record ID.');
        }
        const paramsResult = worldApiRecordParamsSchema.safeParse({
          record_id: recordId,
        });
        if (!paramsResult.success)
          throw new TaskError(400, 'invalid_record_id', 'Invalid record ID.');
        const params = paramsResult.data;
        const allowedQueryKeys = new Set(['limit', 'cursor', 'view']);
        for (const key of url.searchParams.keys())
          if (!allowedQueryKeys.has(key))
            throw new TaskError(400, 'invalid_query', 'Unsupported query key.');
        for (const key of allowedQueryKeys)
          if (url.searchParams.getAll(key).length > 1)
            throw new TaskError(400, 'invalid_query', 'Duplicate query key.');
        const queryResult = worldApiRecordReadQuerySchema.safeParse({
          limit: url.searchParams.get('limit') ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
          view: url.searchParams.get('view') ?? undefined,
        });
        if (!queryResult.success)
          throw new TaskError(
            400,
            'invalid_world_query',
            'World Model query parameters are invalid.',
          );
        const query = queryResult.data;
        if (query.view === 'detail') {
          send(
            200,
            worldRecordReadResponseSchema.parse({
              view: 'detail',
              detail: runtime.store.worldRecordDetailForIdentity(
                identity,
                runtime.executionMode,
                params.record_id,
              ),
            }),
          );
          return;
        }
        const lineageInput = worldLineageInputSchema.safeParse({
          record_id: params.record_id,
          limit: query.limit,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
        if (!lineageInput.success)
          throw new TaskError(
            400,
            'invalid_world_query',
            'World Model query parameters are invalid.',
          );
        const page = runtime.store.worldLineageForIdentity(
          identity,
          runtime.executionMode,
          lineageInput.data,
        );
        if (query.view === 'history') {
          send(
            200,
            worldRecordReadResponseSchema.parse({
              view: 'history',
              history: worldRecordHistoryResponseSchema.parse({
                ...page,
                schema_version: 'haze.world.history-page.v1',
              }),
            }),
          );
          return;
        }
        send(
          200,
          worldRecordReadResponseSchema.parse({
            view: 'lineage',
            lineage: worldRecordLineageResponseSchema.parse(page),
          }),
        );
        return;
      }
      const match =
        /^\/api\/tasks\/([A-Za-z0-9-]+)(?:\/(events|updates|control|world))?$/.exec(
          url.pathname,
        );
      if (!match)
        throw new TaskError(
          404,
          'route_not_found',
          'General task API route not found.',
        );
      const id = match[1]!;
      if (match[2] === 'updates' && request.method === 'POST') {
        send(
          200,
          runtime.update(
            id,
            await readBody(request, 65536),
            idempotencyKey(request),
            identity,
          ),
        );
        return;
      }
      if (match[2] === 'world' && request.method === 'GET') {
        if (url.searchParams.size)
          throw new TaskError(400, 'invalid_query', 'Unsupported query key.');
        send(
          200,
          worldTaskResponseSchema.parse(
            runtime.store.worldTaskView(id, identity),
          ),
        );
        return;
      }
      if (match[2] === 'control' && request.method === 'POST') {
        send(
          200,
          runtime.control(
            id,
            await readBody(request, 65536),
            idempotencyKey(request),
            identity,
          ),
        );
        return;
      }
      if (request.method !== 'GET' || (match[2] && match[2] !== 'events'))
        throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
      if (match[2] === 'events') {
        // `after` is the only supported key, and a repeated cursor must not
        // silently resolve to its first value.
        for (const key of url.searchParams.keys())
          if (key !== 'after' || url.searchParams.getAll(key).length !== 1)
            throw new TaskError(
              400,
              'invalid_query',
              'Unsupported or duplicate query key.',
            );
        const cursor = url.searchParams.get('after') ?? '0';
        if (!/^\d{1,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
          throw new TaskError(
            400,
            'invalid_cursor',
            'Use a nonnegative integer cursor.',
          );
        send(200, runtime.store.events(id, identity, Number(cursor)));
        return;
      }
      if (url.searchParams.size)
        throw new TaskError(400, 'invalid_query', 'Unsupported query key.');
      send(200, runtime.store.read(id, identity));
    };
    void handle().catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof TaskError)
        send(error.status, {
          error: { code: error.code, message: error.message },
        });
      else
        send(500, {
          error: {
            code: 'task_service_failed',
            message:
              'The task service failed; no fallback answer was produced.',
          },
        });
    });
  };
  return Object.assign(handler, {
    runtime,
    close: () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        dashboard?.view.close();
        try {
          await dashboard?.hazeops.close();
        } finally {
          await runtime.close();
        }
      })();
      return closing;
    },
  });
}
