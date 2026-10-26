# General engine verification

Recorded 25 October 2026. The `npm run check` result below is a historical general-engine run with pinned Node 24.22.1: 202 backend tests, 70 frontend tests, 21 upstream engine conformance checks, and the fresh-process fixture verifier. The latest World Model verification is recorded separately below; older orchestration verification files remain historical records.

## Latest World Model verification

The current World Model checks were run individually because `npm run check` stopped at formatting: a protected, untracked planning document is not formatted and was left untouched.

| Command                    | Result                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | Passed.                                                                                                                                                        |
| `npm run build`            | Passed.                                                                                                                                                        |
| `npm test`                 | Passed: 28 files and 249 tests.                                                                                                                                |
| `npm run test:engines`     | Passed: 13 H-MEM and 8 World Model checks.                                                                                                                     |
| `npm run frontend:check`   | Passed: production build and 103 tests across 18 files.                                                                                                        |
| `npm run test:integration` | Passed with fixture-tested acceptance, correction holds, and restart readback.                                                                                 |
| `npm run lint`             | Did not pass: 246 errors in the existing `server/src/api/app.ts`, `server/src/index.ts`, `server/test/api.test.ts` and `server/test/liveStream.test.ts` files. |

The fixture integration run does not establish live source readiness. No live verification was performed for this World Model check.

## Release gates and evidence

| Gate                 | Evidence                                                                                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General intake       | `general-runtime.test.ts` and the process verifier import a source and complete an objective without location, dates, pollutant or global domain fields. The direct Manager response path also has a configured provider receipt.                                                                                     |
| Hybrid investigation | PM2.5 deterministic retrieval, source-row validation, coverage calculation, separate numerical checking, two persisted peer messages, and explicit unavailable observation/attribution branches. `pm25-methods.test.ts`, `task-evidence.test.ts` and `general-runtime.test.ts` cover the fixture behavior.            |
| Correction           | Tests revise investigation scope, stale affected analysis/review, exclude late output, preserve original passages and byte hashes, and require applicability records for unaffected reuse.                                                                                                                            |
| Recovery and races   | `general-store.test.ts` and runtime tests exercise duplicate delivery, two SQLite connections, shared reservations, pause/cancel/resume/revoke/continue, old-receipt fences, unknown attempts (including network interruption without a receipt), pending actions, restart and unchanged deadlines/remaining budgets. |
| Extensibility        | `general-extension.test.ts` registers a vocabulary capability with different inputs/artifacts and seven specialist assignments, without changing core contracts or runtime. Dependency lint and `general-boundaries.test.ts` enforce the composition boundary.                                                        |
| Evidence integrity   | Retained source/numerical tests reject tampering, inconsistent raw-row linkage, invented citations, invalid units, incorrect counts/ranges/missingness and producer self-review. Rejected material is excluded from synthesis.                                                                                        |
| Frontend             | Service and interaction tests cover general and optional PM2.5 rendering, questions, imported/pasted sources, exact corrections, controls, stale history and linked-run readback. Browser fixture flows were inspected at desktop and 390-pixel mobile widths.                                                        |

The reference fixture and live trace summaries are in [general-engine-evidence.json](general-engine-evidence.json). Complete local reports retain exact durable events, tasks, source artifacts and charged attempts under `.state/general-verification/`. Reports use fresh isolated directories; archival v1/v2 databases are untouched.

## Commands and scope

Run checks with Node **24.22.1** and npm **11.8.0**:

```sh
npm run check
npm run tasks:verify -- --fixture
npm run tasks:verify -- --live Klang 2026-10-24T00:00:00Z 2026-10-25T00:00:00Z
```

`check` includes pin verification, formatting, root and SmokeLedger type checks, lint, build, backend unit tests, pinned engine conformance, frontend build/tests and explicit fixture process/restart verification. PostgreSQL saver tests require their separately configured disposable database and are run separately in CI.

The browser source file chooser required an extension setting unavailable in the test session. The source paste alternative completed the same real import API flow; file encoding, UTF-8 validation and the full decoded 1 MiB boundary are tested. Desktop/mobile screenshots are retained locally under `tmp/general-ui-evidence/`.

## Live readiness

A configured NVIDIA model completed a source-backed direct response with an exact citation and actual response-model, response-ID and token-usage receipt. Earlier malformed action/synthesis attempts remain charged and recorded as failures. The adapter now requests native JSON output; agent schemas still validate every returned action before dispatch. This follows the [NVIDIA structured-output guidance](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html#structured-json-output).

The final live run completed the general explanation and returned a truthful partial PM2.5 result after the attempted source tool reported a missing credential. Restart readback remained unchanged. No Zetaris source credential was configured for this session, so a genuine successful live PM2.5 source trace is still unavailable. Fixture results and model-only success do not advance live source readiness. The engine does not switch providers, retry automatically or substitute synthetic data. Configure the existing `ZETARIS_API_KEY`, REST URL and organization access, then explicitly admit a new live verification run before claiming that gate.

Capability cards conservatively remain `implemented`; captured fixture success is recorded separately. Source attribution is not proof of authenticity, and deterministic checks do not establish scientific qualification, causal attribution, health advice or operational permission.
