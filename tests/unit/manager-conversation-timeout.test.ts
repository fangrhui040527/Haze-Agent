import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagerConversationFactory } from '../../app/orchestration/conversation.js';
import { ExecutionRegistry } from '../../app/orchestration/ports.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

const runtimes: TaskRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    const rel = relative(resolve(tmpdir()), target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Unsafe temporary directory cleanup.');
    await rm(target, { recursive: true, force: true });
  }
});

async function stateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-chat-timeout-'));
  directories.push(directory);
  return { root: directory, state: join(directory, 'state') };
}

describe('Manager conversation runtime timeout', () => {
  it.each([
    {
      label: 'default',
      configured: undefined,
      timeoutMs: 120000,
      checkpointMs: 119999,
    },
    {
      label: 'extended',
      configured: '180000',
      timeoutMs: 180000,
      checkpointMs: 120001,
    },
  ])(
    'propagates the $label deadline through managerChat without an earlier runtime cutoff',
    async ({ configured, timeoutMs, checkpointMs }) => {
      const { state } = await stateDirectory();
      const observed: { signal?: AbortSignal } = {};
      const conversationFactory: ManagerConversationFactory = () => ({
        resolve: (_request, _identity, signal) => {
          observed.signal = signal;
          return new Promise((done) => {
            signal.addEventListener(
              'abort',
              () =>
                done({
                  kind: 'reply',
                  paragraphs: ['The configured conversation deadline elapsed.'],
                  citations: [],
                  error: { category: 'transport_failure', retryable: true },
                }),
              { once: true },
            );
          });
        },
      });
      const runtime = new TaskRuntime({
        stateDirectory: state,
        registry: new ExecutionRegistry(),
        mode: 'fixture',
        env:
          configured === undefined
            ? {}
            : { HAZE_MANAGER_TIMEOUT_MS: configured },
        conversationFactory,
      });
      runtimes.push(runtime);
      vi.useFakeTimers();
      // Native AbortSignal.timeout uses Node's internal timers. Bridge that API
      // to the fake clock while retaining its abort behavior and requested delay.
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((milliseconds) => {
          const controller = new AbortController();
          setTimeout(
            () =>
              controller.abort(new DOMException('Timed out', 'TimeoutError')),
            milliseconds,
          );
          return controller.signal;
        });
      let settled = false;
      const result = runtime
        .managerChat(
          {
            schema_version: 'haze.manager.chat.request.v1',
            conversation_id: randomUUID(),
            turn_id: randomUUID(),
            message: 'Hello',
          },
          randomUUID(),
        )
        .then(
          (response) => {
            settled = true;
            return { response };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
      expect(timeout).toHaveBeenCalledWith(timeoutMs);
      expect(observed.signal).toBeDefined();
      await vi.advanceTimersByTimeAsync(checkpointMs);
      expect(observed.signal?.aborted).toBe(false);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(timeoutMs - checkpointMs);
      expect(observed.signal?.aborted).toBe(true);
      expect(settled).toBe(true);
      expect(await result).toMatchObject({
        response: {
          kind: 'reply',
          error: { category: 'transport_failure' },
        },
      });
      expect(
        runtime.store.listTaskSummaries(localTaskIdentity).tasks,
      ).toHaveLength(0);
    },
  );

  it('rejects an invalid configured timeout before acquiring state ownership', async () => {
    const { root, state } = await stateDirectory();
    expect(
      () =>
        new TaskRuntime({
          stateDirectory: state,
          registry: new ExecutionRegistry(),
          mode: 'fixture',
          env: { HAZE_MANAGER_TIMEOUT_MS: '999' },
        }),
    ).toThrow('HAZE_MANAGER_TIMEOUT_MS');
    expect(await readdir(root)).toEqual([]);
  });
});
