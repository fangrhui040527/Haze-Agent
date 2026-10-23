# Air Quality Ingestion & Registration

Fetch and register hourly Open-Meteo PM2.5 and PM10 air quality data in Zetaris.

## Standalone Ingestion (TypeScript)

### Ingest All 345 Canonical Locations

```powershell
node --experimental-strip-types app/zetaris/sources/air_quality/fetch_air_quality.ts
```

Or using `npx tsx`:

```powershell
npx tsx app/zetaris/sources/air_quality/fetch_air_quality.ts
```

### Ingest Specific Location(s)

```powershell
node --experimental-strip-types app/zetaris/sources/air_quality/fetch_air_quality.ts --location kuala-lumpur
```

Or multiple locations:

```powershell
node --experimental-strip-types app/zetaris/sources/air_quality/fetch_air_quality.ts --location kuala-lumpur --location petaling-jaya
```

### Dry Run (Preview SQL)

```powershell
node --experimental-strip-types app/zetaris/sources/air_quality/fetch_air_quality.ts --location kuala-lumpur --dry-run
```
