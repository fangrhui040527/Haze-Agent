import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { format } from 'prettier';
import { TaskStore } from '../dist/tasks/store.js';
import { TraceExportService } from '../dist/tasks/trace-export.js';
import { TraceProjectionService } from '../dist/tasks/trace-projection.js';

// Frozen local methods and an injected scripted Manager: never live verification.
const run = promisify(execFile);
const logs = resolve('.state/trace-examples', randomUUID(), 'logs');
for (const id of ['single', 'rejected-review', 'known-failure']) {
  const { stdout } = await run(
    process.execPath,
    ['scripts/evaluate-manager.mjs', '--scripted', '--case', id],
    {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        HAZE_TRACE_DIR: logs,
        HAZE_TRACE_FILES: 'on',
        HAZE_TRACE_STDOUT: 'off',
      },
    },
  );
  const completion = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  if (!completion.passed) throw new Error(`Fixture failed: ${id}`);
  const report = JSON.parse(await readFile(completion.report, 'utf8'));
  const saved = report.cases[0].task;
  const store = new TaskStore(join(resolve(completion.report, '..'), id), {
    recover: false,
  });
  try {
    // Reopen authority and projection, exactly as a restarted owner would.
    const projector = new TraceProjectionService(store, {
      directory: logs,
      env: { ...process.env, HAZE_TRACE_FILES: 'on', HAZE_TRACE_STDOUT: 'off' },
    });
    await projector.close();
    const exporter = new TraceExportService(store);
    const bundle = exporter.bundle(
      saved.id,
      saved.current_run_id,
      saved.identity,
    );
    const fileRecords = (
      await readFile(join(logs, saved.current_run_id, 'events.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const pages = [];
    let cursor = 0;
    do {
      const page = exporter.page(
        saved.id,
        saved.current_run_id,
        saved.identity,
        cursor,
        2,
      );
      pages.push(...page.records);
      cursor = page.next_cursor;
      if (!page.has_more) break;
    } while (true);
    if (
      JSON.stringify(fileRecords) !== JSON.stringify(bundle.records) ||
      JSON.stringify(pages) !== JSON.stringify(bundle.records) ||
      bundle.manifest.status !== saved.status
    )
      throw new Error(`Trace sources disagree after restart: ${id}`);
    const destination = resolve('output_examples/orchestration/traces', id);
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, 'evidence-bundle.json'),
      await format(JSON.stringify(bundle), { parser: 'json' }),
    );
    await writeFile(
      join(destination, 'summary.md'),
      await format(bundle.summary, { parser: 'markdown' }),
    );
    console.log(
      JSON.stringify({
        fixture: id,
        outcome: bundle.manifest.status,
        records: bundle.records.length,
        artifacts: bundle.artifacts.length,
        restart_agreement: true,
      }),
    );
  } finally {
    store.close();
  }
}
