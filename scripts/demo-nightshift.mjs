import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const prompt =
  'Synthetic Haze control demo. In three short bullets, describe what a PM2.5 evidence report should disclose. Do not invent measurements.';
const terminal = new Set([
  'completed',
  'sealed',
  'failed',
  'errored',
  'cancelled',
]);
const help = `Nightshift control demo (no Haze application state is changed)

  npm run nightshift:demo                         Offline fixture assertions
  npm run nightshift:demo -- --inspect             Installed schema + daemon status
  npm run nightshift:demo -- --live --n 2,4         Small local generation jobs
  npm run nightshift:demo -- --live --fleet ID     Select an existing fleet
  npm run nightshift:demo -- --live --trigger repeat --runs 2 --every-seconds 60
  npm run nightshift:demo -- --live --trigger change --watch PATH --runs 1

Options:
  --fixture | --inspect | --live   Default: fixture; only --live submits real jobs
  --n 2,4                         Attempt counts to demonstrate (1..64 each)
  --fleet ID                      Existing fleet; omitted uses runtime selection
  --judge accuracy                accuracy | consistency | creative | quality
  --budget low                    low | mid | high | max
  --privacy local-only            local-only | edge-only | cloud-ok
  --max-spend 0                    Per-job USD ceiling; 0 requires local-only
  --window now                    now | quiet (quiet only supports trigger once)
  --trigger once                  once | repeat | change; timers belong to this script
  --runs 2                        Repeat/change rounds (1..3; <=12 jobs altogether)
  --every-seconds 60               Repeat interval or file polling interval
  --watch PATH                    File whose SHA-256 changes trigger a round
  --watch-seconds 180              Overall change-watcher deadline
  --timeout-seconds 120            Completion deadline for each immediate job
  --cli PATH                      ns executable, ns.mjs, or installed ns.cmd

Repeat runs wait for the preceding job to finish. Change watches hash bytes only;
they do not upload the file. Quiet submissions remain queued for Nightshift.
No individual --lane control or native schedule is claimed by this demo.
`;

function number(value, name, min, max) {
  const parsed = Number(value);
  if (
    !String(value).trim() ||
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max
  )
    throw new Error(`${name} must be between ${min} and ${max}.`);
  return parsed;
}

function options(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      fixture: { type: 'boolean' },
      inspect: { type: 'boolean' },
      live: { type: 'boolean' },
      help: { type: 'boolean' },
      n: { type: 'string', default: '2,4' },
      fleet: { type: 'string' },
      judge: { type: 'string', default: 'accuracy' },
      budget: { type: 'string', default: 'low' },
      privacy: { type: 'string', default: 'local-only' },
      'max-spend': { type: 'string', default: '0' },
      window: { type: 'string', default: 'now' },
      trigger: { type: 'string', default: 'once' },
      runs: { type: 'string', default: '2' },
      'every-seconds': { type: 'string', default: '60' },
      watch: { type: 'string' },
      'watch-seconds': { type: 'string', default: '180' },
      'timeout-seconds': { type: 'string', default: '120' },
      cli: { type: 'string' },
    },
  });
  if (v.help) return { help: true };
  if ([v.fixture, v.inspect, v.live].filter(Boolean).length > 1)
    throw new Error('Choose one of --fixture, --inspect, or --live.');
  for (const [key, allowed] of Object.entries({
    judge: ['accuracy', 'consistency', 'creative', 'quality'],
    budget: ['low', 'mid', 'high', 'max'],
    privacy: ['local-only', 'edge-only', 'cloud-ok'],
    window: ['now', 'quiet'],
    trigger: ['once', 'repeat', 'change'],
  })) {
    if (!allowed.includes(v[key])) throw new Error(`Invalid --${key}.`);
  }
  const counts = v.n.split(',').map((value) => number(value, '--n', 1, 64));
  if (counts.length > 4 || counts.some((n) => !Number.isInteger(n)))
    throw new Error('--n accepts at most four integer attempt counts.');
  const runs = number(v.runs, '--runs', 1, 3);
  if (
    !Number.isInteger(runs) ||
    counts.length * (v.trigger === 'once' ? 1 : runs) > 12
  )
    throw new Error('Use integer --runs and at most 12 jobs per demo.');
  const maxSpend = number(v['max-spend'], '--max-spend', 0, 5);
  if (maxSpend === 0 && v.privacy !== 'local-only')
    throw new Error('--max-spend 0 requires --privacy local-only.');
  if (v.window === 'quiet' && v.trigger !== 'once')
    throw new Error('Quiet submissions support --trigger once only.');
  if (v.live && v.trigger === 'change' && !v.watch)
    throw new Error('--trigger change requires --watch PATH in live mode.');
  if (v.fleet !== undefined && (!v.fleet.trim() || v.fleet.length > 128))
    throw new Error('--fleet must be a nonempty ID of at most 128 characters.');
  return {
    mode: v.live ? 'live' : v.inspect ? 'inspect' : 'fixture',
    counts,
    fleet: v.fleet,
    judge: v.judge,
    budget: v.budget,
    privacy: v.privacy,
    maxSpend,
    window: v.window,
    trigger: v.trigger,
    runs,
    everyMs: number(v['every-seconds'], '--every-seconds', 0.1, 3600) * 1000,
    watchMs: number(v['watch-seconds'], '--watch-seconds', 1, 3600) * 1000,
    timeoutMs:
      number(v['timeout-seconds'], '--timeout-seconds', 1, 3600) * 1000,
    watch: v.watch,
    cli: v.cli,
  };
}

function envelope(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  let result;
  try {
    result = JSON.parse(lines.at(-1));
  } catch {
    throw new Error('Nightshift returned no final JSON envelope.');
  }
  if (result.ns !== 1 || typeof result.ok !== 'boolean')
    throw new Error('Nightshift returned an invalid JSON envelope.');
  if (!result.ok) {
    const code = /^[A-Z_0-9]+$/.test(result.error?.code ?? '')
      ? result.error.code
      : 'E_UNKNOWN';
    // Do not echo arbitrary daemon errors, prompts, output text, or credentials.
    throw Object.assign(new Error(`Nightshift command failed (${code}).`), {
      code,
    });
  }
  return result.data;
}

function cliClient(path, signal) {
  let command =
    path ||
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || '', 'Nightshift/cli/ns.cmd')
      : 'ns');
  let prefix = [];
  if (/\.(cmd|bat)$/i.test(command)) {
    const script = join(dirname(resolve(command)), 'ns.mjs');
    if (!existsSync(script))
      throw new Error(
        'Cannot find ns.mjs beside the Windows launcher; use --cli PATH.',
      );
    const bundledNode = resolve(dirname(script), '../node/node.exe');
    command = existsSync(bundledNode) ? bundledNode : process.execPath;
    prefix = [script];
  } else if (/\.m?js$/i.test(command)) {
    prefix = [resolve(command)];
    command = process.execPath;
  }
  return async (args, { cleanup = false } = {}) => {
    let stdout;
    let failed = false;
    try {
      ({ stdout } = await execute(
        command,
        [...prefix, ...args, '--json', '--timeout', '5000'],
        {
          cwd: root,
          timeout: 15_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          // Direct argv invocation avoids shell interpretation of prompts/IDs.
          ...(cleanup ? {} : { signal }),
        },
      ));
    } catch (error) {
      failed = true;
      stdout = typeof error.stdout === 'string' ? error.stdout : '';
      if (!stdout.trim())
        throw new Error(
          'Nightshift CLI unavailable, interrupted, or timed out. Use --cli PATH and check the runtime.',
        );
    }
    const data = envelope(stdout);
    if (failed)
      throw new Error('Nightshift exited unsuccessfully despite its response.');
    return data;
  };
}

function generateArgs(o, n) {
  return [
    'generate',
    '--prompt',
    prompt,
    '--n',
    String(n),
    '--judge',
    o.judge,
    '--budget',
    o.budget,
    '--privacy',
    o.privacy,
    '--max-spend',
    String(o.maxSpend),
    '--window',
    o.window,
    ...(o.fleet ? ['--fleet', o.fleet] : []),
  ];
}

function supported(schema, o) {
  const flags = schema.commands?.find((c) => c.command === 'generate')?.flags;
  for (const arg of generateArgs(o, o.counts[0]).filter((a) =>
    a.startsWith('--'),
  )) {
    if (!flags?.[arg.slice(2)])
      throw new Error(
        `Installed CLI does not advertise ${arg}; no job was submitted.`,
      );
  }
  for (const key of ['judge', 'budget', 'privacy', 'window']) {
    if (!flags[key].values?.includes(o[key]))
      throw new Error(`Installed CLI does not advertise the requested ${key}.`);
  }
  return flags;
}

async function fingerprint(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    size += bytes.length;
    if (size > 1024 * 1024)
      throw new Error('Watch files must be at most 1 MiB.');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

async function runTriggers(o, { round, sleep, now, readHash, signal }) {
  if (o.trigger === 'once') return round('manual', 1);
  if (o.trigger === 'repeat') {
    for (let i = 1; i <= o.runs; i++) {
      signal?.throwIfAborted();
      if (i > 1) await sleep(o.everyMs);
      // The next interval starts after completion: remote jobs never overlap.
      await round('repeat', i);
    }
    return;
  }
  let previous = await readHash();
  let rounds = 0;
  const deadline = now() + o.watchMs;
  while (rounds < o.runs) {
    signal?.throwIfAborted();
    if (now() >= deadline)
      throw new Error(
        'Change watcher expired before all requested changes arrived.',
      );
    await sleep(Math.min(o.everyMs, deadline - now()));
    const current = await readHash();
    if (current === previous) continue;
    await round(`file_changed:${current.slice(0, 12)}`, ++rounds);
    previous = current;
  }
}

function jobRunner(o, { invoke, record, sleep, now, log, signal }) {
  return async (reason, round) => {
    for (const n of o.counts) {
      signal?.throwIfAborted();
      const requested = {
        n,
        fleet: o.fleet ?? null,
        judge: o.judge,
        budget: o.budget,
        privacy: o.privacy,
        max_spend: o.maxSpend,
        window: o.window,
      };
      // Journal intent before dispatch. A missing acknowledgement is not retryable.
      await record({ type: 'submission_intent', round, reason, requested });
      let submitted;
      try {
        submitted = await invoke(generateArgs(o, n));
      } catch (error) {
        await record({
          type: 'submission_unconfirmed',
          code: error.code ?? null,
        });
        throw new Error(
          'Submission failed or its outcome is unknown; it was not retried. Reconcile with ns job list before resubmitting.',
        );
      }
      const id = submitted?.job_id ?? submitted?.job?.id ?? submitted?.id;
      if (typeof id !== 'string' || !id)
        throw new Error(
          'Submission returned no job ID; do not resubmit automatically.',
        );
      await record({ type: 'submitted', job_id: id, requested });
      log(
        `SUBMITTED ${id}: n=${n}, fleet=${o.fleet ?? '(runtime selection)'}, ${o.window}`,
      );
      if (o.window === 'quiet') {
        await record({ type: 'queued_for_quiet_window', job_id: id });
        continue;
      }
      let finished = false;
      try {
        const deadline = now() + o.timeoutMs;
        for (;;) {
          signal?.throwIfAborted();
          if (now() >= deadline)
            throw new Error(`Completion deadline expired for ${id}.`);
          const response = await invoke(['job', 'get', id]);
          const job = response.job ?? response;
          if (terminal.has(job.status)) {
            finished = true;
            await record({
              type: 'settled',
              job_id: id,
              status: job.status,
              observed_fleet_id:
                typeof job.fleet_id === 'string' ? job.fleet_id : null,
            });
            if (!['completed', 'sealed'].includes(job.status))
              throw new Error(`Demo job ${id} ended with ${job.status}.`);
            const outcome = await invoke(['job', 'outcome', id]);
            const status = outcome.status ?? outcome.outcome?.status;
            const recordedOutcome = [
              'accepted',
              'rejected',
              'undecided',
            ].includes(status)
              ? status
              : 'unknown';
            await record({
              type: 'outcome',
              job_id: id,
              outcome: recordedOutcome,
            });
            log(
              `SETTLED ${id}: ${job.status}; Nightshift outcome=${recordedOutcome}`,
            );
            break;
          }
          await sleep(Math.min(2000, Math.max(0, deadline - now())));
        }
      } finally {
        if (!finished) {
          await record({ type: 'cancel_requested', job_id: id });
          try {
            await invoke(['job', 'cancel', id], { cleanup: true });
            await record({ type: 'cancel_acknowledged', job_id: id });
          } catch {
            await record({ type: 'cancel_unconfirmed', job_id: id });
            log(
              `Cancellation unconfirmed for ${id}; inspect it in Nightshift.`,
            );
          }
        }
      }
    }
  };
}

async function fixtureDemo(record, directory) {
  console.log(
    'FIXTURE ONLY: synthetic daemon replies and a virtual clock; no models run.',
  );
  let checks = 0;
  let nextFixtureId = 1;
  const base = options([]);
  function harness(overrides = {}) {
    const o = { ...base, ...overrides };
    let clock = 0;
    const calls = [];
    const jobs = new Map();
    const events = [];
    const sleep = async (ms) => {
      clock += ms;
    };
    const invoke = async (args) => {
      calls.push(args);
      if (args[0] === 'generate') {
        const params = Object.fromEntries(
          Array.from({ length: (args.length - 1) / 2 }, (_, i) => [
            args[1 + i * 2],
            args[2 + i * 2],
          ]),
        );
        const id = `fixture-${nextFixtureId++}`;
        jobs.set(id, {
          id,
          fleet_id: params['--fleet'] ?? null,
          status: params['--window'] === 'quiet' ? 'queued' : 'running',
          polls: 0,
        });
        return { job_id: id };
      }
      const job = jobs.get(args[2]);
      assert(job, 'Fixture job must exist.');
      if (args[1] === 'get') {
        job.polls++;
        if (job.polls > 1 && !o.stall) job.status = 'completed';
        return job;
      }
      if (args[1] === 'outcome') return { status: 'undecided' };
      if (args[1] === 'cancel') {
        job.status = 'cancelled';
        return { requested: true };
      }
      throw new Error('Unexpected fixture command.');
    };
    const round = jobRunner(o, {
      invoke,
      sleep,
      now: () => clock,
      log: () => {},
      record: async (event) => {
        events.push(event);
        await record({ ...event, fixture: true });
      },
    });
    return { o, calls, jobs, events, round, sleep, now: () => clock };
  }
  const pass = (name) => {
    checks++;
    console.log(`PASS ${name}`);
  };
  const first = harness({ fleet: 'fixture-haze-research' });
  await first.round('manual', 1);
  const submissions = first.calls.filter((a) => a[0] === 'generate');
  assert.deepEqual(
    submissions.map((a) => a[a.indexOf('--n') + 1]),
    ['2', '4'],
  );
  assert(
    submissions.every(
      (a) => a[a.indexOf('--fleet') + 1] === 'fixture-haze-research',
    ),
  );
  assert(
    first.events
      .filter((e) => e.type === 'outcome')
      .every((e) => e.outcome === 'undecided'),
  );
  pass('attempt counts 2/4 and selected fleet reach the generation command');

  const repeat = harness({
    counts: [1],
    trigger: 'repeat',
    runs: 2,
    everyMs: 10,
  });
  let active = 0;
  let peak = 0;
  await runTriggers(repeat.o, {
    ...repeat,
    round: async (...args) => {
      peak = Math.max(peak, ++active);
      await repeat.round(...args);
      active--;
    },
  });
  assert.equal(repeat.jobs.size, 2);
  assert.equal(peak, 1);
  assert([...repeat.jobs.values()].every((j) => j.status === 'completed'));
  pass('repeat timer submits two rounds without overlapping work');

  const change = harness({
    counts: [1],
    trigger: 'change',
    runs: 2,
    everyMs: 10,
  });
  const watchFile = join(directory, 'fixture-watch.txt');
  await writeFile(watchFile, 'A');
  const updates = ['A', 'B', 'B', 'C'];
  let polls = 0;
  await runTriggers(change.o, {
    ...change,
    sleep: async (ms) => {
      await change.sleep(ms);
      await writeFile(watchFile, updates.shift() ?? 'C');
      polls++;
    },
    readHash: () => fingerprint(watchFile),
  });
  assert.equal(change.jobs.size, 2);
  assert.equal(polls, 4);
  assert.deepEqual(
    change.events
      .filter((e) => e.type === 'submission_intent')
      .map((e) => e.reason),
    ['B', 'C'].map(
      (text) =>
        `file_changed:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
    ),
  );
  pass(
    'change trigger ignores unchanged snapshots and dispatches once per change',
  );

  const quiet = harness({ counts: [1], window: 'quiet' });
  await quiet.round('manual', 1);
  assert.equal([...quiet.jobs.values()][0].status, 'queued');
  assert(!quiet.events.some((e) => e.type === 'settled'));
  pass('quiet submission stays queued; completion is never invented');

  let dispatches = 0;
  const uncertain = jobRunner(base, {
    invoke: async () => {
      dispatches++;
      throw new Error('Simulated lost acknowledgement.');
    },
    record: async () => {},
    log: () => {},
    sleep: async () => {},
    now: () => 0,
  });
  await assert.rejects(uncertain('manual', 1), /not retried/);
  assert.equal(dispatches, 1);
  pass('unknown submission outcome stops immediately without retry');

  const stalled = harness({ counts: [1], timeoutMs: 5, stall: true });
  await assert.rejects(stalled.round('manual', 1), /deadline expired/);
  assert.equal(stalled.calls.filter((a) => a[1] === 'cancel').length, 1);
  pass('completion timeout requests cancellation of the demo job');

  const data = { ns: 1, ok: true, t: 'result', data: { job_id: 'fixture' } };
  assert.deepEqual(
    envelope(`{"ns":1,"t":"progress"}\n${JSON.stringify(data)}\n`),
    data.data,
  );
  assert.throws(
    () => envelope('{"ns":1,"ok":false,"error":{"code":"E_UNREACHABLE"}}'),
    /E_UNREACHABLE/,
  );
  assert.throws(() => envelope('{"ns":1,"t":"progress"}'), /invalid/);
  pass('NDJSON final envelopes and typed failures are interpreted correctly');

  assert.throws(() => options(['--n', '2,,4']));
  assert.throws(() => options(['--n', '65']));
  assert.throws(() => options(['--lane', 'invented']));
  assert.throws(() => options(['--privacy', 'cloud-ok']));
  assert.throws(
    () => supported({ commands: [] }, base),
    /no job was submitted/,
  );
  pass(
    'invalid counts, unsupported lane flags, and missing CLI controls fail early',
  );
  console.log(
    `${checks}/${checks} fixture checks passed. Live integration remains unverified.`,
  );
  return checks;
}

async function main() {
  const o = options(process.argv.slice(2));
  if (o.help) return console.log(help);
  await mkdir(join(root, 'tmp'), { recursive: true });
  const directory = await mkdtemp(join(root, 'tmp/nightshift-controls-'));
  const reportPath = join(directory, 'report.json');
  const journalPath = join(directory, 'journal.jsonl');
  const report = {
    version: 1,
    mode: o.mode,
    status: 'running',
    recorded_at: new Date().toISOString(),
    native_controls: [
      'n',
      'fleet',
      'judge',
      'budget',
      'privacy',
      'max-spend',
      'window',
    ],
    script_controls: ['repeat', 'file_change'],
    events: [],
  };
  const record = async (event) => {
    const entry = { at: new Date().toISOString(), mode: o.mode, ...event };
    await appendFile(journalPath, `${JSON.stringify(entry)}\n`);
    report.events.push(entry);
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    await record({ type: 'demo_started' });
    if (o.mode === 'fixture') {
      report.checks_passed = await fixtureDemo(record, directory);
      report.status = 'fixture-passed';
      return;
    }
    const invoke = cliClient(o.cli, controller.signal);
    const schema = await invoke(['schema']);
    const flags = supported(schema, o);
    report.advertised_flags = Object.keys(flags);
    console.log(`Installed CLI controls: ${Object.keys(flags).join(', ')}`);
    console.log(
      'Fleet selection is native; individual lane editing and repeat/change scheduling are not CLI commands.',
    );
    let status;
    try {
      status = await invoke(['status']);
      report.runtime = {
        reachable: status.engine_reachable ?? null,
        ready: status.engine_ready ?? null,
      };
      console.log(
        `Runtime reachable=${report.runtime.reachable}; ready=${report.runtime.ready}`,
      );
    } catch (error) {
      report.runtime = { status: 'unavailable', code: error.code ?? null };
      if (o.mode === 'live') throw error;
      report.status = 'schema-only';
      console.log(
        `${error.message} Schema was inspected; no live control was verified.`,
      );
      return;
    }
    if (o.mode === 'inspect') {
      report.status = 'inspected';
      return;
    }
    if (status.engine_ready !== true)
      throw new Error('Runtime is not ready; no demo job was submitted.');
    await invoke(['discover']);
    const count = o.counts.length * (o.trigger === 'once' ? 1 : o.runs);
    console.log(
      `LIVE: at most ${count} jobs; n=${o.counts.join(',')}; privacy=${o.privacy}; USD ceiling/job=${o.maxSpend}.`,
    );
    const sleep = (ms) => delay(ms, undefined, { signal: controller.signal });
    const round = jobRunner(o, {
      invoke,
      record,
      sleep,
      now: Date.now,
      signal: controller.signal,
      log: console.log,
    });
    await runTriggers(o, {
      round,
      sleep,
      now: Date.now,
      signal: controller.signal,
      readHash: () => fingerprint(o.watch),
    });
    report.status =
      o.window === 'quiet' ? 'submitted-quiet-jobs' : 'live-demo-completed';
  } catch (error) {
    report.status = 'failed';
    report.failure = error.message;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report: ${reportPath}`);
    console.log(`Submission journal: ${journalPath}`);
  }
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
