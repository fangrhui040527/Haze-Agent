import { afterEach, expect, it, vi } from 'vitest';
import type { LiveUpdate } from '../../frontend/src/services/data/DataService.ts';
import type { HazeItem } from '../../frontend/src/shared/types/domain.ts';
import { createApp, type AppDependencies } from '../src/api/app.ts';

afterEach(() => vi.useRealTimers());

it('starts each connection with current data and then preserves update order', async () => {
  vi.useFakeTimers();
  let items = [{ id: 'hz-old' } as HazeItem];
  let receive: ((update: LiveUpdate) => void) | null = null;
  const stop = vi.fn();
  const app = createApp({
    snapshot: () => {
      expect(receive).not.toBeNull(); // subscribe before taking the snapshot
      return { items, locations: [], sources: [] };
    },
    onItemsChanged: (listener: (update: LiveUpdate) => void) => {
      receive = listener;
      return stop;
    },
  } as unknown as AppDependencies);
  const connect = async () => {
    const response = await app.request('/api/stream');
    return response.body!.getReader();
  };
  const decoder = new TextDecoder();
  const readUntil = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    target: string,
  ) => {
    let text = '';
    while (!text.includes(target)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Stream ended before expected event');
      text += decoder.decode(chunk.value);
    }
    return text;
  };
  const first = await connect();
  const initial = await readUntil(first, 'event: hello');
  expect(initial).toContain('event: reset');
  expect(initial).toContain('hz-old');
  expect(initial.indexOf('event: reset')).toBeLessThan(
    initial.indexOf('event: hello'),
  );
  receive!({
    kind: 'upsert',
    items: [{ id: 'hz-new' } as HazeItem],
    asOf: 'now',
  });
  expect(await readUntil(first, 'hz-new')).toContain('event: upsert');
  await first.cancel();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(stop).toHaveBeenCalled();

  // A change with no connected browser must still appear in the reconnect reset.
  items = [{ id: 'hz-only-current' } as HazeItem];
  const second = await connect();
  const restored = await readUntil(second, 'event: hello');
  expect(restored).toContain('hz-only-current');
  expect(restored).not.toContain('hz-old');
  await second.cancel();
  await vi.advanceTimersByTimeAsync(15_000);
});
