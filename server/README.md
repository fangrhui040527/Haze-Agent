# HazeWatch server

The API behind the HazeWatch dashboard. It owns the pinned **Meterless World Model** and
**H-MEM** engines and runs **HazeOps**, which retrieves real haze evidence for every configured
location (Klang first) and writes it into the World Model.

```
frontend ──HTTP + SSE──► server ──► World Model (facts, evidence)   ◄── HazeOps watchers
                                └─► H-MEM (chat memory)                 Open-Meteo, OpenAQ,
                                                                        NASA FIRMS, Zetaris
```

## Run

```sh
# once, in the repository root: builds and hash-checks the pinned engines
npm run build

cd server
npm ci
npm start          # API on http://127.0.0.1:8000
```

Then run the frontend (`cd frontend && npm run dev`). Vite proxies `/api` to this server.

Configuration comes from the repository-root `.env` (never commit it):

| Variable                               | Needed for                                  | Default                                      |
| -------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `OPEN_AQ_KEY`                          | OpenAQ ground stations (Malaysia)           | watcher disabled if missing                  |
| `FIRMS_MAP_KEY`                        | NASA FIRMS fire hotspots                    | watcher disabled if missing                  |
| `ZETARIS_USERNAME`, `ZETARIS_PASSWORD` | local Zetaris platform                      | watcher disabled if missing                  |
| `ZETARIS_BASE_URL`                     | Zetaris REST gateway                        | `http://localhost:3000`                      |
| `HAZEOPS_COVERAGE`                     | `malaysia`, `asean` or `worldwide`          | `asean`: 75 Malaysian places + 20 neighbours |
| `HAZEOPS_SCHEDULER`                    | `off` to stop automatic polling             | on                                           |
| `SAMPLE_MODE`                          | `true` disables every network source        | off                                          |
| `PORT`, `HOST`                         | listen address                              | `8000`, `127.0.0.1`                          |
| `HAZEWATCH_STATE_DIR`                  | where state lives                           | `.state/hazewatch`                           |
| `HAZE_OPERATOR_TOKEN`                  | protects `/api/heartbeat/tick` off-loopback | unset (loopback only)                        |

Malaysian places beyond the frontend list come from `server/config/locations-malaysia.json` (rebuild with `node server/scripts/build-malaysia-locations.mjs`; coordinates from GeoNames via the Open-Meteo Geocoding API, CC BY 4.0).

Open-Meteo needs no key. Its free API is for non-commercial use and requires attribution to
the Copernicus Atmosphere Monitoring Service (CAMS) and Open-Meteo.

## API

| Endpoint                      | Purpose                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `GET /api/health`             | engine pins, watcher status, which agents are connected |
| `GET /api/snapshot`           | all items, locations, sources (`DataSnapshot`)          |
| `GET /api/items/:id`          | one item with location, sources, related items          |
| `GET /api/evidence/:id`       | one pinned evidence record with its provenance          |
| `GET /api/stream`             | SSE: `upsert` events when items change                  |
| `GET /api/hazeops/watchers`   | each watcher's Spec §12 declaration and state           |
| `GET /api/manager/assignments` | what the Manager assigned to each agent, and how it ended |
| `GET /api/runtime/jobs`       | recent runtime jobs, each with its own deadline         |
| `POST /api/heartbeat/tick`    | operator-only: run due watchers now (Spec §15.2)        |
| `POST /api/runs`              | ask a question → `{ runId }`                            |
| `GET /api/runs/:id/events`    | SSE: `agent` events (`AgentEvent`), then `answer`       |
| `POST /api/runs/:id/cancel`   | cancel a run                                            |
| `POST /api/tasks`             | open a task report (scheduling or revenue recovery only; others → 422) |
| `GET /api/tasks/:id`          | the finished result envelope (v0.14 §16), 202 while running |
| `GET /api/tasks/:id/events`   | SSE: `step` and `block` events as the report is written, then `result` |
| `POST /api/tasks/:id/cancel`  | cancel a task                                           |
| `POST /api/runs/:id/feedback` | `{ kind: helpful                                        | not_helpful | wrong }` → H-MEM feedback |

The spec defines polling only; SSE is a HazeWatch addition.

## What is real and what is not

- **Real:** World Model and H-MEM (pinned Meterless reference engines), HazeOps retrieval from
  four sources, evidence pinning with SHA-256, Manager deadlines (300 s per job, 2 at once,
  3 attempts per source call, 20 s each).
- **Not connected:** EvidenceCritic (independent checks) and WorkerShield (the AI agent). So
  nothing is marked "verified", and chat answers are templates filled from real records, not
  AI-written. Health questions get no advice.
- **Zetaris:** login works; no haze queries are configured yet. Add pinned queries to
  `server/config/zetaris-queries.json` (`{ "queries": [{ id, version, description, sql,
sourceKind, columns: { locationId, observedAt, pm25 }, unit }] }`). The local platform's
  query engine container must be running.

## Limits of the reference engines

The pinned World Model keeps everything in memory and rewrites its JSON file on each write.
HazeOps writes only changes and keeps raw bytes outside it, which is fine for days of demo
data, not for production. H-MEM recall is keyword-like (hash embedder), not semantic.

## Tests

```sh
npm test         # needs `npm run build` in the repository root first
npm run typecheck
```

Data model: [`docs/05-world-model-data-model.md`](../docs/05-world-model-data-model.md).
