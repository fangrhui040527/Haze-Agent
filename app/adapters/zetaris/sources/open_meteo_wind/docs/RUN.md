# Open-Meteo wind Zetaris REST setup

Registers one live Zetaris REST table for each selected location in
`locations.json`, then creates a unified view. The API response is not copied
to PostgreSQL or stored as a snapshot. This source is a peer of `nasa_power`
and `location`.

From the repository root, preview the generated Zetaris SQL for Kuala Lumpur:

```powershell
npm run open-meteo:fetch:wind -- --test --dry-run
```

Run setup for Kuala Lumpur only:

```powershell
npm run open-meteo:fetch:wind -- --test
```

Register all 345 locations, or select specific location IDs:

```powershell
npm run open-meteo:fetch:wind
npm run open-meteo:fetch:wind -- --location kuala-lumpur --location perlis
```

The script needs Zetaris connection settings in
`app/adapters/zetaris/.env.local` and Python dependencies documented by the
Zetaris adapter. `--dry-run` prints the generated SQL without sending it.
`--test` cannot be combined with `--location`.

Registration creates the REST-table definitions; whether Zetaris also
validates or calls an endpoint during registration depends on the platform.
USL activation and queries against the full view may contact all 345 location
endpoints. Start with `--test` for Kuala Lumpur, then monitor provider usage
before registering/activating the full location set. Filter by `location_id`
where possible, but verify predicate pushdown and API usage on your Zetaris
instance.

See the [registration SQL](../sql/wind_register.sql), [view SQL](../sql/wind_view.sql),
[USL activation SQL](../sql/wind_activate.sql), and
[sample query](../sql/wind_query.sql).
