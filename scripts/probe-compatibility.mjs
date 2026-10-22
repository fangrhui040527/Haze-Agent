import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifySources, verifyWorkflowPins } from './engine-sources.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

/** Sequential OS processes: no in-memory graph, saver or engine object survives. */
export async function proveCompatibility({ stateDir, env = process.env }) {
  assert(stateDir?.trim(), 'STATE_DIR must be an explicit nonempty directory');
  await verifySources(root);
  await verifyWorkflowPins(root);
  const threadId = `compat-${randomUUID()}`;
  const directory = join(resolve(stateDir), 'compatibility', threadId);
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, 'report.json');
  const report = {
    reportVersion: 1,
    recordedAt: new Date().toISOString(),
    threadId,
    stateDir: resolve(stateDir),
    requestedProvider: env.HAZE_PROVIDER?.trim() || 'offline',
    status: 'failed',
    phases: [],
  };
  try {
    for (const phase of ['start', 'resume']) {
      const { stdout } = await execute(
        process.execPath,
        [join(root, 'dist/compatibility/worker.js'), phase, threadId],
        {
          cwd: root,
          env: { ...env, STATE_DIR: resolve(stateDir) },
          timeout: 90_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      report.phases.push(JSON.parse(stdout));
    }
    const [started, resumed] = report.phases;
    assert.notEqual(started.pid, resumed.pid);
    assert.equal(started.checkpointAfter, resumed.checkpointBefore);
    assert.notEqual(resumed.checkpointBefore, resumed.checkpointAfter);
    assert.equal(started.threadId, resumed.threadId);
    assert.equal(started.state.memoryId, resumed.state.memoryId);
    assert.equal(started.state.worldEntityId, resumed.state.worldEntityId);
    assert.equal(resumed.state.recordsVerified, true);
    assert.deepEqual(resumed.state.completedNodes, [
      'capture_memory',
      'append_observation',
      'recall_after_restart',
      'probe_provider',
    ]);
    report.localCompatibility = 'passed';
    report.provider = resumed.state.providerResult;
    report.status =
      report.provider.status === 'passed'
        ? 'passed'
        : `local-passed-provider-${report.provider.status}`;
  } catch {
    report.failure =
      'Compatibility proof failed; no successful result is claimed.';
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportPath };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { report, reportPath } = await proveCompatibility({
    stateDir: process.env.STATE_DIR,
  });
  console.log(
    JSON.stringify(
      { status: report.status, reportPath, provider: report.provider },
      null,
      2,
    ),
  );
  if (
    report.status !== 'passed' &&
    report.status !== 'local-passed-provider-skipped'
  )
    process.exitCode = 1;
}
