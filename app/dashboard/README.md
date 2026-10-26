# Dashboard and HazeOps migration

`frontend/` owns dashboard presentation. This module supplies read APIs and live
updates over the same SQLite World Model used by general AI tasks. There is no
second dashboard World Model or separate dashboard server.

## Modules

| Path                                    | Responsibility                                                     |
| --------------------------------------- | ------------------------------------------------------------------ |
| `app/contracts/dashboard.ts`            | Browser-safe dashboard and stream types                            |
| `app/dashboard/http.ts`                 | Snapshot, item, evidence, health and SSE APIs                      |
| `app/dashboard/projection.ts`           | Views of retained World Model observations                         |
| `app/agents/hazeops/index.ts`           | HazeOps agent definition and instructions                          |
| `app/agents/hazeops/service.ts`         | Bounded recurring collection, schedules and status                 |
| `app/capabilities/evidence-collection/` | Shared source selection, collection and integrity checks           |
| `app/world/`                            | Common normalized ingestion, exact raw retention and legacy import |
| `app/tasks/store.ts`                    | Authoritative application SQLite and transaction boundary          |

`app/composition.ts` connects these services to the task runtime's existing store.
The HTTP handler initializes dashboard services on the first dashboard request;
task-only scripts and tests do not start watchers. Shutdown stops streams, fences
collectors, waits for active work and then releases the database owner.

## Run and configure

From the repository root, run `npm run build` and
`npm --prefix frontend run dev`. Vite dev and preview handle dashboard and task
APIs in one process. `npm run tasks:serve` starts the same API standalone on
`127.0.0.1:8787`; static hosting needs a same-origin backend proxy.

All entry points choose `HAZE_TASK_STATE_DIR`, then `STATE_DIR`, then
`.state/general-v2`. Use a compatible general SQLite directory. One process owns
it at a time. The old `HAZE_STATE_DIR` no longer selects active dashboard storage.
Credentials remain in root `.env` or the host environment, never browser variables.

| Setting                                                    | Purpose                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `HAZEOPS_COVERAGE`                                         | `malaysia`, `asean` (default), or `worldwide`                                                  |
| `HAZEOPS_SCHEDULER=off`                                    | Disable automatic polling                                                                      |
| `SAMPLE_MODE=true`                                         | Disable live source clients                                                                    |
| `OPEN_AQ_KEY`                                              | OpenAQ source access                                                                           |
| `FIRMS_MAP_KEY`                                            | NASA FIRMS source access                                                                       |
| `ZETARIS_USERNAME`, `ZETARIS_PASSWORD`, `ZETARIS_BASE_URL` | Approved Zetaris source queries                                                                |
| `HAZEOPS_ZETARIS_QUERIES_FILE`                             | Optional host-owned pinned query JSON; defaults to `app/dashboard/config/zetaris-queries.json` |
| `HAZE_OPERATOR_TOKEN`                                      | Additional token for manual heartbeat requests                                                 |

Fixture and replay modes never start network watchers automatically. Manual
`POST /api/heartbeat/tick` requires the common local same-origin boundary, an
empty JSON body and `Idempotency-Key`; an operator token is also required when
configured. Receipts replay the original admitted watcher IDs. Watcher state and
bounded job history live in the shared SQLite database.

## Shared evidence

Watchers retain exact evidence bytes as bounded immutable artifacts. Task
`evidence.collection.capture` artifacts use the same normalized ingestion inside
their save transaction. Sources, locations, stations, facts and relationships are
visible through both dashboard views and `/api/world`. World Model references
retain scoped IDs, revisions, hashes and exact artifact support.

Collection preserves unreviewed status. Retention, hash integrity and dashboard
freshness checks do not grant acceptance. Existing task review and configured
acceptance policies remain authoritative. Fixture records and cards are explicitly
synthetic and remain isolated from live records.

The real geography registry is `app/dashboard/config/locations.json`. Its retained
Malaysian place provenance is in `locations-malaysia.json`; GeoNames material is
CC BY 4.0. `node scripts/build-dashboard-locations.mjs` can extend the real registry
with Open-Meteo geocoding and optional GeoNames results.

## Import an existing dashboard archive

The migration is explicit and leaves the source unchanged. Build first, stop any
runtime that owns the target, then run from the repository root:

```sh
node scripts/migrate-dashboard-state.mjs .state/haze .state/general-v2
```

The source must contain `world/.world/haze.json` and its original `raw/` evidence.
The importer validates evidence hashes, byte counts and referenced entities before
the atomic write. Missing or changed raw evidence fails explicitly. Repeating a
successful import replays its receipt. Source and target must be separate; an
incompatible target is rejected without changing its historical data.

Archived H-MEM files are preserved in the source and are not imported as domain
evidence. The browser Reference sandbox also stays disposable and separate.
Old template `/api/runs` and `/api/reports` routes now provide v3 task guidance;
durable tasks remain available through `/api/tasks` and `/task/:id`.
