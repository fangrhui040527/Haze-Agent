# Malaysia Environmental USL: Operations & Federated Queries

Operational execution guide and cross-source SQL queries for the Zetaris Unified Semantic Layer (`malaysia_env_usl`).

---

## 1. Operational Playbook

### Cold Start / Day-0 Bootstrap
Register the live per-location sources for a selected location before querying:

```powershell
npm run zetaris:fetch:pm25 -- --location kuala-lumpur --dry-run
npm run zetaris:fetch:wind -- --location kuala-lumpur --dry-run
```

Review the plan before rerunning without `--dry-run`. This publishes air-quality
and wind FileStore snapshots plus the FIRMS source, without a separate ingestion
database. The optional SmokeLedger USL is a read-only semantic view over the
Environmental sources; it does not require PostgreSQL. Existing database
volumes and registered objects are not deleted or migrated automatically.

After publishing the source snapshots and compiling the Environmental USL,
bootstrap its SmokeLedger view:

```powershell
npm run zetaris:bootstrap:smokeledger -- --dry-run
npm run zetaris:bootstrap:smokeledger
```

The broader environmental and law models have their own lifecycle. When
setting up those models on a fresh environment:

```bash
# Bootstrap BOTH Environmental USL + Law USL (default — no flag needed)
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts
# or using npx tsx:
npx tsx app/adapters/zetaris/usl/bootstrap_usl.ts

# Bootstrap ONLY the Environmental USL (malaysia_env_usl)
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts --env-only
npx tsx app/adapters/zetaris/usl/bootstrap_usl.ts --env-only

# Bootstrap ONLY the Law USL (malaysia_law_usl)
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts --law-only
npx tsx app/adapters/zetaris/usl/bootstrap_usl.ts --law-only

# Fast bootstrap (skips 345 NASA POWER tables for quicker test deployment)
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts --env-only --skip-power

# Preview execution steps without applying changes
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts --dry-run
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts --env-only --dry-run

# Optional post-bootstrap entity checks (may take several minutes)
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl_and_verify.ts --env-only
```

The regular `bootstrap_usl.ts` command bootstraps and activates the selected
USLs without running post-bootstrap verification queries. Run
`bootstrap_usl_and_verify.ts` explicitly when you want those checks.

> **Windy in the bootstrap:** `bootstrap_usl.ts` builds Windy at `[Env Step 6/7]`. It runs `windy_register.sql` (filling the `${WINDY_API_KEY}` placeholder from `.env`), then `windy_view.sql`, and activates the two Windy USL tables during step 7. If `WINDY_API_KEY` is not set, Windy registration is skipped with a warning and the rest of the bootstrap continues.

---

### Daily Morning Routine
Run when you need to register provider sources or roll NASA POWER date-keyed
views forward:

```bash
# Register Open-Meteo REST tables for a selected location:
npm run zetaris:fetch:pm25 -- --location kuala-lumpur
npm run zetaris:fetch:wind -- --location kuala-lumpur

# Refresh NASA FIRMS Active Fires (past 5 days):
node --experimental-strip-types app/adapters/zetaris/sources/nasa_firms/fetch_nasa_firms.ts --day-range 5

# Refresh NASA POWER Climate (shifts target date to today - 4 days):
node --experimental-strip-types app/adapters/zetaris/sources/nasa_power/fetch_nasa_power.ts

# Refresh Windy Point Forecast (KL point; not part of daily_update.ts, run on demand):
node --experimental-strip-types app/adapters/zetaris/sources/windy/fetch_windy.ts --all
```

> **Note on Weather & Air Quality:**
> Data.gov.my retains a live REST table. Open-Meteo air quality and wind use
> per-location live REST tables. Queries through Zetaris may contact the
> provider; registration or view activation may also validate endpoints. Use
> `--test` to limit setup to Kuala Lumpur, and verify predicate pushdown and
> provider usage before querying across all locations. Registering source views
> does not refresh an already activated USL copy.
>
> **Note on Windy:**
> The two `windy_*` tables read from a FileStore CSV snapshot, not a live REST feed, so they do **not** update on query. Refresh them with `fetch_windy.ts` on demand; `daily_update.ts` excludes Windy because its Testing-tier key allows only 500 requests/day.

---

## 2. Federated Cross-Source SQL Queries

### Comprehensive Environmental Intelligence Query
Join all 4 environmental sources against the canonical location dimension in a single federated query:

```sql
SELECT
    loc.location_name,
    aq.observation_time,
    aq.pm2_5_ug_m3,
    p.T2M          AS temperature_c,
    p.RH2M         AS relative_humidity,
    p.PRECTOTCORR  AS precipitation_mm,
    w.morning_forecast,
    f.frp          AS fire_radiative_power_mw
FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_code lc
  ON loc.location_index = lc.location_index
LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq
  ON loc.location_index = aq.location_index
LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.power_daily p
  ON loc.location_index = p.location_index
LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast w
  ON lc.location_code = w.location_code
LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.active_fires f
  ON loc.location_index = f.location_index
WHERE aq.pm2_5_ug_m3 > 35.0 OR f.frp > 10.0
ORDER BY loc.location_index;
```

---

### High-Risk Environmental Alert Query
Filter locations experiencing both poor air quality and active thermal hotspots:

```sql
SELECT
    loc.location_name,
    loc.latitude,
    loc.longitude,
    aq.pm2_5_ug_m3,
    aq.pm10_ug_m3,
    f.acq_myt,
    f.frp,
    f.confidence,
    p.WS10M AS wind_speed_10m
FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq
  ON loc.location_index = aq.location_index
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.active_fires f
  ON loc.location_index = f.location_index
LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.power_daily p
  ON loc.location_index = p.location_index
WHERE aq.pm2_5_ug_m3 > 50.0
ORDER BY f.frp DESC;
```

---

### Windy Point Forecast Query (Kuala Lumpur)
Read the Windy GFS weather point forecast and join it through the canonical location dimension:

```sql
SELECT
    loc.location_index,
    loc.location_id,
    loc.location_name,
    w.forecast_time,
    w.temp_c,
    w.relative_humidity_pct,
    w.pressure_hpa,
    w.wind_speed_ms,
    w.wind_direction_deg,
    w.wind_gust_ms
FROM lightning.metastore.malaysia_env.malaysia_env_usl.windy_forecast_obs w
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON w.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY w.forecast_time DESC
LIMIT 10;
```

### Windy Air-Quality Forecast Query (Kuala Lumpur)
Read the Windy CAMS air-quality point forecast (PM2.5, PM10, AQI, NO2, dust):

```sql
SELECT
    loc.location_name,
    c.observation_time,
    c.pm2_5_ug_m3,
    c.pm10_ug_m3,
    c.aqi_us,
    c.no2_ug_m3,
    c.dust_ug_m3
FROM lightning.metastore.malaysia_env.malaysia_env_usl.windy_air_quality_obs c
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON c.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY c.observation_time DESC
LIMIT 10;
```

---

### Predicate Pushdown Best Practice
Filter by `location_name` or `location_index` and the requested time range to limit the selected rows. Open-Meteo air quality reads a FileStore snapshot; it does not make location-specific HTTP calls at query time. NASA POWER retains its REST-table path:

```sql
SELECT
    loc.location_name,
    aq.observation_time,
    aq.pm2_5_ug_m3
FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq
  ON loc.location_index = aq.location_index
WHERE loc.location_name = 'Kuala Lumpur';
```
