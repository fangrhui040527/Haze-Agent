# Contributing

Use Node 24.22.1 and npm 11.8.0 from the repository pins. Install with `npm ci` and `npm --prefix frontend ci`; commit dependency changes with their matching lockfiles.

## Commands

| Command                                                                 | Purpose                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run build`                                                         | Verify/vendor pinned engines and compile the backend                         |
| `npm run check`                                                         | Run root checks, unit/engine suites, frontend checks and fixture integration |
| `npm run frontend:check`                                                | Build and test the frontend                                                  |
| `npm run test:integration`                                              | Run the fixture HTTP task and fresh-process readback after building          |
| `npm run typecheck`, `npm run lint`                                     | Check backend types and lint                                                 |
| `npm test`, `npm run test:watch`                                        | Run or watch local unit tests                                                |
| `npm run tasks:test`                                                    | Run focused general runtime, storage, HTTP and domain checks                 |
| `npm run tasks:verify -- --fixture`                                     | Capture an explicitly synthetic task and fresh-process readback              |
| `npm run tasks:serve`                                                   | Start the configured local task API                                          |
| `npm run tasks:verify -- --live LOCATION START END`                     | Verify the configured general path and restart/readback                      |
| `npm run test:postgres`                                                 | Run the PostgreSQL saver integration suite                                   |
| `npm run verify:pins`, `npm run vendor:engines`, `npm run test:engines` | Verify sources, generate engine output and run upstream conformance          |
| `npm run probe:compatibility`                                           | Probe engines, the selected provider and SQLite restart behavior             |
| `npm start -- input_examples/01-minimal.json`                           | Run the offline metadata example after building                              |
| `npm run format:check`, `npm run format`                                | Check or apply repository formatting                                         |

The v1/v2 task paths and `hybrid:*`/`orchestration:*` command aliases are retired. Use the general v3 commands above. Historical state is never migrated automatically.

Build before tests that load the pinned local engines. Default unit tests use disposable memory or temporary SQLite state and require no API credentials. PostgreSQL tests require a dedicated disposable database through `HAZE_TEST_POSTGRES_URL`; the library does not load that environment variable from a file. Run that suite when changing saver configuration, checkpoint behavior or PostgreSQL dependencies.

For frontend changes, also run:

```sh
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
```

Before review, run the checks relevant to the change and record any unavailable check with its reason. Live verifiers require existing configured services and explicit scope; fixture success does not replace live integration evidence.

## Implementation boundaries

`app/tasks/` owns the general lifecycle, authoritative SQLite records, controls, recovery and HTTP. `app/orchestration/` owns the typed executable registry, action contracts and reference checkpoints. Browser-safe public schemas live in `app/contracts/`; `json.ts` supplies separate server-only serialization/hashing. Executable agent modules own instructions, validation and bounded loops. Capabilities own domain inputs, methods, retrieval guidance, artifacts and independent checks. Only `app/composition.ts` imports domain modules into the running application. Lint and architecture tests enforce that boundary. See the [general engine guide](docs/orchestration/general-engine.md).

Preserve Manager, HazeOps, WorkerShield, EvidenceCritic and DamageAccountant as the five domain roles. DamageAccountant owns imported-input accounting; HazeOps acquires evidence, WorkerShield supplies intervention options and EvidenceCritic reviews independently. The fifth role does not add execution slots or budgets. LangGraph and savers provide execution infrastructure. Requests, checkpoints, model agreement and structural validation do not grant scientific approval or accepted-state authority.

The v0.13 scheduling package and connected demo UI have been removed; see the [retirement record](docs/history/legacy-retirement.md). Do not restore mandatory planning bundles, crew defaults or schedule-only contracts to general task admission. Retained historical design documents describe prior decisions and are not current implementation instructions.

Keep offline metadata inputs and same-named expected outputs in `input_examples/` and `output_examples/`. Their numeric `schemaVersion` is separate from task contract versions. Orchestration examples must retain explicit synthetic provenance, immutable artifact references and honest execution receipts. Never populate fabricated provider usage or approvals to make a fixture appear live.

## Review and verification

Keep changes focused and explain their resulting behavior, relevant checks and limitations. Add focused tests for meaningful behavior or regressions. Review should confirm that:

- Server-owned identity, permissions, scope and resource limits remain enforced in code.
- Exact evidence versions, hashes, selected rows, uncertainty and intended use remain visible.
- Cancellation, restart and late-result behavior remain truthful; adapters do not silently retry or substitute fixtures.
- Component readiness is supported by recorded evidence in [the current verification record](docs/orchestration/general-engine-verification.md).
- Direct dependencies remain exactly pinned and local/CI behavior agree.
- Secrets, databases, logs and generated build output are absent from the diff.

Update active documentation and example references when removing or moving code. Record executed checks separately from historical results; changed code must not inherit old test counts or live-readiness claims.

## Dependencies, source pins and secrets

Preserve checksum-pinned sources under `third_party/meterless/`, including their complete declared inventory, upstream lockfiles, licenses and notices. Edit the pin and provenance deliberately when updating upstream; the build rejects missing or changed files. Generated `dist/` and `vendor/` remain ignored. Retained Zetaris scripts and datasets under `app/adapters/zetaris/` are independent operator tooling and must not be removed solely because the PM2.5 runtime does not import them.

Update Node/npm pins together and regenerate lockfiles with the pinned npm version. Store real credentials only in process environment, ignored environment files or CI secrets. `.env.example` contains placeholders; browser `VITE_*` variables must never contain credentials.
