import { createReadStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  rename,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { TraceRecord } from '../contracts/trace.js';
import type { TaskIdentity } from '../contracts/tasks.js';
import type { TaskStore } from './store.js';
import { TraceExportService } from './trace-export.js';
import { isTraceHighlight, renderTraceSummary } from './trace-summary.js';
import type { TraceSanitizer } from './trace-sanitize.js';

export interface TraceProjectionOptions {
  exporter?: TraceExportService;
  env?: NodeJS.ProcessEnv;
  directory?: string;
  stdout?: (line: string) => void | Promise<void>;
  stdoutTimeoutMs?: number;
  batchSize?: number;
}
interface RunProgress {
  directory: string;
  fileCursor: number;
  recordCount: number;
  recent: TraceRecord[];
  captures: Set<string>;
  omissions: Set<string>;
}

/** Disposable projections: SQLite is the only authority and is never mutated here. */
export class TraceProjectionService {
  private readonly directory: string;
  private readonly filesEnabled: boolean;
  private readonly stdoutMode: 'off' | 'key' | 'all';
  private readonly batchSize: number;
  private readonly exporter: TraceExportService;
  private readonly unsubscribe: () => void;
  private readonly runs = new Map<string, RunProgress>();
  private readonly startupCursor: number;
  private stdoutCursor = 0;
  private processedCursor = 0;
  private failures = 0;
  private lastError: string | undefined;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private stdoutFailed = false;
  private readonly stdoutError = () => this.recordFailure('stdout sink failed');

  constructor(
    private readonly store: TaskStore,
    private readonly options: TraceProjectionOptions = {},
  ) {
    const env = options.env ?? process.env;
    this.directory = resolve(options.directory ?? env.HAZE_TRACE_DIR ?? 'logs');
    this.filesEnabled = !['off', 'false', '0'].includes(
      (env.HAZE_TRACE_FILES ?? 'on').toLowerCase(),
    );
    const stdout = (env.HAZE_TRACE_STDOUT ?? 'key').toLowerCase();
    this.stdoutMode = ['off', 'false', '0'].includes(stdout)
      ? 'off'
      : stdout === 'all'
        ? 'all'
        : 'key';
    this.batchSize = Math.max(1, Math.min(500, options.batchSize ?? 100));
    this.exporter = options.exporter ?? new TraceExportService(store, { env });
    this.startupCursor = this.latestCursor();
    if (!options.stdout && this.stdoutMode !== 'off')
      process.stdout.on('error', this.stdoutError);
    this.unsubscribe = store.onTraceCommitted(() => this.notify());
    this.notify();
  }

  private latestCursor(): number {
    return Number(
      this.store.db
        .prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM trace_records')
        .get()!.cursor,
    );
  }

  health() {
    const pending = Number(
      this.store.db
        .prepare('SELECT COUNT(*) AS count FROM trace_records WHERE cursor>?')
        .get(this.processedCursor)!.count,
    );
    return {
      files_enabled: this.filesEnabled,
      stdout: this.stdoutMode,
      processed_cursor: this.processedCursor,
      pending_records: pending,
      failed_operations: this.failures,
      stdout_disabled_after_failure: this.stdoutFailed,
      ...(this.lastError ? { last_error: this.lastError } : {}),
    };
  }

  private recordFailure(message: string) {
    this.failures++;
    // Exception text may itself contain a secret path or provider value.
    this.lastError = message;
  }

  private notify() {
    if (this.closed || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 0);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (!this.closed && this.lastError?.startsWith('file')) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush();
        }, 1000);
        this.timer.unref();
      } else if (!this.closed && this.latestCursor() > this.processedCursor) {
        this.notify();
      }
    });
    return this.running;
  }

  private async drain() {
    try {
      if (!this.filesEnabled && this.stdoutMode === 'off') {
        this.processedCursor = this.latestCursor();
        return;
      }
      for (;;) {
        const records = this.store.readTraceBatch(
          this.processedCursor,
          this.batchSize,
        );
        if (!records.length) return;
        const touched = new Set<RunProgress>();
        const sanitizers = new Map<
          string,
          ReturnType<TraceExportService['sanitizerForRun']>
        >();
        for (const raw of records) {
          let sanitizer = sanitizers.get(raw.run_id);
          if (!sanitizer) {
            const identity = this.store.db
              .prepare('SELECT principal,workspace FROM tasks WHERE id=?')
              .get(raw.task_id) as TaskIdentity;
            sanitizer = this.exporter.sanitizerForRun(
              raw.task_id,
              raw.run_id,
              identity,
            );
            sanitizers.set(raw.run_id, sanitizer);
          }
          const record = sanitizer.sanitize(raw) as unknown as TraceRecord;
          if (this.filesEnabled) {
            const progress = await this.runProgress(record, sanitizer);
            if (record.cursor > progress.fileCursor) {
              await appendFile(
                join(progress.directory, 'events.jsonl'),
                JSON.stringify(record) + '\n',
                'utf8',
              );
              progress.fileCursor = record.cursor;
            }
            progress.recordCount++;
            progress.captures.add(record.provenance.capture);
            for (const omission of record.provenance.omissions)
              progress.omissions.add(omission);
            progress.recent.push(record);
            if (progress.recent.length > 200) progress.recent.shift();
            touched.add(progress);
          }
          if (
            !this.stdoutFailed &&
            record.cursor > Math.max(this.startupCursor, this.stdoutCursor) &&
            this.stdoutMode !== 'off' &&
            (this.stdoutMode === 'all' || isTraceHighlight(record))
          ) {
            try {
              const line = `[${record.event_id}] ${record.at} ${record.actor} ${record.action}: ${record.summary}\n`;
              let timeout: ReturnType<typeof setTimeout> | undefined;
              try {
                const delivery = this.options.stdout
                  ? Promise.resolve(this.options.stdout(line))
                  : new Promise<void>((done, reject) =>
                      process.stdout.write(line, (error) =>
                        error ? reject(error) : done(),
                      ),
                    );
                await Promise.race([
                  delivery,
                  new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                      () => reject(new Error('stdout timeout')),
                      this.options.stdoutTimeoutMs ?? 1000,
                    );
                  }),
                ]);
              } finally {
                if (timeout) clearTimeout(timeout);
              }
            } catch {
              this.stdoutFailed = true;
              this.recordFailure('stdout sink failed');
            }
            this.stdoutCursor = record.cursor;
          }
          this.processedCursor = record.cursor;
        }
        for (const progress of touched) await this.writeMetadata(progress);
        if (!this.lastError?.startsWith('stdout')) this.lastError = undefined;
        await nextTurn();
      }
    } catch {
      this.recordFailure(
        'file projection failed; committed records remain available in SQLite',
      );
      // Reconcile complete lines again even if the failed append wrote partial bytes.
      this.processedCursor = 0;
      this.runs.clear();
    }
  }

  private async runProgress(
    record: TraceRecord,
    sanitizer: TraceSanitizer,
  ): Promise<RunProgress> {
    const saved = this.runs.get(record.run_id);
    if (saved) return saved;
    // Run identifiers are validated UUIDs by the trace contract.
    if (!/^[a-f0-9-]{36}$/i.test(record.run_id))
      throw new Error('Invalid run id');
    const directory = join(this.directory, record.run_id);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'events.jsonl');
    await appendFile(path, '', 'utf8');
    await this.repairTail(path);
    let fileCursor = 0;
    let bytes = 0;
    let expected: { cursor: number; body: string }[] = [];
    let expectedIndex = 0;
    const stream = createReadStream(path);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          const value = JSON.parse(line) as TraceRecord;
          if (
            value.run_id !== record.run_id ||
            value.task_id !== record.task_id ||
            !Number.isSafeInteger(value.cursor) ||
            value.cursor <= fileCursor ||
            value.event_id !== `trace:${value.cursor}`
          )
            break;
          if (expectedIndex >= expected.length) {
            expected = this.store.db
              .prepare(
                'SELECT cursor,body FROM trace_records WHERE task_id=? AND run_id=? AND cursor>? ORDER BY cursor LIMIT ?',
              )
              .all(
                record.task_id,
                record.run_id,
                fileCursor,
                this.batchSize,
              ) as { cursor: number; body: string }[];
            expectedIndex = 0;
          }
          const authoritative = expected[expectedIndex++];
          if (
            authoritative?.cursor !== value.cursor ||
            JSON.stringify(
              sanitizer.sanitize(JSON.parse(authoritative.body)),
            ) !== line
          )
            break;
          fileCursor = value.cursor;
          bytes += Buffer.byteLength(line) + 1;
        } catch {
          break;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if ((await stat(path)).size !== bytes) await truncate(path, bytes);
    const progress: RunProgress = {
      directory,
      fileCursor,
      recordCount: 0,
      recent: [],
      captures: new Set(),
      omissions: new Set(),
    };
    this.runs.set(record.run_id, progress);
    return progress;
  }

  private async repairTail(path: string) {
    const file = await open(path, 'r+');
    try {
      let end = (await file.stat()).size;
      const buffer = Buffer.alloc(65536);
      while (end > 0) {
        const start = Math.max(0, end - buffer.length);
        const { bytesRead } = await file.read(buffer, 0, end - start, start);
        const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
        if (newline >= 0) {
          await file.truncate(start + newline + 1);
          return;
        }
        end = start;
      }
      await file.truncate(0);
    } finally {
      await file.close();
    }
  }

  private async writeMetadata(progress: RunProgress) {
    const last = progress.recent.at(-1)!;
    const manifest = {
      schema_version: 'haze.trace.files.v1',
      task_id: last.task_id,
      run_id: last.run_id,
      snapshot_cursor: last.cursor,
      record_count: progress.recordCount,
      capture: [...progress.captures],
      omissions: [...progress.omissions],
      sink_health: this.health(),
      stdout_delivery: 'best_effort; historical records are not replayed',
      files: ['events.jsonl', 'manifest.json', 'summary.md'],
    };
    for (const [name, content] of [
      ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
      ['summary.md', renderTraceSummary(progress.recent, progress.recordCount)],
    ]) {
      const temporary = join(progress.directory, `.${name!}.tmp`);
      await writeFile(temporary, content!, 'utf8');
      await rename(temporary, join(progress.directory, name!));
    }
  }

  async close() {
    this.closed = true;
    this.unsubscribe();
    await this.flush();
    if (!this.options.stdout)
      process.stdout.removeListener('error', this.stdoutError);
  }
}
