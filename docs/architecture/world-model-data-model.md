# Haze World Model data model

This document now covers two separate systems. The existing sections below
describe the legacy, file-backed HazeOps model in `server/src/world/hazeWorld.ts`.
That model is not the acceptance authority for the active v3 task engine, and
its records are not imported automatically. The active v3 model is documented
in [Active v3 World Model](#active-v3-world-model).

## Legacy HazeOps file-backed model

> The contract between the Haze engines layer and anything that writes into it
> (HazeOps today; EvidenceCritic, WorkerShield and teammates' agents later).
> Written 24 Oct 2026. Implemented in `server/src/world/hazeWorld.ts`.

## Where it lives

- **Engine:** the pinned Meterless World Model reference (revision `1742dec`), loaded through
  `app/compatibility/meterless/loader.ts` (hash-checked). Namespace **`haze`**, separate from any
  crew-scheduling data.
- **File:** `.state/haze/world/.world/haze.json` (git-ignored).
- **One writer:** only the Haze server process opens this file. The reference engine keeps
  state in memory and rewrites the whole file on every write, so two processes would overwrite
  each other. Other agents must call the server (or run inside it), never open the file.
- **Raw bytes are not in the World Model.** Each retrieved response is archived once in
  `.state/haze/raw/<sha256>.json`; the World Model keeps the hash and metadata
  (Spec §10: raw archives hold bytes, canonical records hold meaning and status).

## Rules every writer follows

1. **Always use `externalKey`** (`system: "haze"`). Without it the World Model matches by
   name similarity and can auto-merge look-alike names.
2. **Every write carries provenance** `{ kind, by, at, url?, checksum?, runId? }`. `at` is the
   observation time, never the wall clock, which keeps re-ingest idempotent.
3. **Write only what changed.** Unchanged entities and repeated observations are skipped.
4. **Facts are never deleted.** A newer observation supersedes an older one
   (`conflictPolicy: most-recent-wins`); history stays.
5. **Missing is not zero.** A missing value is `null` with a reason.
6. **HazeOps never marks anything verified.** Independent checks (EvidenceCritic) and
   intended-use review (qualified people) are separate and currently pending.

## Entities

Entity ids follow the engine's grammar `type:system:id`.

| Type       | Id example                       | Attributes                                                                                                              | Written by         |
| ---------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `location` | `location:haze:klang`            | region, country, countryCode, lat, lon, timeZone, aqiStandard, populationBand (+ latest fact values, set by the engine) | server config sync |
| `source`   | `source:haze:src-openaq`         | the frontend `Source` fields + `watcherId`, `freshnessMinutes`                                                          | server config sync |
| `station`  | `station:haze:openaq-3400978`    | lat, lon, provider, isMonitor, sensorId, nearestLocationId, distanceKm                                                  | HazeOps (OpenAQ)   |
| `evidence` | `evidence:haze:src-openaq:9f2c…` | a subset of `haze.evidence.v2` (Spec §4.1), see below                                                                   | HazeOps            |

Klang is the first configured location (the first target user's place); locations are data,
so any configured city works the same way.

### Evidence record (`haze.evidence.v2-subset`)

`evidenceId` (`<sourceId>:<first 16 hex of sha256>`), `revision`, `upstream {system,id}`,
`rawSha256`, `rawRef`, `rawBytes`, `sourceId`, `sourceKind` (`observation | forecast | modeled`),
`title`, `sourceOwner`, `locator {kind:"data", url (no credentials), selection}`, `pollutant`,
`unit`, `issuedAt` + `issuedAtReason`, `validInterval`, `retrievedAt`, `acceptedAt: null` +
`acceptedAtReason` (HazeOps cannot accept evidence), `nativeTemporalResolution`,
`spatialSupport`, `licenceRef`, `permittedUses`, `limitations`, `disposition:
"pinned_unreviewed"`, `checks` (Spec §4.2 layers 1–2 run; layers 3–4 listed as pending).

Evidence entities are immutable: the same bytes give the same id and are never rewritten.

## Facts (the values)

| Predicate                | About    | Value                                                                                                                                                   |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm25_modeled`           | location | `value`, `pm10`, `unit`, `observedAt`, `valueThreeHoursEarlier`, `gridLat`, `gridLon`, `evidenceId`                                                     |
| `pm25_forecast_24h`      | location | `validFrom`, `validTo`, `maxPm25`, `meanPm25`, `pastMeanPm25`, `direction`, `unit`, `evidenceId`                                                        |
| `pm25_observed`          | station  | `value`, `unit`, `averaging`, `observedAt`, `sensorId`, `evidenceId`                                                                                    |
| `fire_hotspots_24h`      | location | `count`, `highConfidenceCount`, `maxFrpMw`, `highestConfidence`, `nearestKm`, `radiusKm`, `windowStart`, `windowEnd`, `latestAcquisition`, `evidenceId` |
| `pm25_zetaris_<queryId>` | location | `value`, `unit`, `observedAt`, `query`, `evidenceId`                                                                                                    |

Fact provenance: `kind` = the evidence `sourceKind`, `by: "hazeops"`, `at` = observation time,
`checksum` = raw SHA-256, `url` = locator URL, `runId` = the watcher run.

## Relationships

| Type           | From → To          | Notes                                                      |
| -------------- | ------------------ | ---------------------------------------------------------- |
| `published_by` | evidence → source  | once per evidence record                                   |
| `near`         | station → location | attrs `distanceKm`; a new nearest city closes the old edge |

## Read side

Table rows (`HazeItem`s) are **not stored**. The server computes them on every read from the
newest fact per subject and predicate (`server/src/world/projection.ts`), adding a freshness
check against the current time. Item ids: `hz-modeled-<loc>`, `hz-forecast-<loc>`,
`hz-observed-<station>`, `hz-hotspots-<loc>`, `hz-zetaris-<query>-<loc>`.

Item status: `stale` if the freshness rule fails; `unverified` if any check fails; otherwise
`partial` (identity and coverage checked, independent review pending). Nothing is `verified`
until EvidenceCritic exists.

## How a new agent plugs in

Add a writer method in `HazeWorld` (or call the server's API) that follows the rules above,
pick a predicate name, and add its projection in `projection.ts`. Ask the Haze engines
owner before adding entity types.

## Active v3 World Model

### Ownership and storage

The v3 task engine owns World Model writes and reads. Its World Model tables
share the task engine's SQLite database and transaction boundary under
`.state/general-v1` or the configured `STATE_DIR`. The existing storage marker
is validated before SQLite opens. World Model schema versions are recorded in
`world_schema_migrations`; additive migrations run transactionally. A schema
newer than the running code fails explicitly. Existing legacy HazeOps JSON is
not read or imported.

Records, relationships, assessments, acceptance outcomes, dependency links,
holds, operation receipts, and the durable event log are stored with principal,
workspace, and execution-mode scope. Event-derived entity and relationship
tables are rebuildable projections; the durable events and versioned records,
not cached projections, are authoritative. Identical operation retries return
their recorded receipt, while reuse of an operation key for different content
fails.

### Projection and capability coverage

The registered adapters are PM2.5 evidence summary, damage accounting, episode
investigation, and evidence synthesis. They project domain records and
relationships that point to exact immutable task artifacts; artifact payloads
are not copied into World Model records. Support references retain exact
artifact hashes and producer/reviewer assignment revisions. Task results and
World Model acceptance remain separate records.

### Acceptance and current status

Acceptance is disabled unless the server is explicitly configured with
`HAZE_WORLD_ACCEPTANCE_POLICY=research-v1`. The fixed `research-v1` policy
binds supported capabilities to their allowed stated uses and gives eligible
acceptances a 30-day maximum age. Unknown policy values prevent startup.

Finalization evaluates exact artifact versions and hashes, required review,
producer/reviewer identity, dependency closure, permissions, execution mode,
holds, and expiry inside the same SQLite transaction that saves the task
result. Ineligibility is recorded with reasons and does not by itself prevent a
valid informational task result from completing. Acceptance applies only to
its stated use; it is not a general verification, legal decision, or approval
of a final narrative.

Current-status reads recheck support currency, access, applicable holds, and
expiry rather than trusting a projection or an old task-result snapshot.
Corrections, grant revocations, source supersession, and registered
method/policy changes can place holds on affected records and dependent
branches. Unrelated records remain separate. Lifecycle changes are appended
to the durable task event stream; historical task results are not rewritten.

### Access and limitations

The task report reads current status separately from the saved task result.
`GET /api/tasks/:id/world` returns related records and current acceptance
outcomes. `GET /api/world/records/:id` provides authorized record detail or
bounded, paginated history and lineage. Reads are scoped to the local
principal, workspace, and execution mode.

The bounded `world.lookup`, `world.context`, and `world.lineage` tools use
task-grant checks. Context reads recheck source access, pin exact support
artifacts, and save an immutable context snapshot for downstream work. Fixture
verification demonstrates fixture behavior and restart persistence only; it
does not establish live source readiness. External effects, automatic import
of legacy data, and acceptance of final narrative conclusions are outside the
current model.
