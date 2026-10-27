# Execution trace logging implementation report

Recorded: 28 October 2026. Scope: [trace logging implementation plan](../../plans/orchestration/trace-logging-implementation-plan.md).

Haze now persists a trace envelope with every new task event, projects sanitized run logs after commit, exposes run-scoped trace and evidence downloads, and presents the same saved facts through the report timeline and development CLI. The existing TaskEvent v3 API and SQLite storage marker remain compatible.

## What changed

| Area                           | Implemented behavior                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Durable contract and migration | `app/contracts/trace.ts` defines independent `haze.trace.record.v1` records. `TaskStore` creates the additive, repeatable `trace_records` table/index and captures envelopes in the domain transaction, including events inserted through extension writers. Rollback and nested savepoints remove both event and trace.                                                                                                                                     |
| Causality and review           | Stable event IDs, exact artifact references, decision/attempt/message IDs, peer roles, assignment revisions, execution generation, objective revision and Manager plan revision are preserved. The Manager consumed-event cursor is separate from direct causes. Explicit `supersedes` links distinguish replacement work/reviews from triggering events. Missing review availability is labelled as a runtime assessment.                                   |
| Failed and late work           | Failed Manager dispatches remain visible. Attempts retain actual saved receipts and acceptance separately from evidence verdicts and task outcome. Excluded late receipts remain attached to their originating run and assignment revision after Continue creates a new run.                                                                                                                                                                                 |
| File and stdout projection     | `TraceProjectionService` writes `events.jsonl`, `manifest.json` and deterministic `summary.md` beneath `logs/<run_id>`. Defaults are files on and stdout key highlights. Batches are bounded; restart checks the saved prefix against SQLite, repairs torn/divergent suffixes and appends missing records without duplicate IDs. Sink failures cannot undo committed work. Runtime shutdown flushes after execution producers stop and before SQLite closes. |
| Shared snapshots and policy    | One `TraceExportService` instance is shared by the runtime projector and HTTP surfaces. It reads exact historical Manager state/results and captures a consistent cursor boundary. A common sanitizer masks credentials, credential-bearing URLs, known secrets and copied source bodies. Uploaded originals and revoked/unsupported evidence are withheld with reasons. Raw external source bytes require trusted public-kind registration.                 |
| Bundle identities and limits   | The bundle retains original artifact `{id,version,sha256}` references separately from `exported_sha256`, which hashes sanitized compact JSON plus newline. Manifests include provenance, native/reconstructed capture, omissions, cursor and active-snapshot status. Bundles are bounded to 32 MiB with explicit `export_too_large`. JSONL downloads depend only on trace records, so unrelated oversized artifacts do not block them.                       |
| HTTP                           | Added `GET /api/tasks/:taskId/runs/:runId/trace` with validated pagination or `format=jsonl`, and `GET /api/tasks/:taskId/runs/:runId/evidence-bundle`. Existing local authorization applies; downloads use attachment/no-store handling. Invalid queries, foreign task/run pairs and unsupported methods fail explicitly.                                                                                                                                   |
| CLI                            | `tasks trace <taskId> [--run <runId>] [--follow]` and `tasks export <taskId> [--run <runId>] --out "<directory>"` communicate through HTTP. Follow pins its run and supports cancellation. Directory exports refuse overwrite, use fixed safe filenames, verify sanitized artifact hashes and preserve context and artifact indexes.                                                                                                                         |
| Task report                    | Added a run selector, readable highlights, optional full timeline, expandable technical details, causes, replacement links, exact references, provenance, separate verdicts and both downloads. Stale requests are aborted and identity-guarded. Unsupported mocks show unavailable. Raw receipts remain, and the current saved-result panel is explicitly labelled.                                                                                         |
| Documentation and examples     | Added the [trace guide](../../testing/trace-logging.md), environment defaults, regeneration/crash commands and [three tracked examples](../../../output_examples/orchestration/traces/README.md). Generated logs remain ignored. Tests isolate sinks with temporary directories or injected stdout.                                                                                                                                                          |

## Verification

The preview fixture verifier now sends `Connection: close` for GET/POST requests. Diagnostics established an idle keep-alive timeout during synchronous fixture work: the same server stayed alive and answered a new health request. Fresh connections preserve all assertions and duplicate-admission/idempotency checks without changing production timeouts or adding retries. The updated verifier passed twice sequentially.

Focused capture coverage includes rollback/savepoint behavior, extension event writes, native immutability, historical reconstruction, exact receipts and causes, failed decisions, peer role resolution, review/replacement links and excluded late receipts across Continue. Projection coverage includes batches beyond 100 records, pre-projection commits, torn tails, missing complete lines, divergent payloads, deduplication, disk repair, stdout rejection/timeouts and shutdown flushing.

Export and HTTP coverage includes secret and URL masking, short-secret structural-ID preservation, upload/source omission, revoked evidence, exact historical result/Manager state, original versus exported hashes, pagination, active snapshots, strict query parsing, local authorization, attachments and size limits. CLI/report tests cover pagination, Windows paths, overwrite refusal, follow cancellation, stale selection, mock unavailability and downloads.

| Check                                           | Result                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine/dependency pins                          | Passed.                                                                                                                                           |
| Repository formatting                           | Passed; all matched files conform to Prettier.                                                                                                    |
| Backend and Zetaris typechecks                  | Passed, including final checks with Node 24.22.1.                                                                                                 |
| Full repository lint                            | Passed; final scoped capture/export/harness checks also passed.                                                                                   |
| Backend build                                   | Passed with Node 24.22.1.                                                                                                                         |
| Trace capture/projection/export/HTTP/CLI suites | 32 tests passed across five files on Node 24.22.1.                                                                                                |
| Full backend suite                              | Final frozen-code run in progress; prior run passed 1,538 tests, and its single stale-module summary assertion passed in the clean focused rerun. |
| Frontend                                        | Production build and 353 tests passed, one test skipped, with four workers. Final supported-Node rerun in progress.                               |
| Route/harness checks                            | 63 tests passed.                                                                                                                                  |
| Vendored engines                                | 21 conformance checks passed (13 H-MEM, eight World Model).                                                                                       |
| Domain fixture verification                     | General, damage account, reduction assessment, planning preview, programmes, pilot and external evaluation passed.                                |
| Separate-process crashes                        | Four existing LangGraph crash cases and three new trace-projection crash boundaries passed.                                                       |
| Tracked example regeneration                    | All three scenarios completed and agreed after SQLite/file reopening.                                                                             |

Final backend validation uses the required Node 24.22.1, invoked from the npm cache; npm is 11.8.0. The machine's default Node remains 24.11.0. Earlier concurrent checks exposed a timeout and the preview keep-alive race; the verification harness fix and final reruns are recorded separately from live-source verification. Local detailed logs are retained under `.state/trace-verification/` and remain ignored.

## Reproducible submission examples

| Scenario          | Outcome                               | Trace records | Permitted exported artifacts |
| ----------------- | ------------------------------------- | ------------: | ---------------------------: |
| `single`          | Completed                             |            54 |                            2 |
| `rejected-review` | Completed after feedback and revision |           113 |                            8 |
| `known-failure`   | Completed after an alternative plan   |            82 |                            2 |

The generator runs the frozen scripted `single`, `rejected-review` and `known-failure` Manager cases, reopens their SQLite stores, repairs/reconciles projection files and checks complete sanitized-record agreement between JSONL, paginated report responses and bundles. It also checks the final outcome against the saved task. Each tracked example contains a self-contained bundle and readable summary.

These scenarios exercise retained evidence, feedback-driven revision and controlled recovery with synthetic methods. They do not establish live provider quality, live Zetaris retrieval or actual Meterless operations. Real receipts are included only when those operations were exercised.

## Compatibility and practical limits

- Older runs reconstruct available events on demand and explicitly label unavailable event-time metadata. They never substitute current Manager state or results for historical selections. Automatic files project native captures made after rollout.
- Stdout delivery is best effort and historical output is not replayed. A stalled or failed stdout sink is disabled for that owner lifetime. SQLite and files remain available.
- File summaries retain the latest 200 records and label that bound; JSONL contains the complete native stream. API/export summaries use their complete selected snapshot.
- Revocation can deliberately withhold narrative/result bytes as well as artifact bytes when disclosure would expose denied evidence. References and omission reasons remain visible.
- Confidence is optional and is not fabricated. Missing direct causes, provider metadata or historical context remain missing facts.
- Downloads are JSON/JSONL and CLI directory exports for v1; no archive dependency was added.

Pre-existing plan changes and concurrent README/history documentation edits were preserved.
