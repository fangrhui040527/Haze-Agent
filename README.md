# Haze Agent

Haze accepts natural-language objectives through a local chat and one durable `haze.task.request.v3` API. A registered Manager chooses a direct response or a dependency graph of specialist assignments. The production capabilities cover source-backed explanations, episode investigations, and the existing modeled PM2.5 methods.

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

Configure the existing model route in server-only `.env` using the placeholders in [.env.example](.env.example). Configure existing Zetaris access in `third_party/zetaris/.env.local` or process environment: `ZETARIS_API_KEY`, `ZETARIS_REST_URL` and `ZETARIS_ORG_ID`. Keep credentials out of browser `VITE_*` variables. The application does not provision these services or create credentials.

A general request needs only its objective. Import text, Markdown, CSV or JSON when the answer needs your source material. For example:

> Explain the supplied report and identify what its evidence does and does not establish.

A PM2.5 investigation additionally needs a domain scope, either explicitly or through a bounded phrase such as:

> Investigate PM2.5 evidence for Klang during 2026-10-24 to 2026-10-25, distinguish modeled values from observations, and identify coverage gaps.

The frontend always uses the general protocol. Set `STATE_DIR=.state/general-v1` for the new storage format; an existing incompatible configured directory fails without modification. Run `npm run tasks:serve` for the standalone loopback API at `http://127.0.0.1:8787`. Mutations require the local same-origin boundary and an `Idempotency-Key`; updates and controls also require the current objective revision, run ID, lease generation and state revision.

## Verify general execution

```sh
npm run check
npm run tasks:verify -- --fixture
npm run tasks:verify -- --live Klang 2026-10-24T00:00:00Z 2026-10-25T00:00:00Z
```

`check` includes root formatting, types, lint, build, unit and engine checks, frontend build/tests, and a fresh-process general fixture verification. Use `npm run tasks:test` for focused engine/domain tests. For an explicitly synthetic development server, build first and run `node scripts/serve-tasks.mjs --fixture`. Normal execution never substitutes fixtures, switches providers or retries automatically.

The fixture verifier imports a source, completes a general explanation and a PM2.5 investigation, checks duplicate delivery, captures exact artifacts/events and verifies unchanged readback after process restart. A fixture pass establishes integration behavior only. Live readiness requires a captured configured model and source-tool trace; missing access or a failed attempt never advances readiness. See the [implementation record](docs/orchestration/general-engine-verification.md).

## Repository layout

Browse the [documentation index](docs/README.md) for guides grouped by topic.

| Path                                  | Purpose                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `app/tasks/`                          | General task admission, authoritative SQLite rows, controls, recovery and HTTP API         |
| `app/orchestration/`                  | Bounded agent actions, registered definitions, typed tools and graph/checkpoint boundaries |
| `app/contracts/`                      | Browser-safe v3 contracts and separate server-only canonical serialization                 |
| `app/agents/`, `app/capabilities/`    | Versioned agents and independently registered domain methods                               |
| `app/adapters/`, `app/checkpoints/`   | Pinned Meterless facades, provider integration and checkpoint helpers                      |
| `app/compatibility/`, `app/graph.ts`  | Engine/restart proof and offline metadata graph                                            |
| `frontend/`                           | Chat, evidence results, source samples and agent execution display                         |
| `scripts/`, `tests/`                  | Build, verification, examples and regression checks                                        |
| `input_examples/`, `output_examples/` | Offline metadata examples and explicit orchestration fixtures                              |
| `third_party/`                        | Pinned engine sources and retained Zetaris deployment/data-source tooling                  |
| `docs/`                               | Current architecture, implementation notes and labeled historical design records           |

## Offline infrastructure and engine pins

The metadata graph uses TypeScript `StateGraph` from `@langchain/langgraph` in this process; no hosted LangGraph service is required. After building, run an offline example:

```sh
npm start -- input_examples/01-minimal.json
```

It prints deterministic execution metadata and writes an ignored JSONL trace under `logs/`. Matching expected outputs are in `output_examples/`. Its numeric `schemaVersion: 2` is an infrastructure metadata version, separate from the task request versions.

[engine_sources.json](engine_sources.json) binds immutable Meterless source revisions, complete file inventories and SHA-256 checksums. The build verifies those sources before generating ignored `vendor/` and `dist/` output. Preserve upstream lockfiles, licenses and notices; see [engine pins](docs/infrastructure/engine-pins.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The [Dockerfile](Dockerfile) uses a digest-pinned Node image and runs the first offline metadata example by default.

`npm run probe:compatibility` separately tests pinned engines, a selected provider and fresh-process SQLite checkpoint readback. Its [original infrastructure scope](docs/infrastructure/compatibility-probe.md) remains useful independently of task execution.

## Persistence and current limits

Task records, assignments, charged attempts, actions, control receipts, questions, peer messages and immutable artifacts use local SQLite under `.state/general-v1` by default. The storage-format marker is checked before opening SQLite. One application process owns a directory. LangGraph checkpoints hold references to authoritative records; they do not replace those records.

Restart fences old workers. Accepted completed work remains available, while calls interrupted without a receipt retain their charge and unknown outcome. Explicit resume requests a replacement attempt under the original deadline and remaining budget; expired work requires an explicitly linked continuation run with fresh reservations. No automatic retry occurs.

The application retains a local single-user boundary, two active tasks and two shared specialist slots. It supports configurable bounded resources and one purpose-bound peer channel per run. Source attribution is not proof of authenticity. World Model accepted-state decisions, external effects, memory capture, publication, alerts and scheduled monitoring remain disabled. Fixture checks, model prose and engine conformance do not confer scientific or operational qualification.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and review conventions.
