import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  AgentModel,
  AgentModelCompletion,
  AgentModelInput,
  AgentModelReceipt,
} from './agent-model.js';

export interface ModelCacheRoute {
  provider: string;
  model: string;
  base_url?: string | null;
  capability_contract: { version: number; id: string; hash: string };
}
export interface ModelCacheNormalizer {
  readonly version: string;
  project(input: AgentModelInput): {
    input: AgentModelInput;
    encodeOutput(text: string): string;
    decodeOutput(text: string): string;
  };
}
export interface ModelCacheOptions {
  directory: string;
  route: ModelCacheRoute;
  /** Other explicitly allowed recorded producers; misses still use route/base. */
  replayRoutes?: ModelCacheRoute[];
  mode?: 'read-only' | 'read-through' | 'cache-only' | 'record-only';
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  normalizer?: ModelCacheNormalizer;
  onEvent?: (event: {
    type: 'hit' | 'miss' | 'recorded' | 'record_failed';
    key: string;
  }) => void;
}
interface CacheRecord {
  schema_version: 'haze.model-cache.v1';
  key_sha256: string;
  recorded_at: string;
  route: ModelCacheRoute;
  normalizer: string;
  input: AgentModelInput;
  completion: AgentModelCompletion;
  content_sha256: string;
}
const MAX_TEXT = 12_000;
const defaultProjection = (input: AgentModelInput) => ({
  input,
  encodeOutput: (text: string) => text,
  decodeOutput: (text: string) => text,
});

function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, ordered(child)]),
      );
    return item;
  };
  const source = JSON.stringify(value);
  if (source === undefined)
    throw new Error('Model cache input must be JSON-serializable.');
  const serialized = JSON.stringify(ordered(JSON.parse(source)));
  if (serialized === undefined)
    throw new Error('Model cache input must be JSON-serializable.');
  return serialized;
}
const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

export function modelCacheKey(
  input: AgentModelInput,
  route: ModelCacheRoute,
  normalizer?: ModelCacheNormalizer,
): string {
  return digest({
    version: 1,
    route,
    normalizer: normalizer?.version ?? 'exact-v1',
    input: (normalizer ? normalizer.project(input) : defaultProjection(input))
      .input,
  });
}
export class ModelCacheMissError extends Error {
  constructor(readonly key: string) {
    super(`No matching recorded model reply is available for input ${key}.`);
  }
}
const genuine = (
  completion: AgentModelCompletion,
  input: AgentModelInput,
): boolean =>
  typeof completion.text === 'string' &&
  completion.text.trim().length > 0 &&
  completion.text.length <= MAX_TEXT &&
  completion.receipt?.synthetic !== true &&
  completion.receipt?.cache === undefined &&
  completion.receipt?.http_status === 200 &&
  completion.receipt?.response_status === 'stop' &&
  typeof completion.receipt?.response_model === 'string' &&
  completion.receipt.response_model.trim().length > 0 &&
  typeof completion.receipt?.response_id === 'string' &&
  completion.receipt.response_id.trim().length > 0 &&
  (completion.receipt.output_tokens === null ||
    completion.receipt.output_tokens <= (input.max_output_tokens ?? 1200));

async function boundedRead(path: string, maximum: number): Promise<unknown> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum)
      throw new Error('Invalid model cache entry.');
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > maximum)
      throw new Error('Model cache entry exceeded its limit.');
    return JSON.parse(bytes.subarray(0, size).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

/** Individual genuine model replies only; tools and all runtime validation run again. */
export function withCachedAgentModel(
  base: AgentModel | undefined,
  options: ModelCacheOptions,
): AgentModel {
  const route = structuredClone(options.route);
  const replayRoutes = structuredClone(options.replayRoutes ?? []);
  if (replayRoutes.length > 8)
    throw new Error('Too many recorded model producers.');
  for (const identity of [route, ...replayRoutes]) {
    if (
      !identity.provider ||
      !identity.model ||
      !identity.capability_contract?.id ||
      !identity.capability_contract.hash
    )
      throw new Error(
        'Model cache requires a provider, model and capability contract.',
      );
    if (identity.base_url) {
      const url = new URL(identity.base_url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          'Model cache route must not contain credentials, query or fragment.',
        );
    }
  }
  const directory = resolve(options.directory);
  if (
    base &&
    (base.selection.provider !== route.provider ||
      base.selection.model !== route.model)
  )
    throw new Error(
      'Model cache route must match its underlying model selection.',
    );
  const mode = options.mode ?? (base ? 'read-only' : 'cache-only');
  if (!base && !['cache-only', 'read-only'].includes(mode))
    throw new Error('A model is required to record cache misses.');
  const maxEntries = options.maxEntries ?? 256;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const maxEntryBytes = options.maxEntryBytes ?? 512 * 1024;
  for (const value of [maxEntries, maxBytes, maxEntryBytes])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('Model cache limits must be positive integers.');
  const project = (input: AgentModelInput) =>
    options.normalizer
      ? options.normalizer.project(input)
      : defaultProjection(input);
  const normalizerVersion = options.normalizer?.version ?? 'exact-v1';
  const notify = (
    type: 'hit' | 'miss' | 'recorded' | 'record_failed',
    key: string,
  ) => {
    try {
      options.onEvent?.({ type, key });
    } catch {
      /* Diagnostics cannot dispatch an extra model request. */
    }
  };

  async function record(
    input: AgentModelInput,
    completion: AgentModelCompletion,
    key: string,
  ) {
    const body = {
      schema_version: 'haze.model-cache.v1' as const,
      key_sha256: key,
      recorded_at: new Date().toISOString(),
      route,
      normalizer: normalizerVersion,
      input,
      completion,
    };
    const data = `${JSON.stringify({ ...body, content_sha256: digest(body) }, null, 2)}\n`;
    if (Buffer.byteLength(data) > Math.min(maxEntryBytes, maxBytes))
      throw new Error('Model cache entry exceeds its storage bound.');
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${key}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(directory, `${key}.json`));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const files = await Promise.all(
      (await readdir(directory))
        .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
        .map(async (name) => ({
          path: join(directory, name),
          info: await stat(join(directory, name)),
        })),
    );
    files.sort(
      (a, b) => a.info.mtimeMs - b.info.mtimeMs || a.path.localeCompare(b.path),
    );
    let total = files.reduce((sum, file) => sum + file.info.size, 0);
    let count = files.length;
    for (const file of files) {
      if (count <= maxEntries && total <= maxBytes) break;
      await unlink(file.path);
      count--;
      total -= file.info.size;
    }
  }

  const completeWithReceipt = async (
    input: AgentModelInput,
    signal: AbortSignal,
  ): Promise<AgentModelCompletion> => {
    signal.throwIfAborted();
    const originalInput = structuredClone(input);
    const key = modelCacheKey(originalInput, route, options.normalizer);
    if (mode !== 'record-only') {
      for (const producer of [route, ...replayRoutes]) {
        const producerKey = modelCacheKey(
          originalInput,
          producer,
          options.normalizer,
        );
        try {
          const value = (await boundedRead(
            join(directory, `${producerKey}.json`),
            maxEntryBytes,
          )) as CacheRecord;
          const { content_sha256, ...body } = value;
          if (
            value.schema_version !== 'haze.model-cache.v1' ||
            value.key_sha256 !== producerKey ||
            value.normalizer !== normalizerVersion ||
            canonical(value.route) !== canonical(producer) ||
            !Number.isFinite(Date.parse(value.recorded_at)) ||
            digest(body) !== content_sha256 ||
            modelCacheKey(value.input, producer, options.normalizer) !==
              producerKey ||
            !genuine(value.completion, value.input)
          )
            throw new Error('Invalid model cache record.');
          const text = project(originalInput).decodeOutput(
            project(value.input).encodeOutput(value.completion.text),
          );
          if (!text.trim() || text.length > MAX_TEXT)
            throw new Error('Invalid rebound model reply.');
          signal.throwIfAborted();
          const receipt: AgentModelReceipt = {
            response_model: value.completion.receipt.response_model,
            response_id: null,
            input_tokens: null,
            output_tokens: null,
            response_status: 'cache_hit',
            cache: {
              version: 1,
              key_sha256: producerKey,
              recorded_at: value.recorded_at,
              original_route: structuredClone(value.route),
              original_receipt: structuredClone(value.completion.receipt),
            },
          };
          notify('hit', producerKey);
          return { text, receipt };
        } catch {
          signal.throwIfAborted();
        }
      }
    }
    notify('miss', key);
    if (!base || mode === 'cache-only') throw new ModelCacheMissError(key);
    const completion = base.completeWithReceipt
      ? await base.completeWithReceipt(originalInput, signal)
      : {
          text: await base.complete(originalInput, signal),
          receipt: {
            response_model: null,
            response_id: null,
            input_tokens: null,
            output_tokens: null,
          },
        };
    signal.throwIfAborted();
    if (mode !== 'read-only' && genuine(completion, originalInput)) {
      try {
        await record(originalInput, structuredClone(completion), key);
        notify('recorded', key);
      } catch {
        notify('record_failed', key);
      }
    }
    return completion;
  };
  return {
    selection: { provider: route.provider, model: route.model },
    completeWithReceipt,
    async complete(input, signal) {
      return (await completeWithReceipt(input, signal)).text;
    },
  };
}
