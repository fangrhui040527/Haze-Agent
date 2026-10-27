import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentModel, AgentModelInput } from '../../app/adapters/agent-model.js';
import { ModelRouteRegistry } from '../../app/adapters/model-routes.js';
import { withCachedAgentModel } from '../../app/adapters/model-cache.js';
import { managerModelCacheNormalizer } from '../../app/orchestration/model-cache-bindings.js';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(join(tmpdir(), 'haze-cache-routes-'))))
      throw new Error('Unsafe temporary test directory.');
    await rm(path, { recursive: true, force: true });
  }
});

describe('cached model-route preparation', () => {
  it.each(['cache-only', 'read-only'] as const)(
    'returns a %s hit without Ollama setup or model network access',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'haze-cache-routes-'));
      directories.push(directory);
      const recorded = new ModelRouteRegistry({
        HAZE_PROVIDER: 'nvidia',
        HAZE_MODEL: 'recorded-test-model',
        NVIDIA_API_KEY: 'unit-test-only',
        HAZE_MODEL_CACHE_MODE: 'off',
      }).snapshot().routes.Manager;
      const producer = {
        provider: recorded.provider,
        model: recorded.requested_model!,
        base_url: recorded.base_url!,
        capability_contract: recorded.capability_contract,
      };
      const input: AgentModelInput = {
        role: 'HazeOps', instruction: 'Choose a next action.',
        context: { samples: [12, 14] }, json_mode: true, max_output_tokens: 191,
      };
      const original: AgentModel = {
        selection: { provider: producer.provider, model: producer.model },
        complete: () => Promise.resolve('{"type":"finish"}'),
        completeWithReceipt: () => Promise.resolve({
          text: '{"type":"finish"}',
          receipt: {
            response_model: producer.model, response_id: 'recorded-test-response',
            input_tokens: 10, output_tokens: 4,
            http_status: 200, response_status: 'stop',
          },
        }),
      };
      await withCachedAgentModel(original, {
        directory, route: producer, mode: 'record-only',
        normalizer: managerModelCacheNormalizer,
      }).complete(input, new AbortController().signal);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({
        schema_version: 'haze.model-cache.manifest.v1', routes: [producer],
      }));

      const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('No network allowed.'));
      const registry = new ModelRouteRegistry({
        SAMPLE_MODE: 'true', HAZE_MODEL_CACHE_MODE: mode,
        HAZE_MODEL_CACHE_DIR: directory,
      }, network);
      const model = await registry.prepare(registry.snapshot().routes.Manager, new AbortController().signal);
      expect(network).not.toHaveBeenCalled();
      const result = await model.completeWithReceipt!(input, new AbortController().signal);
      expect(result.text).toBe('{"type":"finish"}');
      expect(result.receipt).toMatchObject({
        response_status: 'cache_hit', response_id: null,
        input_tokens: null, output_tokens: null,
        cache: { original_route: producer },
      });
      expect(result.receipt.http_status).toBeUndefined();
      expect(network).not.toHaveBeenCalled();
    },
  );
});
