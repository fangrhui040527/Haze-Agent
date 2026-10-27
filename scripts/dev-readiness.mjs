export const STARTUP_COMPONENTS = [
  { id: 'zetaris', label: 'Zetaris platform' },
  { id: 'build', label: 'Haze TypeScript build' },
  { id: 'web', label: 'Haze web app' },
  { id: 'tasks', label: 'Haze tasks (LangGraph)' },
  { id: 'world', label: 'World Model (SQLite)' },
  { id: 'hmem', label: 'H-MEM' },
  { id: 'hazeops', label: 'HazeOps collectors' },
  { id: 'agents', label: 'Agent model routes' },
  { id: 'nightshift-runtime', label: 'Nightshift runtime' },
  { id: 'nightshift-jobs', label: 'Nightshift candidate jobs' },
  { id: 'nightshift-inference', label: 'Nightshift inference' },
  { id: 'nightshift-automation', label: 'Nightshift automation' },
];

const text = (value) =>
  String(value ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 500);
const row = (id, status, detail) => ({ id, status, detail: text(detail) });

export function memoryReadiness(health) {
  const description = health.agents?.hmem;
  if (
    typeof description === 'string' &&
    /not enabled|disabled|archival/i.test(description)
  )
    return row(
      'hmem',
      'DISABLED',
      'Not attached to Haze tasks; historical memory is archival',
    );
  return row(
    'hmem',
    'UNKNOWN',
    'No active H-MEM readiness check is exposed by this runtime',
  );
}

export function collectorsReadiness(health) {
  const watchers = health.watchers ?? [];
  const enabled = watchers.filter((watcher) => watcher.enabled === true);
  const failed = enabled.filter((watcher) => watcher.lastOutcome === 'failed');
  const scheduler = health.hazeops?.scheduler;
  const detail = `${enabled.length}/${watchers.length} sources enabled${failed.length ? `; ${failed.length} last collection(s) failed` : ''}`;
  if (scheduler === 'disabled')
    return row('hazeops', 'DISABLED', `${health.hazeops.reason}; ${detail}`);
  if (scheduler === 'running')
    return row(
      'hazeops',
      failed.length || enabled.length !== watchers.length
        ? 'DEGRADED'
        : 'RUNNING',
      `Scheduler running; ${detail}`,
    );
  if (scheduler === 'starting')
    return row('hazeops', 'PENDING', `Scheduler initializing; ${detail}`);
  if (scheduler === 'stopped') return row('hazeops', 'STOPPED', detail);
  return row('hazeops', 'UNKNOWN', `Scheduler state unavailable; ${detail}`);
}

export function modelReadiness(id, routes) {
  if (!Array.isArray(routes) || !routes.length)
    return row(id, 'UNCONFIGURED', 'No model routes configured');
  const configured = routes.filter((route) => route.configured);
  const blocked = configured.filter(
    (route) => !route.schema_compatible || route.reachability === 'blocked',
  );
  const unreachable = configured.filter(
    (route) => route.reachability === 'unreachable',
  );
  const verified = configured.filter((route) => route.live_verified === true);
  const summary = `${configured.length}/${routes.length} roles configured`;
  if (!configured.length)
    return row(
      id,
      'UNCONFIGURED',
      routes.find((route) => route.reason)?.reason ?? summary,
    );
  if (blocked.length)
    return row(
      id,
      'BLOCKED',
      `${summary}; ${blocked[0].role}: ${blocked[0].reason ?? 'model contract unavailable'}`,
    );
  if (unreachable.length)
    return row(
      id,
      'UNREACHABLE',
      `${summary}; ${unreachable[0].reason ?? 'model endpoint unreachable'}`,
    );
  if (verified.length === routes.length)
    return row(
      id,
      'READY',
      `${routes.length} roles verified with live inference`,
    );
  return row(id, 'UNVERIFIED', `${summary}; live inference not verified`);
}

/** Probe the running app; never open a second store, submit work, or call a model. */
export async function checkStartupComponents({
  request,
  probeWeb,
  signal,
  onStart = () => {},
  onResult = () => {},
}) {
  const rows = new Map();
  const publish = (value, startedAt) => {
    if (signal?.aborted) return;
    const result = {
      ...value,
      seconds: ((Date.now() - startedAt) / 1000).toFixed(1),
    };
    rows.set(value.id, result);
    onResult(result);
  };
  const check = async (ids, operation) => {
    const startedAt = Date.now();
    ids.forEach(onStart);
    try {
      for (const result of await operation()) publish(result, startedAt);
    } catch (error) {
      if (signal?.aborted) throw error;
      for (const id of ids)
        publish(
          row(
            id,
            ['web', 'tasks', 'world'].includes(id) ? 'FAILED' : 'UNAVAILABLE',
            error.message,
          ),
          startedAt,
        );
    }
  };
  // A successful health response initializes the single runtime before parallel reads.
  let health;
  await check(['hmem'], async () => {
    health = await request('/api/health', { signal });
    if (health.ok !== true)
      throw new Error('Haze health check did not report ready.');
    return [memoryReadiness(health)];
  });
  const mode = health?.mode === 'fixture' ? ' (fixture)' : '';
  await Promise.all([
    check(['web'], async () => {
      await probeWeb(signal);
      return [row('web', 'READY', `React interface served by Vite${mode}`)];
    }),
    check(['tasks'], async () => {
      const value = await request('/api/tasks?limit=1', { signal });
      if (!Array.isArray(value.tasks))
        throw new Error('Invalid task-store response.');
      return [
        row(
          'tasks',
          'READY',
          `Task API and durable task store responding${mode}`,
        ),
      ];
    }),
    check(['world'], async () => {
      const world = await request('/api/world/records?limit=1', { signal });
      if (
        !world.counts ||
        !['records', 'relationships', 'events'].every(
          (key) =>
            Number.isSafeInteger(world.counts[key]) && world.counts[key] >= 0,
        )
      )
        throw new Error('Invalid World Model query response.');
      return [
        row(
          'world',
          'READY',
          `SQLite read OK; ${world.counts.records} records, ${world.counts.events} events${mode}`,
        ),
      ];
    }),
    check(['hazeops'], async () => [
      collectorsReadiness(await request('/api/health', { signal })),
    ]),
    check(['agents', 'nightshift-inference'], async () => {
      const value = await request('/api/nightshift/readiness', { signal });
      if (!Array.isArray(value.routes))
        throw new Error('Invalid model-route readiness response.');
      const nightshiftRoutes = value.routes.filter(
        (route) => route.provider === 'nightshift',
      );
      if (health?.sampleMode === true)
        return [
          row(
            'agents',
            'DISABLED',
            'Sample mode disables model calls and network inspection',
          ),
          nightshiftRoutes.length
            ? row(
                'nightshift-inference',
                'DISABLED',
                'Sample mode disables Nightshift inference',
              )
            : modelReadiness('nightshift-inference', nightshiftRoutes),
        ];
      return [
        modelReadiness('agents', value.routes),
        modelReadiness('nightshift-inference', nightshiftRoutes),
      ];
    }),
    check(['nightshift-runtime', 'nightshift-jobs'], async () => {
      const value = await request('/api/nightshift/jobs/readiness', { signal });
      if (
        typeof value.runtime_reachable !== 'boolean' ||
        typeof value.ready !== 'boolean'
      )
        throw new Error('Invalid Nightshift jobs readiness response.');
      if (health?.sampleMode === true)
        return [
          row(
            'nightshift-runtime',
            'DISABLED',
            'Sample mode disables Nightshift network inspection',
          ),
          row(
            'nightshift-jobs',
            'DISABLED',
            'Sample mode disables Nightshift requests',
          ),
        ];
      const ready =
        value.ready === true &&
        value.runtime_reachable === true &&
        value.schema_compatible === true &&
        ((value.cloud_enforced === true &&
          value.cloud_compute_available === true) ||
          (value.local_only_enforced === true &&
            value.local_compute_available === true));
      return [
        row(
          'nightshift-runtime',
          value.runtime_reachable ? 'RUNNING' : 'UNREACHABLE',
          value.runtime_reachable
            ? `Runtime reachable${value.runtime_version ? `; version ${value.runtime_version}` : ''}`
            : (value.reason ?? 'Nightshift runtime is not reachable'),
        ),
        row(
          'nightshift-jobs',
          ready
            ? 'READY'
            : value.cli_available === false
              ? 'UNAVAILABLE'
              : 'BLOCKED',
          ready
            ? 'Candidate generation contract and eligible compute available; no job submitted'
            : (value.reason ?? 'Candidate job requirements are not met'),
        ),
      ];
    }),
    check(['nightshift-automation'], async () => {
      const value = await request('/api/nightshift/automation/readiness', {
        signal,
      });
      if (
        typeof value.ready !== 'boolean' ||
        typeof value.released !== 'boolean'
      )
        throw new Error('Invalid Nightshift automation readiness response.');
      const ready =
        value.ready &&
        value.released &&
        ['live', 'fixture'].includes(value.evidence_kind) &&
        typeof value.evidence_id === 'string' &&
        value.evidence_id.length > 0 &&
        Array.isArray(value.gates) &&
        value.gates.length > 0 &&
        value.gates.every((gate) => gate.passed === true);
      return [
        row(
          'nightshift-automation',
          ready
            ? value.evidence_kind === 'fixture'
              ? 'FIXTURE'
              : 'READY'
            : 'BLOCKED',
          ready
            ? `Release gates passed (${value.evidence_kind ?? 'unknown'} evidence)`
            : (value.reason ?? 'Automatic chains are not released'),
        ),
      ];
    }),
  ]);
  if (signal?.aborted) throw signal.reason;
  return STARTUP_COMPONENTS.filter(({ id }) => rows.has(id)).map(({ id }) =>
    rows.get(id),
  );
}
