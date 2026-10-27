import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EffectiveModelRoute } from '../contracts/model-routes.js';
import { sampleModeEnabled } from './sample-mode.js';
import { sampleModelUsesBuiltinFallback } from './sample-model.js';
import type { ModelCacheRoute } from './model-cache.js';

const recordedRoute = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  base_url: z.string().optional(),
  capability_contract: z.strictObject({
    version: z.literal(1),
    id: z.string().min(1),
    hash: z.string().min(1),
  }),
});
const manifest = z.strictObject({
  schema_version: z.literal('haze.model-cache.manifest.v1'),
  routes: z.array(recordedRoute).max(8),
});

/** Optional inference transport cache; it never selects a task or a final result. */
export function modelCacheConfiguration(
  env: NodeJS.ProcessEnv,
  route: EffectiveModelRoute,
) {
  const setting =
    env.HAZE_MODEL_CACHE_MODE?.trim() ||
    (sampleModeEnabled(env) ? 'read-only' : 'off');
  if (setting === 'off') return undefined;
  const modes = {
    'read-only': 'read-only',
    'read-write': 'read-through',
    'record-only': 'record-only',
    'cache-only': 'cache-only',
  } as const;
  if (!Object.hasOwn(modes, setting))
    throw new Error('Unknown HAZE_MODEL_CACHE_MODE.');
  if (!route.requested_model) return undefined;
  const directory = env.HAZE_MODEL_CACHE_DIR?.trim()
    ? resolve(env.HAZE_MODEL_CACHE_DIR)
    : fileURLToPath(new URL('../../data/llm-cache/', import.meta.url));
  let replayRoutes: ModelCacheRoute[] = [];
  // Explicit provider choices stay pinned. Only the automatic local fallback
  // may consume the bundled allowlist of historical inference producers.
  if (sampleModelUsesBuiltinFallback(env)) {
    try {
      const bytes = readFileSync(resolve(directory, 'manifest.json'));
      if (bytes.byteLength > 16_384)
        throw new Error('Cache manifest is too large.');
      replayRoutes = manifest
        .parse(JSON.parse(bytes.toString('utf8')))
        .routes.map(({ base_url, ...producer }) => ({
          ...producer,
          ...(base_url !== undefined ? { base_url } : {}),
        }));
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
  }
  return {
    directory,
    mode: modes[setting as keyof typeof modes],
    route: {
      provider: route.provider,
      model: route.requested_model,
      ...(route.base_url ? { base_url: route.base_url } : {}),
      capability_contract: route.capability_contract,
    },
    replayRoutes,
  };
}
