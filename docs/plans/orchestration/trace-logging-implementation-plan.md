# Implement verifiable execution traces in Haze

Status: implemented on 28 October 2026. See the [implementation and verification report](../../reports/orchestration/trace-logging-implementation-report.md) for changes, executed checks and limitations.

## Summary

Add automatic tracing for every Haze task run, a readable timeline in task reports, and CLI/browser exports containing sanitized evidence.

SQLite remains authoritative. Each trace connects **request → decisions → evidence → agent feedback → revisions → reviewed output** using persisted identifiers and exact artifact versions.

## 1. Durable capture and causality

- Introduce a separate versioned trace contract without changing the existing TaskEvent v3 API. Include UTC timestamp, stable event ID, source cursor, task/run IDs, agent and assignment revision, action, status, concise input/output summaries, artifact references and provenance.
- Add an additive `trace_records` table keyed by the existing event cursor. Save each immutable trace envelope in the same transaction as its task event.
- Instrument Manager decisions, assignment transitions, model/tool attempts, peer exchanges, artifact production, independent reviews, controls and final results. Preserve failed decisions and excluded late receipts.
- Record direct causes where known: decision, attempt, message and triggering event IDs. Keep the Manager's consumed-event watermark separate from direct causal relationships.
- Resolve peer-message sender/recipient IDs into actual agent roles. Link reviews to the exact artifact `{id, version, sha256}`, then link subsequent revisions and replacement reviews.
- Keep execution acceptance, evidence-review verdicts and final task status separate. Record retries independently from plan revisions, objective revisions and execution generations.
- Record actual provider/model receipts and Zetaris/Meterless operations only where exercised. Confidence remains optional and requires its subject, assessor and basis.

## 2. Automatic files, stdout and recovery

- Add a runtime-owned projection service, notified through the existing after-commit hook. Filesystem and stdout operations occur after the domain transaction commits.
- Write `events.jsonl`, `manifest.json` and a generated `summary.md` under `logs/<run_id>/`. Summaries use saved records and templates; they require no additional model calls.
- Enable these defaults:
  - `HAZE_TRACE_FILES=on`
  - `HAZE_TRACE_STDOUT=key`
  - `HAZE_TRACE_DIR=logs`
- Files contain the complete normalized event stream. Stdout contains decisions, handoffs, reviews, failures and lifecycle changes, with stable event IDs.
- Process committed records in bounded batches. On restart, reconcile file progress against SQLite, repair a torn final line and append missing records without duplicate JSONL IDs. Historical stdout delivery remains best effort and is not replayed automatically.
- Report sink health and pending progress through trace metadata. Disk/stdout failure must not invalidate committed task work.
- Flush tracing after execution producers stop and before the runtime closes SQLite. Tests use temporary directories or injected sinks.

## 3. Evidence bundles, API, CLI and UI

**Build one shared run-scoped snapshot/export service.**

- Select an exact authorized task/run and capture a consistent cursor boundary. Include its original input, saved result, decisions, assignment history, attempts, peer interactions, reviews and referenced evidence.
- Read historical Manager state and results explicitly. Never substitute the current run's state for a selected older run.
- Apply one sanitization policy across files, stdout, APIs and exports. Remove credentials, authorization headers, credential-bearing URLs and known secret values.
- Omit uploaded originals and copied source bodies in prompts/receipts. Include registered public/fixture evidence and permitted derived fields; list withheld or unsupported contents with reasons.
- Preserve original artifact references separately from exported-byte hashes. Redacted content must never appear to retain the original content hash.
- Include capture completeness, provenance, omissions and snapshot cursor in the manifest. Active-run exports are labelled snapshots.

**Add these read endpoints under the existing local authorization boundary:**

```text
GET /api/tasks/:taskId/runs/:runId/trace?after=0&limit=100
GET /api/tasks/:taskId/runs/:runId/trace?format=jsonl
GET /api/tasks/:taskId/runs/:runId/evidence-bundle
```

- Return paginated, validated trace JSON for the UI; keep pages within the existing transport size limit.
- Serve JSONL and the self-contained evidence bundle JSON as attachment downloads using dedicated response handling.
- Reject foreign task/run combinations, unsupported queries and oversized exports explicitly. Downloads use no-store headers and retain artifact permission/revocation checks.
- Bound evidence bundles to 32 MiB; return `export_too_large` instead of silently dropping evidence.

**Extend the existing development CLI:**

```text
tasks trace <taskId> [--run <runId>] [--follow]
tasks export <taskId> [--run <runId>] --out "<directory>"
```

The CLI communicates through HTTP. Export creates a new directory containing the manifest, JSONL, summary, input/output and permitted artifacts, using fixed safe filenames and refusing overwrite.

**Extend the existing task report:**

- Add a run selector, defaulting to the current run.
- Show a readable highlights timeline with expandable technical details, causal links, artifact references, review verdicts and provenance.
- Add **Download JSONL** and **Download evidence bundle**.
- Preserve the raw receipts section. Clearly distinguish historical trace selection from the current saved-result panel.
- Abort stale requests when selection changes; unsupported mock services display an unavailable state.

## 4. Compatibility and submission examples

- Introduce the trace table through an additive, repeatable migration; preserve task-storage format and existing endpoints.
- Automatically capture new events after rollout. For older runs, reconstruct available records on demand and label missing historical context explicitly.
- Keep generated `logs/` ignored. Save three sanitized, reproducible submission examples in the tracked output examples: successful evidence-backed work, feedback that changes the answer, and a controlled failure/recovery or honest stop.
- Document capture settings, CLI commands, export contents, provenance and limitations. Fixture examples remain explicitly labelled; live verification is a separate configured run.
- Use JSON downloads and CLI directory exports for v1; no archive dependency is required.

## 5. Verification and acceptance

- **Durability:** test transaction/savepoint rollback, crash before projection, crash after file append, torn lines, restart recovery and shutdown flushing.
- **Correctness:** test concurrent assignments, histories across Continue/new runs, critique-to-revision links, exact reviewed artifact versions, and excluded late receipts.
- **Export safety:** test secret masking, uploaded-content omission, redacted-byte hashes, revoked artifacts, malformed queries, size limits and active snapshots.
- **User surfaces:** test pagination beyond 100 events, run isolation, stale-request cancellation, download links, CLI follow/cancellation, Windows paths and overwrite refusal.
- **End to end:** execute deterministic fixture scenarios, restart the server and verify that JSONL, UI and exported bundles agree on event IDs, evidence references and final outcome.
- Run formatting checks, type checks, lint, backend tests, frontend checks and relevant integration/crash checks.

Acceptance requires a reviewer to trace a final claim back to its evidence and review, see how feedback changed the work, and distinguish captured facts from unavailable metadata.
