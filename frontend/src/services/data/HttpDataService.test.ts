import { afterEach, expect, it, vi } from 'vitest';
import { HttpDataService } from './HttpDataService.ts';
import type { LiveUpdate } from './DataService.ts';
import type { ConnectionStatus } from '../../shared/types/domain.ts';

class FakeEventSource extends EventTarget {
  static CLOSED = 2;
  static latest: FakeEventSource;
  readyState = 1;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    super();
    FakeEventSource.latest = this;
  }
  send(kind: string, data: unknown) {
    this.dispatchEvent(
      Object.assign(new Event(kind), { data: JSON.stringify(data) }),
    );
  }
}
afterEach(() => vi.unstubAllGlobals());

it('receives replacements on the initial connection and reconnect, then continues streaming', () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  const update = vi.fn<(event: LiveUpdate) => void>();
  const status = vi.fn<(value: ConnectionStatus) => void>();
  const stop = new HttpDataService('/').subscribe(update, status);
  const source = FakeEventSource.latest;
  const first = { kind: 'reset', snapshot: { items: [{ id: 'hz-old' }] } };
  const second = { kind: 'reset', snapshot: { items: [{ id: 'hz-new' }] } };
  source.send('reset', first);
  source.send('hello', {});
  source.onerror?.();
  source.send('reset', second);
  source.send('hello', {});
  source.send('upsert', { kind: 'upsert', items: [], asOf: 'now' });
  expect(update.mock.calls.map(([value]) => value)).toEqual([
    first,
    second,
    { kind: 'upsert', items: [], asOf: 'now' },
  ]);
  expect(status.mock.calls.map(([value]) => value)).toEqual([
    'connecting',
    'live',
    'offline',
    'live',
  ]);
  stop();
  expect(source.close).toHaveBeenCalledOnce();
});
