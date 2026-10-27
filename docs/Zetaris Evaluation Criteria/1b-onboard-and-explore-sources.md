# 1b. Onboard and explore the sources

## Answer

The repository has source registrations, SQL examples, and an Environmental
USL for the four sources in [criterion 1a](1a-use-case-and-data-sources.md).
The [USL operations guide](../../app/adapters/zetaris/usl/env_usl/docs/OPERATION_AND_QUERIES.md)
describes setup and queries.

The SQL below is a query pack, not execution evidence. FIRMS and weather
queries start without a location filter to avoid hiding available rows. After
checking returned location codes, add filters if needed. Save the query, run
time, and results.

Some queries may contact live providers. FIRMS Query 3 and weather Query 3
check the registered source directly when the USL query is empty. Do not
re-fetch PM2.5 or FIRMS for this evaluation.

## Open-Meteo air quality

Source: `lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs`
(hourly PM2.5/PM10).

### Query 1: inspect the latest available readings

```sql
SELECT
    loc.location_id,
    loc.location_name,
    aq.observation_time,
    aq.pm2_5_ug_m3,
    aq.pm10_ug_m3
FROM lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON aq.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY aq.observation_time DESC
LIMIT 20
```

### Query 2: inspect available row count and time span for one location

```sql
SELECT
    loc.location_id,
    COUNT(*) AS row_count,
    MIN(aq.observation_time) AS first_observation,
    MAX(aq.observation_time) AS last_observation
FROM lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON aq.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
GROUP BY loc.location_id
```

### Query 3: summarize missing or out-of-range values

```sql
SELECT
    COUNT(*) AS row_count,
    SUM(CASE WHEN aq.pm2_5_ug_m3 IS NULL THEN 1 ELSE 0 END) AS null_pm25_rows,
    SUM(CASE WHEN aq.pm2_5_ug_m3 < 0 THEN 1 ELSE 0 END) AS negative_pm25_rows,
    MIN(aq.pm2_5_ug_m3) AS min_pm25,
    MAX(aq.pm2_5_ug_m3) AS max_pm25
FROM lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON aq.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
```

## NASA FIRMS active fires

Source: `lightning.metastore.malaysia_env.malaysia_env_usl.active_fires`.
Start without a location filter because FIRMS uses IDs such as
`wp-kuala-lumpur`. If the USL query is empty, check
`NASA_FIRMS_FILES.active_fires` directly.

### Query 1: sample active USL detections without narrowing the location

```sql
SELECT
    f.location_index,
    f.acq_utc,
    f.acq_myt,
    f.fire_latitude,
    f.fire_longitude,
    f.frp,
    f.confidence,
    f.satellite
FROM lightning.metastore.malaysia_env.malaysia_env_usl.active_fires f
ORDER BY f.acq_utc DESC
LIMIT 20
```

### Query 2: count active USL detections by date and satellite

```sql
SELECT
    CAST(f.acq_utc AS DATE) AS acquisition_date,
    f.satellite,
    COUNT(*) AS detection_count
FROM lightning.metastore.malaysia_env.malaysia_env_usl.active_fires f
GROUP BY CAST(f.acq_utc AS DATE), f.satellite
ORDER BY acquisition_date DESC, f.satellite
```

### Query 3: inspect raw registered FIRMS rows if the USL sample is empty

This checks the registered source without the USL join. If it has rows but
Query 1 does not, check the
[FIRMS activation SQL](../../app/adapters/zetaris/sources/nasa_firms/sql/firms_activate.sql).

```sql
SELECT
    f.region,
    f.location_id,
    f.acq_utc,
    f.latitude,
    f.longitude,
    f.frp,
    f.confidence,
    f.satellite
FROM NASA_FIRMS_FILES.active_fires f
ORDER BY f.frp DESC
LIMIT 20
```

## NASA POWER daily climate

For a single location, query its REST table directly instead of
`power.power_daily`, which combines up to 345 location tables. The example
below uses a separate date-specific table:
`NASA_POWER_REST.power_kuala_lumpur_20261021_raw`.

### Query 1: read daily values for Kuala Lumpur

```sql
SELECT
    to_date(observation_key, 'yyyyMMdd') AS observation_date,
    observation_value AS WS10M,
    element_at(
        from_json(to_json(properties.parameter.T2M), 'map<string,double>'),
        observation_key
    ) AS T2M,
    element_at(
        from_json(to_json(properties.parameter.RH2M), 'map<string,double>'),
        observation_key
    ) AS RH2M
FROM NASA_POWER_REST.power_kuala_lumpur_20261021_raw
LATERAL VIEW explode(
    from_json(to_json(properties.parameter.WS10M), 'map<string,double>')
) AS observation_key, observation_value
LIMIT 5
```

### Query 2: check the returned date and location

```sql
SELECT
    header.start AS start_date,
    header.end AS end_date,
    header.time_standard,
    header.fill_value,
    geometry.coordinates[1] AS latitude,
    geometry.coordinates[0] AS longitude
FROM NASA_POWER_REST.power_kuala_lumpur_20261021_raw
LIMIT 1
```

### Query 3: inspect all parameter values and missing-value markers

```sql
SELECT properties.parameter
FROM NASA_POWER_REST.power_kuala_lumpur_20261021_raw
LIMIT 1
```

The October 21 table was registered in Zetaris and tested. The query returned:

| Date | Temperature | Humidity | Wind speed |
| --- | ---: | ---: | ---: |
| 2026-10-21 | 26.90 °C | 83.17% | 1.04 m/s |

The query returned in about four seconds. The previous table is still set to
October 23 and returns `-999`; use the new table above for October 21. The
combined `power.power_daily` query was cancelled after more than three
minutes. Treat `-999` as missing data.

## Data.gov.my weather forecast

Source: `lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast`.
Find actual codes first; do not assume `W.P.` is valid. If the USL query is
empty, check `DATA_GOV_MY_WEATHER.forecasts_raw`.

### Query 1: sample active USL forecasts and discover actual codes

```sql
SELECT
    w.forecast_date,
    w.location_code,
    w.morning_forecast,
    w.afternoon_forecast,
    w.night_forecast
FROM lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast w
ORDER BY w.forecast_date DESC
LIMIT 20
```

### Query 2: count forecast rows by actual code

```sql
SELECT
    w.location_code,
    COUNT(*) AS forecast_rows,
    MIN(w.forecast_date) AS first_forecast_date,
    MAX(w.forecast_date) AS last_forecast_date
FROM lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast w
GROUP BY w.location_code
ORDER BY forecast_rows DESC
```

### Query 3: inspect the raw REST source if the USL sample is empty

This checks the provider source without the USL join. If it has rows but
Query 1 does not, check the location-code match and USL activation.

```sql
SELECT
    raw.location.location_id AS location_code,
    raw.location.location_name,
    raw.date AS forecast_date,
    raw.morning_forecast,
    raw.afternoon_forecast,
    raw.night_forecast
FROM DATA_GOV_MY_WEATHER.forecasts_raw raw
LIMIT 20
```

After finding a code, use it to check missing forecast periods:

```sql
SELECT
    w.location_code,
    w.forecast_date,
    w.morning_forecast,
    w.afternoon_forecast,
    w.night_forecast
FROM lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast w
WHERE w.location_code = '<code returned by Query 1>'
  AND (
      w.morning_forecast IS NULL
      OR w.afternoon_forecast IS NULL
      OR w.night_forecast IS NULL
  )
ORDER BY w.forecast_date
```

## Evidence to capture

Record each executed query, run time, returned rows, and any empty result.
These examples do not prove that the sources returned data.
