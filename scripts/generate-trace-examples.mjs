import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { format } from 'prettier';
import { TaskStore } from '../dist/tasks/store.js';
import { TraceExportService } from '../dist/tasks/trace-export.js';
import { TraceProjectionService } from '../dist/tasks/trace-projection.js';

// Frozen local methods and an injected scripted Manager: never live verification.
const logs = resolve('logs');
function runExample(id) {
  return new Promise((resolveOutput, reject) => {
    const child = execFile(
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
          HAZE_TRACE_STDOUT: 'all',
        },
      },
      (error, stdout) => (error ? reject(error) : resolveOutput(stdout)),
    );
    // Forward the actual child stream while retaining it for evidence below.
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
}
for (const id of ['single', 'rejected-review', 'known-failure']) {
  const stdout = await runExample(id);
  const completion = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  if (!completion.passed) throw new Error(`Fixture failed: ${id}`);
  const report = JSON.parse(await readFile(completion.report, 'utf8'));
  const saved = report.cases[0].task;
  const runDirectory = join(logs, saved.current_run_id);
  await writeFile(join(runDirectory, 'stdout.txt'), stdout);
  const store = new TaskStore(join(resolve(completion.report, '..'), id), {
    recover: false,
  });
  try {
    // Reopen authority and projection, exactly as a restarted owner would.
    const projector = new TraceProjectionService(store, {
      directory: logs,
      env: { ...process.env, HAZE_TRACE_FILES: 'on', HAZE_TRACE_STDOUT: 'all' },
    });
    await projector.close();
    const exporter = new TraceExportService(store);
    const bundle = exporter.bundle(
      saved.id,
      saved.current_run_id,
      saved.identity,
    );
    const fileRecords = (
      await readFile(join(runDirectory, 'events.jsonl'), 'utf8')
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
    const consoleLines = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('[trace:'));
    const expectedLines = bundle.records.map(
      (record) =>
        `[${record.event_id}] ${record.at} ${record.actor} ${record.action}: ${record.summary}`,
    );
    if (
      !consoleLines.length ||
      JSON.stringify(consoleLines) !== JSON.stringify(expectedLines)
    )
      throw new Error(`Captured stdout disagrees with saved trace: ${id}`);
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
    await writeFile(join(destination, 'stdout.txt'), stdout);
    console.log(
      JSON.stringify({
        fixture: id,
        outcome: bundle.manifest.status,
        records: bundle.records.length,
        artifacts: bundle.artifacts.length,
        restart_agreement: true,
        stdout_agreement: true,
        stdout_capture: join(runDirectory, 'stdout.txt'),
      }),
    );
  } finally {
    store.close();
  }
}
