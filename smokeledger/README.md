# SmokeLedger: Haze Agent Harness

**Track 02: The Agent That Can Explain Why**

One evidence engine for Malaysia's transboundary haze, run by a team of agents:

- **Protect:** plan outdoor crew shifts and warn families and schools, hour by hour, before the air turns.
- **Trace:** follow the air over a town backwards to the fires, the peat and the concession land it crossed.
- **Act:** warn the landholder, record when they were told, re-check the satellites, and escalate if the fire keeps burning.

Every number cites a hashed query. An independent critic re-runs those queries and can block publication.

## Architecture

```
POST /run ──► LangGraph StateGraph (checkpointed per run in SQLite, 300 s hard deadline)

  admit ─► Manager ──► HazeOps ───────────┐   air outlook: forward trajectories + PM2.5 → 24 h API, hourly air
  (scope,     │   ├──► WorkerShield ───────┤   crew plan from versioned guidance (plan_outdoor_work)
   H-MEM      │   └──► PeatFire Sentinel ──┤   backward trajectories → fire / peat / concession shares (trace_sources)
   recall,    ◄─────────────────────────────┘
   World Model snapshot)
              └─► synthesize ─► EvidenceCritic ─approve─► gate ─► CommunityAlert (previews only) ─► END
                                     │ re-runs every cited query, own coverage query,
                                     │ guidance binding, hindsight disclosure, Nemotron judge (live)
                                     ├─revise (max 2)─► Manager → targeted specialist
                                     └─insufficient──► partial (explicit gaps) ─► END

Shared engines (local, Meterless reference, pinned):  H-MEM = reviewed memory + trust ledger
                                                      World Model = entities, evidence & conclusion revisions
Evidence boundary: Zetaris (live) over the Postgres store ◄── FIRMS fires, Open-Meteo wind + PM2.5, maps
Hosted reasoning:  Meterless Nightshift → Nemotron (narratives, judge lane, `ask`)
POST /heartbeat/tick: act loop (cases) + re-run decisions whose evidence changed
```

| Role | File | Owns |
|---|---|---|
| Manager | `src/agents/manager.ts` | scope, routing, synthesis, revisions, freshness and publication gate |
| HazeOps | `src/agents/hazeops.ts` | outlook and exact covered / uncovered hours |
| WorkerShield | `src/agents/workershield.ts` | crew plan; narrows validity when evidence is missing |
| PeatFire Sentinel | `src/agents/peatfire.ts` | source attribution with ranges; leads, not verdicts |
| CommunityAlert | `src/agents/communityalert.ts` | BM/EN previews bound to the approved revision; never sends |
| EvidenceCritic | `src/agents/critic.ts` | independent checks; approve, revise or insufficient_evidence |

## Quick start: offline, no credentials

```bash
npm install
npm run setup          # vendors the pinned Meterless engines + conformance suites
npm test               # 35 tests, including all three scenario families
npm run conformance    # upstream H-MEM (13 checks) and World Model (8 checks) suites
SAMPLE_MODE=true node run.mjs --input input_examples/example_1.json
SAMPLE_MODE=true npm start                 # API on http://0.0.0.0:8000
```

With Docker:

```bash
docker build -t haze-harness .
docker run --rm -p 8000:8000 --env-file .env -e STATE_DIR=/data -v haze-state:/data haze-harness
docker run --rm --network none -e SAMPLE_MODE=true haze-harness node run.mjs --input input_examples/example_1.json
```

`SAMPLE_MODE=true` uses an embedded database seeded with a **fictional** episode (3–9 Oct 2026). H-MEM and World Model
really execute. Zetaris and hosted inference are reported as **skipped**, never as executed.

## Live mode

1. Start Zetaris and Nightshift (see the hackathon setup guide). `cp .env.example .env` and fill in the keys.
2. `docker compose up -d` (evidence store on port 5433), then `npm run sl -- db:init`.
3. In the Zetaris SQL Editor, run `sql/02_zetaris_register.sql` one statement at a time. From the Haze root, `npm run dev` does steps 2 and 3 for you: it registers `sl_pg` once the sidecar is healthy.
4. Load your data (see **DATA.md**), then run `npm run sl -- check`. Every line should say PASS.
5. `npm start`. Every claim-bearing query now goes through Zetaris; every narrative and judge call goes through Nightshift.

### `.env`: what you need and where to get it

`cp .env.example .env`, then fill in the values below. Never commit `.env`. With `SAMPLE_MODE=true`, none of the
keys are needed.

**Keys you have to get yourself**

| Variable | What it is | Where to get it |
|---|---|---|
| `ZETARIS_API_KEY` | Bearer key for the Zetaris REST API (every evidence query) | Zetaris web UI → **Management → API Tokens** → **+**. Copy the key when it is shown, because it is displayed only once. See `docs/zetaris/connections/client-setup.md`. If you get REST `401`, create a new key. |
| `METERLESS_RUNTIME_TOKEN` | Token for hosted reasoning (Nemotron narratives, judge lane, `ask`) | Meterless Nightshift → **Console**. Copy the runtime token from the same page as `METERLESS_BASE_URL`. |
| `FIRMS_MAP_KEY` | NASA FIRMS MAP_KEY for downloading fire hotspots (see **DATA.md** §4) | Free at https://firms.modaps.eosdis.nasa.gov/api/map_key (enter your email, and the key arrives by mail). Limit: 5,000 transactions per 10 minutes. SmokeLedger itself does not read it. The FIRMS adapters in `app/` read it, and you need it for the download URLs printed by `npm run sl -- urls`. |
| `GFW_API_KEY` | Global Forest Watch Data API key, for fetching concession boundaries (**DATA.md** §1) | Sign up at https://www.globalforestwatch.org/my-gfw/, then create a key via the GFW Data API (https://data-api.globalforestwatch.org, `POST /auth/apikey`). No code reads it yet. It is only for your own GFW downloads. |
| `SANDBOX_RECIPIENT` | The only address that receives case notices while `DEMO_MODE=true` | Your own email address |

**Settings with working defaults**

| Variable | Default | Change it when |
|---|---|---|
| `SAMPLE_MODE` | `false` | Set it to `true` to run offline on the fictional sample (no Zetaris and no Nightshift) |
| `STATE_DIR`, `LOG_DIR`, `PORT` | `.state`, `logs`, `8000` | You need different paths or a different port |
| `DB_MODE` | `postgres` | Use `pglite` to run on the embedded DB instead of Docker Postgres |
| `PG_URL` | `postgres://smokeledger:smokeledger@localhost:5433/smokeledger` | You changed `docker-compose.yml` |
| `ZETARIS_REST_URL` | `http://localhost:8888/api/v1.0` | Zetaris runs on another host or port |
| `ZETARIS_ORG_ID` | `1` | Your Zetaris organisation has a different ID |
| `ZETARIS_SOURCE` | `sl_pg` | You named the datasource differently in `sql/02_zetaris_register.sql` |
| `QUERY_BACKEND` | `zetaris` | Use `postgres` only during development, before Zetaris is wired |
| `METERLESS_BASE_URL` | `http://127.0.0.1:8088/v1` | Nightshift → **Console** shows a different URL |
| `METERLESS_APP` | `smokeledger` | Rarely |
| `MODEL_DEEP`, `MODEL_JUDGE` | `meterless/auto` | You want to pin specific Nemotron routes from `GET /v1/models` |
| `DEMO_MODE` | `true` | Keep it `true` for the hackathon, so every notice goes to `SANDBOX_RECIPIENT` |
| `WIND_GRID_STEP` | `1.0` | You fetched the Open-Meteo wind grid at a different spacing, for example `0.5` |

Open-Meteo (wind and PM2.5) needs no key.

## Judge interface

| Interface | Behaviour |
|---|---|
| `GET /health` | ready or degraded, mode, schema version, adapters; no secrets |
| `POST /run` | validates, runs the bounded graph, returns output and trace references; idempotent by `run_id` |
| `GET /runs/{id}` | stored result |
| `POST /heartbeat/tick` | `{"now": "..."}` optional (virtual clock for replay) |
| `node run.mjs --input FILE` | same contract; also runs scenario files with `scenario_steps` |

Operations: `plan_outdoor_work` (his locked Klang scope), `assess_haze`, `trace_sources`. Other districts and
operations return a structured `unsupported` error. A Klang request looks like this:

```json
{ "run_id": "judge-001",
  "input": { "operation": "plan_outdoor_work", "district_id": "my-selangor-klang", "timezone": "Asia/Kuala_Lumpur",
             "time_window": { "start": "2026-10-07T08:00:00+08:00", "end": "2026-10-07T12:00:00+08:00" },
             "query": "Plan one outdoor maintenance crew's shift; explain why." },
  "options": { "sample_mode": true } }
```

Response fields: `run_id, status, mode, reasoning_backend, source_backend, engine_versions, workflow_backend,
thread_id, checkpoint_id, engine_operations_executed, remote_calls_executed, remote_calls_skipped,
output{summary, proposed_plan, claims, evidence, limitations, validity, messages}, rationale, guidance_versions,
assumptions, change_reason, critic, agents, memory, snapshot_id, conclusion_revision_id, trace_id, log_file,
execution_time_seconds, sponsor_integration_evidence, error`. Each run writes `logs/trace-RUN_ID.jsonl`.

## Scenario families (`input_examples/`, captured runs in `output_examples/`)

| File | What it shows |
|---|---|
| `example_1` Plan and explain | H-MEM recall of a crew constraint changes the plan; critic approves; reviewed decision captured with audit entry |
| `example_2` Challenge and revise | The sample forecast ends at 08:00, so the critic blocks persisted values; WorkerShield narrows; status `partial`, unserved interval 09:00–12:00 |
| `example_3` Update and explain | A newer forecast arrives; the heartbeat re-runs only the Klang plan (heavy work postponed), and the unrelated Batu Pahat decision stays unchanged |
| `example_4` assess_haze | School-closure outlook with BM parent and school drafts |
| `example_5` trace_sources | Concession and peat shares with ranges and confidence |
| `example_6` unsupported | Structured `unsupported` error |

## Sponsor proof

| Sponsor | Where | What to show |
|---|---|---|
| Zetaris | `src/query.ts` (REST, bounded retries, request ids as receipts); `sql/02_zetaris_register.sql` | `sponsor_integration_evidence.zetaris.request_ids`; the critic's independent re-query |
| Meterless H-MEM | `src/meterless/hmem.ts` | recalled memory changes a plan; capture after approval; stale marker supersedes; `memory.audit_entries` |
| Meterless World Model | `src/meterless/worldModel.ts` | conclusion revisions supersede on heartbeat; concession `held_by` group graph |
| Nightshift + Nemotron | `src/llm.ts`, critic judge lane, `ask` agent | `remote_calls_executed["nightshift.chat"]` plus the Nightshift run log |
| Cursor | development | keep honest notes linked to commits |

## Product CLI (data loading, cases, replay)

`npm run sl -- help` lists the product commands: `load`, `forecast`, `replay`, `trace`, `scan`, `draft`, `approve`,
`recheck`, `ask` and `verify`. `npm run demo:synthetic` runs all of them offline.

## Limits (say them in the pitch)

- Fires inside a concession show where land burned, not who lit it. Names are leads for verification.
- Public concession maps may be outdated. Each result shows the map's source and date.
- The trajectories use a simple model, not HYSPLIT. Shares come with ranges.
- The PM2.5 → API breakpoints (US EPA, pre-2024) must be verified against DOE. The peat factor (3×) is an assumption.
- Workplace guidance `0.1-placeholder` is **not** official DOSH guidance. Replace it before real use.
- Offline and replay runs use archived model values (hindsight) and say so. `cached_live` mode is not implemented.
- No public message is ever sent. CommunityAlert produces previews only; case notices need human approval and go to a sandbox in `DEMO_MODE`.

See `pre_existing.md` for prior work and reused components.
