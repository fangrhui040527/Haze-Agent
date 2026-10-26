# NASA FIRMS Satellite Active Fire Ingestion & Registration

Fetch and register NASA FIRMS near real-time satellite active fire data (VIIRS NOAA-20, NOAA-21, Suomi NPP) covering nationwide Malaysia in Zetaris.

## Standalone Ingestion (TypeScript)

### Nationwide Fetch, Flatten & Register (Default: Last 3 Days)

Fetches live active fire data across Malaysia for the **last 3 days**, flattens partitions, copies flat files to the Docker container (`/home/zetaris/customer-data/shared/firms_flat`), and registers `NASA_FIRMS_FILES.active_fires`. Set `FIRMS_MAP_KEY` in the root `.env` first; a missing key or failed API batch stops the run without replacing the previous snapshot. No PostgreSQL service is required.

Downloads are staged until all requested batches succeed. A successful zero-fire response is published as an empty table; a failed download is an error. Re-runs update the existing FileStore options using the same path and do not drop its table.

```powershell
npm run zetaris:fetch:firms
```

Or using `npx tsx`:

```powershell
npx tsx app/adapters/zetaris/sources/nasa_firms/fetch_nasa_firms.ts
```

> **Note on Day Range:** The pipeline defaults to `3` days (`--day-range 3`) to ensure active thermal anomaly records are captured even if yesterday had cloud cover or zero fire detections.

### Custom Day Range (1–5 days)

```powershell
npm run zetaris:fetch:firms -- --day-range 5
```

### Specific Location(s)

```powershell
npm run zetaris:fetch:firms -- --location kuala-lumpur
```

### Use Local Cached Data (Skip Remote API)

If you already have cached CSV files in `data/firms_csv/` or want to re-publish without calling NASA:

```powershell
npm run zetaris:fetch:firms -- --skip-api
```

### Dry Run (Preview SQL)

```powershell
npm run zetaris:fetch:firms -- --location kuala-lumpur --dry-run
```

The dry-run prints actions and SQL without network calls, local data writes, Docker commands, or credentials. It works without a cached snapshot or API key. The live command needs the local Zetaris REST credentials used by `scripts/run_sql.py`.

Set `ZETARIS_DRIVER_CONTAINER` in root `.env`, or pass `--container <name>`, if the driver container is not `zetaris-driver-1`. `--skip-api` explicitly republishes an existing cached snapshot and fails when none exists.
