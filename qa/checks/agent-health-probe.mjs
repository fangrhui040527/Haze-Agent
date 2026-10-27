#!/usr/bin/env node
// Agent health report, taken from the runtime's own endpoints rather than inferred.
//
//   GET /api/agents                -> per-role routing, definitions, capabilities, live assignments
//   GET /api/capabilities          -> registered capability cards and readiness
//   GET /api/nightshift/readiness  -> model/provider readiness per role
//
// Boots scripts/serve-tasks.mjs --fixture on a fresh STATE_DIR so nothing
// existing is touched. Reports status; it only FAILS if an agent is missing,
// unroutable, or has no capability at all.
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 19200 + Math.floor(Math.random() * 600);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const stateDir = mkdtempSync(join(tmpdir(), 'haze-agent-health-'));

const EXPECTED_ROLES = [
  'Manager',
  'HazeOps',
  'WorkerShield',
  'EvidenceCritic',
  'DamageAccountant',
];

function call(path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        method: 'GET',
        path,
        headers: { origin: ORIGIN },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(data);
          } catch {
            /* leave null */
          }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

// serve-tasks.mjs reads process.env directly and does NOT load .env itself; the
// `tasks:serve` npm script supplies the --env-file flags. Passing them here too
// means this probe sees the same provider configuration the real entry point does.
const MODE = process.argv.includes('--live') ? [] : ['--fixture'];
const server = spawn(
  'node',
  [
    '--env-file-if-exists=app/adapters/zetaris/.env.local',
    '--env-file-if-exists=.env',
    'scripts/serve-tasks.mjs',
    ...MODE,
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, STATE_DIR: stateDir, HAZE_TASK_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let log = '';
server.stdout.on('data', (d) => (log += d.toString()));
server.stderr.on('data', (d) => (log += d.toString()));

const ready = await new Promise((resolve) => {
  const deadline = Date.now() + 60_000;
  const poll = setInterval(() => {
    if (/Local Haze application API/.test(log)) {
      clearInterval(poll);
      resolve(true);
    } else if (server.exitCode !== null || Date.now() > deadline) {
      clearInterval(poll);
      resolve(false);
    }
  }, 250);
});

let report = { booted: ready };
const problems = [];

try {
  if (!ready) {
    problems.push('runtime did not boot');
    throw new Error('runtime did not boot');
  }

  const [agents, capabilities, readiness] = await Promise.all([
    call('/api/agents'),
    call('/api/capabilities'),
    call('/api/nightshift/readiness'),
  ]);

  const list = agents.body?.agents ?? [];
  const byRole = new Map(list.map((a) => [a.role, a]));

  const rows = EXPECTED_ROLES.map((role) => {
    const a = byRole.get(role);
    const route = a?.route ?? {};
    const row = {
      role,
      registered: Boolean(a),
      routed: Boolean(route.provider || route.model || route.profile),
      provider: route.provider ?? null,
      model: route.model ?? null,
      policy: route.policy ?? null,
      route_status: route.status ?? route.readiness ?? null,
      definitions: a?.definitions?.length ?? 0,
      capabilities: a?.capabilities?.length ?? 0,
      active_assignments: a?.assignments?.length ?? 0,
    };
    if (!row.registered) problems.push(`${role}: not registered`);
    else if (!row.routed) problems.push(`${role}: no model route resolved`);
    return row;
  });

  // Any extra roles the runtime exposes that this probe did not expect.
  const unexpected = list
    .map((a) => a.role)
    .filter((r) => !EXPECTED_ROLES.includes(r));

  report = {
    booted: true,
    endpoints: {
      '/api/agents': agents.status,
      '/api/capabilities': capabilities.status,
      '/api/nightshift/readiness': readiness.status,
    },
    agents: rows,
    unexpected_roles: unexpected,
    capability_count: Array.isArray(capabilities.body)
      ? capabilities.body.length
      : (capabilities.body?.capabilities?.length ?? null),
    capabilities: (Array.isArray(capabilities.body)
      ? capabilities.body
      : (capabilities.body?.capabilities ?? [])
    ).map((c) => ({
      id: c.id ?? c.capability ?? null,
      roles: c.roles ?? null,
      ready: c.ready ?? c.readiness ?? null,
    })),
    provider_readiness: {
      provider: readiness.body?.provider ?? null,
      status: readiness.body?.status ?? null,
      reason: readiness.body?.reason ?? null,
      checked_at: readiness.body?.checked_at ?? null,
      routes: (readiness.body?.routes ?? []).map((r) => ({
        role: r.role,
        provider: r.provider ?? null,
        requested_model: r.requested_model ?? null,
        configured: r.configured ?? null,
        reachability: r.reachability ?? null,
        schema_compatible: r.schema_compatible ?? null,
        live_verified: r.live_verified ?? null,
        role_evaluation: r.role_evaluation ?? null,
        policy: r.policy ?? null,
        reason: r.reason ?? null,
      })),
    },
  };

  process.stdout.write('\nAGENT HEALTH\n');
  process.stdout.write(
    '  role                registered  routed  defs  caps  active\n',
  );
  for (const r of rows)
    process.stdout.write(
      `  ${r.role.padEnd(18)} ${String(r.registered).padEnd(11)} ${String(r.routed).padEnd(7)} ${String(r.definitions).padEnd(5)} ${String(r.capabilities).padEnd(5)} ${r.active_assignments}\n`,
    );
  if (unexpected.length)
    process.stdout.write(`  other roles exposed: ${unexpected.join(', ')}\n`);

  process.stdout.write('\nMODEL ROUTES (inference readiness)\n');
  for (const r of report.provider_readiness.routes)
    process.stdout.write(
      `  ${String(r.role).padEnd(18)} provider=${r.provider ?? '-'} configured=${r.configured} reachability=${r.reachability ?? '-'} live_verified=${r.live_verified}\n` +
        (r.reason ? `  ${' '.repeat(18)} reason: ${r.reason}\n` : ''),
    );
  // Configured but unreachable means the agents can be supervised and can
  // retrieve evidence, but cannot perform model inference.
  const blocked = report.provider_readiness.routes.filter(
    (r) => r.reachability && r.reachability !== 'reachable',
  );
  report.inference_available = blocked.length === 0;
  report.blocked_routes = blocked.length;
  process.stdout.write(
    `\nrequested model: ${report.provider_readiness.routes[0]?.requested_model ?? '-'}\n`,
  );
  process.stdout.write(
    `inference available: ${report.inference_available} (${blocked.length} blocked route(s))\n`,
  );
  process.stdout.write(`capabilities registered: ${report.capability_count}\n`);
} catch (error) {
  report.error = String(error?.message ?? error);
  report.server_log_tail = log.slice(-1500);
} finally {
  if (process.platform === 'win32' && server.pid)
    spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  else server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

report.problems = problems;
report.verdict = problems.length
  ? 'DEGRADED'
  : report.inference_available === false
    ? 'STRUCTURALLY HEALTHY, INFERENCE BLOCKED (no reachable model provider)'
    : 'ALL AGENTS REGISTERED, ROUTED, CAPABILITY-BACKED AND INFERENCE-READY';
writeFileSync('qa/agent-health.json', `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`\nverdict: ${report.verdict}\n`);
if (problems.length)
  for (const p of problems) process.stdout.write(`  - ${p}\n`);
process.stdout.write('-> qa/agent-health.json\n');
process.exit(problems.length ? 1 : 0);
