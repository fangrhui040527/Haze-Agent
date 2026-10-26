# SmokeLedger database

This local PostgreSQL database stores SmokeLedger evidence. Each API ingester
has its own folder, shared ingestion helpers live at the source root, and
Zetaris's USL definition lives under `app/adapters/zetaris/usl/smokeledger_usl/`.
The schema is initialized automatically when its Docker volume is first created:

```sh
npm run db:init
```

PostgreSQL is published only on localhost at port `5433`, with database and
username `smokeledger`. The included `smokeledger` password is for local
development only; do not use it for a shared or production database. The
database volume persists between starts.

`sql/01_schema.sql` creates an empty schema. Fetchers read the existing
canonical locations from the Zetaris air-quality source, upsert those
locations into `towns`, and save API responses in this PostgreSQL database.
They do not register new tables in Zetaris; run `sql/02_zetaris_register.sql`
after initializing the schema so Zetaris can query it.

## Fetch public data

The fetchers use NASA FIRMS for active-fire detections and Open-Meteo for
hourly wind components and PM2.5. From the repository root, initialize the DB
and run:

```powershell
npm run db:init
npm run smokeledger:fetch:firms
npm run smokeledger:fetch:wind
npm run smokeledger:fetch:pm25
```

The Open-Meteo fetchers default to all canonical locations. To test or update
only selected locations, pass one or more `--location` IDs:

```powershell
npm run smokeledger:fetch:wind -- --location kuala-lumpur
npm run smokeledger:fetch:pm25 -- --location kuala-lumpur
npm run smokeledger:fetch:pm25 -- --location kuala-lumpur --location petaling-jaya
```

Use `--dry-run` to fetch and validate the API response without writing towns or
measurements. The FIRMS fetcher queries both Malaysia bounding boxes for three
near-real-time VIIRS satellites. It defaults to the latest day; set
`FIRMS_DAYS` in `.env` to an integer from 1 to 10 to change the range.

The documented public sources are:

- NASA FIRMS: <https://firms.modaps.eosdis.nasa.gov/api/area/>. Obtain a key
  from <https://firms.modaps.eosdis.nasa.gov/api/map_key/> and store it as
  `FIRMS_MAP_KEY` in the local, gitignored `.env` file.
- Open-Meteo wind: <https://api.open-meteo.com/v1/forecast> (no key).
- Open-Meteo air quality: <https://air-quality-api.open-meteo.com/v1/air-quality>
  (no key).

FIRMS requires a personal free map key. Add `FIRMS_MAP_KEY=...` to the
gitignored root `.env` file; never commit
the key. Open-Meteo needs no key.
Set `SMOKELEDGER_DATABASE_URL` in root `.env`
to override the local PostgreSQL connection.

The fetchers upsert repeated fire and wind observations. PM2.5 forecasts are
keyed by their hourly issue time so repeat fetches within the same hour update
the forecast rather than duplicating it. Network and database failures stop
the command with a non-zero exit status; a completed batch may already have
been saved if a later API batch fails.

## Register the database and bootstrap the Zetaris USL

Start Zetaris and make sure the Haze root `.env` contains the
Zetaris REST connection settings. From the repository root, preview the setup:

```powershell
npm run zetaris:bootstrap:smokeledger -- --dry-run
```

Then run the complete setup:

```powershell
npm run zetaris:bootstrap:smokeledger
```

The bootstrap starts the local PostgreSQL database, creates/registers the
`sl_pg` datasource in Zetaris, compiles the USL and activates its 15 tables
from PostgreSQL. It finishes by running verification queries. It stops at the
first failed step; credential values are not printed.

Use `--skip-db-init` when PostgreSQL is already running, or
`--skip-activation` to register the datasource and compile the USL without
copying data into USL tables. After fetching more API data, rerun the bootstrap
to refresh the activated tables.

The optional live Open-Meteo REST federation demo is kept separate in
`sql/03_openmeteo_live_demo.sql`; the bootstrap does not create those objects.
The `host.docker.internal:5433` JDBC URL lets Zetaris containers reach the
local PostgreSQL service.

To check the local schema after initialization:

```sh
docker compose exec -T smokeledger-db psql -U smokeledger -d smokeledger -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
```
