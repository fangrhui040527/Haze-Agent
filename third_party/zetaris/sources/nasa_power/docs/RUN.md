# NASA POWER Ingestion & Registration

Fetch and register daily NASA POWER climate data (20 meteorological and solar parameters) in Zetaris.

## Standalone Ingestion (TypeScript)

### Ingest All 345 Canonical Locations

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts
```

Or using `npx tsx`:

```powershell
npx tsx app/zetaris/sources/nasa_power/fetch_nasa_power.ts
```

### Ingest Specific Location(s)

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts --location kuala-lumpur
```

Or multiple locations:

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts --location kuala-lumpur --location petaling-jaya
```

### Specify a Custom Date (YYYYMMDD)

Default is 4 days prior to today:

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts --location kuala-lumpur --date 20261018
```

### Dry Run (Preview SQL)

```powershell
node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts --location kuala-lumpur --dry-run
```
