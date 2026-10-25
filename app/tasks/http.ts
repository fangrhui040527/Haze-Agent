import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { parseContractJson } from '../contracts/json.js';
import { TaskError, type TaskIdentity } from './contracts.js';
import { TaskRuntime, localTaskIdentity } from './runtime.js';
import { OrchestrationRuntime } from '../orchestration/runtime.js';
import {
  createLivePorts,
  type IntegrationPorts,
} from '../orchestration/ports.js';

const loopback = (value: string | undefined) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value ?? '');
const localHost = (value: string) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(value);

/** Local single-user authority, matching the existing dev-server trust boundary. Never accepts client identity/grants. */
function authorize(request: IncomingMessage): {
  url: URL;
  identity: TaskIdentity;
} {
  if (!loopback(request.socket.remoteAddress))
    throw new TaskError(
      403,
      'local_only',
      'This evidence API is available only on this computer.',
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
    throw new TaskError(
      403,
      'local_only',
      'Use a localhost address for the evidence API.',
    );
  }
  if (request.headers['sec-fetch-site'] === 'cross-site')
    throw new TaskError(
      403,
      'same_origin_required',
      'Cross-site access is denied.',
    );
  if (
    request.headers.origin !== undefined &&
    request.headers.origin !== url.origin
  )
    throw new TaskError(
      403,
      'same_origin_required',
      'Origin must match this local application.',
    );
  if (request.method === 'POST' && request.headers.origin !== url.origin)
    throw new TaskError(
      403,
      'same_origin_required',
      'Submit from the same local application; an Origin header is required.',
    );
  return { url, identity: localTaskIdentity };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers['content-type']?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new TaskError(
      415,
      'json_required',
      'Send an application/json task request.',
    );
  const length = Number(request.headers['content-length'] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > 16384)
    throw new TaskError(
      413,
      'request_too_large',
      'Task request exceeds 16 KiB.',
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const data of request) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
    bytes += chunk.length;
    if (bytes > 16384)
      throw new TaskError(
        413,
        'request_too_large',
        'Task request exceeds 16 KiB.',
      );
    chunks.push(chunk);
  }
  try {
    return parseContractJson(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new TaskError(
      400,
      'invalid_json',
      'Task JSON must be valid and contain no duplicate keys.',
    );
  }
}

export function createTaskHandler(
  options: ConstructorParameters<typeof TaskRuntime>[0] & {
    orchestrationPorts?: IntegrationPorts;
    orchestrationProfile?: ConstructorParameters<
      typeof OrchestrationRuntime
    >[0]['profile'];
    /** Previous bootstrap option names remain accepted during the module rename. */
    hybridPorts?: IntegrationPorts;
    hybridProfile?: ConstructorParameters<
      typeof OrchestrationRuntime
    >[0]['profile'];
  },
) {
  const orchestrationProfile =
    options.orchestrationProfile ?? options.hybridProfile;
  const runtime: TaskRuntime = new TaskRuntime({
    ...options,
    stateDirectory: resolve(options.stateDirectory),
    otherActiveTasks: (): number => orchestration?.activeCount ?? 0,
  });
  const orchestration: OrchestrationRuntime = new OrchestrationRuntime({
    taskStore: runtime.store,
    stateDirectory: resolve(options.stateDirectory),
    ports:
      options.orchestrationPorts ??
      options.hybridPorts ??
      createLivePorts(
        options.env ?? process.env,
        options.source,
        options.model,
      ),
    ...(orchestrationProfile ? { profile: orchestrationProfile } : {}),
    otherActiveTasks: (): number => runtime.activeCount,
  });
  const handler = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void = () => {
      response.statusCode = 404;
      response.end();
    },
  ): void => {
    if (!/^\/api\/tasks(?:[/?]|$)/.test(request.url ?? '')) {
      next();
      return;
    }
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify(body));
    };
    const handle = async () => {
      const { url, identity } = authorize(request);
      if (url.pathname === '/api/tasks' && request.method === 'POST') {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(key))
          throw new TaskError(
            400,
            'idempotency_key_required',
            'Provide a stable Idempotency-Key (1–128 letters, numbers, colon, underscore or hyphen).',
          );
        const body = await readBody(request);
        const version =
          body && typeof body === 'object' && 'schema_version' in body
            ? body.schema_version
            : undefined;
        const admitted =
          version === 'haze.task.request.v2'
            ? orchestration.admit(body, key, identity)
            : runtime.admit(body, key, identity);
        response.setHeader('Location', admitted.status_url);
        send(202, admitted);
        return;
      }
      const cancellation = /^\/api\/tasks\/([a-f0-9-]{36})\/cancel$/.exec(
        url.pathname,
      );
      if (cancellation && request.method === 'POST') {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(key))
          throw new TaskError(
            400,
            'idempotency_key_required',
            'Provide a stable Idempotency-Key for cancellation.',
          );
        const body = await readBody(request);
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length
        )
          throw new TaskError(
            400,
            'invalid_cancellation',
            'Cancellation accepts an empty JSON object; identity and grants are server controlled.',
          );
        send(200, orchestration.cancel(cancellation[1]!, identity, key));
        return;
      }
      const match =
        /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(events|artifacts\/([a-f0-9-]{36})))?$/.exec(
          url.pathname,
        );
      if (!match || request.method !== 'GET')
        throw new TaskError(
          404,
          'task_route_not_found',
          'Task API route not found.',
        );
      const id = match[1]!;
      const store = orchestration.store.exists(id)
        ? orchestration.store
        : runtime.store;
      if (match[2] === 'events') {
        const cursor = url.searchParams.get('after') ?? '0';
        if (!/^\d{1,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
          throw new TaskError(
            400,
            'invalid_cursor',
            'Use a nonnegative integer event cursor.',
          );
        send(200, store.events(id, identity, Number(cursor)));
        return;
      }
      if (match[3]) {
        store.read(id, identity);
        const artifact = store.artifact(match[3], identity);
        if (artifact.task_id !== id)
          throw new TaskError(
            404,
            'artifact_not_found',
            'Artifact does not belong to this task.',
          );
        send(200, artifact);
        return;
      }
      send(200, store.read(id, identity));
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
    close: async () => {
      await orchestration.close();
      await runtime.close();
    },
    runtime,
    orchestration,
    hybrid: orchestration,
  });
}
