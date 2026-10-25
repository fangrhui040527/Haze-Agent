import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseContractJson } from '../contracts/json.js';
import { TaskError, type TaskIdentity } from '../contracts/tasks.js';
import { createExecutionRegistry } from '../composition.js';
import {
  TaskRuntime,
  localTaskIdentity,
  type TaskRuntimeOptions,
} from './runtime.js';

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
  const runtime = new TaskRuntime({
    ...options,
    registry:
      options.registry ??
      createExecutionRegistry({
        mode: options.mode ?? 'live',
        ...(options.env ? { env: options.env } : {}),
      }),
  });
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
      const { url, identity } = authorize(request);
      if (url.pathname === '/api/capabilities' && request.method === 'GET') {
        send(200, runtime.capabilities(identity));
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
        send(200, runtime.store.artifact(artifact[1]!, identity));
        return;
      }
      const match =
        /^\/api\/tasks\/([A-Za-z0-9-]+)(?:\/(events|updates|control))?$/.exec(
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
  return Object.assign(handler, { runtime, close: () => runtime.close() });
}
