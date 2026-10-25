-- =============================================================================
-- Activate USL Fact Table: power_daily
--
-- Model: malaysia_env_usl
-- Namespace: lightning.metastore.malaysia_env
-- Target Table: power_daily
--
-- Source: power.power_daily (NASA POWER Daily Climate REST API)
-- Joins with USL location_dim on region = location_id to attach canonical location_index FK.
-- =============================================================================

ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.power_daily AS
SELECT
    loc.location_index AS location_index,
    CAST(p.observation_date AS DATE) AS observation_date,
    CAST(p.T2M AS DOUBLE) AS T2M,
    CAST(p.T2M_MAX AS DOUBLE) AS T2M_MAX,
    CAST(p.T2M_MIN AS DOUBLE) AS T2M_MIN,
    CAST(p.T2MDEW AS DOUBLE) AS T2MDEW,
    CAST(p.T2MWET AS DOUBLE) AS T2MWET,
    CAST(p.RH2M AS DOUBLE) AS RH2M,
    CAST(p.QV2M AS DOUBLE) AS QV2M,
    CAST(p.PRECTOTCORR AS DOUBLE) AS PRECTOTCORR,
    CAST(p.PS AS DOUBLE) AS PS,
    CAST(p.WS10M AS DOUBLE) AS WS10M,
    CAST(p.WD10M AS DOUBLE) AS WD10M,
    CAST(p.WS10M_MAX AS DOUBLE) AS WS10M_MAX,
    CAST(p.WS2M AS DOUBLE) AS WS2M,
    CAST(p.WS50M AS DOUBLE) AS WS50M,
    CAST(p.WD50M AS DOUBLE) AS WD50M,
    CAST(p.GWETTOP AS DOUBLE) AS GWETTOP,
    CAST(p.GWETROOT AS DOUBLE) AS GWETROOT,
    CAST(p.GWETPROF AS DOUBLE) AS GWETPROF,
    CAST(p.EVLAND AS DOUBLE) AS EVLAND,
    CAST(p.TS AS DOUBLE) AS TS
FROM power.power_daily p
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON p.region = loc.location_id;
