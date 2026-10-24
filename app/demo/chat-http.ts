import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveAgentModel, type AgentModel } from '../adapters/agent-model.js';
import { openHazeEngines } from '../adapters/meterless/index.js';
import { parseContractJson } from '../contracts/json.js';
import { runSchema } from '../contracts/planning.js';
import { runDemoAgents } from './agent-run.js';
import type { DemoAgentStreamFrame } from './agent-contract.js';
import { createDemoChatHarness, DemoChatError } from './chat-harness.js';

const prefix = '/api/demo/crew-scheduling';
export const DEMO_CHAT_BODY_LIMIT = 16_384;

const loopbackAddress = (address: string | undefined) =>
  address === '127.0.0.1' ||
  address === '::1' ||
  address === '::ffff:127.0.0.1';
const localHostname = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

function localRequestUrl(request: IncomingMessage) {
  if (!loopbackAddress(request.socket.remoteAddress)) {
    throw new DemoChatError(
      403,
      'local_only',
      'The fictional scheduling harness is available only on this computer.',
    );
  }
  let url: URL;
  try {
    const host = new URL(`http://${request.headers.host ?? ''}`);
    if (
      !localHostname(host.hostname) ||
      host.pathname !== '/' ||
      host.username ||
      host.password
    )
      throw new Error('invalid_host');
    url = new URL(request.url ?? '/', host);
    if (url.host !== host.host) throw new Error('invalid_host');
  } catch {
    throw new DemoChatError(
      403,
      'local_only',
      'Use a localhost address for the fictional scheduling harness.',
    );
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new DemoChatError(
      403,
      'same_origin_required',
      'Cross-site requests cannot access this local harness.',
    );
  }
  if (request.method === 'POST') {
    let matching = false;
    try {
      const origin = new URL(request.headers.origin ?? '');
      matching = origin.origin === url.origin;
    } catch {
      /* A missing or malformed Origin does not authorize a mutation. */
    }
    if (!matching)
      throw new DemoChatError(
        403,
        'same_origin_required',
        'Submit the fictional sample from the same local application.',
      );
  }
  return url;
}

async function readRequest(request: IncomingMessage) {
  if (
    request.headers['content-type']?.split(';')[0]?.trim() !==
    'application/json'
  ) {
    throw new DemoChatError(
      415,
      'json_required',
      'Send a JSON haze.run.v2 request.',
    );
  }
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (
    !Number.isFinite(declaredLength) ||
    declaredLength > DEMO_CHAT_BODY_LIMIT
  ) {
    throw new DemoChatError(
      413,
      'request_too_large',
      'The scheduling request exceeds the local harness limit.',
    );
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const data of request) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
    bytes += chunk.length;
    if (bytes > DEMO_CHAT_BODY_LIMIT)
      throw new DemoChatError(
        413,
        'request_too_large',
        'The scheduling request exceeds the local harness limit.',
      );
    chunks.push(chunk);
  }
  try {
    return parseContractJson(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DemoChatError(
      400,
      'invalid_json',
      'The scheduling request must be valid JSON without duplicate keys.',
    );
  }
}

/** Connect-compatible middleware, installed solely by the local frontend dev server. */
export function createDemoChatHandler(
  options: {
    env?: NodeJS.ProcessEnv;
    model?: AgentModel;
    engines?: Awaited<ReturnType<typeof openHazeEngines>>;
  } = {},
) {
  const harness = createDemoChatHarness();
  let activeAgentRuns = 0;
  return (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void = () => {
      response.statusCode = 404;
      response.end();
    },
  ): void => {
    if (!request.url?.split('?')[0]?.startsWith(`${prefix}/`)) {
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
      const url = localRequestUrl(request);
      if (url.pathname === `${prefix}/sample` && request.method === 'GET') {
        const kind = url.searchParams.get('case') ?? 'named-set';
        if (kind !== 'named-set' && kind !== 'missing-evidence')
          throw new DemoChatError(
            400,
            'unknown_sample',
            'Choose the named-set or missing-evidence fictional sample.',
          );
        send(200, harness.sample(kind));
      } else if (
        url.pathname === `${prefix}/agent-runs` &&
        request.method === 'POST'
      ) {
        if (activeAgentRuns >= 4)
          throw new DemoChatError(
            429,
            'agent_capacity',
            'The local agent team is busy. Retry when another run finishes.',
          );
        const input = runSchema.safeParse(await readRequest(request));
        if (!input.success)
          throw new DemoChatError(
            400,
            'invalid_run_contract',
            'The request does not satisfy haze.run.v2.',
          );
        let model: AgentModel;
        try {
          model =
            options.model ?? resolveAgentModel(options.env ?? process.env);
        } catch (error) {
          // Resolver errors contain configuration guidance, never upstream bodies or keys.
          throw new DemoChatError(
            503,
            'agent_configuration_required',
            error instanceof Error
              ? error.message
              : 'Configure the server-side model provider before running the team.',
          );
        }
        const accepted = harness.run(input.data);
        const scheduling = harness.read(accepted.run_id);
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once('close', abort);
        request.once('aborted', abort);
        let directory: string | undefined;
        const env = options.env ?? process.env;
        const repositoryRoot = fileURLToPath(
          new URL('../../', import.meta.url),
        );
        const storageRoot = resolve(
          repositoryRoot,
          env.STATE_DIR || '.state',
          'crew-agent-runs',
        );
        activeAgentRuns++;
        try {
          let engines = options.engines;
          if (!engines) {
            await mkdir(storageRoot, { recursive: true });
            directory = await mkdtemp(resolve(storageRoot, 'run-'));
            engines = await openHazeEngines({
              memoryDirectory: resolve(directory, 'memory'),
              worldDirectory: resolve(directory, 'world'),
              namespace: 'fictional_crew_demo',
            });
          }
          controller.signal.throwIfAborted();
          response.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Accel-Buffering': 'no',
          });
          response.flushHeaders();
          const write = (frame: DemoAgentStreamFrame) => {
            if (!controller.signal.aborted && !response.destroyed)
              response.write(`${JSON.stringify(frame)}\n`);
          };
          try {
            const result = await runDemoAgents({
              scheduling,
              question: input.data.input.query ?? '',
              model,
              engines,
              onEvent: (event) => write({ type: 'event', event }),
              signal: controller.signal,
            });
            write(result);
          } catch {
            // runDemoAgents emitted its truthful terminal event; never send a fallback result.
          }
          if (!response.destroyed) response.end();
        } catch {
          if (!controller.signal.aborted && !response.headersSent)
            throw new DemoChatError(
              503,
              'agent_engines_unavailable',
              'The pinned memory services could not start. Run npm run build at the repository root and retry.',
            );
        } finally {
          activeAgentRuns--;
          response.off('close', abort);
          request.off('aborted', abort);
          if (directory) {
            // Only remove the exact per-run child returned by mkdtemp, within our storage root.
            const child = relative(storageRoot, resolve(directory));
            if (
              child.startsWith('run-') &&
              !isAbsolute(child) &&
              !child.includes(sep) &&
              child !== '..'
            )
              await rm(directory, { recursive: true, force: true });
          }
        }
      } else if (
        url.pathname === `${prefix}/runs` &&
        request.method === 'POST'
      ) {
        const accepted = harness.run(await readRequest(request));
        response.setHeader('Location', accepted.status_url);
        send(202, accepted);
      } else if (
        url.pathname.startsWith(`${prefix}/runs/`) &&
        request.method === 'GET'
      ) {
        send(
          200,
          harness.read(
            decodeURIComponent(url.pathname.slice(`${prefix}/runs/`.length)),
          ),
        );
      } else {
        throw new DemoChatError(
          404,
          'demo_route_not_found',
          'This local harness route is unavailable.',
        );
      }
    };
    void handle().catch((error: unknown) => {
      if (response.writableEnded || response.destroyed) return;
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof DemoChatError) {
        send(error.status, {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        });
      } else {
        send(500, {
          error: {
            code: 'demo_computation_failed',
            message:
              'The fictional sample could not pass computation and validation; no result was produced.',
          },
        });
      }
    });
  };
}
