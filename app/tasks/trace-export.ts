import { createHash } from 'node:crypto';
import type {
  Artifact,
  ArtifactRef,
  JsonValue,
} from '../contracts/artifacts.js';
import { artifactRefSchema } from '../contracts/artifacts.js';
import { traceRecordSchema, type TraceRecord } from '../contracts/trace.js';
import {
  evidenceBundleSchema,
  tracePageSchema,
  type EvidenceBundle,
  type TracePage,
} from '../contracts/trace-export.js';
import {
  TaskError,
  type TaskIdentity,
  type TaskRecord,
} from '../contracts/tasks.js';
import type { TaskStore } from './store.js';
import { createTraceSanitizer } from './trace-sanitize.js';
import { renderTraceSummary } from './trace-summary.js';

export const MAX_EVIDENCE_BUNDLE_BYTES = 32 * 1024 * 1024;
export const MAX_TRACE_PAGE_BYTES = 1024 * 1024;
const terminal = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const refKey = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;
const copyJson = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

function completeness(records: TraceRecord[]) {
  return {
    native: records.filter((record) => record.provenance.capture === 'native')
      .length,
    reconstructed: records.filter(
      (record) => record.provenance.capture === 'reconstructed',
    ).length,
    omissions: [
      ...new Set(records.flatMap((record) => record.provenance.omissions)),
    ],
  };
}
function collectStrings(value: unknown, result: string[]) {
  if (typeof value === 'string') {
    result.push(value);
    result.push(...value.split(/\r?\n/).filter((line) => line.length >= 8));
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, result);
  }
}
function collectRefs(
  value: unknown,
  refs: Map<string, ArtifactRef>,
  depth = 0,
) {
  if (!value || typeof value !== 'object' || depth > 32) return;
  const ref = artifactRefSchema.safeParse(value);
  if (ref.success) {
    refs.set(refKey(ref.data), ref.data);
    return;
  }
  for (const item of Object.values(value)) collectRefs(item, refs, depth + 1);
}

/** Synchronous snapshots keep every read at one SQLite cursor boundary. */
export class TraceExportService {
  constructor(
    private readonly store: TaskStore,
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      sinkHealth?: () => JsonValue;
      /** Trusted composition registration; never inferred from a source URL. */
      publicEvidenceKinds?: readonly string[];
    } = {},
  ) {}

  private selected(taskId: string, runId: string, identity: TaskIdentity) {
    const task = this.store.read(taskId, identity);
    const run = task.runs.find((item) => item.id === runId);
    if (!run)
      throw new TaskError(
        404,
        'run_not_found',
        'Run is not part of this task.',
      );
    return { task, run };
  }

  sanitizerForRun(taskId: string, runId: string, identity: TaskIdentity) {
    const { task, run } = this.selected(taskId, runId, identity);
    return this.sanitizer(task, run.objective_revision, identity, runId);
  }

  private sanitizer(
    task: TaskRecord,
    objectiveRevision: number,
    identity: TaskIdentity,
    runId: string,
  ) {
    const withheldSources: string[] = [];
    const refs = new Map<string, ArtifactRef>();
    collectRefs(task.original_request.context_refs, refs);
    collectRefs(
      task.corrections
        .filter((item) => item.objective_revision <= objectiveRevision)
        .flatMap((item) => item.context_refs ?? []),
      refs,
    );
    for (const row of this.store.db
      .prepare(
        "SELECT body FROM artifacts WHERE principal=? AND workspace=? AND json_extract(body,'$.task_id')=? AND json_extract(body,'$.run_id')=?",
      )
      .all(identity.principal, identity.workspace, task.id, runId) as {
      body: string;
    }[]) {
      const artifact = JSON.parse(row.body) as Artifact;
      refs.set(refKey(artifact), {
        id: artifact.id,
        version: artifact.version,
        sha256: artifact.sha256,
      });
    }
    const deniedReferences = new Set<string>();
    // Source bytes are used only to remove copied text; they are never exported.
    for (const ref of refs.values()) {
      try {
        // This internal read is solely a deny-list input. Revoking disclosure
        // must not allow an old copied upload to reappear in a trace summary.
        const row = this.store.db
          .prepare(
            'SELECT body FROM artifacts WHERE id=? AND principal=? AND workspace=?',
          )
          .get(ref.id, identity.principal, identity.workspace) as
          { body: string } | undefined;
        const artifact = row ? (JSON.parse(row.body) as Artifact) : undefined;
        if (
          artifact &&
          artifact.version === ref.version &&
          artifact.sha256 === ref.sha256
        ) {
          let denied = false;
          try {
            this.store.artifact(ref.id, identity, ref);
          } catch {
            denied = true;
            deniedReferences.add(refKey(ref));
          }
          if (
            denied ||
            artifact.producer.kind === 'user' ||
            artifact.evidence_origin === 'user_supplied'
          )
            collectStrings(artifact.content, withheldSources);
          for (const dependency of artifact.dependencies)
            refs.set(refKey(dependency), dependency);
        }
      } catch {
        /* Corrupt/unavailable originals cannot supply a masking input. */
      }
    }
    const sanitizer = createTraceSanitizer(
      this.options.env ?? process.env,
      withheldSources,
    );
    return {
      ...sanitizer,
      deniedReferences,
      sanitize: (value: unknown): JsonValue => {
        const record = traceRecordSchema.safeParse(value);
        if (
          record.success &&
          record.data.artifacts.some((ref) => deniedReferences.has(refKey(ref)))
        )
          return sanitizer.sanitize({
            ...record.data,
            summary:
              'Details withheld because referenced evidence is unavailable or its disclosure grant was revoked.',
            details: { withheld_reason: 'artifact_disclosure_denied' },
          });
        return sanitizer.sanitize(value);
      },
    };
  }

  page(
    taskId: string,
    runId: string,
    identity: TaskIdentity,
    after = 0,
    limit = 100,
  ): TracePage {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new TaskError(
        400,
        'invalid_query',
        'Use a nonnegative cursor and limit from 1 to 100.',
      );
    return this.store.transaction(() => {
      const { task, run } = this.selected(taskId, runId, identity);
      const boundary = this.boundary();
      const sanitize = this.sanitizer(
        task,
        run.objective_revision,
        identity,
        runId,
      );
      const candidates = this.store.listTraceRecords(
        taskId,
        runId,
        identity,
        after,
        limit + 1,
        boundary,
      );
      const records: TraceRecord[] = [];
      let used = 4096;
      for (const candidate of candidates.slice(0, limit)) {
        const record = traceRecordSchema.parse(sanitize.sanitize(candidate));
        const size = bytes(record);
        if (used + size > MAX_TRACE_PAGE_BYTES) {
          if (!records.length)
            throw new TaskError(
              413,
              'trace_record_too_large',
              'This trace record exceeds the JSON page limit; use a download.',
            );
          break;
        }
        records.push(record);
        used += size;
      }
      return tracePageSchema.parse({
        schema_version: 'haze.trace.page.v1',
        task_id: taskId,
        run_id: runId,
        records,
        next_cursor: records.at(-1)?.cursor ?? after,
        has_more: candidates.length > records.length,
        snapshot_cursor: boundary,
        active_snapshot: !terminal.has(run.status),
        completeness: completeness(records),
        ...(this.options.sinkHealth
          ? { sink_health: this.options.sinkHealth() }
          : {}),
      });
    });
  }

  private boundary() {
    return (
      this.store.db
        .prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events')
        .get() as { cursor: number }
    ).cursor;
  }

  bundle(
    taskId: string,
    runId: string,
    identity: TaskIdentity,
  ): EvidenceBundle {
    return this.store.transaction(() => {
      const { task, run } = this.selected(taskId, runId, identity);
      const boundary = this.boundary();
      const sanitize = this.sanitizer(
        task,
        run.objective_revision,
        identity,
        runId,
      );
      const records: TraceRecord[] = [];
      let after = 0,
        size = 0;
      while (true) {
        const batch = this.store.listTraceRecords(
          taskId,
          runId,
          identity,
          after,
          100,
          boundary,
        );
        if (!batch.length) break;
        for (const item of batch) {
          const record = traceRecordSchema.parse(sanitize.sanitize(item));
          size += bytes(record);
          this.assertSize(size);
          records.push(record);
        }
        after = batch.at(-1)!.cursor;
      }
      const manager = this.store.managerStateForRun(taskId, runId, identity);
      const output = this.store.runResult(taskId, runId, identity);
      const assignments = task.assignments.filter(
        (item) => item.run_id === runId,
      );
      const histories = this.rows(
        `SELECT h.body FROM assignment_history h JOIN assignments a ON a.id=h.assignment_id WHERE a.task_id=? AND a.run_id=? ORDER BY h.rowid`,
        taskId,
        runId,
      );
      const attempts = this.store
        .attempts(taskId, identity)
        .filter((item) => item.run_id === runId)
        .map((item) => {
          const attempt = { ...item };
          delete attempt.output;
          return attempt;
        });
      const channelHistory = this.rows(
        'SELECT h.body FROM channel_history h JOIN runs r ON r.id=h.run_id WHERE r.task_id=? AND r.id=? ORDER BY h.revision',
        taskId,
        runId,
      );
      const channels = this.rows(
        'SELECT body FROM channels WHERE task_id=? AND run_id=? ORDER BY rowid',
        taskId,
        runId,
      );
      const peerMessages = this.rows(
        'SELECT m.body FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.task_id=? AND c.run_id=? ORDER BY m.rowid',
        taskId,
        runId,
      );
      const refs = new Map<string, ArtifactRef>();
      collectRefs(records, refs);
      collectRefs(output, refs);
      collectRefs(assignments, refs);
      collectRefs(task.original_request.context_refs, refs);
      collectRefs(
        task.corrections
          .filter((item) => item.objective_revision <= run.objective_revision)
          .flatMap((item) => item.context_refs ?? []),
        refs,
      );
      const artifacts: EvidenceBundle['artifacts'] = [];
      const omissions: EvidenceBundle['manifest']['omissions'] = [
        {
          subject: 'raw model/tool prompts and source copies',
          reason:
            'Raw bodies, copied uploaded text and provider output bodies are withheld by the shared sanitization policy.',
        },
      ];
      const queue = [...refs.values()];
      for (let index = 0; index < queue.length; index++) {
        if (queue.length > 10000)
          throw new TaskError(
            413,
            'export_too_large',
            'Evidence bundle exceeds the supported artifact count.',
          );
        const ref = queue[index]!;
        let artifact: Artifact;
        try {
          artifact = this.store.artifact(ref.id, identity, ref);
        } catch (error) {
          omissions.push({
            subject: refKey(ref),
            reason:
              error instanceof TaskError ? error.code : 'artifact_unavailable',
          });
          continue;
        }
        for (const dependency of artifact.dependencies) {
          if (!refs.has(refKey(dependency))) {
            refs.set(refKey(dependency), dependency);
            queue.push(dependency);
          }
        }
        if (
          artifact.producer.kind === 'user' ||
          artifact.evidence_origin === 'user_supplied' ||
          artifact.kind === 'source.import'
        ) {
          omissions.push({
            subject: refKey(ref),
            reason: 'Uploaded original content is withheld.',
          });
          continue;
        }
        if (!this.permittedArtifact(artifact)) {
          omissions.push({
            subject: refKey(ref),
            reason:
              'Unsupported source content: no registered public/fixture or derived provenance.',
          });
          continue;
        }
        const content = sanitize.sanitize(artifact.content);
        const exported = `${JSON.stringify(content)}\n`;
        size += Buffer.byteLength(exported);
        this.assertSize(size);
        artifacts.push({
          original_ref: ref,
          filename: `artifact-${String(artifacts.length + 1).padStart(4, '0')}.json`,
          exported_sha256: createHash('sha256').update(exported).digest('hex'),
          content,
          provenance: sanitize.sanitize({
            kind: artifact.kind,
            producer: artifact.producer,
            mode: task.mode,
            evidence_origin: artifact.evidence_origin ?? 'derived',
            dependencies: artifact.dependencies,
            created_at: artifact.created_at,
            source_location: artifact.source_location,
          }),
        });
      }
      const result: EvidenceBundle = {
        schema_version: 'haze.evidence-bundle.v1',
        manifest: {
          schema_version: 'haze.trace.manifest.v1',
          task_id: taskId,
          run_id: runId,
          snapshot_cursor: boundary,
          active_snapshot: !terminal.has(run.status),
          status: run.status,
          mode: task.mode,
          capture: completeness(records),
          omissions,
          sanitization:
            'haze.trace.sanitization.v1; exported_sha256 hashes UTF-8 JSON plus newline, independently of original_ref.sha256',
          created_at: new Date().toISOString(),
          ...(this.options.sinkHealth
            ? { sink_health: this.options.sinkHealth() }
            : {}),
        },
        records,
        summary: renderTraceSummary(records),
        input: sanitize.sanitize(task.original_request),
        output:
          output && sanitize.deniedReferences.size > 0
            ? {
                withheld: true,
                reason:
                  'Referenced artifact disclosure is unavailable or revoked.',
              }
            : sanitize.sanitize(output ?? null),
        artifacts,
        context: sanitize.sanitize({
          run,
          corrections: task.corrections.filter(
            (item) => item.objective_revision <= run.objective_revision,
          ),
          assignments,
          assignment_history: histories,
          attempts,
          channels,
          channel_history: channelHistory,
          peer_messages: peerMessages,
          manager: manager ?? null,
          historical_context: manager
            ? 'saved exact-run manager state'
            : 'manager state unavailable for selected run',
        }),
      };
      if (output && sanitize.deniedReferences.size > 0)
        result.manifest.omissions.push({
          subject: 'saved result',
          reason:
            'Saved result text is withheld because referenced artifact disclosure is unavailable or revoked.',
        });
      this.assertSize(bytes(result));
      return evidenceBundleSchema.parse(result);
    });
  }

  private permittedArtifact(artifact: Artifact) {
    if (artifact.evidence_origin === 'external_source')
      return (
        artifact.producer.kind === 'service' &&
        (this.options.publicEvidenceKinds ?? []).includes(artifact.kind)
      );
    return (
      artifact.evidence_origin === 'synthetic_fixture' ||
      artifact.evidence_origin === 'derived' ||
      (artifact.producer.kind === 'assignment' &&
        !/^source[.:-]/i.test(artifact.kind))
    );
  }
  private rows(sql: string, taskId: string, runId: string): JsonValue[] {
    return (
      this.store.db.prepare(sql).all(taskId, runId) as { body: string }[]
    ).map((row) => copyJson(JSON.parse(row.body)));
  }
  private assertSize(size: number) {
    if (size > MAX_EVIDENCE_BUNDLE_BYTES)
      throw new TaskError(
        413,
        'export_too_large',
        'Evidence export exceeds the 32 MiB limit.',
      );
  }
  jsonl(taskId: string, runId: string, identity: TaskIdentity): string {
    return this.store.transaction(() => {
      const { task, run } = this.selected(taskId, runId, identity);
      const boundary = this.boundary();
      const sanitize = this.sanitizer(
        task,
        run.objective_revision,
        identity,
        runId,
      );
      const lines: string[] = [];
      let after = 0,
        size = 0;
      while (true) {
        const batch = this.store.listTraceRecords(
          taskId,
          runId,
          identity,
          after,
          100,
          boundary,
        );
        if (!batch.length) break;
        for (const item of batch) {
          const record = traceRecordSchema.parse(sanitize.sanitize(item));
          const line = `${JSON.stringify(record)}\n`;
          size += Buffer.byteLength(line);
          this.assertSize(size);
          lines.push(line);
        }
        after = batch.at(-1)!.cursor;
      }
      return lines.join('');
    });
  }
}
