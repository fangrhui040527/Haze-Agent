#!/usr/bin/env node
// UC-31: end-to-end HTTP contract test against the real task API.
// Boots scripts/serve-tasks.mjs --fixture on a fresh STATE_DIR, then drives the
// documented guarantees: same-origin boundary, localhost-only, Idempotency-Key
// semantics, v3-only intake, bounded bodies, rejected client identity,
// task read/events/world/control.
//
// Uses node:http (not fetch) so forbidden headers like Host are fully controllable.
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 18787 + Math.floor(Math.random() * 900);
const BASE = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${BASE}`;
const stateDir = mkdtempSync(join(tmpdir(), 'haze-api-e2e-'));

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, ...detail });
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
  if (!ok) process.stdout.write(`       ${JSON.stringify(detail)}\n`);
}

function call({ method = 'GET', path, headers = {}, body, host }) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined
        ? null
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const hdrs = { ...headers };
    if (payload) {
      hdrs['content-length'] = String(payload.length);
      if (!hdrs['content-type']) hdrs['content-type'] = 'application/json';
    }
    if (host) hdrs.host = host;
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, method, path, headers: hdrs },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Standard well-formed mutation headers.
const mut = (key) => ({
  origin: ORIGIN,
  'idempotency-key': key,
  'content-type': 'application/json',
});
const V3 = 'haze.task.request.v3';
const objective = 'Explain the evidence needed to investigate a haze episode.';

const server = spawn('node', ['scripts/serve-tasks.mjs', '--fixture'], {
  cwd: process.cwd(),
  env: { ...process.env, STATE_DIR: stateDir, HAZE_TASK_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d.toString()));
server.stderr.on('data', (d) => (serverLog += d.toString()));

const ready = await new Promise((resolve) => {
  const deadline = Date.now() + 60_000;
  const poll = setInterval(async () => {
    if (/Local Haze application API/.test(serverLog)) {
      clearInterval(poll);
      resolve(true);
    } else if (server.exitCode !== null || Date.now() > deadline) {
      clearInterval(poll);
      resolve(false);
    }
  }, 250);
});

let exitCode = 0;
try {
  if (!ready) {
    record('server boots on fresh STATE_DIR', false, {
      serverLog: serverLog.slice(-2000),
    });
    throw new Error('server did not boot');
  }
  record('server boots on fresh STATE_DIR', true, {});

  // --- read-only surface ---
  const caps = await call({ path: '/api/capabilities' });
  record(
    'GET /api/capabilities returns registered capabilities',
    caps.status === 200 && !!caps.body,
    {
      status: caps.status,
      keys: caps.body ? Object.keys(caps.body).slice(0, 8) : null,
    },
  );

  const capsQuery = await call({ path: '/api/capabilities?bogus=1' });
  record(
    'capabilities route rejects an unsupported query key',
    capsQuery.status >= 400 && capsQuery.status < 500,
    { status: capsQuery.status, code: capsQuery.body?.error?.code },
  );

  // --- transport guards ---
  const noOrigin = await call({
    method: 'POST',
    path: '/api/tasks',
    headers: {
      'idempotency-key': 'k-no-origin',
      'content-type': 'application/json',
    },
    body: { schema_version: V3, objective },
  });
  record(
    'POST without Origin rejected 403 same_origin_required',
    noOrigin.status === 403 &&
      noOrigin.body?.error?.code === 'same_origin_required',
    { status: noOrigin.status, code: noOrigin.body?.error?.code },
  );

  const badOrigin = await call({
    method: 'POST',
    path: '/api/tasks',
    headers: {
      origin: 'http://evil.example',
      'idempotency-key': 'k-bad-origin',
      'content-type': 'application/json',
    },
    body: { schema_version: V3, objective },
  });
  record(
    'POST with foreign Origin rejected 403',
    badOrigin.status === 403 &&
      badOrigin.body?.error?.code === 'same_origin_required',
    { status: badOrigin.status, code: badOrigin.body?.error?.code },
  );

  const crossSite = await call({
    path: '/api/capabilities',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  record(
    'GET with Sec-Fetch-Site: cross-site rejected 403',
    crossSite.status === 403,
    { status: crossSite.status, code: crossSite.body?.error?.code },
  );

  const foreignHost = await call({
    path: '/api/capabilities',
    host: 'evil.example',
  });
  record(
    'Non-localhost Host header rejected 403 local_only',
    foreignHost.status === 403 &&
      foreignHost.body?.error?.code === 'local_only',
    { status: foreignHost.status, code: foreignHost.body?.error?.code },
  );

  const wrongType = await call({
    method: 'POST',
    path: '/api/tasks',
    headers: {
      origin: ORIGIN,
      'idempotency-key': 'k-type',
      'content-type': 'text/plain',
    },
    body: 'plain text',
  });
  record(
    'POST non-JSON content-type rejected 415 json_required',
    wrongType.status === 415 && wrongType.body?.error?.code === 'json_required',
    { status: wrongType.status, code: wrongType.body?.error?.code },
  );

  const noKey = await call({
    method: 'POST',
    path: '/api/tasks',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: { schema_version: V3, objective },
  });
  record(
    'POST without Idempotency-Key rejected (4xx)',
    noKey.status >= 400 && noKey.status < 500,
    { status: noKey.status, code: noKey.body?.error?.code },
  );

  // --- retired protocol versions ---
  for (const retired of ['haze.task.request.v1', 'haze.task.request.v2']) {
    const r = await call({
      method: 'POST',
      path: '/api/tasks',
      headers: mut(`k-${retired}`),
      body: { schema_version: retired, objective },
    });
    const guided = JSON.stringify(r.body ?? '').includes('v3');
    record(
      `Retired ${retired} rejected with v3 guidance`,
      r.status >= 400 && r.status < 500 && guided,
      { status: r.status, code: r.body?.error?.code, mentions_v3: guided },
    );
  }

  // --- client-supplied authority must be rejected ---
  const spoof = await call({
    method: 'POST',
    path: '/api/tasks',
    headers: mut('k-spoof'),
    body: {
      schema_version: V3,
      objective,
      identity: { user: 'attacker' },
      permissions: ['admin'],
    },
  });
  record(
    'Client-supplied identity/permissions rejected',
    spoof.status >= 400 && spoof.status < 500,
    { status: spoof.status, code: spoof.body?.error?.code },
  );

  // --- happy path intake ---
  const created = await call({
    method: 'POST',
    path: '/api/tasks',
    headers: mut('k-main'),
    body: { schema_version: V3, objective },
  });
  const taskId = created.body?.task_id ?? created.body?.id;
  record(
    'POST valid v3 request admitted',
    created.status >= 200 && created.status < 300 && !!taskId,
    {
      status: created.status,
      id: taskId,
      code: created.body?.error?.code,
      bodyKeys: created.body ? Object.keys(created.body).slice(0, 10) : null,
    },
  );

  if (taskId) {
    const replay = await call({
      method: 'POST',
      path: '/api/tasks',
      headers: mut('k-main'),
      body: { schema_version: V3, objective },
    });
    const replayId = replay.body?.task_id ?? replay.body?.id;
    record(
      'Identical redelivery under same Idempotency-Key returns recorded receipt',
      replay.status >= 200 && replay.status < 300 && replayId === taskId,
      { status: replay.status, id: replayId, expected: taskId },
    );
    record(
      'Redelivery is flagged reused=true (not admitted as new work)',
      replay.body?.reused === true && created.body?.reused === false,
      {
        first_reused: created.body?.reused,
        replay_reused: replay.body?.reused,
      },
    );

    const conflict = await call({
      method: 'POST',
      path: '/api/tasks',
      headers: mut('k-main'),
      body: {
        schema_version: V3,
        objective: 'A different objective entirely.',
      },
    });
    record(
      'Different content under same Idempotency-Key fails',
      conflict.status >= 400 && conflict.status < 500,
      { status: conflict.status, code: conflict.body?.error?.code },
    );

    const read = await call({ path: `/api/tasks/${taskId}` });
    record(
      'GET /api/tasks/:id returns task',
      read.status === 200 && !!read.body,
      {
        status: read.status,
        keys: read.body ? Object.keys(read.body).slice(0, 12) : null,
      },
    );

    const ev0 = await call({ path: `/api/tasks/${taskId}/events?after=0` });
    const list0 = Array.isArray(ev0.body) ? ev0.body : (ev0.body?.events ?? []);
    record(
      'GET events?after=0 returns durable events',
      ev0.status === 200 && Array.isArray(list0),
      {
        status: ev0.status,
        count: Array.isArray(list0) ? list0.length : null,
      },
    );

    // Exclusive cursor: after=<first seq> must not re-deliver that event.
    const firstSeq =
      list0?.[0]?.cursor ?? list0?.[0]?.sequence ?? list0?.[0]?.seq;
    if (typeof firstSeq === 'number') {
      const ev1 = await call({
        path: `/api/tasks/${taskId}/events?after=${firstSeq}`,
      });
      const list1 = Array.isArray(ev1.body)
        ? ev1.body
        : (ev1.body?.events ?? []);
      const seqs = list1.map((e) => e.cursor ?? e.sequence ?? e.seq);
      record(
        'events cursor is exclusive (after=N omits N)',
        ev1.status === 200 && !seqs.includes(firstSeq),
        { status: ev1.status, firstSeq, returned: seqs.slice(0, 5) },
      );
    } else {
      record('events cursor is exclusive (after=N omits N)', false, {
        reason: 'could not determine event sequence field',
        sample: list0?.[0] ?? null,
      });
    }

    const world = await call({ path: `/api/tasks/${taskId}/world` });
    record('GET /api/tasks/:id/world responds', world.status === 200, {
      status: world.status,
      code: world.body?.error?.code,
    });

    const worldQuery = await call({
      path: `/api/tasks/${taskId}/world?bogus=1`,
    });
    record(
      'task-world route rejects an unsupported query key',
      worldQuery.status >= 400 && worldQuery.status < 500,
      { status: worldQuery.status, code: worldQuery.body?.error?.code },
    );

    // Strict query parsing: 9 sites in app/tasks/http.ts throw invalid_query for
    // unsupported/duplicate keys. These probe whether the events and task-read
    // routes apply the same policy.
    const badQuery = await call({
      path: `/api/tasks/${taskId}/events?after=0&bogus=1`,
    });
    record(
      'events route rejects an unsupported query key (policy parity with other routes)',
      badQuery.status >= 400 && badQuery.status < 500,
      { status: badQuery.status, code: badQuery.body?.error?.code },
    );

    const dupQuery = await call({
      path: `/api/tasks/${taskId}/events?after=0&after=999999`,
    });
    const dupList = Array.isArray(dupQuery.body)
      ? dupQuery.body
      : (dupQuery.body?.events ?? []);
    record(
      'events route rejects a duplicate `after` key rather than silently using the first',
      dupQuery.status >= 400 && dupQuery.status < 500,
      {
        status: dupQuery.status,
        code: dupQuery.body?.error?.code,
        returned_events: Array.isArray(dupList) ? dupList.length : null,
      },
    );

    const readQuery = await call({ path: `/api/tasks/${taskId}?bogus=1` });
    record(
      'task-read route rejects an unsupported query key',
      readQuery.status >= 400 && readQuery.status < 500,
      { status: readQuery.status, code: readQuery.body?.error?.code },
    );

    // Control: the task LIST route does validate its query keys (http.ts:277).
    const listQuery = await call({ path: '/api/tasks?bogus=1' });
    record(
      'CONTROL: task-list route rejects unsupported query key (expected to pass)',
      listQuery.status >= 400 && listQuery.status < 500,
      { status: listQuery.status, code: listQuery.body?.error?.code },
    );

    const ctl = await call({
      method: 'POST',
      path: `/api/tasks/${taskId}/control`,
      headers: mut('k-ctl-1'),
      body: { schema_version: 'haze.task.control.v3', action: 'pause' },
    });
    record(
      'POST control pause accepted or returns structured refusal',
      ctl.status === 200 ||
        (ctl.status >= 400 && ctl.status < 500 && !!ctl.body?.error?.code),
      { status: ctl.status, code: ctl.body?.error?.code, body: ctl.body },
    );

    const ctlNoFence = await call({
      method: 'POST',
      path: `/api/tasks/${taskId}/control`,
      headers: mut('k-ctl-2'),
      body: { schema_version: 'haze.task.control.v3', action: 'bogus_action' },
    });
    record(
      'Unknown control action rejected',
      ctlNoFence.status >= 400 && ctlNoFence.status < 500,
      {
        status: ctlNoFence.status,
        code: ctlNoFence.body?.error?.code,
      },
    );
  }

  // --- artifact import bounds: decoded content max 1 MiB ---
  const big = Buffer.alloc(1024 * 1024 + 512, 0x41).toString('base64');
  const oversize = await call({
    method: 'POST',
    path: '/api/artifacts',
    headers: mut('k-art-big'),
    body: {
      schema_version: 'haze.artifact.import.v3',
      filename: 'big.txt',
      media_type: 'text/plain',
      content_base64: big,
    },
  });
  record(
    'Oversize artifact (>1MiB decoded) rejected',
    oversize.status >= 400 && oversize.status < 500,
    { status: oversize.status, code: oversize.body?.error?.code },
  );

  const art = await call({
    method: 'POST',
    path: '/api/artifacts',
    headers: mut('k-art-ok'),
    body: {
      schema_version: 'haze.artifact.import.v3',
      filename: 'note.md',
      media_type: 'text/markdown',
      content_base64: Buffer.from(
        '# Note\n\nPM2.5 observation note.\n',
      ).toString('base64'),
    },
  });
  const artId = art.body?.id ?? art.body?.artifact?.id;
  record(
    'Valid artifact import accepted',
    art.status >= 200 && art.status < 300 && !!artId,
    {
      status: art.status,
      id: artId,
      code: art.body?.error?.code,
    },
  );
  if (artId) {
    const got = await call({ path: `/api/artifacts/${artId}` });
    const hasHash = JSON.stringify(got.body ?? '').includes('sha256');
    record(
      'GET artifact returns immutable record with hash',
      got.status === 200 && hasHash,
      {
        status: got.status,
        has_sha256: hasHash,
      },
    );

    const artQuery = await call({ path: `/api/artifacts/${artId}?bogus=1` });
    record(
      'artifact-read route rejects an unsupported query key',
      artQuery.status >= 400 && artQuery.status < 500,
      { status: artQuery.status, code: artQuery.body?.error?.code },
    );
  }

  const badMedia = await call({
    method: 'POST',
    path: '/api/artifacts',
    headers: mut('k-art-exe'),
    body: {
      schema_version: 'haze.artifact.import.v3',
      filename: 'x.exe',
      media_type: 'application/x-msdownload',
      content_base64: Buffer.from('MZ').toString('base64'),
    },
  });
  record(
    'Disallowed artifact media_type rejected',
    badMedia.status >= 400 && badMedia.status < 500,
    {
      status: badMedia.status,
      code: badMedia.body?.error?.code,
    },
  );

  const unknown = await call({ path: '/api/does-not-exist' });
  record('Unknown route returns 404', unknown.status === 404, {
    status: unknown.status,
  });
} catch (error) {
  record('harness completed without throwing', false, { error: String(error) });
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  if (server.exitCode === null) server.kill('SIGKILL');
}

const failed = checks.filter((c) => !c.ok);
const report = {
  use_case: 'UC-31 HTTP API end-to-end contract',
  port: PORT,
  state_dir: stateDir,
  totals: {
    total: checks.length,
    pass: checks.length - failed.length,
    fail: failed.length,
  },
  checks,
  server_log_tail: serverLog.slice(-3000),
};
writeFileSync('qa/api-e2e.json', JSON.stringify(report, null, 2));
try {
  rmSync(stateDir, { recursive: true, force: true });
} catch {
  /* keep for inspection */
}
process.stdout.write(
  `\nUC-31: ${report.totals.pass}/${report.totals.total} passed -> qa/api-e2e.json\n`,
);
if (failed.length) exitCode = 1;
process.exit(exitCode);
