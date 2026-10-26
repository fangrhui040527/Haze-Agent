# Air Quality REST Registration

Register one live Open-Meteo REST table for each canonical location and build
the `air_quality.hourly_observations` federated view. This is not a local
snapshot: live requests may occur during registration, activation, or query,
depending on Zetaris behavior. Run commands from the repository root.

## Register all 345 locations

```powershell
npm run zetaris:fetch:pm25
```

This creates 345 per-location REST definitions; it does not issue a single
nationwide Open-Meteo request.

## Test only Kuala Lumpur

```powershell
npm run zetaris:fetch:pm25 -- --test
```

You can also choose locations explicitly with repeated `--location <id>`
options. `--test` cannot be combined with explicit location selections.

## Offline dry run

This generates and parses the registration/view SQL without sending it to
Zetaris or calling Open-Meteo.

```powershell
npm run zetaris:fetch:pm25 -- --test --dry-run
```

Ensure the root `.env` contains the Zetaris REST credentials before running
without `--dry-run`. The API itself does not require a secret key.
