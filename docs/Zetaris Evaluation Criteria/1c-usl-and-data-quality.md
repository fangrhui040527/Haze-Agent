# 1c. Show the USL and an executed data-quality rule

## Answer

Show both USLs. **DDL** means **Data Definition Language**: the `CREATE TABLE`
statements define tables, columns, types, and links between tables.
`ACTIVATE USL TABLE` statements connect source data to those tables.

### Environmental USL DDL

The Environmental USL is `malaysia_env_usl` in
`lightning.metastore.malaysia_env`. Its location tables link air quality,
fire, climate, and weather data. This excerpt shows the main tables:

```sql
COMPILE USL IF NOT EXISTS malaysia_env_usl
DEPLOY NAMESPACE lightning.metastore.malaysia_env DDL
CREATE TABLE location_dim (
    location_index int NOT NULL PRIMARY KEY,
    location_id varchar(80),
    location_name varchar(200),
    latitude double,
    longitude double
);
CREATE TABLE location_code (
    location_code varchar(10) NOT NULL PRIMARY KEY,
    location_index int NOT NULL FOREIGN KEY REFERENCES location_dim(location_index),
    code_type varchar(30),
    code_name varchar(200)
);
CREATE TABLE air_quality_obs (
    location_index int FOREIGN KEY REFERENCES location_dim(location_index),
    observation_time timestamp,
    pm2_5_ug_m3 double,
    pm10_ug_m3 double
);
CREATE TABLE active_fires (
    location_index int FOREIGN KEY REFERENCES location_dim(location_index),
    acq_utc timestamp,
    acq_myt timestamp,
    fire_latitude double,
    fire_longitude double,
    frp double,
    confidence varchar(1),
    satellite varchar(50)
);
CREATE TABLE power_daily (
    location_index int FOREIGN KEY REFERENCES location_dim(location_index),
    observation_date date,
    T2M double,
    RH2M double,
    PRECTOTCORR double,
    WS10M double
);
CREATE TABLE weather_forecast (
    location_code varchar(10) FOREIGN KEY REFERENCES location_code(location_code),
    forecast_date date,
    location_name varchar(200),
    morning_forecast varchar(500),
    afternoon_forecast varchar(500),
    night_forecast varchar(500)
);
```

The [full Environmental USL DDL](../../app/adapters/zetaris/usl/env_usl/usl_schema.sql)
also defines Open-Meteo and Windy tables. Its
[activation SQL](../../app/adapters/zetaris/usl/env_usl/compat_activate.sql)
connects source data to the USL.

### SmokeLedger USL DDL

The SmokeLedger USL is `smokeledger_usl` in
`lightning.metastore.smokeledger`. It defines 15 tables. Current feeds fill
`towns`, `fires`, `wind`, and `pm25`; the other tables are empty until a data
source is connected.

```sql
COMPILE USL IF NOT EXISTS smokeledger_usl
DEPLOY NAMESPACE lightning.metastore.smokeledger DDL
CREATE TABLE towns (
    town varchar(200) NOT NULL PRIMARY KEY,
    district varchar(200),
    state varchar(200),
    lat double NOT NULL,
    lon double NOT NULL
);
CREATE TABLE fires (
    fire_id varchar(64) NOT NULL PRIMARY KEY,
    lat double NOT NULL,
    lon double NOT NULL,
    acq_utc timestamp NOT NULL,
    frp double NOT NULL,
    confidence varchar(20),
    satellite varchar(50),
    daynight varchar(10),
    concession_id varchar(200),
    on_peat boolean,
    source_file varchar(255),
    ingested_utc timestamp
);
CREATE TABLE wind (
    level varchar(20) NOT NULL,
    lat double NOT NULL,
    lon double NOT NULL,
    valid_utc timestamp NOT NULL,
    u double NOT NULL,
    v double NOT NULL,
    PRIMARY KEY (level, lat, lon, valid_utc)
);
CREATE TABLE pm25 (
    town varchar(200) NOT NULL FOREIGN KEY REFERENCES towns(town),
    valid_utc timestamp NOT NULL,
    kind varchar(30) NOT NULL,
    issued_utc timestamp,
    pm25 double NOT NULL,
    api_source varchar(100),
    ingested_utc timestamp NOT NULL
);
```

The [full SmokeLedger DDL](../../app/adapters/zetaris/usl/smokeledger_usl/usl_schema.sql)
defines its other tables. Its
[activation SQL](../../app/adapters/zetaris/usl/smokeledger_usl/usl_activate.sql)
connects the four feeds and creates empty relations for the rest.

See the [Environmental operations guide](../../app/adapters/zetaris/usl/env_usl/docs/OPERATION_AND_QUERIES.md)
and [SmokeLedger README](../../app/adapters/zetaris/usl/smokeledger_usl/README.md)
for setup steps.

Run these queries in Zetaris and save the results to show the USLs are active.

## Environmental USL: active-query evidence

### Query 1: confirm canonical locations are queryable

```sql
SELECT location_index, location_id, location_name, latitude, longitude
FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim
ORDER BY location_index
LIMIT 10
```

### Query 2: confirm recent air-quality rows are queryable

```sql
SELECT
    loc.location_id,
    aq.observation_time,
    aq.pm2_5_ug_m3,
    aq.pm10_ug_m3
FROM lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON aq.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY aq.observation_time DESC
LIMIT 10
```

### Query 3: confirm FIRMS rows are queryable

```sql
SELECT
    loc.location_id,
    f.acq_utc,
    f.fire_latitude,
    f.fire_longitude,
    f.frp,
    f.confidence,
    f.satellite
FROM lightning.metastore.malaysia_env.malaysia_env_usl.active_fires f
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON f.location_index = loc.location_index
ORDER BY f.acq_utc DESC
LIMIT 10
```

## SmokeLedger USL: active-query evidence

These query the four entities connected to current environmental feeds.

### Query 1: confirm towns are queryable

```sql
SELECT town, district, state, lat, lon
FROM lightning.metastore.smokeledger.smokeledger_usl.towns
ORDER BY town
LIMIT 10
```

### Query 2: confirm SmokeLedger fire rows are queryable

```sql
SELECT fire_id, acq_utc, lat, lon, frp, confidence, satellite
FROM lightning.metastore.smokeledger.smokeledger_usl.fires
ORDER BY acq_utc DESC
LIMIT 10
```

### Query 3: confirm SmokeLedger PM2.5 rows are queryable

```sql
SELECT town, valid_utc, issued_utc, kind, pm25, api_source
FROM lightning.metastore.smokeledger.smokeledger_usl.pm25
ORDER BY valid_utc DESC
LIMIT 10
```

Save query results and run times. If fires returns no rows, record that.

## Data-quality rule

This rule counts FIRMS rows with missing required values, invalid coordinates,
or negative FRP.

```sql
SELECT
    COUNT(*) AS total_rows,
    SUM(
        CASE
            WHEN location_index IS NULL
              OR acq_utc IS NULL
              OR fire_latitude IS NULL
              OR fire_longitude IS NULL
              OR fire_latitude < -90 OR fire_latitude > 90
              OR fire_longitude < -180 OR fire_longitude > 180
              OR frp IS NULL OR frp < 0
            THEN 1 ELSE 0
        END
    ) AS invalid_rows
FROM lightning.metastore.malaysia_env.malaysia_env_usl.active_fires
```

Record the run time, total rows, and invalid rows. Treat NASA POWER values of
`-999` as missing data.

## Evidence status

The DDL and activation files are linked above. Live query and quality-rule
results still need to be recorded; this document does not claim they have run.
