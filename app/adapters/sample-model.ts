import { sampleModeEnabled } from './sample-mode.js';

const SAMPLE_MODEL = 'qwen2.5:7b';
const SAMPLE_MODEL_BASE_URL = 'http://127.0.0.1:11434/v1';
const SAMPLE_MODEL_ALIAS = 'haze-sample-qwen2.5-7b-16k-v1:latest';
const SAMPLE_CONTEXT = 16_384;
const preparations = new WeakMap<typeof fetch, Promise<void>>();

export function sampleModelUsesBuiltinFallback(
  env: NodeJS.ProcessEnv,
): boolean {
  const provider = env.HAZE_PROVIDER?.trim();
  return (
    sampleModeEnabled(env) &&
    (!provider || provider === 'offline') &&
    !env.HAZE_SAMPLE_MODEL?.trim() &&
    !env.HAZE_SAMPLE_MODEL_BASE_URL?.trim()
  );
}

export function isBuiltinSampleModelRoute(
  env: NodeJS.ProcessEnv,
  route: {
    provider: string;
    requested_model: string | null;
    base_url: string | null;
  },
): boolean {
  return (
    sampleModelUsesBuiltinFallback(env) &&
    route.provider === 'openai-compatible' &&
    route.requested_model === SAMPLE_MODEL_ALIAS &&
    route.base_url === SAMPLE_MODEL_BASE_URL
  );
}

async function metadataBody(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.body)
    throw new Error('Local sample model returned empty metadata.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 262_144)
        throw new Error('Local sample model metadata exceeded its limit.');
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const value: unknown = JSON.parse(
      Buffer.concat(chunks, size).toString('utf8'),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid local sample model metadata.');
    return value as Record<string, unknown>;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function hasSampleContext(value: Record<string, unknown> | undefined): boolean {
  if (typeof value?.parameters !== 'string') return false;
  const lines = value.parameters
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^num_ctx\b/u.test(line));
  return lines.length === 1 && /^num_ctx\s+16384$/u.test(lines[0]!);
}

/** Metadata setup only: reuse cached weights and preserve the original model. */
export async function prepareSampleModel(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!sampleModelUsesBuiltinFallback(env)) return;
  let preparation = preparations.get(fetcher);
  if (!preparation) {
    preparation = (async () => {
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(45_000),
      ]);
      const request = async (
        path: string,
        body: unknown,
        missingAllowed = false,
      ) => {
        const response = await fetcher(new URL(path, SAMPLE_MODEL_BASE_URL), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: requestSignal,
          redirect: 'error',
        });
        if (response.status === 404 && missingAllowed) {
          await response.body?.cancel();
          return undefined;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Local sample model metadata request failed.');
        }
        return metadataBody(response, requestSignal);
      };
      const base = await request('/api/show', { model: SAMPLE_MODEL }, true);
      if (!base)
        throw new Error(
          'Local sample model qwen2.5:7b is not cached; no model download was attempted.',
        );
      let alias = await request(
        '/api/show',
        { model: SAMPLE_MODEL_ALIAS },
        true,
      );
      if (!hasSampleContext(alias)) {
        const created = await request('/api/create', {
          model: SAMPLE_MODEL_ALIAS,
          from: SAMPLE_MODEL,
          parameters: { num_ctx: SAMPLE_CONTEXT },
          stream: false,
        });
        if (created?.status !== 'success')
          throw new Error(
            'Local sample model alias preparation did not succeed.',
          );
        alias = await request('/api/show', { model: SAMPLE_MODEL_ALIAS });
      }
      if (!hasSampleContext(alias))
        throw new Error(
          'Local sample model alias has no verified 16384-token context.',
        );
      console.log(
        `Sample model setup: ${SAMPLE_MODEL_ALIAS}, num_ctx=${SAMPLE_CONTEXT} verified; cached weights, metadata only.`,
      );
    })();
    preparations.set(fetcher, preparation);
    void preparation.catch(() => {
      if (preparations.get(fetcher) === preparation)
        preparations.delete(fetcher);
    });
  }
  await preparation;
  signal.throwIfAborted();
}

/** No-auth sample inference is confined to canonical loopback endpoints. */
export function isLoopbackModelBase(value: string | null | undefined): boolean {
  if (
    !value ||
    value.length > 2048 ||
    !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/iu.test(
      value,
    )
  )
    return false;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function sampleModelAllowsNoCredential(
  env: NodeJS.ProcessEnv,
  provider: string,
  baseUrl: string | null | undefined,
): boolean {
  return (
    sampleModeEnabled(env) &&
    provider === 'openai-compatible' &&
    isLoopbackModelBase(baseUrl)
  );
}

/** Preserve configured providers; otherwise use a real local model for samples. */
export function sampleModelEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const provider = env.HAZE_PROVIDER?.trim();
  if (!sampleModeEnabled(env) || (provider && provider !== 'offline'))
    return env;
  const model =
    env.HAZE_SAMPLE_MODEL?.trim() ||
    (sampleModelUsesBuiltinFallback(env) ? SAMPLE_MODEL_ALIAS : SAMPLE_MODEL);
  const baseUrl =
    env.HAZE_SAMPLE_MODEL_BASE_URL?.trim() || SAMPLE_MODEL_BASE_URL;
  if (
    model.length > 256 ||
    Array.from(model).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error('HAZE_SAMPLE_MODEL must be a bounded local model name.');
  if (!isLoopbackModelBase(baseUrl))
    throw new Error(
      'HAZE_SAMPLE_MODEL_BASE_URL must be a loopback HTTP(S) URL without credentials, query, or fragment.',
    );
  return {
    ...env,
    HAZE_PROVIDER: 'openai-compatible',
    HAZE_MODEL: model,
    HAZE_PROVIDER_BASE_URL: baseUrl,
    // An unrelated hosted key must not be sent to the automatic local fallback.
    HAZE_PROVIDER_API_KEY: '',
  };
}
