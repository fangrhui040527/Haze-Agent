# Scaffold verification — 25 October 2026

This record captures the scaffold before the [scheduling retirement](../history/legacy-retirement.md) later on 25 October 2026. Its original contract/demo/input checks and test counts describe that earlier tree. They are retained as historical evidence, not validation of the changed repository.

Current file references use orchestration naming. Captured execution records, identifiers and hashes remain unchanged.

Frontend typecheck, production build and 90 tests passed after the cancellation-state fix. Browser verification helpers were stopped; existing user servers were preserved.

Story: a natural-language PM2.5 request enters the existing chat, becomes a durable v2 task, runs distinct bounded role contexts through shared component ports, and returns reviewed artifacts/citations. Stop-wait and server cancellation remain separate controls.

| Boundary                    | Evidence                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository checks           | `npm run check` passed using pinned Node 24.22.1/npm 11.8.0: formatting, typechecks, lint, build, original contracts/demo/input checks, 445 unit tests and 21 pinned-engine conformance checks. The final unit-suite run passed 447 tests after two additional adapter-isolation regressions. |
| Assignment/runtime/ports    | Tests cover actual per-role invocation, model and tool ledgers, version/hash lineage including authorized v1 inputs, malformed plans/ports, aggregate limits, independent calculations, rejected/partial output, large optional metadata, scoped access, cancellation and late completion.    |
| Fixture HTTP path           | Five model turns, five tool operations, nine immutable artifacts, full role receipts and exact citations; a fresh server process returned identical task and event records. The complete captured synthetic trace is in `output_examples/orchestration/fixture-trace.json`.                   |
| Browser flow                | Isolated fixture Vite server, actual Edge submission, five model calls and durable assignment receipts; fixture labels in chat and office, exact source link, no console errors on the completed path. Desktop and 390-pixel mobile widths had no page overflow.                              |
| Cancellation                | Browser Stop waiting detached polling; subsequent explicit server cancellation advanced the durable generation to 2 and showed stopped office activity from server status. No execution receipt was invented.                                                                                 |
| PostgreSQL saver regression | `npm run test:postgres` passed, one test against a fresh loopback-only PostgreSQL 18.1 cluster/database. The cluster was stopped; existing databases were untouched.                                                                                                                          |
| Configured live path        | Manager planning completed one real model turn; the task then failed at the source attempt. No source-backed answer was produced. A separate source preflight returned `unavailable`: `ZETARIS_API_KEY is missing`. Live readiness remains unverified.                                        |

The live failure retained one charged model call, three tool-operation attempts (including two unavailable optional-context operations), one artifact and durable events. Fresh-process task/event readback matched. Failed inference/retrieval is never substituted with a fixture answer. H-Mem and World Model service integrations still require teammate adapters; the pinned local engine conformance checks do not establish those service contracts.

Readiness is recorded separately in `orchestration-readiness.json`. Fixture tests, model agreement and engineering checks do not establish scientific qualification or operational authority.

Automatic approval review blocked deletion of the stopped temporary PostgreSQL data directory without a detailed reason. Only stopped disposable test data remains outside the repository; no test database process remains running.
