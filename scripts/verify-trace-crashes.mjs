import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { TaskStore } from '../dist/tasks/store.js';
import { TraceProjectionService } from '../dist/tasks/trace-projection.js';
import { TraceExportService } from '../dist/tasks/trace-export.js';

const root = await mkdtemp(join(tmpdir(), 'haze-trace-crashes-'));
try {
  for (const stage of ['before-projection', 'after-append', 'torn-tail']) {
    const directory = join(root, stage);
    const child = spawnSync(
      process.execPath,
      ['scripts/trace-crash-worker.mjs', directory, stage],
      { windowsHide: true, encoding: 'utf8' },
    );
    assert.equal(
      child.status,
      stage === 'before-projection' ? 91 : 92,
      child.stderr,
    );
    const store = new TaskStore(join(directory, 'state'), { recover: false });
    try {
      const native = store.readTraceBatch(0, 100);
      assert.equal(native.length, 1);
      const projection = new TraceProjectionService(store, {
        directory: join(directory, 'logs'),
        env: { HAZE_TRACE_FILES: 'on', HAZE_TRACE_STDOUT: 'off' },
      });
      await projection.close();
      const task = native[0];
      const bundle = new TraceExportService(store).bundle(
        task.task_id,
        task.run_id,
        { principal: 'trace-crash', workspace: 'trace-crash' },
      );
      const lines = (
        await readFile(
          join(directory, 'logs', task.run_id, 'events.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(lines, bundle.records);
      assert.equal(
        new Set(lines.map((record) => record.event_id)).size,
        lines.length,
      );
      assert.equal(projection.health().pending_records, 0);
      console.log(
        JSON.stringify({
          stage,
          recovered_records: lines.length,
          duplicate_ids: 0,
        }),
      );
    } finally {
      store.close();
    }
  }
} finally {
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel || rel.startsWith('..'))
    throw new Error('Unsafe temporary cleanup target.');
  await rm(root, { recursive: true, force: true });
}
