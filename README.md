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

Run deterministic fixture workflows without live model or source credentials:

```sh
npm run tasks:verify -- --fixture
npm run damage:verify -- --fixture
```

These build and exercise orchestration, review, persistence and restart/readback with synthetic adapters. Fixture model decisions and evidence are deterministic; they verify integration behavior, not live reasoning or source readiness.

For a fixture API, build first and run `npm run tasks:serve -- --fixture` with `HAZE_TASK_STATE_DIR` set to a separate directory. The frontend's `/demos/damage-account` and `/demos/damage-reduction` pages show bundled synthetic recordings; see the [demo guide](docs/guides/damage-account-demo.md).

`SAMPLE_MODE=true` enforces offline provider behavior; it does **not** select fixture orchestration adapters.

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
