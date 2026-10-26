# Legacy SmokeLedger Open-Meteo wind fetcher

The current Zetaris source is `sources/open_meteo_wind/fetch_open_meteo_wind.ts`
and `npm run zetaris:fetch:wind`. This retained legacy script writes only to
the optional PostgreSQL store and is not used by the Zetaris source.

Fetches 10 m and 850 hPa hourly winds for canonical locations and stores
eastward (`u`) and northward (`v`) components in the SmokeLedger PostgreSQL
`wind` table. Run from the repository root:

```powershell
node --experimental-strip-types app/adapters/zetaris/legacy/smokeledger/open_meteo_wind/fetch.ts --location kuala-lumpur
```

Omit `--location` to fetch all canonical locations. Add `--dry-run` to validate
the API response without writing to PostgreSQL.
