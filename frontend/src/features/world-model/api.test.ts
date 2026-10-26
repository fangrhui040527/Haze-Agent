import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browseWorldRecords,
  readWorldRecord,
  rebuildWorldProjections,
  WorldModelApiError,
} from './api.ts';

const recordId = 'wmr:entity/1';
const ref = { id: recordId, revision: 1, sha256: 'a'.repeat(64) };
const scope = { principal: 'local', workspace: 'default', mode: 'fixture' };
const record = {
  schema_version: 'haze.world.record.v1',
  ref,
  scope,
  kind: 'entity',
  external_id: 'station:1',
  payload: { label: 'Station 1' },
  producer: { kind: 'service', id: 'test' },
  recorded_at: '2026-10-26T00:00:00.000Z',
};
const browse = {
  schema_version: 'haze.world.browse.v1',
  scope,
  records: [record],
  kinds: [{ kind: 'entity', count: 1 }],
  kinds_truncated: false,
  counts: { records: 1, relationships: 0, events: 1 },
  projection_cursor: 1,
  has_more: false,
};
const detail = {
  view: 'detail',
  detail: {
    schema_version: 'haze.world.record-detail.v1',
    record,
    relationships: [],
    support_artifacts: [],
    payload: record.payload,
    status: {
      schema_version: 'haze.world.current-status.v1',
      record_id: recordId,
      acceptances: [],
    },
  },
};
const history = {
  view: 'history',
  history: {
    schema_version: 'haze.world.history-page.v1',
    record: ref,
    entries: [],
    page: { limit: 10, has_more: true, next_cursor: '7' },
  },
};
const rebuilt = {
  schema_version: 'haze.world.projection-rebuild.v1',
  mode: 'fixture',
  projection_cursor: 1,
  reused: false,
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(response: Response) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

afterEach(() => vi.unstubAllGlobals());

describe('World Model control plane API client', () => {
  it('browses only the same-origin API with encoded filters and the caller signal', async () => {
    const fetcher = mockFetch(json(browse));
    const signal = new AbortController().signal;
    expect(
      await browseWorldRecords(
        { kind: 'entity', query: 'station & 1', limit: 20, cursor: '2' },
        signal,
      ),
    ).toEqual(browse);
    const [path, init] = fetcher.mock.calls[0];
    const url = new URL(path as string, 'http://haze.local');
    expect(url.pathname).toBe('/api/world/records');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: 'entity',
      query: 'station & 1',
      limit: '20',
      cursor: '2',
    });
    expect(init).toMatchObject({
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  });

  it('validates filters before sending a request', async () => {
    const fetcher = mockFetch(json(browse));
    await expect(browseWorldRecords({ limit: 101 })).rejects.toThrow(
      'browse filters are invalid',
    );
    await expect(browseWorldRecords({ cursor: '-1' })).rejects.toThrow(
      'browse filters are invalid',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads default detail with an encoded record identifier', async () => {
    const fetcher = mockFetch(json(detail));
    expect(await readWorldRecord(recordId)).toEqual(detail);
    expect(fetcher.mock.calls[0][0]).toBe(
      '/api/world/records/wmr%3Aentity%2F1?view=detail&limit=50',
    );
  });

  it('preserves paged history and lineage cursors', async () => {
    const fetcher = mockFetch(json(history));
    expect(
      await readWorldRecord(recordId, 'history', { limit: 10, cursor: '4' }),
    ).toEqual(history);
    expect(fetcher.mock.calls[0][0]).toBe(
      '/api/world/records/wmr%3Aentity%2F1?view=history&limit=10&cursor=4',
    );
    const lineage = {
      view: 'lineage',
      lineage: {
        ...history.history,
        schema_version: 'haze.world.lineage-page.v1',
      },
    };
    fetcher.mockResolvedValueOnce(json(lineage));
    expect(await readWorldRecord(recordId, 'lineage')).toEqual(lineage);
  });

  it('rejects a valid record response with a different identity or view', async () => {
    const fetcher = mockFetch(json(history));
    await expect(readWorldRecord(recordId, 'detail')).rejects.toThrow(
      'did not match the requested record and view',
    );
    fetcher.mockResolvedValueOnce(
      json({
        ...history,
        history: { ...history.history, record: { ...ref, id: 'wmr:other' } },
      }),
    );
    await expect(readWorldRecord(recordId, 'history')).rejects.toThrow(
      'did not match the requested record and view',
    );
    fetcher.mockResolvedValueOnce(
      json({
        ...detail,
        detail: {
          ...detail.detail,
          status: { ...detail.detail.status, record_id: 'wmr:other' },
        },
      }),
    );
    await expect(readWorldRecord(recordId)).rejects.toThrow(
      'did not match the requested record and view',
    );
  });

  it('rebuilds projections with an explicit stable operation key and an empty body', async () => {
    const fetcher = mockFetch(json(rebuilt));
    expect(await rebuildWorldProjections('rebuild-operation')).toEqual(rebuilt);
    expect(fetcher.mock.calls[0]).toEqual([
      '/api/world/projections/rebuild',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'rebuild-operation',
        },
      }),
    ]);
    await expect(rebuildWorldProjections('bad key')).rejects.toThrow(
      'operation key is invalid',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('validates every response with its runtime contract', async () => {
    const fetcher = mockFetch(json({}));
    await expect(browseWorldRecords()).rejects.toThrow('contract validation');
    fetcher.mockResolvedValueOnce(json({}));
    await expect(readWorldRecord(recordId)).rejects.toThrow(
      'contract validation',
    );
    fetcher.mockResolvedValueOnce(json({}));
    await expect(rebuildWorldProjections('rebuild')).rejects.toThrow(
      'contract validation',
    );
  });

  it('exposes bounded API errors and status without rendering raw error documents', async () => {
    const fetcher = mockFetch(
      json(
        {
          error: {
            code: 'world_record_not_found',
            message: 'World Model record not found.',
          },
        },
        404,
      ),
    );
    await expect(readWorldRecord(recordId)).rejects.toMatchObject({
      name: 'WorldModelApiError',
      status: 404,
      code: 'world_record_not_found',
      message: 'World Model record not found.',
    });
    fetcher.mockResolvedValueOnce(
      json({ error: { message: 'unexpected secret error document' } }, 500),
    );
    await expect(browseWorldRecords()).rejects.toMatchObject({
      status: 500,
      message: 'World Model request failed (500).',
    });
  });

  it('shows useful errors for unavailable hosts, invalid JSON, and network failures', async () => {
    const fetcher = mockFetch(
      new Response('<html>Vite fallback</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    await expect(browseWorldRecords()).rejects.toThrow(
      'unavailable on this host',
    );
    fetcher.mockResolvedValueOnce(
      new Response('{broken', {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(browseWorldRecords()).rejects.toThrow('invalid JSON');
    fetcher.mockRejectedValueOnce(new TypeError('private transport detail'));
    await expect(browseWorldRecords()).rejects.toThrow('could not be reached');
  });

  it('enforces the byte bound with and without a Content-Length header', async () => {
    const fetcher = mockFetch(
      new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024 + 1),
        },
      }),
    );
    await expect(browseWorldRecords()).rejects.toThrow(
      'browser response bound',
    );
    fetcher.mockResolvedValueOnce(json('x'.repeat(2 * 1024 * 1024)));
    await expect(browseWorldRecords()).rejects.toThrow(
      'browser response bound',
    );
  });

  it('does not start a request with an already aborted signal', async () => {
    const fetcher = mockFetch(json(browse));
    const controller = new AbortController();
    controller.abort();
    await expect(
      browseWorldRecords({}, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts promptly when a transport ignores the signal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const controller = new AbortController();
    const pending = browseWorldRecords({}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels an unfinished body when aborted during response parsing', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    mockFetch(
      new Response(stream, {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const controller = new AbortController();
    const pending = browseWorldRecords({}, controller.signal);
    // Let fetch resolve and the body reader attach before cancelling.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('exports a distinct API error type for presentation and retry handling', () => {
    const error = new WorldModelApiError(
      'Unavailable',
      503,
      'world_unavailable',
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Unavailable',
      status: 503,
      code: 'world_unavailable',
    });
  });
});
