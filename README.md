# Haze Agent

Haze accepts natural-language requests through a local chat and durable task API. The implemented capability summarizes stored modeled PM2.5 evidence for an explicit location and time period, with exact source artifacts, coverage checks and visible limitations. The target design is [Architecture v0.14](docs/Haze_Agent_Architecture_v0.14.pdf); broader task families remain future work.

The default [v1 evidence path](docs/milestone-v014.md) performs retrieval, deterministic analysis and one synthesis turn. The opt-in [v2 orchestration path](docs/orchestration-scaffold.md) gives Manager, HazeOps, WorkerShield and EvidenceCritic separate bounded assignments, independent numerical checks and server cancellation. Teammates connect through the [shared component ports](docs/orchestration-adapters.md).

The v0.13 crew-scheduling backend, contracts, fixtures and connected UI have been retired. Scheduling requests no longer route to the historical demo. See the [retirement record](docs/legacy-retirement.md) for scope and recovery information.

## Develop locally

Use Node **24.22.1** and npm **11.8.0**, as pinned in [.nvmrc](.nvmrc) and [package.json](package.json):

```sh
npm ci
npm --prefix frontend ci
npm run build
npm --prefix frontend run dev
```

Configure the existing model route in server-only `.env` using the placeholders in [.env.example](.env.example). Configure existing Zetaris access in `third_party/zetaris/.env.local` or process environment: `ZETARIS_API_KEY`, `ZETARIS_REST_URL` and `ZETARIS_ORG_ID`. Keep credentials out of browser `VITE_*` variables. The application does not provision these services or create credentials.

Ask with an explicit place and interval, for example:

> Summarize the PM2.5 evidence available for Klang during 2026-10-24 to 2026-10-25, distinguish modeled values from observations, and identify coverage gaps.

The frontend defaults to v1. Set `VITE_HAZE_ORCHESTRATION=true` in its environment to use the v2 orchestration path. The previous `VITE_HAZE_HYBRID` flag remains a fallback for existing configuration. Both normal paths use the configured live adapters and report failed or unavailable integrations explicitly.

For a standalone loopback API, run `npm run tasks:serve`. It listens at `http://127.0.0.1:8787` by default; requests require the local same-origin boundary and a stable `Idempotency-Key`. See the [v1 API](docs/milestone-v014.md) and [v2 API](docs/orchestration-scaffold.md) documentation for payloads, polling, artifacts and cancellation.

## Verify the task paths

```sh
npm run check
npm run orchestration:verify -- --fixture
```

The previous `hybrid:verify` and `hybrid:test` commands remain compatibility aliases; use `orchestration:verify` and `orchestration:test` for new work.

`check` includes frontend production build/tests (`frontend:check`) and the explicit fixture integration check (`test:integration`), in addition to root formatting, types, lint, build, unit tests and engine checks. Run `npm run test:integration` directly after building to exercise the integration check alone.

The explicit fixture verifier uses synthetic evidence and deterministic model responses, captures exact events/artifacts and checks readback in a fresh process. Its output does not establish live readiness. The normal API never falls back to fixtures. For a deliberately synthetic development server, build first and run `node scripts/serve-tasks.mjs --orchestration-fixture`.

To exercise configured live access:

```sh
npm run tasks:verify -- Klang 2026-10-24T00:00:00Z 2026-10-25T00:00:00Z
npm run orchestration:verify -- --live Klang 2026-10-24T00:00:00Z 2026-10-25T00:00:00Z
```

The [verification record](docs/orchestration-verification.md), [source limitations](docs/pm25-evidence-source.md) and [readiness register](docs/orchestration-readiness.json) distinguish captured synthetic runs from live evidence. Recorded live attempts remain blocked by missing Zetaris access; no source-backed answer has been verified.

## Repository layout

| Path                                               | Purpose                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `app/tasks/`                                       | Durable task admission, v1 runtime, HTTP API and bounded evidence/model adapters     |
| `app/orchestration/`                               | Manager/specialist coordination, v2 contracts, runtime, ports and independent checks |
| `app/contracts/common.ts`, `app/contracts/json.ts` | Shared immutable references, canonical JSON and hashing                              |
| `app/adapters/`, `app/checkpoints/`                | Pinned Meterless facades, provider integration and checkpoint helpers                |
| `app/compatibility/`, `app/graph.ts`               | Engine/restart proof and offline metadata graph                                      |
| `frontend/`                                        | Chat, evidence results, source samples and agent execution display                   |
| `scripts/`, `tests/`                               | Build, verification, examples and regression checks                                  |
| `input_examples/`, `output_examples/`              | Offline metadata examples and explicit orchestration fixtures                        |
| `third_party/`                                     | Pinned engine sources and retained Zetaris deployment/data-source tooling            |
| `docs/`                                            | Current architecture, implementation notes and labeled historical design records     |

## Offline infrastructure and engine pins

The metadata graph uses TypeScript `StateGraph` from `@langchain/langgraph` in this process; no hosted LangGraph service is required. After building, run an offline example:

```sh
npm start -- input_examples/01-minimal.json
```

It prints deterministic execution metadata and writes an ignored JSONL trace under `logs/`. Matching expected outputs are in `output_examples/`. Its numeric `schemaVersion: 2` is an infrastructure metadata version, separate from the task request versions.

[engine_sources.json](engine_sources.json) binds immutable Meterless source revisions, complete file inventories and SHA-256 checksums. The build verifies those sources before generating ignored `vendor/` and `dist/` output. Preserve upstream lockfiles, licenses and notices; see [engine pins](docs/engine-pins.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The [Dockerfile](Dockerfile) uses a digest-pinned Node image and runs the first offline metadata example by default.

`npm run probe:compatibility` separately tests pinned engines, a selected provider and fresh-process SQLite checkpoint readback. Its [original infrastructure scope](docs/compatibility-probe.md) remains useful independently of task execution.

## Persistence and current limits

Task records, assignments, charged attempts, events and immutable artifacts use local SQLite state under `STATE_DIR` (normally `.state/`). One process owns a state directory. Interrupted tasks become explicit failures after restart; they do not automatically replay. LangGraph checkpoints support execution and do not confer domain authority. The PostgreSQL saver has a separate integration suite.

The current application is a local single-user development boundary. It supports one bounded stored-PM2.5 capability, not the full v0.14 task catalogue. Live Zetaris response behavior and coverage remain unverified. H-Mem and World Model orchestration ports default to explicit unavailability; the teammate NightShift service is not connected. Reviewed-memory capture, accepted-state writes, publication, alerts and other external effects remain disabled. Model prose, fixture checks and engine conformance do not establish scientific or operational qualification.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and review conventions.
