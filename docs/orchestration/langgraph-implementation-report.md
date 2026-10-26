# LangGraph implementation and verification report

Recorded: 26 October 2026. Scope: replace the custom Manager coordinator and specialist action loops with independently checkpointed executable LangGraph workflows while preserving v3 application behavior and scientific methods.

This report separates implementation, demonstrated runtime behavior and operational release gates. It does not claim better model reasoning or successful live-source integration.

## Baseline and preserved work

The existing checkout contained tracked and untracked implementation work. That work was preserved; no reset or clean checkout was used. A baseline snapshot is retained under `tmp/langgraph-baseline`. The shell initially reported Node 24.11.0; verification uses the pinned Node 24.22.1 and npm 11.8.0 toolchain under `tmp/node-toolchain`.

The baseline `npm run check` stopped at formatting in the pre-existing `docs/architecture/world-model-implementation-plan.md`. Its log is `tmp/langgraph-baseline-check.log`. This is an existing baseline failure, not proof that the prior runtime passed every repository gate in this checkout.

The remaining baseline checks were then run and passed separately: type checking, lint, build, 306 backend tests, 21 upstream engine checks, frontend build and 124 frontend tests, and both separate-process fixture restart verifiers. Their log is `tmp/langgraph-baseline-validation.log`.

The formatting-only baseline issue was corrected in the working copy. The retained baseline snapshot preserves its original bytes.

## Implementation

The [runtime architecture](../architecture/langgraph-runtime.md) describes graph ownership, operation receipts, wait cursors, authority fences and legacy gating. The [cutover/rollback runbook](langgraph-cutover-runbook.md) describes migration on a separate explicit copy and preservation of matching executable/state pairs.

Public v3 schemas and routes, models, instructions, roles, tools and deterministic scientific methods remain the compatibility boundary. Runtime reliability is the scope; reasoning evaluation is separate.

| Change                             | Implementation                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executable Manager control flow    | `app/orchestration/manager-graph.ts`: hydration, context, model decisions, validation, lookup, action execution, dispatch, waits and finalization                                                              |
| Executable specialist control flow | `app/orchestration/specialist-graph.ts`: model/action nodes, controlled deterministic assignments, receipt-backed nested services and separate interrupt nodes; the old `app/agents/shared.ts` loop is removed |
| Durable independent invocation     | `app/tasks/graph-dispatcher.ts`: per-thread delivery, cancellation and detached asynchronous invocation context                                                                                                |
| Application receipts and waits     | `app/tasks/graph-ledger.ts`: versioned execution records, stable operations, attempt links, effect receipts, cursor-deduplicated jobs and transactional wakeups                                                |
| Compatibility facade               | `app/tasks/runtime.ts` retains v3 admission/read/update/control behavior and routes execution through the graphs                                                                                               |
| Ownership and migration            | `app/tasks/runtime-owner.ts` uses an OS-released SQLite exclusive lock; `app/tasks/migrate.ts` and its CLI create a verified separate v2 copy and gate legacy execution                                        |

## Verification record

The full `npm run check` passed with pinned Node 24.22.1 and npm 11.8.0: pin verification, formatting, root/SmokeLedger type checks, lint, build, **330 backend tests**, **21 upstream engine checks**, frontend build and **124 frontend tests**, both fixture restart verifiers and the four process-kill scenarios. The complete log is `tmp/langgraph-final-check.log`. The frontend build retains its existing advisory about a bundle above 500 kB; it completed successfully.

Focused verification also passed all nine new runtime acceptance tests and 28 combined migration/ledger/store tests. Waiting tests exercise runtime close/reopen; process-kill tests exercise fresh OS processes. These are distinct recovery checks.

| Acceptance gate                           | Evidence                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent execution and shared capacity | `langgraph-runtime.test.ts` completes both specialists while the Manager decision remains blocked and measures a maximum of two specialist executions across two tasks. It checks three distinct graph threads with empty inherited checkpoint namespaces.                                      |
| Durable human and peer waiting            | Runtime acceptance tests close and reopen the runtime, retain waiting states without repeated question/model calls, release specialist leases, resume the authorized response and deliver exactly one peer message.                                                                             |
| Wakeup reliability                        | `general-migration.test.ts` covers duplicate/reordered wakeups, events committed before parking, deferred delivery, exact recipient/revision filtering and generation reconstruction of parked waits.                                                                                           |
| Cancellation and authority fences         | New tests cover pause, cancel, revoke and correction with a tool that ignores AbortSignal. Charges remain, late receipts are historical, current artifacts/results stay absent and remote termination remains unconfirmed. Existing Manager/store tests retain supersession and closure checks. |
| Migration and legacy gating               | Migration tests preserve IDs, artifact contents, completed results, idempotency receipts and old checkpoints; reject incompatible/non-quiescent sources; keep source hashes unchanged; reject legacy Resume/update/lease acquisition; and create one explicit linked successor.                 |
| Runtime ownership                         | Unit tests and an actual second process reject simultaneous ownership. The crash harness reacquires ownership after hard process loss.                                                                                                                                                          |
| Compatibility                             | Existing Manager, domain, extension, HTTP, frontend and fixture suites pass in the full repository check.                                                                                                                                                                                       |

The integrated separate-process crash report is `tmp/langgraph-crash-verification/3376c9ec-d0fe-455d-a4aa-96281e5d1017/report.json`. An earlier final targeted run is retained at `tmp/langgraph-crash-verification/72fc1d9b-a55e-43bc-9337-4ab21a9e0d5e/report.json` with console log `tmp/langgraph-crashes-final.log`. A second independent process was rejected while the first runtime held the selected directory.

| Process-kill boundary                                  | Demonstrated result                                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Prepared before dispatch                               | No call before the kill; exactly one call and one charge after restart                                               |
| Dispatched remote call without receipt                 | One unknown charged attempt; no automatic repeat; explicit Resume permits one replacement and preserves the deadline |
| Accepted response committed before graph advancement   | Restart reuses the response with one total call and charge                                                           |
| Specialist artifact committed before graph advancement | Restart retains exactly one artifact with the original ID and hash                                                   |

The new separate-process harness is `scripts/verify-langgraph-crashes.mjs`. It uses deterministic scripted responses and disposable directories under `tmp/langgraph-crash-verification`. It hard-kills the worker at four boundaries: after operation preparation before dispatch, during a remote call, after a committed response receipt, and after a committed specialist artifact before checkpoint advancement. An independent SQLite reader confirms operation commits before the corresponding kill. Restart assertions cover retained unknown charges, no automatic replay of an unknown call, explicit Resume with the original deadline, accepted-response reuse and identical artifact ID/hash after recovery.

The report also retains and checks actual `graph_node` events for Manager hydration, context, model decision, validation, action execution, dispatch and finalization, and specialist hydration, context, deterministic execution and completion.

The rollback rehearsal passed against the final repository-check build and an actual old executable compiled from the preserved baseline sources. It created and completed an old-format fixture, migrated a separate copy, completed a distinct new-format task, archived the new state with its built reader, restored the untouched old snapshot into another directory, and compared exact task/artifact readback through both matching runtimes. The original source database hash remained unchanged. Final evidence: `tmp/langgraph-rollback-verification/0359cc84-d4a5-41d4-ba79-20e20a01e2d2/report.json`; log: `tmp/langgraph-rollback-final.log`.

## Operational status and readiness gaps

No source state directory was explicitly selected, and no existing operational `.state` directory was migrated or cut over. Operational quiescence, copy verification, explicit legacy continuation and switching the serving process remain operator actions against the selected state. Disposable migration tests are distinct from that deployment.

The prior [Manager report](manager-completion-report.md) records the configured NVIDIA model's decision-quality gate as failed (supervised native-schema 3/12 versus baseline 5/12 under evaluator v2). This runtime migration has not rerun or improved that evaluation.

Successful live PM2.5 retrieval remains a separate unverified integration gate. The earlier direct source probe lacked `ZETARIS_API_KEY`; no successful new live source trace is claimed here. Fixture and scripted crash results do not establish live-source readiness.
