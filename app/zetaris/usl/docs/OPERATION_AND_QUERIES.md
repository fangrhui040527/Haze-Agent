# Malaysia Environmental USL: Operations & Federated Queries

Operational execution guide and cross-source SQL queries for the Zetaris Unified Semantic Layer (`malaysia_env_usl`).

---

## 1. Operational Playbook

### Cold Start / Day-0 Bootstrap
When setting up a fresh environment with no existing tables or databases:

```bash
# Complete end-to-end setup (all sources, compiles & activates USL)
node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts
# or using npx tsx:
npx tsx app/zetaris/usl/bootstrap_usl.ts

# Fast bootstrap (skips 345 NASA POWER tables for quicker test deployment)
node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --skip-power

# Preview execution steps without applying changes
node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --dry-run
```

---

### Daily Morning Routine
Run when you need to roll forward FIRMS satellite detections and NASA POWER date-keyed views:

```bash
# Refresh NASA FIRMS Active Fires (past 5 days):
node --experimental-strip-types app/zetaris/sources/nasa_firms/fetch_nasa_firms.ts --day-range 5

# Refresh NASA POWER Climate (shifts target date to today - 4 days):
node --experimental-strip-types app/zetaris/sources/nasa_power/fetch_nasa_power.ts
```

> **Note on Weather & Air Quality:**
> Data.gov.my and Open-Meteo use live REST tables in Zetaris. They update **automatically on query execution** without running any daily update scripts.

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

### Predicate Pushdown Best Practice
When querying point-based sources (Open-Meteo or NASA POWER), filter by `location_name` or `location_index` to leverage predicate pushdown and avoid scanning unnecessary endpoints:

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
