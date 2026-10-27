import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const NIGHTSHIFT_BASE_URL = 'http://127.0.0.1:8088/v1';
/** The server must implement these semantics at its final provider boundary. */
export const NIGHTSHIFT_STRICT_CONTRACT = Object.freeze({
  id: 'nightshift-haze-strict-v1',
  version: 1,
  model_authority: 'exact',
  output_cap: 'provider-enforced',
  finish_reason: 'upstream',
  usage: 'upstream-or-null',
  reasoning: 'nemotron-enable-thinking',
  structured_output: 'json-object-or-schema',
  single_call: true,
});
export const NIGHTSHIFT_CONTRACT = Object.freeze({
  version: 1 as const,
  id: NIGHTSHIFT_STRICT_CONTRACT.id,
  hash: createHash('sha256')
    .update(JSON.stringify(NIGHTSHIFT_STRICT_CONTRACT))
    .digest('hex'),
});
export const NIGHTSHIFT_CONTRACT_FAILURE =
  'Nightshift direct inference requires a verified contract for this exact model on the strict-inference endpoint. Install the supported strict runtime integration; reachability alone does not establish inference readiness.';

/** Resolve the installed CLI's per-user state directory without exposing it publicly. */
export function nightshiftCredentialReference(env: NodeJS.ProcessEnv): string {
  if (env.METERLESS_TOKEN?.trim()) return 'env:METERLESS_TOKEN';
  const directory =
    env.METERLESS_STATE_DIR ||
    (process.platform === 'win32'
      ? join(
          env.LOCALAPPDATA ||
            join(env.USERPROFILE || homedir(), 'AppData', 'Local'),
          'ai.meterless.runtime',
        )
      : process.platform === 'darwin'
        ? join(
            homedir(),
            'Library',
            'Application Support',
            'ai.meterless.runtime',
          )
        : '/var/lib/meterless');
  return `file:${join(directory, 'proxy-token')}`;
}

/** Files are bounded and never returned in diagnostics or receipts. */
export function resolveRouteCredential(
  ref: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!ref) return null;
  if (ref.startsWith('env:')) {
    const value = env[ref.slice(4)]?.trim();
    return value &&
      value.length <= 16_384 &&
      !value.includes('\r') &&
      !value.includes('\n')
      ? value
      : null;
  }
  if (ref.startsWith('file:')) {
    try {
      const path = ref.slice(5);
      if (statSync(path).size > 16_384) return null;
      return readFileSync(path, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Authenticated, bounded read only inspection; never creates jobs or inference. */
async function inspectJson(
  url: string,
  token: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<{
  reachability: 'reachable' | 'unreachable' | 'blocked';
  body: unknown;
}> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(new Error('Readiness deadline elapsed.'));
      requestSignal.addEventListener('abort', abortListener, {
        once: true,
      });
      if (requestSignal.aborted) abortListener();
    });
    const inspection = async () => {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: requestSignal,
        redirect: 'error',
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return {
          reachability:
            response.status === 401 || response.status === 403
              ? ('blocked' as const)
              : response.status === 404 ||
                  response.status === 400 ||
                  response.status === 409 ||
                  response.status === 503
                ? ('reachable' as const)
                : ('unreachable' as const),
          body: null,
        };
      }
      if (!response.body) throw new Error();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        requestSignal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65_536) throw new Error();
        chunks.push(chunk.value);
      }
      const body: unknown = JSON.parse(
        Buffer.concat(chunks, size).toString('utf8'),
      );
      return {
        reachability: 'reachable' as const,
        body,
      };
    };
    return await Promise.race([inspection(), aborted]);
  } catch {
    if (signal?.aborted)
      throw new DOMException(
        'Nightshift inspection was cancelled.',
        'AbortError',
      );
    return { reachability: 'unreachable', body: null };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (abortListener)
      requestSignal.removeEventListener('abort', abortListener);
    void reader?.cancel().catch(() => undefined);
  }
}

export async function inspectNightshiftModels(
  baseUrl: string,
  token: string,
  requestedModel: string | null,
  fetcher: typeof fetch,
): Promise<{
  reachability: 'reachable' | 'unreachable' | 'blocked';
  model_available: boolean;
}> {
  const result = await inspectJson(`${baseUrl}/models`, token, fetcher);
  const data =
    result.body && typeof result.body === 'object' && 'data' in result.body
      ? result.body.data
      : null;
  return {
    reachability:
      result.reachability === 'blocked' || Array.isArray(data)
        ? result.reachability
        : 'unreachable',
    model_available:
      Array.isArray(data) &&
      data.some(
        (row: unknown) =>
          row &&
          typeof row === 'object' &&
          'id' in row &&
          row.id === requestedModel,
      ),
  };
}

/** Exact-model negotiation is separate from model advertisement and live quality. */
export async function inspectNightshiftContract(
  baseUrl: string,
  token: string,
  requestedModel: string | null,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<{
  reachability: 'reachable' | 'unreachable' | 'blocked';
  contract_verified: boolean;
}> {
  if (!requestedModel)
    return { reachability: 'blocked', contract_verified: false };
  const url = new URL(`${baseUrl}/haze/contract`);
  url.searchParams.set('model', requestedModel);
  const result = await inspectJson(url.href, token, fetcher, signal);
  const body = result.body;
  const record =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  return {
    reachability: result.reachability,
    contract_verified:
      record !== null &&
      Object.entries(NIGHTSHIFT_STRICT_CONTRACT).every(
        ([key, value]) => record[key] === value,
      ) &&
      Array.isArray(record.models) &&
      record.models.length === 1 &&
      record.models[0] === requestedModel,
  };
}
