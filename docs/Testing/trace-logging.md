# Execution traces and evidence exports

Every newly committed task event also creates an immutable `haze.trace.record.v1` envelope in SQLite. The existing TaskEvent v3 protocol and storage-format marker remain unchanged. Trace identifiers are stable (`trace:<event cursor>`); direct causal identifiers are separate from the Manager's consumed-event watermark. Missing causes, provider receipts and confidence are never invented.

## Capture settings

| Setting             | Default | Behavior                                                                                                                              |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `HAZE_TRACE_FILES`  | `on`    | Write `events.jsonl`, `manifest.json`, and deterministic `summary.md` under a run directory. Set `off` to disable.                    |
| `HAZE_TRACE_STDOUT` | `key`   | Print decisions, handoffs, reviews, failures and lifecycle changes with stable IDs. `all` prints every record; `off` disables stdout. |
| `HAZE_TRACE_DIR`    | `logs`  | Root of `<directory>/<run UUID>/`; relative paths resolve from the server working directory.                                          |

Filesystem and stdout work begins after the task transaction commits. Sink failure is reported in trace metadata and cannot roll back task work. Reopening the runtime reconciles the JSONL prefix against SQLite, truncates a torn or divergent suffix, and appends missing records in bounded batches. Shutdown stops execution producers before flushing tracing and closing SQLite. Stdout is best effort, bounded against a stalled sink, and does not replay historical events. A failed stdout sink is disabled for the remaining owner lifetime.

Generated `logs/` is ignored. Tests disable production sinks globally and explicitly enable temporary directories or inject stdout when checking projection behavior.

## CLI and browser

Start the local server with `npm run dev`, then use its development console:

```text
tasks trace <taskId> [--run <runId>] [--follow]
tasks export <taskId> [--run <runId>] --out "C:\Users\me\trace export"
```

The CLI uses HTTP and pins the selected run. Follow supports cancellation. Export refuses an existing output directory and uses fixed filenames, preserving original artifact references separately from hashes of exported bytes. It writes manifest, JSONL, summary, input, output, historical context, an artifact index, and permitted artifact JSON files.

The task report offers a run selector, highlights, expandable technical details, exact artifact references, causal identifiers, evidence verdicts and provenance. The saved-result panel still describes the current task result. Changing trace selection aborts stale requests; mock services without trace support explicitly show unavailable. Raw receipts remain available.

Authenticated local read endpoints:

```text
GET /api/tasks/:taskId/runs/:runId/trace?after=0&limit=100
GET /api/tasks/:taskId/runs/:runId/trace?format=jsonl
GET /api/tasks/:taskId/runs/:runId/evidence-bundle
```

JSON pages fit the transport limit and expose a next cursor. Downloads use attachment and no-store headers. Foreign task/run combinations, unsupported query keys, malformed cursors and oversized exports fail explicitly. Bundles are bounded to 32 MiB with `export_too_large`. Active runs are labelled snapshots and include their exact capture cursor.

## Evidence and sanitization

All sinks share the same policy: credential fields, authorization headers, known secret values and credential-bearing URL parts are masked. Uploaded originals and copied source bodies in prompts and receipts are withheld. Export reads exact artifact versions with the current permission and revocation checks; inaccessible or unsupported artifacts appear as omissions with reasons. Fixture evidence and permitted derived content may be included. Raw external source bodies are omitted by default. Trusted server code can register public service evidence kinds through `TaskRuntimeOptions.tracePublicEvidenceKinds` (or `TraceExportService`'s `publicEvidenceKinds`); registration never permits uploaded originals or bypasses revocation checks.

An `original_ref` identifies saved evidence. `exported_sha256` hashes the actual sanitized JSON bytes (compact JSON plus newline) and must not be interpreted as the original content hash. Manifests record provenance, omissions, native versus reconstructed capture, snapshot boundaries and available sink health. Historical Manager state and results are selected by run; absent historical context remains absent.

Older events can be reconstructed on demand for API/export with explicit missing-context labels. Automatic file projection contains native records captured after rollout. Historical reconstruction cannot establish metadata that was never saved.

## Reproducible examples

Run `npm run traces:examples` to execute three frozen, scripted scenarios and regenerate [submission examples](../../output_examples/orchestration/traces/README.md). The generator reopens SQLite and file projection, then checks agreement between paginated report data, JSONL and the bundle on complete sanitized records, exact references and final outcome. Examples demonstrate successful evidence-backed work, rejected review followed by revision, and failure followed by recovery.

Run `npm run traces:test:crashes` to exercise abrupt worker exits before projection, after JSONL append but before manifest writing, and after a torn final line. Recovery checks compare the reopened authority, files and evidence bundle and reject duplicate event IDs.

These are local deterministic fixtures/replays. They do not establish live model quality, live Zetaris retrieval or real Meterless operations. Live verification requires a separately configured run and its actual receipts.
