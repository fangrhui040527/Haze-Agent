-- =============================================================================
-- USL: malaysia_env_usl
-- Unified Semantic Layer for Malaysia environmental monitoring.
--
-- Combines six data sources under a normalized location dimension model:
--   - location_dim : 345 canonical location centroids (PK: location_index)
--   - location_code: 440 unique codes across 5 types: St, Rc, Ds, Tn, Dv
--                   (PK: location_code, FK: location_index -> location_dim)
--   - air_quality_obs : Open-Meteo hourly PM2.5 / PM10 (FK -> location_dim)
--   - open_meteo_pm25_obs : Open-Meteo hourly modeled PM2.5 (FK -> location_dim)
--   - open_meteo_wind_obs : Open-Meteo hourly 10 m / 850 hPa wind (FK -> location_dim)
--   - active_fires    : NASA FIRMS satellite active-fires (FK -> location_dim)
--   - power_daily     : NASA POWER 20 daily climate variables (FK -> location_dim)
--   - windy_forecast_obs    : Windy (GFS) point weather forecast (FK -> location_dim)
--   - windy_air_quality_obs : Windy (CAMS) point air-quality forecast (FK -> location_dim)
--   - weather_forecast: Data.gov.my forecasts across all 5 code types (FK -> location_code)
-- =============================================================================

CREATE NAMESPACE IF NOT EXISTS lightning.metastore;
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.malaysia_env;

COMPILE USL IF NOT EXISTS malaysia_env_usl DEPLOY NAMESPACE lightning.metastore.malaysia_env DDL
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
CREATE TABLE open_meteo_pm25_obs (
    location_index int FOREIGN KEY REFERENCES location_dim(location_index),
    observation_time timestamp,
    pm2_5_ug_m3 double
);
CREATE TABLE open_meteo_wind_obs (
    location_index int FOREIGN KEY REFERENCES location_dim(location_index),
    observation_time timestamp,
    level varchar(20),
    wind_speed_ms double,
    wind_direction_deg double,
    u_ms double,
    v_ms double
);
CREATE TABLE active_fires (
    location_index int FOREIGN KEY REFERENCES location_dim(location_index),
    acq_utc timestamp,
    acq_myt timestamp,
    fire_latitude double,
    fire_longitude double,
    bright_ti4 double,
    frp double,
    confidence varchar(1),
    satellite varchar(50),
    instrument varchar(50),
    fire_source varchar(30),
    daynight varchar(1)
);
CREATE TABLE power_daily (
    location_index int FOREIGN KEY REFERENCES location_dim(location_index),
    observation_date date,
    T2M double,
    T2M_MAX double,
    T2M_MIN double,
    T2MDEW double,
    T2MWET double,
    RH2M double,
    QV2M double,
    PRECTOTCORR double,
    PS double,
    WS10M double,
    WD10M double,
    WS10M_MAX double,
    WS2M double,
    WS50M double,
    WD50M double,
    GWETTOP double,
    GWETROOT double,
    GWETPROF double,
    EVLAND double,
    TS double
);
CREATE TABLE windy_forecast_obs (
    location_index int FOREIGN KEY REFERENCES location_dim(location_index),
    forecast_time timestamp,
    temp_c double,
    relative_humidity_pct double,
    pressure_hpa double,
    wind_speed_ms double,
    wind_direction_deg double,
    wind_gust_ms double
);
CREATE TABLE windy_air_quality_obs (
    location_index int FOREIGN KEY REFERENCES location_dim(location_index),
    observation_time timestamp,
    pm2_5_ug_m3 double,
    pm10_ug_m3 double,
    aqi_us double,
    no2_ug_m3 double,
    dust_ug_m3 double
);
CREATE TABLE weather_forecast (
    location_code varchar(10) FOREIGN KEY REFERENCES location_code(location_code),
    forecast_date date,
    location_name varchar(200),
    morning_forecast varchar(500),
    afternoon_forecast varchar(500),
    night_forecast varchar(500)
);
