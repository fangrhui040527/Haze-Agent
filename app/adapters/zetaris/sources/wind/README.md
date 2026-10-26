# Open-Meteo wind source

This source collects modeled hourly winds at 10 m and 850 hPa, converts speed
and meteorological direction into eastward (`u`) and northward (`v`) components
in m/s, and publishes a CSV FileStore snapshot in local Zetaris. It creates
`OPEN_METEO_WIND.hourly_snapshot` and the typed `wind.hourly_observations` view.
PostgreSQL is not used.

From the Haze repository root, preview first:

```powershell
npm run zetaris:fetch:wind -- --location kuala-lumpur --dry-run
```

The dry run is offline and writes nothing. After reviewing the plan, collect
and publish:

```powershell
npm run zetaris:fetch:wind -- --location kuala-lumpur
```

Repeat `--location` for multiple canonical IDs, or omit it for all locations.
The source requests one past day and three forecast days in UTC. Missing speed
or direction produces null `u` and `v` rather than a fabricated vector.

New samples merge into the gitignored `data/snapshot.json` cache by location,
timestamp and level. Matching values are replaced; other cached locations and
hours remain. `ingested_utc` records local receipt, and `issued_utc` remains null
because this response does not establish provider issuance. The latest raw API
response is retained per location. This is not a model-run archive.

Republish the complete validated cache without another API request:

```powershell
npm run zetaris:fetch:wind -- --skip-api
```

Publication atomically replaces the driver's complete `snapshot.csv` and updates
the FileStore at its stable path. A source cache lock rejects concurrent writers.
After a crash, inspect `data/.ingestion.lock` and confirm no ingestion is running
before removing that stale lock manually.

Use `ZETARIS_DRIVER_CONTAINER` if the driver has another container name. The
Python SQL runner uses root `.env` Zetaris settings. See
[`sql/wind_query.sql`](sql/wind_query.sql) for a source query.
