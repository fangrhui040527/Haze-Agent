# Legacy SmokeLedger Open-Meteo PM2.5 fetcher

Current ingestion uses `sources/air_quality/fetch_air_quality.ts` and
`npm run zetaris:fetch:pm25`. This retained script writes only to the optional
legacy PostgreSQL store; it does not publish the current Zetaris snapshot.

Fetches hourly model PM2.5 for canonical locations and stores the values in the
SmokeLedger PostgreSQL `pm25` table. Run from the repository root:

```powershell
node --experimental-strip-types app/adapters/zetaris/legacy/smokeledger/open_meteo_pm25/fetch.ts --location kuala-lumpur
```

Omit `--location` to fetch all canonical locations. Add `--dry-run` to validate
the API response without writing to PostgreSQL.
