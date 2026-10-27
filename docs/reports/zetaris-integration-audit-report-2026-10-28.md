# Zetaris integration: audit and findings report

[Reports](README.md) · [Sponsor technology hardening plan](../plans/sponsor-technology-hardening-plan.md) · [Zetaris documentation](../Zetaris/README.md)

Audit executed: **28 October 2026, Asia/Singapore**. Commit audited: `5a12ec5`; every cited reference re-verified at `3bd6bfe`.

This report records an executed audit of how the Zetaris platform is integrated into the product, together with the live probes that produced each finding. It establishes the current wiring and the observed failure modes. It does **not** establish that any listed remediation has been implemented, that the Environmental USL is unusable in principle, or that Zetaris provides no value in a corrected integration. No defect below is inferred from reading alone; each carries the probe output that produced it.

Platform state during the audit: Zetaris Lightning `2.4.3-v2.4.3.1-hackathon`, four containers healthy, REST at `http://localhost:8888/api/v1.0`, UI at `http://localhost:3001`.

## Summary

Removing Zetaris stops exactly one capability: PM2.5 evidence retrieval. Everything else — damage accounting, reduction planning, programmes, pilots, evidence review and research, episode investigation, evidence synthesis, Nightshift, Manager orchestration, the dashboard and the World Model — never reaches it.

| Measure                                          | Value                              |
| ------------------------------------------------ | ---------------------------------- |
| Unit suite with every `ZETARIS_*` variable unset | 116 files, 1434 tests, all passing |
| Product statements issued to Zetaris             | 1                                  |
| Product files importing a Zetaris module         | 3 (441 lines)                      |
| Side-car tree `app/adapters/zetaris/**`          | 30 files, 6236 lines               |

The single product query is `app/capabilities/pm25/evidence.ts:254`, reading `air_quality.hourly_observations`. No other file outside `app/adapters/zetaris/` references a Zetaris table or USL name.

The suite result above was produced at `5a12ec5`. `3bd6bfe` adds `tests/unit/final-answer.test.ts` and `tests/unit/nightshift-release.test.ts`, which that run did not cover.

## Findings

### F-1. The product's PM2.5 retrieval path fails after the stored token expires

`app/adapters/zetaris.ts` reads a static `ZETARIS_API_KEY` and contains no refresh path (`grep -c refresh` returns `0`). Probed with the stored key, then with a freshly minted one, against the same code and the same SQL:

```
stored key  → provider_failure :: Zetaris evidence retrieval failed (HTTP 400)
fresh token → OK rows=24  first={"start":"2026-10-27T00:00:00.000Z","value":62.6,
                                 "location":"Kuala Lumpur","latitude":3.1412,...}
```

Decoding the minted token locally gave an expiry **15 minutes** after issue. `POST /api/auth/login` returns `idToken` plus an unused `refreshToken`. So the only genuine Zetaris integration stops working a quarter of an hour after a person last logged in and pasted a token, and reports only `HTTP 400`, which directs an operator to the SQL rather than to authentication.

Commit `31d6290` fixed this failure mode in `app/adapters/zetaris/scripts/zetaris_sql.py`. The product transport was not changed.

### F-2. Three Zetaris clients exist with three authentication strategies

| Client                                             | Authentication                       | Endpoint                           | Observed state                    |
| -------------------------------------------------- | ------------------------------------ | ---------------------------------- | --------------------------------- |
| `app/adapters/zetaris.ts` (product, PM2.5)         | static `ZETARIS_API_KEY`, no refresh | `:8888 /sql-editor/sqls/run`       | fails once the token lapses (F-1) |
| `app/adapters/haze-sources/zetaris.ts` (dashboard) | username/password login per run      | `:3001 /api/proxy/query/sql/start` | issues no query (F-3)             |
| `app/adapters/zetaris/scripts/zetaris_api.{ts,py}` | login, local expiry decode, refresh  | varies                             | works                             |

The client with correct credential handling sits outside the product. The product's own client has none.

### F-3. The `zetaris` evidence-collection provider cannot succeed as configured

`app/dashboard/config/zetaris-queries.json` contains `{"queries": []}`, and `app/composition.ts:258` calls `createEvidenceCollectionTools(options)` without `zetarisQueries`. `zetaris` is nevertheless a member of `collectionProviderSchema`, and the assignment instructions offer it alongside the three working providers. Selecting it returns:

> `No approved pinned Zetaris queries are configured for evidence collection.`

saved as an `evidence.gap` artifact. The dashboard watcher registers with the same empty list and performs a login check only, returning no evidence and no facts. An advertised provider that cannot structurally return data is a defect in what the capability claims, not only in its configuration.

### F-4. Neither USL is deployed on the running instance

Queried directly through the platform's own REST runner:

```
SELECT COUNT(*) FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim
  → table is not found : metastore.malaysia_env.malaysia_env_usl.location_dim
SELECT COUNT(*) FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents
  → table is not found : metastore.malaysia_law.malaysia_law_usl.law_documents
```

Two flat objects exist: `air_quality.hourly_observations` (schemastore view) and `NASA_FIRMS_FILES.active_fires` (filestore table). `DESCRIBE air_quality.hourly_observations` returns exactly the eight columns `app/capabilities/pm25/evidence.ts` selects, so the product SQL is correct against what is deployed.

The Zetaris evaluation criteria describe the USL as the delivered value — reusing `location_dim` and `location_code`, querying related USL tables, reusing quality queries. `app/adapters/zetaris/usl/env_usl/usl_schema.sql` defines those tables. Nothing has applied it to this instance, and no product code references a USL name. The claims and the running system disagree.

### F-5. The federated data matches the upstream the agent already retrieves directly

Live scenario S4 in `qa/scenarios-live.json` compared the stored warehouse against its own source: peak PM2.5 `90.8 µg/m³` stored, `90.8 µg/m³` live, ratio `1.00`. The same Open-Meteo air-quality endpoint is retrieved directly by `app/adapters/haze-sources/openMeteo.ts`, which is the adapter an admitted task actually calls. `qa/data-sources-probe.json` records the same conclusion for all five upstreams: _"Zetaris itself is NOT required for this probe."_

Freshness runs the other way. The observed `ingested_utc` was `2026-10-27T11:25`, refreshed only when a person runs `npm run zetaris:fetch:pm25`. `app/adapters/zetaris/usl/daily_update.ts` has no caller, and `compose.yaml` declares no scheduled job for it. The direct adapter retrieves current data. For identical values, the Zetaris path therefore trades fresh data for stale data plus the failure mode in F-1.

### F-6. Zetaris gates application startup and sits outside the repository's quality gates

`scripts/dev.mjs` runs `docker compose up --detach` as startup stage 0. A throw there sets the exit code and the command never reaches the build, web, task-engine or World Model stages. The three independent collectors degrade politely when their keys are absent — `registerDisabled(spec, 'OPEN_AQ_KEY is not set')` — but the platform that serves one query stops the whole application.

Separately, `tsconfig.json` excludes `app/adapters/zetaris/**` and `eslint.config.mjs` ignores it. `tsconfig.zetaris.json` covers 8 of the 19 TypeScript files there. These 11 are type-checked by no project:

```
scripts/check_zetaris.ts   scripts/load_env.ts   scripts/query_zetaris.ts
scripts/zetaris_api.ts     sources/law/flatten_law_json.ts
sources/nasa_power/fetch_nasa_power.ts        sources/weather/fetch_weather.ts
sources/open_meteo_pm25/fetch_open_meteo_pm25.ts
sources/open_meteo_wind/fetch_open_meteo_wind.ts
sources/windy/fetch_windy.ts                  usl/daily_update.ts
```

The twelve Python files in the same tree are covered by neither gate. `frontend/scripts/general-api-plugin.ts` imports `app/adapters/zetaris/scripts/env-files.ts`, a generic environment-file helper that is unrelated to the platform and is lint-exempt by virtue of its location.

## Live provider verification

Independent of Zetaris, this session recorded the first non-synthetic provider receipt in the repository. `qa/findings-report.json` states _"No real LLM call was ever made: every provider receipt was marked synthetic."_ That is no longer current.

A per-role route was configured through the existing `HAZE_MODEL_ROUTES_JSON` and `HAZE_AGENT_ROUTES_JSON` settings, mapping `HazeOps` to direct NVIDIA and leaving the other four roles on the inherited Nightshift provider. Executed through `ModelRouteRegistry`:

```
HazeOps  model nvidia/nemotron-3.5-lightning-30b-a3b  tokens 31/7  synthetic false
```

The same model also returns native tool calls when a `tools` array is supplied — `finish_reason: tool_calls`, with correctly formed arguments. `app/adapters/agent-model.ts` sends no `tools` array and reads no `tool_calls`, so model-chosen tool invocation does not occur in this product. Tool invocation remains host-deterministic. This is a design property, not a defect; changing it would affect bounded tool grants, per-assignment call caps, exact artifact references and producer/reviewer separation.

The web-search tool was verified against the registered research catalogue. `haze-web-search` is Tavily, selected and executed by host code, and is independent of the model provider:

```
source: dosm-district-population
query : site:open.dosm.gov.my population district Malaysia methodology
tavily → 3 results, response sha256 635676d3...
  https://open.dosm.gov.my/data-catalogue/population_district
```

The first result is the `documentation_url` registered for that source in `app/capabilities/damage-evidence/registry.ts`.

Nightshift itself could not be exercised. `%LOCALAPPDATA%\Nightshift\engine` does not exist, `npm run nightshift:contract:install` exits `ENOENT` on that path, and the engine is not vendored — `vendor/meterless/engines/` contains only the H-MEM and World Model conformance engines. The repository's installer patches a pre-existing third-party installation; it does not provide one. Route readiness for the four inherited roles reports `blocked: Server credential is unavailable.`

## Remediation options

Two coherent directions. The first two items are required under either.

1. Replace `app/adapters/zetaris.ts` with the login-and-refresh transport, or port the local expiry decode and re-mint from `zetaris_sql.py` into it. Resolves F-1 and F-2.
2. Make startup stage 0 non-fatal, degrading with a stated reason as `HazeOpsService` already does for an absent `OPEN_AQ_KEY`. Resolves the startup half of F-6.

**Make the federation real.** Apply `usl_schema.sql` and `compat_activate.sql` to the instance, repoint the PM2.5 query at the `location_dim`-joined USL tables so federation is exercised, populate `zetaris-queries.json` and thread `zetarisQueries` through the composition root, schedule `daily_update.ts`, and bring the side-car tree under `tsconfig` and ESLint. Resolves F-3, F-4, F-5 and F-6, and makes the evaluation-criteria claims verifiable.

**Demote Zetaris to one optional backend.** Give the PM2.5 capability a direct Open-Meteo source behind the same `EvidenceSource` port, remove `zetaris` from `collectionProviderSchema` until pinned queries exist, keep items 1 and 2, and restate the evaluation criteria to claim only what runs.

Choosing the second direction does not establish that the USL approach is unsound; it records that the deployed system does not currently implement it.

## Reproducing these findings

```sh
# F-3, F-6: the empty pinned-query file and the excluded tree
cat app/dashboard/config/zetaris-queries.json
npx tsc -p tsconfig.zetaris.json --listFiles --noEmit

# F-4: what the instance actually holds
python app/adapters/zetaris/scripts/run_sql.py -e "DESCRIBE air_quality.hourly_observations"
python app/adapters/zetaris/scripts/run_sql.py \
  -e "SELECT COUNT(*) FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim"

# Summary measure: the suite without Zetaris
env -u ZETARIS_API_KEY -u ZETARIS_USERNAME -u ZETARIS_PASSWORD \
    -u ZETARIS_BASE_URL -u ZETARIS_REST_URL npx vitest run --project unit
```

F-1 requires minting a token through `POST /api/auth/login` and retrieving with `resolveEvidenceSource`, once with the stored `ZETARIS_API_KEY` and once with the fresh token. Credentials must stay in the gitignored root `.env`; no probe in this audit printed a credential, and `app/adapters/zetaris.ts` independently rejects any response echoing the server key.
