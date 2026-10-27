import { describe, expect, it, vi } from 'vitest';

interface ReadinessRow {
  id: string;
  status: string;
  detail: string;
  seconds: string;
}
interface Client {
  startupChecks(options?: {
    signal?: AbortSignal;
    onResult?: (row: ReadinessRow) => void;
  }): Promise<ReadinessRow[]>;
}
const { createDevApi } = (await import(
  new URL('../../scripts/dev-api.mjs', import.meta.url).href
)) as {
  createDevApi: (options: {
    getUrl: () => string;
    fetchImpl: typeof fetch;
    timeoutMs?: number;
  }) => Client;
};
const defaults: Record<string, unknown> = {
  '/api/health': {
    ok: true,
    mode: 'live',
    agents: { hmem: 'not enabled; dashboard memory remains archival' },
    hazeops: { scheduler: 'running', reason: null },
    watchers: [{ enabled: true, lastOutcome: 'ok' }],
  },
  '/api/tasks': { tasks: [] },
  '/api/world/records': {
    counts: { records: 7, relationships: 3, events: 12 },
  },
  '/api/nightshift/readiness': {
    routes: [
      {
        role: 'Manager',
        provider: 'nightshift',
        configured: true,
        schema_compatible: true,
        reachability: 'reachable',
        live_verified: false,
      },
    ],
  },
  '/api/nightshift/jobs/readiness': {
    ready: true,
    cli_available: true,
    schema_compatible: true,
    runtime_reachable: true,
    local_only_enforced: true,
    local_compute_available: true,
    runtime_version: 'test-runtime',
    reason: null,
  },
  '/api/nightshift/automation/readiness': {
    ready: false,
    released: false,
    reason: 'Live release gates remain unmet',
  },
};

function application(
  overrides: Record<string, unknown> = {},
  timeoutMs = 1000,
) {
  const responses = { ...defaults, ...overrides };
  const fetchImpl = vi.fn<typeof fetch>((input) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
    const value = responses[url.pathname];
    if (value instanceof Error) return Promise.reject(value);
    if (value instanceof Response) return Promise.resolve(value.clone());
    if (url.pathname === '/' && value === undefined)
      return Promise.resolve(
        new Response('<html>React web app</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
      );
    return Promise.resolve(
      new Response(JSON.stringify(value ?? {}), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  return {
    fetchImpl,
    client: createDevApi({
      getUrl: () => 'http://127.0.0.1:5198',
      fetchImpl,
      timeoutMs,
    }),
  };
}

describe('named startup component readiness', () => {
  it('checks data access and reports active, archival, and unverified components separately', async () => {
    const { client, fetchImpl } = application();
    const published: ReadinessRow[] = [];
    const rows = await client.startupChecks({
      onResult: (value) => published.push(value),
    });
    const byId = Object.fromEntries(rows.map((value) => [value.id, value]));
    expect(byId.web?.status).toBe('READY');
    expect(byId.tasks?.status).toBe('READY');
    expect(byId.world?.status).toBe('READY');
    expect(byId.world?.detail).toContain('7 records, 12 events');
    expect(byId.hmem?.status).toBe('DISABLED');
    expect(byId.hazeops?.status).toBe('RUNNING');
    expect(byId['nightshift-runtime']?.status).toBe('RUNNING');
    expect(byId['nightshift-jobs']?.status).toBe('READY');
    expect(byId['nightshift-inference']?.status).toBe('UNVERIFIED');
    expect(byId['nightshift-automation']?.status).toBe('BLOCKED');
    expect(published).toHaveLength(rows.length);
    for (const [, options] of fetchImpl.mock.calls)
      expect(options?.method ?? 'GET').toBe('GET');
    expect(
      fetchImpl.mock.calls.every(([input]) =>
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).startsWith('http://127.0.0.1:5198/'),
      ),
    ).toBe(true);
  });

  it('does not confuse daemon reachability with usable local inference', async () => {
    const { client } = application({
      '/api/nightshift/jobs/readiness': {
        ready: false,
        cli_available: true,
        runtime_reachable: true,
        reason: 'Only cloud fleets are available',
      },
      '/api/nightshift/readiness': {
        routes: [
          {
            role: 'Manager',
            provider: 'nightshift',
            configured: true,
            schema_compatible: false,
            reachability: 'blocked',
            reason: 'Inference contract unsupported',
          },
        ],
      },
    });
    const rows = await client.startupChecks();
    expect(
      rows.find((value) => value.id === 'nightshift-runtime')?.status,
    ).toBe('RUNNING');
    expect(rows.find((value) => value.id === 'nightshift-jobs')?.status).toBe(
      'BLOCKED',
    );
    expect(
      rows.find((value) => value.id === 'nightshift-inference')?.detail,
    ).toContain('Inference contract unsupported');
  });

  it('keeps core services available when an optional Nightshift probe fails', async () => {
    const { client } = application({
      '/api/nightshift/jobs/readiness': new TypeError('connection refused'),
    });
    const rows = await client.startupChecks();
    expect(rows.find((value) => value.id === 'world')?.status).toBe('READY');
    expect(rows.find((value) => value.id === 'tasks')?.status).toBe('READY');
    expect(
      rows.find((value) => value.id === 'nightshift-runtime')?.status,
    ).toBe('UNAVAILABLE');
    expect(rows.find((value) => value.id === 'nightshift-jobs')?.status).toBe(
      'UNAVAILABLE',
    );
  });

  it('fails actual World Model and web checks instead of trusting a healthy HTTP listener', async () => {
    const { client } = application({
      '/api/world/records': { counts: { records: 'invalid' } },
      '/': new Response('Page failed', { status: 500 }),
    });
    const rows = await client.startupChecks();
    expect(rows.find((value) => value.id === 'web')?.status).toBe('FAILED');
    expect(rows.find((value) => value.id === 'world')?.status).toBe('FAILED');
    expect(rows.find((value) => value.id === 'tasks')?.status).toBe('READY');
  });

  it('reports missing memory diagnostics as unknown and fixture automation as synthetic', async () => {
    const { client } = application({
      '/api/health': {
        ok: true,
        mode: 'fixture',
        hazeops: { scheduler: 'disabled', reason: 'fixture mode' },
        watchers: [],
      },
      '/api/nightshift/automation/readiness': {
        ready: true,
        released: true,
        evidence_kind: 'fixture',
        evidence_id: 'fixture-trace',
        gates: [{ passed: true }],
      },
    });
    const rows = await client.startupChecks();
    expect(rows.find((value) => value.id === 'hmem')?.status).toBe('UNKNOWN');
    expect(rows.find((value) => value.id === 'hazeops')?.status).toBe(
      'DISABLED',
    );
    expect(rows.find((value) => value.id === 'world')?.detail).toContain(
      '(fixture)',
    );
    expect(
      rows.find((value) => value.id === 'nightshift-automation')?.status,
    ).toBe('FIXTURE');
  });

  it('never labels jobs ready without a verified policy and eligible compute', async () => {
    const { client } = application({
      '/api/nightshift/jobs/readiness': {
        ready: true,
        runtime_reachable: true,
        schema_compatible: true,
        local_only_enforced: false,
        local_compute_available: false,
      },
    });
    const rows = await client.startupChecks();
    expect(rows.find((value) => value.id === 'nightshift-jobs')?.status).toBe(
      'BLOCKED',
    );
  });

  it('reports cloud candidate jobs ready without any local model', async () => {
    const { client } = application({
      '/api/nightshift/jobs/readiness': {
        ready: true,
        cli_available: true,
        runtime_reachable: true,
        schema_compatible: true,
        cloud_enforced: true,
        cloud_compute_available: true,
        local_only_enforced: true,
        local_compute_available: false,
      },
    });
    const rows = await client.startupChecks();
    expect(rows.find((value) => value.id === 'nightshift-jobs')?.status).toBe(
      'READY',
    );
    expect(
      rows.find((value) => value.id === 'nightshift-inference')?.status,
    ).toBe('UNVERIFIED');
  });

  it('distinguishes deliberately disabled inspection from a failed connection', async () => {
    const { client } = application({
      '/api/health': { ok: true, mode: 'fixture', sampleMode: true },
    });
    const rows = await client.startupChecks();
    expect(rows.find((value) => value.id === 'agents')?.status).toBe(
      'DISABLED',
    );
    expect(
      rows.find((value) => value.id === 'nightshift-runtime')?.status,
    ).toBe('DISABLED');
    expect(rows.find((value) => value.id === 'nightshift-jobs')?.status).toBe(
      'DISABLED',
    );
  });

  it('requires release evidence before marking automatic chains ready', async () => {
    const { client } = application({
      '/api/nightshift/automation/readiness': { ready: true, released: true },
    });
    const rows = await client.startupChecks();
    expect(
      rows.find((value) => value.id === 'nightshift-automation')?.status,
    ).toBe('BLOCKED');
  });

  it('cancels all startup checks without publishing late readiness', async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = () => new Promise<Response>(() => {});
    const client = createDevApi({
      getUrl: () => 'http://localhost:5198',
      fetchImpl,
    });
    const onResult = vi.fn();
    const pending = client.startupChecks({
      signal: controller.signal,
      onResult,
    });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(onResult).not.toHaveBeenCalled();
  });
});
