# Air Quality Ingestion & Registration

Collect modeled Open-Meteo PM2.5 and PM10 into a cached CSV snapshot, publish it
to the local Zetaris driver, and register `OPEN_METEO_AIR_QUALITY.hourly_snapshot`
plus the typed `air_quality.hourly_observations` view. PostgreSQL is not used.
Run these commands from the Haze repository root.

## Standalone Ingestion (TypeScript)

### Ingest All 345 Canonical Locations

```powershell
node --experimental-strip-types app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts
```

Or using `npx tsx`:

```powershell
npx tsx app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts
```

### Ingest Specific Location(s)

```powershell
node --experimental-strip-types app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts --location kuala-lumpur
```

Or multiple locations:

```powershell
node --experimental-strip-types app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts --location kuala-lumpur --location petaling-jaya
```

### Offline dry run

This previews the actions and SQL without calling an API, Docker, or Python and
without writing files. Review it before publishing.

```powershell
node --experimental-strip-types app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts --location kuala-lumpur --dry-run
```

### Republish the cache

```powershell
node --experimental-strip-types app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts --skip-api
```

The cache is `sources/air_quality/data/snapshot.json` (gitignored). New collection
requests the past day and three forecast days in UTC. It merges by location and
sample timestamp, replaces matching values, and retains other cached hours and
locations. Null concentrations remain unknown. Local receipt is recorded as
`ingested_utc`; provider issuance remains null. Latest raw responses are retained
per location; this is not an immutable model-run archive.

Publication replaces one complete `snapshot.csv` atomically in the driver volume
and updates the FileStore options at the same path. A source cache lock prevents
concurrent writers. If a process crashes, inspect `data/.ingestion.lock` and
confirm no ingestion is running before manually removing that stale lock.

Set `ZETARIS_DRIVER_CONTAINER` when the driver is not named `zetaris-driver-1`.
The Python SQL runner uses the root `.env` Zetaris REST settings. Existing
environmental USL activations remain separate from updating this source view.
