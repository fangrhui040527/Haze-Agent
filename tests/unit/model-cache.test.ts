import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentModelInput,
} from '../../app/adapters/agent-model.js';
import {
  modelCacheKey,
  withCachedAgentModel,
  type ModelCacheNormalizer,
  type ModelCacheRoute,
} from '../../app/adapters/model-cache.js';

const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'haze-model-cache-'));
  directories.push(value);
  return value;
}
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(join(tmpdir(), 'haze-model-cache-'))))
      throw new Error('Unsafe test directory.');
    await rm(path, { recursive: true, force: true });
  }
});
const route: ModelCacheRoute = {
  provider: 'openai-compatible',
  model: 'local-model',
  base_url: 'http://127.0.0.1:11434/v1',
  capability_contract: { version: 1, id: 'test-chat-v1', hash: 'contract-one' },
};
const input: AgentModelInput = {
  role: 'Manager',
  instruction: 'Choose the next action.',
  context: {
    objective: 'Investigate supplied data',
    scope: { place: 'Sample Town', date: '2015-10-01' },
    values: [12, 14],
  },
  output_schema: { type: 'object', properties: { action: { type: 'string' } } },
  max_output_tokens: 200,
  json_mode: true,
};
const signal = () => new AbortController().signal;
function source(identity = route) {
  const completeWithReceipt = vi
    .fn<NonNullable<AgentModel['completeWithReceipt']>>()
    .mockResolvedValue({
      text: '{"action":"inspect"}',
      receipt: {
        response_model: identity.model,
        response_id: 'genuine-response-1',
        response_status: 'stop',
        http_status: 200,
        input_tokens: 100,
        output_tokens: 6,
      },
    });
  return {
    selection: { provider: identity.provider, model: identity.model },
    completeWithReceipt,
    complete: () => Promise.resolve('{"action":"inspect"}'),
  };
}

describe('individual model reply cache', () => {
  it('keeps original call evidence while an explicit typed normalizer rebinds execution identities', async () => {
    const path = await directory();
    const normalizer: ModelCacheNormalizer = {
      version: 'test-run-binding-v1',
      project(value) {
        const context = value.context as { run_id: string; data: number[] };
        return {
          input: { ...value, context: { ...context, run_id: '@run' } },
          encodeOutput(text) {
            const reply = JSON.parse(text) as { run_id: string };
            if (reply.run_id !== context.run_id)
              throw new Error('Unknown runtime identity');
            return JSON.stringify({ ...reply, run_id: '@run' });
          },
          decodeOutput(text) {
            return JSON.stringify({
              ...JSON.parse(text),
              run_id: context.run_id,
            });
          },
        };
      },
    };
    const original = {
      ...input,
      context: { run_id: 'original-run', data: [12, 14] },
    };
    const current = {
      ...input,
      context: { run_id: 'current-run', data: [12, 14] },
    };
    const base = source();
    base.completeWithReceipt.mockResolvedValueOnce({
      ...(await source().completeWithReceipt(input, signal())),
      text: '{"run_id":"original-run","action":"inspect"}',
    });
    const model = withCachedAgentModel(base, {
      directory: path,
      route,
      mode: 'read-through',
      normalizer,
    });
    await model.complete(original, signal());
    expect(JSON.parse(await model.complete(current, signal()))).toMatchObject({
      run_id: 'current-run',
    });
    expect(base.completeWithReceipt).toHaveBeenCalledOnce();
    const stored = JSON.parse(
      await readFile(
        join(path, `${modelCacheKey(current, route, normalizer)}.json`),
        'utf8',
      ),
    ) as { input: AgentModelInput; completion: { text: string } };
    expect(stored.input.context).toEqual(original.context);
    expect(stored.completion.text).toContain('original-run');
    await expect(
      withCachedAgentModel(undefined, {
        directory: path,
        route,
        normalizer,
      }).complete(
        { ...current, context: { run_id: 'current-run', data: [999] } },
        signal(),
      ),
    ).rejects.toThrow('No matching recorded');
  });
  it('sorts object keys but keeps every material input and producer contract in the key', () => {
    const key = modelCacheKey(input, route);
    const reordered = {
      ...input,
      context: {
        values: [12, 14],
        scope: { date: '2015-10-01', place: 'Sample Town' },
        objective: 'Investigate supplied data',
      },
    };
    expect(modelCacheKey(reordered, route)).toBe(key);
    for (const changed of [
      { ...input, instruction: 'Choose another action.' },
      { ...input, context: { ...(input.context as object), values: [12, 15] } },
      { ...input, output_schema: { type: 'string' } },
      { ...input, max_output_tokens: 201 },
      { ...input, context: { run_id: 'new-run', values: [12, 14] } },
    ])
      expect(modelCacheKey(changed, route)).not.toBe(key);
    expect(modelCacheKey(input, { ...route, model: 'other-model' })).not.toBe(
      key,
    );
    expect(
      modelCacheKey(input, {
        ...route,
        capability_contract: {
          ...route.capability_contract,
          hash: 'contract-two',
        },
      }),
    ).not.toBe(key);
  });

  it('reuses one recorded reply without reporting fresh provider calls or token usage', async () => {
    const path = await directory();
    const base = source();
    const model = withCachedAgentModel(base, {
      directory: path,
      route,
      mode: 'read-through',
    });
    const original = await model.completeWithReceipt!(input, signal());
    const hit = await model.completeWithReceipt!(input, signal());
    expect(base.completeWithReceipt).toHaveBeenCalledOnce();
    expect(hit.text).toBe(original.text);
    expect(hit.receipt).toMatchObject({
      response_id: null,
      input_tokens: null,
      output_tokens: null,
      response_status: 'cache_hit',
      cache: { original_route: route, original_receipt: original.receipt },
    });
    expect(hit.receipt.http_status).toBeUndefined();
    const readonly = withCachedAgentModel(undefined, {
      directory: path,
      route,
    });
    expect(await readonly.complete(input, signal())).toBe(original.text);
    await expect(
      readonly.complete({ ...input, instruction: 'Unseen task' }, signal()),
    ).rejects.toThrow('No matching recorded');
  });

  it('permits explicit other recorded producers and keeps unseen fallback records under the actual model', async () => {
    const path = await directory();
    const cloud = {
      ...route,
      provider: 'nvidia',
      model: 'recorded-cloud',
      base_url: 'https://provider.example/v1',
    };
    await withCachedAgentModel(source(cloud), {
      directory: path,
      route: cloud,
      mode: 'record-only',
    }).complete(input, signal());
    const local = source();
    const cached = withCachedAgentModel(local, {
      directory: path,
      route,
      replayRoutes: [cloud],
      mode: 'read-through',
    });
    const hit = await cached.completeWithReceipt!(input, signal());
    expect(hit.receipt.cache?.original_route).toEqual(cloud);
    expect(local.completeWithReceipt).not.toHaveBeenCalled();
    const unseen = { ...input, context: { values: [999] } };
    await cached.complete(unseen, signal());
    expect(local.completeWithReceipt).toHaveBeenCalledOnce();
    expect(await readdir(path)).toContain(
      `${modelCacheKey(unseen, route)}.json`,
    );
    expect(await readdir(path)).not.toContain(
      `${modelCacheKey(unseen, cloud)}.json`,
    );
  });

  it('rejects tampered records and keeps read-only misses out of the cache', async () => {
    const path = await directory();
    const base = source();
    await withCachedAgentModel(base, { directory: path, route }).complete(
      input,
      signal(),
    );
    expect(await readdir(path)).toEqual([]);
    await withCachedAgentModel(base, {
      directory: path,
      route,
      mode: 'record-only',
    }).complete(input, signal());
    const filename = join(path, `${modelCacheKey(input, route)}.json`);
    const value = JSON.parse(await readFile(filename, 'utf8')) as {
      completion: { text: string };
    };
    value.completion.text = 'Invented changed response';
    await writeFile(filename, JSON.stringify(value));
    await expect(
      withCachedAgentModel(undefined, { directory: path, route }).complete(
        input,
        signal(),
      ),
    ).rejects.toThrow('No matching recorded');
  });

  it('does not record synthetic replies and bounds retained entries', async () => {
    const path = await directory();
    const base = source();
    base.completeWithReceipt.mockResolvedValueOnce({
      text: 'fixture',
      receipt: {
        synthetic: true,
        response_model: 'fixture',
        response_id: null,
        input_tokens: null,
        output_tokens: null,
      },
    });
    const model = withCachedAgentModel(base, {
      directory: path,
      route,
      mode: 'read-through',
      maxEntries: 1,
    });
    await model.complete(input, signal());
    expect(await readdir(path)).toEqual([]);
    await model.complete(input, signal());
    await model.complete({ ...input, instruction: 'Another input' }, signal());
    expect(
      (await readdir(path)).filter((name) => name.endsWith('.json')),
    ).toHaveLength(1);
  });
});
