# SmokeLedger Open-Meteo wind fetcher

Fetches 10 m and 850 hPa hourly winds for canonical locations and stores
eastward (`u`) and northward (`v`) components in the SmokeLedger PostgreSQL
`wind` table. Run from the repository root:

```powershell
npm run smokeledger:fetch:wind -- --location kuala-lumpur
```

Omit `--location` to fetch all canonical locations. Add `--dry-run` to validate
the API response without writing to PostgreSQL.
