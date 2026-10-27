# Haze Agent

Haze accepts natural-language objectives through a local chat and one durable `haze.task.request.v3` API. A registered Manager chooses a direct response or a dependency graph of specialist assignments. The registered capabilities cover source-backed explanations, episode investigations, modeled PM2.5 methods and damage accounting from retained World Model evidence.

The reusable engine separates browser-safe contracts, authoritative SQLite state, bounded agent execution, typed tools and domain capabilities. Corrections, questions, imported sources, controls, immutable work products and independent numerical review are visible in the application. See the [general engine guide](docs/orchestration/general-engine.md) and [Architecture v0.14](docs/architecture/Haze_Agent_Architecture_v0.14.pdf).

The v1/v2 task paths and routing flags are retired. Old protocol tags are rejected with v3 guidance. Historical databases and checkpoint directories remain archival and are never automatically migrated or served by the new API. The earlier crew scheduling backend also remains retired; see the [retirement record](docs/history/legacy-retirement.md).

## Develop locally

Use Node **24.22.1** and npm **11.8.0**, as pinned in [.nvmrc](.nvmrc) and [package.json](package.json):

```sh
npm ci
npm --prefix frontend ci
npm run dev
```

`npm run dev` first runs `docker compose up --detach` to start Zetaris,
checks its container status, builds the backend, then starts Vite
with the frontend and the shared dashboard, task and World Model APIs, usually at
`http://localhost:5173`. Docker Desktop must be running, with root `.env` and image
registry access configured as described below. A failed startup step stops the
command before the next step runs.

Keep this terminal running; when the console is idle, `Ctrl+C` stops the app and leaves the Zetaris containers
running. Use `docker compose stop` to stop Zetaris. Run the dev command again after
backend changes to rebuild them. The standalone `tasks:serve` command is an
alternative API entry point and must not run alongside Vite using the same state
directory.

Only one server can own a state directory. Vite stops if its port is already in
use instead of selecting another port. Stop the earlier dev command with `Ctrl+C`
before restarting. A state ownership conflict reports the owner PID and directory;
for an independent instance, set `HAZE_TASK_STATE_DIR` to another directory and
pass a different `--port`. `HAZE_TASK_STATE_DIR` takes precedence over `STATE_DIR`.
Do not delete the state databases or lock files to resolve a running owner.

After startup, an interactive terminal shows a `haze>` command prompt. The launcher
leaves the browser closed; use `open` to launch the frontend when needed. It
initializes the shared API and HazeOps watchers before reporting the app ready;
registered agents execute when work is admitted. Type `help` or `help tasks` for
usage. Tab completes commands and setting names; Up/Down recalls this session's
commands. Configuration writes are excluded from history and credentials are
redacted from console output.
Routine Vite optimizer and restart messages are hidden; warnings and errors
remain visible.

```text
haze> status
haze> status agents --watch
haze> agents show Manager
haze> tasks run "Explain the evidence needed to investigate a haze episode"
haze> tasks list --active
haze> tasks watch TASK_ID
haze> tasks pause TASK_ID
haze> tasks resume TASK_ID
haze> nightshift status
haze> nightshift jobs
haze> config get HAZE_MODEL
haze> config set HAZE_MODEL "your-model"
haze> config validate
haze> app restart --rebuild
haze> logs app --follow
haze> doctor
haze> open world
```

`status` supports `app`, `agents`, `nightshift`, `zetaris`, `world`, and `hazeops`. Task
commands also support `show`, `cancel`, `continue`, and `reply`; `help tasks`
explains their arguments. Resume retains the run's deadline and remaining budget;
Continue creates a fresh linked run. Local cancellation does not establish that a
remote provider stopped. Nightshift status reports separate job, direct inference,
and automatic-chain readiness. It does not install models or start Nightshift's
operating-system service.

`config` shows setup guidance; `config show` lists supported effective settings and
their sources. `config set` validates and saves to root `.env`, preserves unrelated
settings, and reports overrides and restart requirements. Existing task routes
remain pinned. `logs zetaris --follow` streams this project's Compose output;
`tasks watch` and `nightshift show JOB_ID` inspect durable work history.

Manager chat limits can be configured in the same console or root `.env`:

| Setting                          | Default | Allowed range    |
| -------------------------------- | ------- | ---------------- |
| `HAZE_MANAGER_MAX_MODEL_CALLS`   | 6       | 1–64 per message |
| `HAZE_MANAGER_MAX_RETRIEVALS`    | 4       | 0–32 per message |
| `HAZE_MANAGER_TIMEOUT_MS`        | 120000  | 1000–1800000 ms  |
| `HAZE_MANAGER_MAX_OUTPUT_TOKENS` | 2400    | 1–32768 per call |
| `HAZE_MANAGER_MAX_CORRECTIONS`   | 1       | 0–8 per message  |

For example, `config set HAZE_MANAGER_MAX_MODEL_CALLS 12`,
`config set HAZE_MANAGER_MAX_RETRIEVALS 8`, then `config validate` and
`app restart`. Values must be whole numbers within these ranges; invalid server
settings fail startup validation. All decisions share the model-call budget,
including retrieval requests, malformed-output corrections and the final reply.
Increasing a retrieval or correction limit does not increase the model-call
limit. These controls govern quick Manager chat; tracked task budgets remain
separate. Backend source edits require `app restart --rebuild`. If the dev
launcher was already running when its console code changed, stop it and rerun
`npm run dev` once to load the updated console.

Historical comparisons also need evidence covering the requested dates. See
[Compare historical haze days](docs/guides/historical-haze-comparison.md) for the
Kuala Lumpur workflow, timezone boundaries, source imports and current limits.

During a watch or command, `Ctrl+C` ends that command and returns to the prompt.
When idle, `Ctrl+C`, `Ctrl+D`, or `exit` stops the app and preserves Zetaris.
`shutdown --all` stops the app and then this project's Compose services, retaining
their data. Redirected output keeps plain startup logs without a prompt; use
`npm run dev -- --console` to explicitly enable command input through a pipe, or
`npm run dev -- --no-console` to disable the console in a terminal. Other options
continue to pass through to Vite.

The root dev command names the actual components: Zetaris, the Haze TypeScript
build, React web app, LangGraph task engine, SQLite World Model, HazeOps
collectors, agent model routes, and Nightshift runtime, candidate jobs, inference,
and automation. They share the Haze process where applicable; these rows do not
imply separate operating-system services. Each starting or checking component has a live
elapsed timer that refreshes every 0.1 seconds and freezes when the step finishes.
Compose progress and successful build output are captured so they do not print repeated status
lines. Warnings, failure diagnostics and app runtime logs remain visible. Redirected
output prints each component's final startup status once, without terminal escape
codes. `BUILT` confirms compilation. `READY` for the web app, task API, and World
Model requires a successful request, including actual task-store and World Model
reads. HazeOps reports its scheduler's execution state and enabled source count.
Model routes stay `UNVERIFIED` until their live-inference readiness reports prove
otherwise; startup submits no model calls or Nightshift jobs. Optional components
can be `DISABLED`, `BLOCKED`, `UNCONFIGURED`, or `UNAVAILABLE` while the app starts.
A reachable Nightshift runtime is
shown separately from usable candidate jobs and released automation. New candidate
chains allow cloud models with no monetary cap; explicit local-only grants retain
$0 cloud spend. Job, attempt and lifetime limits still apply. Normal agent
inference and background candidate generation are separate Nightshift APIs. Use
`status hazeops` or `nightshift status` to inspect the current state.

`STARTED` means Compose started the containers; the Zetaris row summarizes their
current health and completed one-shot jobs. Check `docker compose ps --all` for
individual container details. Successful `init` and `bootstrap` jobs normally show
`Exited (0)`. The panel includes the actual app URL and total startup time, including
Docker startup and the backend build. Edit `scripts/dev-status.mjs` to customize the
panel. Use `npm run --silent dev` to also hide npm's initial script header. Vite
options still work, for example `npm run dev -- --port 5174`.

### Zetaris and the PM2.5 data flow

Zetaris is the authenticated SQL/query gateway to the SmokeLedger PostgreSQL
evidence store. It is **not** the service that fetches PM2.5 from Open-Meteo or
OpenAQ.

```text
MODELED DATA
Open-Meteo Air Quality API
    -> PM2.5 fetcher
    -> SmokeLedger PostgreSQL (pm25 table)
    -> Zetaris registered PostgreSQL datasource (sl_pg)
    -> Haze PM2.5 tool queries Zetaris REST
    -> bounded, provenance-retaining evidence capture

LIVE STATION OBSERVATIONS (separate path)
OpenAQ v3 API
    -> HazeOps OpenAQ watcher
    -> station evidence
    (does not pass through Zetaris or SmokeLedger's PM2.5 table)
```

#### Modeled PM2.5: Open-Meteo through Zetaris

1. `smokeledger:fetch:pm25` calls Open-Meteo's Air Quality API for canonical
   locations, requesting the past day and three forecast days in GMT. It writes
   returned PM2.5 rows into SmokeLedger PostgreSQL, marking them as modeled and
   recording the source as `open-meteo-air-quality`; it does not publish to
   Zetaris FileStore. See the [fetcher endpoint](third_party/zetaris/sources/smokeledger/open_meteo_pm25/fetch.ts#L18),
   [request window](third_party/zetaris/sources/smokeledger/open_meteo_pm25/fetch.ts#L29),
   and [database upsert](third_party/zetaris/sources/smokeledger/open_meteo_pm25/fetch.ts#L68).
   The [PM2.5 table schema](third_party/zetaris/sources/smokeledger/sql/01_schema.sql#L42)
   separates `kind`, provider issuance time, local ingestion time and source.
   Its comment uses CAMS as an example of a model, but this fetcher identifies
   these rows as Open-Meteo in the `source` column.
2. Zetaris registers the local PostgreSQL database as datasource `sl_pg` using
   JDBC at `host.docker.internal:5433`, then registers its tables. This lets
   Zetaris query PostgreSQL; the [registration SQL](third_party/zetaris/sources/smokeledger/sql/02_zetaris_register.sql#L9)
   does not ask Zetaris to fetch from Open-Meteo.
3. Haze builds a bounded SQL query for the requested town and start-inclusive,
   end-exclusive time range. It reads `sl_pg.pm25`, joins `sl_pg.towns` for
   coordinates, and filters to `kind = 'model'` and
   `source = 'open-meteo-air-quality'`. The [PM2.5 evidence adapter](app/capabilities/pm25/evidence.ts#L231)
   sends that SQL through the [Zetaris REST transport](app/adapters/zetaris.ts#L31).
   The task retains the response and query selection as evidence. This product
   path queries `sl_pg` directly; it does not depend on the separately activated
   SmokeLedger USL tables.

Run commands from the repository root:

```powershell
npm run db:init
npm run smokeledger:fetch:pm25 -- --location kuala-lumpur --dry-run
npm run smokeledger:fetch:pm25 -- --location kuala-lumpur
```

Omit `--location kuala-lumpur` to fetch all canonical locations, or repeat
`--location` for more than one. The dry run requests and validates Open-Meteo
data without writing it to PostgreSQL. See the [database init script](package.json#L16),
[PM2.5 fetch script](package.json#L19)
and [fetcher instructions](third_party/zetaris/sources/smokeledger/open_meteo_pm25/README.md#L3).

To register the PostgreSQL datasource and compile/activate the additional
SmokeLedger USL tables, preview and then run:

```powershell
npm run zetaris:bootstrap:smokeledger -- --dry-run
npm run zetaris:bootstrap:smokeledger
```

The [bootstrap](third_party/zetaris/usl/bootstrap_smokeledger.ts#L114)
also verifies the USL queries. Rerun it after fetching new rows if you need to
refresh those activated USL tables. That activation is separate from the Haze
PM2.5 tool's direct `sl_pg` datasource query. Configure Zetaris credentials
server-side as `ZETARIS_API_KEY`, `ZETARIS_REST_URL` and numeric
`ZETARIS_ORG_ID`; the transport requires the key, has a 30-second timeout, and
limits response size. Never put secrets in source or browser `VITE_*` settings.

#### Observed PM2.5: separate live OpenAQ station feed

OpenAQ is a second, separate HazeOps watcher. The [watcher](server/src/hazeops/adapters/openAq.ts#L20)
calls the OpenAQ v3 API directly for its station catalogue and latest readings;
the [server registers it independently](server/src/index.ts#L58).
It requires `OPEN_AQ_KEY`. It does not use Zetaris, does not populate
`sl_pg.pm25`, and is not an automatic fallback for a failed Zetaris PM2.5 query.

OpenAQ contributes current station observations, not the Open-Meteo modeled
time series. The watcher filters to eligible Malaysian stations near configured
locations and excludes stations with no recent readings. Its documented
limitations matter: many listed Malaysian stations are low-cost sensors, not
official DOE reference monitors, readings can drift with humidity, stations
more than 75 km from a configured city or silent for over 48 hours are excluded,
and station coverage can be incomplete. See the [station description](server/src/hazeops/adapters/openAq.ts#L26)
and [candidate filtering](server/src/hazeops/adapters/openAq.ts#L105).

#### Evidence and limitations

- Open-Meteo values are model output, not ground observations. The API response
  does not establish a provider model-issuance time; new rows store issuance as
  unknown and record local ingestion separately. Town coordinates do not prove
  the model grid cell represents the whole town. Nulls and missing time slots
  stay unknown; hourly output is not evidence of an hour-averaged measurement.
  See the [PM2.5 evidence boundary](docs/evidence/pm25-evidence-source.md#L26).
- Each Haze Zetaris request is limited to 31 days, 1,500 retained rows, 30
  seconds and 512 KiB; truncation means coverage may be incomplete. A task
  queries existing rows and does not fetch or refresh either public provider.
  See the [query bounds](docs/evidence/pm25-evidence-source.md#L50).
- The product transport uses the configured `ZETARIS_API_KEY` directly; it
  does not log in or refresh credentials. A missing or invalid key prevents the
  Zetaris query from running. See the [transport authentication](app/adapters/zetaris.ts#L31).
- Live readiness depends on credentials, a reachable Zetaris instance, a
  registered `sl_pg` datasource and rows for the requested town and period.
  The evidence note records that these live endpoint/data checks were
  not verified at the time of its access check. A fixture test proves only the
  fixture path, not live Zetaris access. See the [access-check qualification](docs/evidence/pm25-evidence-source.md#L55).

For generic setup and SQL helper usage, see the [Zetaris platform guide](third_party/zetaris/zetaris-platform/README.md)
and [repository script guide](third_party/zetaris/scripts/HOWTO.md).
For PM2.5 evidence semantics and data provenance, see the [full source note](docs/evidence/pm25-evidence-source.md).

A general request needs only its objective. Import text, Markdown, CSV or JSON when the answer needs your source material. For example:

> Explain the supplied report and identify what its evidence does and does not establish.

A PM2.5 investigation additionally needs a domain scope, either explicitly or through a bounded phrase such as:

> Investigate PM2.5 evidence for Klang during 2026-10-24 to 2026-10-25, distinguish modeled values from observations, and identify coverage gaps.

[damage-appraisal](app/capabilities/damage-appraisal/README.md) builds and reviews calculated damage accounts from retained evidence. [damage-account-intake](app/capabilities/damage-account-intake/README.md) validates supplied manifests and component completeness. These capabilities were previously named `damage-account` and `damage-accounting`.

Open `/damage-account` and describe the location, episode and dates; no upload is required. `WorldModelDamageInputAdapter` in [app/adapters/damage-input-adapter](app/adapters/damage-input-adapter/README.md) retrieves compatible retained accounting captures and their exact original evidence. Composition supplies its damage-account scope and reconstruction rules. Saved accounts can be opened at `/damage-account/TASK_ID`. This workspace keeps its own task selection; the dashboard and original office retain their existing presentation. DamageAccountant produces separate physical, financial incidence and selected social welfare views; EvidenceCritic independently reconstructs the exact account and components. Missing evidence produces an explicit backend acquisition gap rather than invented values. The adapter requires accounting-ready World Model evidence: it does not fetch external datasets or estimate health effects from PM2.5. See the [adapter report](docs/reports/orchestration/world-model-damage-input-adapter-report.md) and [original accounting report](docs/reports/orchestration/damage-accountant-implementation-report.md).

Open **World Model** in the main navigation, or `/world-model`, to browse retained SQLite records, relationships, current acceptance outcomes, history and lineage, and rebuild derived views. The **Reference sandbox** panel runs Meterless's original control plane with disposable sample data. See the [World Model control-plane guide](docs/testing/world-model-control-plane.md) for configuration and isolated checks.

Choose **Demos** in the frontend to browse the [damage account example](docs/guides/damage-account-demo.md) at `/demos/damage-account` and [damage reduction example](docs/guides/damage-reduction-demo.md) at `/demos/damage-reduction`. These bundled synthetic recordings include exact sources and reviews and need no separate demo commands, provider, or task server. To execute a fresh fixture workflow instead, use `npm run damage:demo` or `npm run reduction:demo`; the isolated servers default to ports 5174 and 5175 respectively.

The frontend always uses the general protocol. Set `STATE_DIR=.state/general-v2` for the new storage format; an existing incompatible configured directory fails without modification. Run `npm run tasks:serve` for the standalone loopback API at `http://127.0.0.1:8787`. Mutations require the local same-origin boundary and an `Idempotency-Key`; updates and controls also require the current objective revision, run ID, lease generation and state revision.

The dashboard, HazeOps watchers, general tasks and `/world-model` now use one
application backend and the same SQLite World Model. Vite dev and preview serve
all `/api` routes locally; a separate dashboard server is unnecessary.
`HAZE_TASK_STATE_DIR` remains a Vite override for the whole application store.
Use a compatible `.state/general-v2` directory; existing legacy directories remain
archival until explicitly imported. See the [dashboard migration guide](app/dashboard/README.md).

## Verify general execution

To test the Manager independently, run `npm run manager:test`. It uses a fresh isolated build and task state with deterministic specialist stubs. Use `npm run manager:test:live` to test only the Manager's configured model against the same stubs. To talk to that model with your own prompts and follow-ups, run `npm run manager:chat`. See [isolated Manager testing](docs/testing/manager-testing.md) for focused cases, interactive chat, traces and the limits of a passing result.

```sh
npm run check
npm run tasks:verify -- --fixture
npm run damage:verify -- --fixture
npm run tasks:verify -- --live Klang 2026-10-24T00:00:00Z 2026-10-25T00:00:00Z
```

`check` includes root formatting, types, lint, build, unit and engine checks, frontend build/tests, and fresh-process general and damage-account fixture verification. Use `npm run tasks:test` for focused engine/domain tests. For an explicitly synthetic development server, build first and run `node scripts/serve-tasks.mjs --fixture`. Normal execution never substitutes fixtures, switches providers or retries automatically.

The fixture verifier imports a source, completes a general explanation and a PM2.5 investigation, checks duplicate delivery, captures exact artifacts/events and verifies unchanged readback after process restart. A fixture pass establishes integration behavior only. Live readiness requires a captured configured model and source-tool trace; missing access or a failed attempt never advances readiness. See the [implementation record](docs/reports/orchestration/general-engine-verification.md).

## Repository layout

Browse the [documentation index](docs/README.md) for guides grouped by topic.

| Path                                                                | Purpose                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`app/tasks/`](app/tasks/README.md)                                 | General task admission, authoritative SQLite rows, controls, recovery and HTTP API                |
| [`app/orchestration/`](app/orchestration/README.md)                 | Bounded agent actions, registered definitions, typed tools and graph/checkpoint boundaries        |
| [`app/contracts/`](app/contracts/README.md)                         | Browser-safe v3 contracts and separate server-only canonical serialization                        |
| `app/agents/`, [`app/capabilities/`](app/capabilities/README.md)    | Versioned agents and independently registered domain methods                                      |
| `app/adapters/`                                                     | Provider integrations, World Model damage-input bridge and Zetaris deployment/data-source tooling |
| `app/dashboard/`, `app/world/`                                      | Dashboard APIs/projections and shared SQLite evidence ingestion                                   |
| [`app/checkpoints/`](app/checkpoints/README.md)                     | Checkpoint helpers                                                                                |
| [`app/compatibility/`](app/compatibility/README.md), `app/graph.ts` | Engine/restart proof and offline metadata graph                                                   |
| `frontend/`                                                         | Chat, evidence results, source samples and agent execution display                                |
| `scripts/`, `tests/`                                                | Build, verification, examples and regression checks                                               |
| `input_examples/`, `output_examples/`                               | Offline metadata examples and explicit orchestration fixtures                                     |
| `third_party/`                                                      | Pinned engine sources                                                                             |
| `docs/`                                                             | Current architecture, implementation notes and labeled historical design records                  |

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
