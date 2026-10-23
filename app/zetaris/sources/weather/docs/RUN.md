# Weather Forecast Ingestion & Registration

## Standalone Ingestion (TypeScript)

Run directly using Node.js v22+ built-in type-stripping:

```powershell
node --experimental-strip-types app/zetaris/sources/weather/fetch_weather.ts
```

Or using `npx tsx`:

```powershell
npx tsx app/zetaris/sources/weather/fetch_weather.ts
```

### Dry Run

Preview generated registration SQL without connecting to Zetaris:

```powershell
node --experimental-strip-types app/zetaris/sources/weather/fetch_weather.ts --dry-run
```
