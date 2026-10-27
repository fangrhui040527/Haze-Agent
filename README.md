# Haze Agent

> **Track:** 02 — The Agent That Can Explain Why  
> **Sponsor technology:** Zetaris, Meterless, NVIDIA Nemotron  
> **Run:** `npm run dev`, then open `http://localhost:5173`; task intake is `POST /api/tasks`

## 1. Problem

Policy analysts and journalists investigating haze in Malaysia need to connect air-quality evidence, episode context, damage estimates and mitigation options. Those sources cover different periods and often mix observations with modeled values, making explanations hard to verify.

Haze investigates scoped PM2.5 questions, explains supplied evidence and compiles damage accounts from retained accounting inputs. It preserves sources, calculation inputs, independent reviews and coverage gaps so users can inspect how a result was produced.

## 2. Agents

The Manager selects the specialists a request needs; every request does not run all five roles.

| Agent            | Responsibility                                                                                | Can block or retry?                                                              |
| ---------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Manager          | Chooses a direct answer, clarification, lookup or specialist plan; supervises and synthesizes | Can replan, wait or request clarification within admitted budgets                |
| HazeOps          | Retrieves and retains evidence through granted tools                                          | Reports gaps and asks for missing scope; no silent fixture fallback              |
| WorkerShield     | Assesses evidence support and develops conditional mitigation plans                           | Can downgrade support and retain prerequisites; does not block evidence delivery |
| EvidenceCritic   | Independently checks exact source and calculation artifacts                                   | Rejects unsupported or inconsistent numerical work; cannot review its own work   |
| DamageAccountant | Compiles physical, financial-incidence and social-welfare views                               | Requests missing inputs or boundaries; can return explicitly partial accounts    |

## 3. What makes this an agent system

- The Manager chooses and revises a dependency plan from the objective, specialist findings and user corrections.
- Independently checkpointed LangGraph workflows let specialists progress while the Manager decides its next action.
- Registered tools validate arguments, results, grants and budgets. Models do not submit SQL or executable code.
- Independent review binds exact artifact versions and hashes; finalization checks their dependencies before selecting numerical products.
- Human questions and bounded peer messages support durable waits. Corrections fence old work and require evidence applicability checks.
- Shared SQLite records retain tasks, charged attempts, immutable artifacts, World Model evidence and decision events across restarts.

See the [task engine guide](docs/orchestration/general-engine.md) and [LangGraph architecture](docs/architecture/langgraph-runtime.md).

## 4. Tech stack

| Component            | Technology                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Application and API  | TypeScript, Node.js, shared local HTTP APIs                                                  |
| Frontend             | React, Vite                                                                                  |
| Orchestration        | LangGraph Manager and specialist workflows                                                   |
| Contracts            | Zod; `haze.task.request.v3` and related schemas                                              |
| Persistence          | SQLite task/World Model records and separate execution checkpoints                           |
| External evidence    | Zetaris REST API and registered source collectors                                            |
| Model inference      | Nightshift with NVIDIA Nemotron; direct NVIDIA and OpenAI-compatible adapters also supported |
| Reference components | Checksum-pinned Meterless starter, H-MEM and World Model sources                             |
| Logging              | Durable SQLite task events; offline example JSONL traces in `logs/`                          |
| Containers           | Docker Compose for Zetaris; root Dockerfile for the offline metadata example                 |

## 5. Setup

Use **Node 24.22.1** and **npm 11.8.0**, as pinned in [.nvmrc](.nvmrc) and [package.json](package.json). The full dev launcher also needs running Docker Desktop and access to the issued Zetaris images.

```sh
cp .env.example .env
npm ci
npm --prefix frontend ci
```

On PowerShell, use `Copy-Item .env.example .env`. Keep `.env` private and use your own credentials; server keys must stay out of browser `VITE_*` variables.

Configure the Zetaris image references, `POSTGRES_PASSWORD` and `ZETARIS_ADMIN_PASSWORD` using the [platform guide](app/adapters/zetaris/zetaris-platform/README.md). For direct NVIDIA inference, set `HAZE_PROVIDER=nvidia`, supply `NVIDIA_API_KEY` and clear `HAZE_PROVIDER_BASE_URL`. The template defaults to a local Nightshift runtime, which needs configured model access. Provider and role-routing settings are in [.env.example](.env.example).

Live PM2.5 retrieval also needs `ZETARIS_API_KEY` and published evidence snapshots; follow the [source guide](docs/evidence/pm25-evidence-source.md) or [historical comparison workflow](docs/guides/historical-haze-comparison.md). Tasks read published data rather than refreshing it automatically.

```sh
npm run dev
```

This starts Zetaris through Compose, builds the backend and starts Vite with shared APIs, normally at `http://localhost:5173`. At `haze>`, use `open` for the browser, `status` for readiness and `help` for commands. `Ctrl+C` at the idle prompt stops the app; `docker compose stop` stops Zetaris.

For the standalone API at `http://127.0.0.1:8787`:

```sh
npm run build
npm run tasks:serve
```

One application process can own a state directory. Stop the dev server first or set a different `HAZE_TASK_STATE_DIR`, which overrides `STATE_DIR`. The default is `.state/general-v2`; incompatible existing state fails without modification. See [sample mode](#7-sample-mode) to run without live services.

## 6. Usage

In the web app, submit an objective and import text, Markdown, CSV or JSON when it needs your source material. Use `/damage-account` for scoped accounts from compatible retained accounting evidence; missing inputs are reported explicitly.

**API request** to the dev server (POSIX shell):

```sh
curl -X POST http://localhost:5173/api/tasks \
  -H "Origin: http://localhost:5173" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: readme-pm25-001" \
  -d '{
    "schema_version": "haze.task.request.v3",
    "objective": "Investigate PM2.5 evidence for Klang during 2026-10-24 to 2026-10-25, distinguish modeled values from observations, and identify coverage gaps."
  }'
```

**Admission response (HTTP 202; example ID):**

```json
{
  "task_id": "3f5cb017-b838-42a4-9fc0-fac595ce725e",
  "status_url": "/api/tasks/3f5cb017-b838-42a4-9fc0-fac595ce725e",
  "events_url": "/api/tasks/3f5cb017-b838-42a4-9fc0-fac595ce725e/events",
  "reused": false
}
```

Execution is asynchronous. Replace `TASK_ID` with the returned ID:

```sh
curl http://localhost:5173/api/tasks/TASK_ID
curl "http://localhost:5173/api/tasks/TASK_ID/events?after=0"
```

The task response includes state, questions and assignments. When available, `result` contains the answer, completion status, sources, work products, uncertainty, review status and next requirements. Events return `next_cursor` for polling. Read artifacts through `GET /api/artifacts/ARTIFACT_ID`.

Reuse an idempotency key only for identical redelivery. Mutations require a matching `Origin`; with the standalone server, change both the URL and `Origin` to `http://127.0.0.1:8787`. See the [API guide](docs/orchestration/general-engine.md#api) for controls, corrections and source imports.

## 7. Sample mode

`SAMPLE_MODE=true` runs the normal Manager and specialist workflows over raw
synthetic evidence in `data/sample-scenarios/`. Individual LLM turns first check
`data/llm-cache/` for genuine recorded model responses matching the complete
semantic request. Typed normalization rebinds only validated runtime references;
changed objectives, evidence, scope or constraints require a matching new entry
or actual model inference. The runtime still executes tools, calculations,
independent reviews and final synthesis. It never loads a completed answer from
`output_examples/`.

The default sample cache mode is `read-only`: use matching responses and let
misses reach the configured LLM. Matching cache hits need no live credentials or
new inference. An allowlist manifest permits the bundled NVIDIA recordings for
the automatic local fallback; it does not allow arbitrary provider substitution.
With no configured provider, a miss uses local Ollama and an installed
`qwen2.5:7b` model. Install Ollama and run `ollama pull qwen2.5:7b` if you need
that fallback. The runtime prepares a dedicated 16,384-token alias from cached
weights without downloading weights or altering the original model. New inputs
without a matching response still need a working configured or local model.
No Zetaris or external evidence credentials are needed, and the dev launcher
skips Docker.

Run the three sample requests and generate their matching outputs:

For the bundled credential-free run, leave `.env` empty. Explicit provider
settings take precedence and may require fresh inference on a cache miss.

```sh
npm run samples:run -- --all
```

Or run one request:

```sh
npm run samples:run -- input_examples/example_1.json
```

After building, `SAMPLE_MODE=true npm start -- input_examples/example_1.json`
also runs the real sample workflow. In PowerShell set
`$env:SAMPLE_MODE='true'` before `npm start -- input_examples/example_1.json`.

The runner enables sample mode, starts fresh isolated state, imports the raw
inputs and submits ordinary v3 tasks. It writes newly generated results to
`output_examples/example_1_output.json`, `example_2_output.json` and
`example_3_output.json`; it never reads those files to answer a request. See the
[sample walkthrough](docs/guides/sample-mode.md) for the three scenarios and
saved execution evidence. The normal sample-mode app defaults to
`.state/sample-mode`; an explicit `HAZE_TASK_STATE_DIR` overrides that location.
Set `HAZE_MODEL_CACHE_MODE` to `read-write` to record successful misses,
`record-only` to refresh every model turn, `off` to always use inference, or
`cache-only` to fail on a miss without contacting a model. Set
`HAZE_MODEL_CACHE_DIR` for another server-side cache directory. Custom local
model settings use `HAZE_SAMPLE_MODEL` and `HAZE_SAMPLE_MODEL_BASE_URL`.
Cache-hit receipts identify the recorded producer and original receipt; they
do not claim fresh HTTP responses or token usage. Sample HTTP tasks allow up to
65,536 input bytes per model turn, subject to explicit host limits.

The [verification record](docs/reports/sample-mode-verification.md) covers all
three runs from a fresh checkout with an empty `.env`, blocked model/external
network access, and a changed-input test that changed the calculated result.

Deterministic integration fixtures are separate from sample mode.
Run deterministic fixture workflows without live model or source credentials:

```sh
npm run tasks:verify -- --fixture
npm run damage:verify -- --fixture
```

These build and exercise orchestration, review, persistence and restart/readback with synthetic adapters. Fixture model decisions and evidence are deterministic; they verify integration behavior, not live reasoning or source readiness.

For a fixture API, build first and run `npm run tasks:serve -- --fixture` with `HAZE_TASK_STATE_DIR` set to a separate directory.

`--fixture` substitutes deterministic agent decisions for integration testing.
Sample mode uses raw local evidence and recorded or newly inferred LLM turns
inside the ordinary runtime; its cache never supplies completed tool results or
independent-review artifacts.

The smaller offline infrastructure example runs a checkpoint graph and prints metadata, with JSONL traces in `logs/`:

```sh
npm run build
npm start -- input_examples/01-minimal.json
```

Or run that same metadata example in Docker:

```sh
docker build -t haze-agent .
docker run --rm haze-agent
```

The root image runs the offline example only; it does not start the web app or task API.

## 8. Failure handling

| Failure                                                     | Behaviour                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Malformed JSON, invalid v3 input or missing idempotency key | HTTP 400 with a structured error                                                             |
| Missing or mismatched mutation `Origin`                     | HTTP 403                                                                                     |
| Idempotency key reused with different content               | HTTP 409; preserves the prior request                                                        |
| Source failure or missing evidence                          | Retains a failure or coverage gap; never silently substitutes fixtures                       |
| Unsupported numerical work                                  | Review gates prevent selecting affected products                                             |
| Invalid model action                                        | Bounded schema/action correction; provider failures have no automatic spending retry         |
| Deadline or execution failure                               | Recorded in task/assignment state                                                            |
| Restart during a dispatched call with no receipt            | Attempt stays charged with unknown outcome; replacement requires explicit Resume or Continue |

Resume retains the deadline and remaining budget; Continue creates a fresh linked run. Local cancellation does not prove a remote provider stopped. See [persistence and recovery](docs/orchestration/general-engine.md#persistence-and-restart).

## 9. Data and licensing

Fixtures and bundled demo recordings use explicitly synthetic data. The repository also contains [real public source samples](data/damage-source-research/2026-10-27/README.md) with URLs, retrieval times, hashes, attribution and limitations. Their observation periods differ; they are not a matched episode or complete damage account.

Preserve dataset attribution and usage terms. See [data/README.md](data/README.md), the [sample manifest](data/damage-source-research/2026-10-27/sample-manifest.json) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Component licenses are retained beside their sources; the repository currently has no root project license.

## 10. Limitations

- Local single-user application, with two active tasks and two shared specialist slots by default.
- Results depend on source coverage, freshness, access and compatible scope. Attribution does not establish authenticity or causation.
- Damage appraisal uses supplied physical quantities and compatible unit values. It does not infer attributable health effects or intervention effectiveness from raw PM2.5 data.
- Numerical and citation checks do not establish scientific qualification. World Model acceptance is disabled by default and requires an explicit supported policy.
- HazeOps supports bounded recurring collection while the app runs. Full unattended acquisition, recalculation and mitigation remain subject to the [product acceptance criteria](docs/architecture/haze-core-goals.md).
- External publication, alerts and operational actions remain disabled.

For development checks, use `npm run check`; see [CONTRIBUTING.md](CONTRIBUTING.md) and the [verification record](docs/reports/orchestration/general-engine-verification.md) for scope and live-readiness requirements.

## 11. Pre-existing components

| Component                                                      | Provenance and use                                                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meterless Agentathon starter, H-MEM and World Model references | Commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`, Apache-2.0. H-MEM is retained for compatibility/conformance, without active product memory integration. |
| Meterless browser World Model control plane                    | Same pinned revision; retained reference and isolated sandbox alongside Haze's application control plane.                                                  |
| LangChain Core, LangGraph and checkpoint packages              | Upstream execution/checkpoint libraries, retaining their MIT licenses.                                                                                     |

[engine_sources.json](engine_sources.json) records Meterless source inventories and checksums, verified before generating `vendor/` and `dist/`. Haze's task engine, capabilities and frontend integrate these components; the project does not claim all dependencies were written during the build window.

Browse the [documentation index](docs/README.md) for detailed guides. The [previous README](docs/history/readme-2026-10-28.md) is archived with its original content and rebased links.
