# NASA FIRMS Satellite Active Fire Ingestion & Registration

Fetch and register NASA FIRMS near real-time satellite active fire data (VIIRS NOAA-20, NOAA-21, Suomi NPP) covering nationwide Malaysia in Zetaris.

## Standalone Ingestion (TypeScript)

### Nationwide Fetch, Flatten & Register (Default: Last 3 Days)

Fetches live active fire data across Malaysia for the **last 3 days** (if `FIRMS_MAP_KEY` is set in `.env`), flattens partitions, copies flat files to the Docker container (`/home/zetaris/customer-data/shared/firms_flat`), and registers `NASA_FIRMS_FILES.active_fires`:

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts
```

Or using `npx tsx`:

```powershell
npx tsx app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts
```

> **Note on Day Range:** The pipeline defaults to `3` days (`--day-range 3`) to ensure active thermal anomaly records are captured even if yesterday had cloud cover or zero fire detections.

### Custom Day Range (1–5 days)

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts --day-range 5
```

### Specific Location(s)

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts --location kuala-lumpur
```

### Use Local Cached Data (Skip Remote API)

If you already have cached CSV files in `data/firms_csv/` or want to re-publish without calling NASA:

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts --skip-api
```

### Dry Run (Preview SQL)

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts --skip-api --dry-run
```
