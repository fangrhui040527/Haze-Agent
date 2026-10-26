# Legacy SmokeLedger Open-Meteo wind fetcher

Current ingestion uses `sources/wind/fetch_wind.ts` and
`npm run zetaris:fetch:wind`. This retained script writes only to the optional
legacy PostgreSQL store; it does not publish the current Zetaris snapshot.

Fetches 10 m and 850 hPa hourly winds for canonical locations and stores
eastward (`u`) and northward (`v`) components in the SmokeLedger PostgreSQL
`wind` table. Run from the repository root:

```powershell
node --experimental-strip-types app/adapters/zetaris/legacy/smokeledger/open_meteo_wind/fetch.ts --location kuala-lumpur
```

Omit `--location` to fetch all canonical locations. Add `--dry-run` to validate
the API response without writing to PostgreSQL.
