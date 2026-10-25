# SmokeLedger Open-Meteo PM2.5 fetcher

Fetches hourly model PM2.5 for canonical locations and stores the values in the
SmokeLedger PostgreSQL `pm25` table. Run from the repository root:

```powershell
npm run smokeledger:fetch:pm25 -- --location kuala-lumpur
```

Omit `--location` to fetch all canonical locations. Add `--dry-run` to validate
the API response without writing to PostgreSQL.
