import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { openSqliteCheckpointer } from '../../app/checkpoints/sqlite.js';
import {
  compatibilityVersions,
  MEMORY_TEXT,
} from '../../app/compatibility/graph.js';
import type { runCompatibilityPhase } from '../../app/compatibility/worker.js';
import { openHazeEngines } from '../../app/compatibility/meterless/index.js';
import versions from '../../app/workflow_versions.json' with { type: 'json' };

type PhaseReport = Awaited<ReturnType<typeof runCompatibilityPhase>>;
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const worker = join(root, 'dist/compatibility/worker.js');

async function phase(
  stage: 'start' | 'resume',
  stateDir: string,
  threadId: string,
  env: NodeJS.ProcessEnv = {},
): Promise<PhaseReport> {
  const { stdout } = await execute(
    process.execPath,
    [worker, stage, threadId],
    {
      cwd: root,
      env: {
        ...process.env,
        HAZE_PROVIDER: 'offline',
        SAMPLE_MODE: '0',
        HAZE_PROVIDER_API_KEY: '',
        NVIDIA_API_KEY: '',
        ...env,
        STATE_DIR: stateDir,
      },
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as PhaseReport;
}

async function withState(
  run: (directory: string, threadId: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-compatibility-'));
  try {
    await run(directory, `compat-${randomUUID()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('persistent StateGraph compatibility spike', () => {
  it('restarts in a new process and reads the same engine evidence from a saved SQLite thread', async () => {
    await withState(async (directory, threadId) => {
      const started = await phase('start', directory, threadId);
      expect(started.pid).not.toBe(process.pid);
      expect(started.checkpointBefore).toBeNull();
      expect(started.state.completedNodes).toEqual([
        'capture_memory',
        'append_observation',
      ]);
      expect(started.state.providerResult).toBeUndefined();
      expect(started.nextAfter).toEqual(['recall_after_restart']);

      const resumed = await phase('resume', directory, threadId);
      expect(resumed.pid).not.toBe(started.pid);
      expect(resumed.pid).not.toBe(process.pid);
      expect(resumed.threadId).toBe(threadId);
      expect(resumed.checkpointBefore).toBe(started.checkpointAfter);
      expect(resumed.checkpointAfter).not.toBe(started.checkpointAfter);
      expect(resumed.nextBefore).toEqual(['recall_after_restart']);
      expect(resumed.nextAfter).toEqual([]);
      expect(resumed.state).toMatchObject({
        ...started.state,
        recordsVerified: true,
        completedNodes: [
          'capture_memory',
          'append_observation',
          'recall_after_restart',
          'probe_provider',
        ],
        providerResult: { provider: 'offline', status: 'skipped' },
      });
      expect(resumed.durability).toEqual({
        saver: 'SqliteSaver',
        journalMode: 'wal',
        synchronous: 2,
        busyTimeoutMs: 5000,
        graph: 'sync',
      });
      expect(resumed.databasePath).toBe(join(directory, 'checkpoint.sqlite'));
      expect((await stat(resumed.databasePath)).size).toBeGreaterThan(0);
      expect(resumed.checkpointCount).toMatchObject({
        count: expect.any(Number) as unknown,
      });
      expect(resumed.versions.node).toBe(process.versions.node);
      expect(resumed.versions.dependencies).toMatchObject(
        versions.dependencies,
      );
      for (const provenance of Object.values(resumed.engineProvenance)) {
        expect(provenance.revision).toMatch(/^[a-f0-9]{40}$/);
        expect(provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(provenance.entrypointSha256).toMatch(/^[a-f0-9]{64}$/);
      }

      const engines = await openHazeEngines({
        memoryDirectory: resumed.stores.memory,
        worldDirectory: resumed.stores.world,
        namespace: 'compatibility',
      });
      const memory = engines.memory
        .query(MEMORY_TEXT, { chatId: threadId, threshold: 0 })
        .memories.find((hit) => hit.memory.id === started.state.memoryId);
      expect(memory?.memory.content).toBe(MEMORY_TEXT);
      expect(
        engines.memory
          .history(started.state.memoryId)
          .filter((entry) => entry.action === 'create'),
      ).toHaveLength(1);
      expect(engines.world.entity(started.state.worldEntityId)?.name).toBe(
        threadId,
      );
      expect(engines.world.events().map((event) => event.id)).toEqual(
        started.state.worldEventIds,
      );
      expect(
        await readFile(join(resumed.stores.memory, 'state.json'), 'utf8'),
      ).toContain(MEMORY_TEXT);
      expect(
        await readFile(
          join(resumed.stores.world, '.world', 'compatibility.json'),
          'utf8',
        ),
      ).toContain(started.state.worldEntityId);

      const handle = await openSqliteCheckpointer(directory);
      try {
        let checkpointCount = 0;
        for await (const tuple of handle.checkpointer.list({
          configurable: { thread_id: threadId },
        })) {
          checkpointCount += 1;
          const channels = JSON.stringify(tuple.checkpoint.channel_values);
          expect(channels).not.toContain(MEMORY_TEXT);
          expect(channels).not.toContain('Synthetic compatibility observation');
          expect(channels).not.toContain(
            'Infrastructure fixture; not scientific haze evidence.',
          );
          expect(channels).not.toContain('provenance');
        }
        expect(checkpointCount).toBeGreaterThan(3);
      } finally {
        handle.close();
      }
      const rawDatabase = await readFile(resumed.databasePath);
      expect(rawDatabase.includes(Buffer.from(MEMORY_TEXT))).toBe(false);
      expect(
        rawDatabase.includes(
          Buffer.from('Synthetic compatibility observation'),
        ),
      ).toBe(false);
    });
  }, 30_000);

  it.each(['missing', 'tampered'] as const)(
    'fails resume when the saved H-MEM store is %s',
    async (mode) => {
      await withState(async (directory, threadId) => {
        const started = await phase('start', directory, threadId);
        const store = join(started.stores.memory, 'state.json');
        if (mode === 'missing') {
          await rm(store);
        } else {
          const saved = await readFile(store, 'utf8');
          expect(saved).toContain(MEMORY_TEXT);
          await writeFile(
            store,
            saved.replace(MEMORY_TEXT, 'Tampered evidence'),
          );
        }
        await expect(
          phase('resume', directory, threadId),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(
            'Compatibility phase failed.',
          ) as unknown,
        });
        const handle = await openSqliteCheckpointer(directory);
        try {
          const tuple = await handle.checkpointer.getTuple({
            configurable: { thread_id: threadId },
          });
          expect(tuple?.checkpoint.channel_values.recordsVerified).not.toBe(
            true,
          );
          expect(
            tuple?.checkpoint.channel_values.providerResult,
          ).toBeUndefined();
          expect(tuple?.checkpoint.channel_values.memoryId).toBe(
            started.state.memoryId,
          );
        } finally {
          handle.close();
        }
      });
    },
    30_000,
  );

  it.each(['graphVersion', 'schemaVersion'] as const)(
    'rejects an incompatible persisted %s before resume',
    async (field) => {
      await withState(async (directory, threadId) => {
        await phase('start', directory, threadId);
        const handle = await openSqliteCheckpointer(directory);
        try {
          const config = { configurable: { thread_id: threadId } };
          const tuple = await handle.checkpointer.getTuple(config);
          if (!tuple?.metadata)
            throw new Error('Missing saved probe checkpoint');
          await handle.checkpointer.put(
            tuple.parentConfig ?? config,
            {
              ...tuple.checkpoint,
              channel_values: {
                ...tuple.checkpoint.channel_values,
                [field]: compatibilityVersions[field] + 1,
              },
            },
            tuple.metadata,
          );
        } finally {
          handle.close();
        }
        await expect(
          phase('resume', directory, threadId),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(
            'Compatibility phase failed.',
          ) as unknown,
        });
      });
    },
    30_000,
  );

  it('calls a local HTTP provider fixture only after the saved process restarts; this is not NVIDIA proof', async () => {
    const requests: { path: string; body: unknown }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          path: request.url ?? '',
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'HAZE_OK' } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected local fixture port');
      }
      const env = {
        HAZE_PROVIDER: 'openai-compatible',
        HAZE_MODEL: 'test-fixture',
        HAZE_PROVIDER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      };
      await withState(async (directory, threadId) => {
        const started = await phase('start', directory, threadId, env);
        expect(requests).toEqual([]);
        expect(started.state.providerResult).toBeUndefined();
        const resumed = await phase('resume', directory, threadId, env);
        expect(resumed.pid).not.toBe(started.pid);
        expect(resumed.checkpointBefore).toBe(started.checkpointAfter);
        expect(resumed.state.recordsVerified).toBe(true);
        expect(resumed.state.providerResult).toEqual({
          provider: 'openai-compatible',
          model: 'test-fixture',
          status: 'passed',
          kind: 'chat-completion',
          responseCharacters: 7,
        });
        expect(requests).toEqual([
          {
            path: '/v1/chat/completions',
            body: {
              model: 'test-fixture',
              messages: [
                {
                  role: 'user',
                  content: 'Reply with the single word HAZE_OK.',
                },
              ],
              max_completion_tokens: 32,
              stream: false,
            },
          },
        ]);
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 30_000);
});
