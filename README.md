# Haze Agent

Haze accepts natural-language objectives through a local chat and one durable `haze.task.request.v3` API. A registered Manager chooses a direct response or a dependency graph of specialist assignments. The registered capabilities cover source-backed explanations, episode investigations, modeled PM2.5 methods and damage accounting from retained World Model evidence.

The reusable engine separates browser-safe contracts, authoritative SQLite state, bounded agent execution, typed tools and domain capabilities. Corrections, questions, imported sources, controls, immutable work products and independent numerical review are visible in the application. See the [general engine guide](docs/orchestration/general-engine.md) and [Architecture v0.14](docs/architecture/Haze_Agent_Architecture_v0.14.pdf).

The v1/v2 task paths and routing flags are retired. Old protocol tags are rejected with v3 guidance. Historical databases and checkpoint directories remain archival and are never automatically migrated or served by the new API. The earlier crew scheduling backend also remains retired; see the [retirement record](docs/history/legacy-retirement.md).

## Develop locally

Use Node **24.22.1** and npm **11.8.0**, as pinned in [.nvmrc](.nvmrc) and [package.json](package.json):

```sh
npm ci
npm --prefix frontend ci
npm run build
npm --prefix frontend run dev
```

Copy [.env.example](.env.example) to root `.env`. This gitignored file holds
the server-side Haze, PostgreSQL, Zetaris and ingestion settings. For live
agent requests, set your own `NVIDIA_API_KEY` (or use
`HAZE_PROVIDER=openai-compatible` with `HAZE_PROVIDER_API_KEY`,
`HAZE_PROVIDER_BASE_URL` and `HAZE_MODEL`). PM2.5 evidence retrieval also
requires an existing Zetaris instance and your own `ZETARIS_API_KEY`; configure
its `ZETARIS_REST_URL` and `ZETARIS_ORG_ID` if they differ from the documented
defaults. Keep credentials out of browser `VITE_*` variables. API keys are
personal and must never be added to a committed example file.

The optional data-ingestion scripts need their own keys: `FIRMS_MAP_KEY` for
NASA FIRMS and `WINDY_API_KEY` for Windy. They belong in root `.env`;
Open-Meteo and Data.gov.my fetchers do not
require keys.

The examples provide configuration names and local development defaults, not
hosted-service credentials. Open-Meteo PM2.5 and wind are federated through
per-location Zetaris REST tables and expose unified views; FIRMS has its own
source folder. PostgreSQL is not required for these source-ingestion commands
or the PM2.5 task. Preview a bounded setup from the repository root:

```sh
npm run zetaris:fetch:pm25 -- --location kuala-lumpur --dry-run
npm run zetaris:fetch:wind -- --location kuala-lumpur --dry-run
```

After reviewing the SQL, rerun the selected command without `--dry-run` to
register the REST tables and views. Zetaris queries may contact Open-Meteo;
start with `--test` or selected locations and verify provider usage before
registering all 345 endpoints. Existing SmokeLedger PostgreSQL data remains
under [legacy tooling](app/adapters/zetaris/legacy/smokeledger/README.md); it is
not required by the current source path and is not migrated automatically.

Existing `app/adapters/zetaris/.env.local`
files remain a fallback for task commands, the frontend task server and Zetaris
helpers. Process variables take precedence; root `.env` values win over the
legacy adapter file, including empty values. Move any settings you still use
into root `.env` without overwriting existing values. The Zetaris helpers also
look in the main checkout when run from a Git worktree.
External API keys are not needed for the
fixture checks (`npm run tasks:verify -- --fixture`), but are needed for live
model or Zetaris requests.

A general request needs only its objective. Import text, Markdown, CSV or JSON when the answer needs your source material. For example:

> Explain the supplied report and identify what its evidence does and does not establish.

A PM2.5 investigation additionally needs a domain scope, either explicitly or through a bounded phrase such as:

> Investigate PM2.5 evidence for Klang during 2026-10-24 to 2026-10-25, distinguish modeled values from observations, and identify coverage gaps.

Open `/damage-account` and describe the location, episode and dates; no upload is required. `WorldModelDamageInputAdapter` retrieves compatible retained accounting captures and their exact original evidence. Saved accounts can be opened at `/damage-account/TASK_ID`. This workspace keeps its own task selection; the dashboard and original office retain their existing presentation. DamageAccountant produces separate physical, financial incidence and selected social welfare views; EvidenceCritic independently reconstructs the exact account and components. Missing evidence produces an explicit backend acquisition gap rather than invented values. The adapter requires accounting-ready World Model evidence: it does not fetch external datasets or estimate health effects from PM2.5. See the [adapter report](docs/orchestration/world-model-damage-input-adapter-report.md) and [original accounting report](docs/orchestration/damage-accountant-implementation-report.md).

Open **World Model** in the main navigation, or `/world-model`, to browse retained SQLite records, relationships, current acceptance outcomes, history and lineage, and rebuild derived views. The **Reference sandbox** panel runs Meterless's original control plane with disposable sample data. See the [World Model control-plane guide](docs/Testing/world-model-control-plane.md) for configuration and isolated checks.

The frontend always uses the general protocol. Set `STATE_DIR=.state/general-v2` for the new storage format; an existing incompatible configured directory fails without modification. Run `npm run tasks:serve` for the standalone loopback API at `http://127.0.0.1:8787`. Mutations require the local same-origin boundary and an `Idempotency-Key`; updates and controls also require the current objective revision, run ID, lease generation and state revision.

The dashboard, HazeOps watchers, general tasks and `/world-model` now use one
application backend and the same SQLite World Model. Vite dev and preview serve
all `/api` routes locally; a separate dashboard server is unnecessary.
`HAZE_TASK_STATE_DIR` remains a Vite override for the whole application store.
Use a compatible `.state/general-v2` directory; existing legacy directories remain
archival until explicitly imported. See the [dashboard migration guide](app/dashboard/README.md).

## Verify general execution

To test the Manager independently, run `npm run manager:test`. It uses a fresh isolated build and task state with deterministic specialist stubs. Use `npm run manager:test:live` to test only the Manager's configured model against the same stubs. To talk to that model with your own prompts and follow-ups, run `npm run manager:chat`. See [isolated Manager testing](docs/Testing/manager-testing.md) for focused cases, interactive chat, traces and the limits of a passing result.

```sh
npm run check
npm run tasks:verify -- --fixture
npm run damage:verify -- --fixture
npm run tasks:verify -- --live Klang 2026-10-24T00:00:00Z 2026-10-25T00:00:00Z
```

`check` includes root formatting, types, lint, build, unit and engine checks, frontend build/tests, and fresh-process general and damage-account fixture verification. Use `npm run tasks:test` for focused engine/domain tests. For an explicitly synthetic development server, build first and run `node scripts/serve-tasks.mjs --fixture`. Normal execution never substitutes fixtures, switches providers or retries automatically.

The fixture verifier imports a source, completes a general explanation and a PM2.5 investigation, checks duplicate delivery, captures exact artifacts/events and verifies unchanged readback after process restart. A fixture pass establishes integration behavior only. Live readiness requires a captured configured model and source-tool trace; missing access or a failed attempt never advances readiness. See the [implementation record](docs/orchestration/general-engine-verification.md).

## Repository layout

Browse the [documentation index](docs/README.md) for guides grouped by topic.

| Path                                                                | Purpose                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`app/tasks/`](app/tasks/README.md)                                 | General task admission, authoritative SQLite rows, controls, recovery and HTTP API         |
| [`app/orchestration/`](app/orchestration/README.md)                 | Bounded agent actions, registered definitions, typed tools and graph/checkpoint boundaries |
| [`app/contracts/`](app/contracts/README.md)                         | Browser-safe v3 contracts and separate server-only canonical serialization                 |
| `app/agents/`, [`app/capabilities/`](app/capabilities/README.md)    | Versioned agents and independently registered domain methods                               |
| `app/adapters/`                                                     | Provider integrations, pinned Meterless facades and Zetaris deployment/data-source tooling |
| `app/dashboard/`, `app/world/`                                      | Dashboard APIs/projections and shared SQLite evidence ingestion                            |
| [`app/checkpoints/`](app/checkpoints/README.md)                     | Checkpoint helpers                                                                         |
| [`app/compatibility/`](app/compatibility/README.md), `app/graph.ts` | Engine/restart proof and offline metadata graph                                            |
| `frontend/`                                                         | Chat, evidence results, source samples and agent execution display                         |
| `scripts/`, `tests/`                                                | Build, verification, examples and regression checks                                        |
| `input_examples/`, `output_examples/`                               | Offline metadata examples and explicit orchestration fixtures                              |
| `third_party/`                                                      | Pinned engine sources                                                                      |
| `docs/`                                                             | Current architecture, implementation notes and labeled historical design records           |

## Offline infrastructure and engine pins

The metadata graph uses TypeScript `StateGraph` from `@langchain/langgraph` in this process; no hosted LangGraph service is required. After building, run an offline example:

```sh
npm start -- input_examples/01-minimal.json
```

It prints deterministic execution metadata and writes an ignored JSONL trace under `logs/`. Matching expected outputs are in `output_examples/`. Its numeric `schemaVersion: 2` is an infrastructure metadata version, separate from the task request versions.

[engine_sources.json](engine_sources.json) binds immutable Meterless source revisions, complete file inventories and SHA-256 checksums. The build verifies those sources before generating ignored `vendor/` and `dist/` output. Preserve upstream lockfiles, licenses and notices; see [engine pins](docs/infrastructure/engine-pins.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The [Dockerfile](Dockerfile) uses a digest-pinned Node image and runs the first offline metadata example by default.

`npm run probe:compatibility` separately tests pinned engines, a selected provider and fresh-process SQLite checkpoint readback. Its [original infrastructure scope](docs/infrastructure/compatibility-probe.md) remains useful independently of task execution.

## Persistence and current limits

Task records, assignments, charged attempts, actions, control receipts, questions, peer messages and immutable artifacts use local SQLite under `.state/general-v2` by default. The storage-format marker is checked before opening SQLite. One application process owns a directory. LangGraph checkpoints hold record references and bounded execution state, including context, logical steps, decisions and responses. Application records remain authoritative for permissions, charges, accepted effects and results.

Restart fences old workers. Accepted completed work remains available, while calls interrupted without a receipt retain their charge and unknown outcome. Explicit resume requests a replacement attempt under the original deadline and remaining budget; expired work requires an explicitly linked continuation run with fresh reservations. No automatic retry occurs.

The application retains a local single-user boundary, two active tasks and two shared specialist slots. It supports configurable bounded resources and one purpose-bound peer channel per run. Source attribution is not proof of authenticity. World Model acceptance is disabled by default and requires an explicit supported policy. HazeOps can run bounded recurring evidence collection; `HAZEOPS_SCHEDULER=off` disables it. External effects, memory capture, publication, alerts and scheduled operational monitoring remain disabled. Fixture checks, model prose and engine conformance do not confer scientific or operational qualification.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and review conventions.
