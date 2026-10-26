-- =============================================================================
-- Activate USL Fact Table: air_quality_obs
--
-- Model: malaysia_env_usl
-- Namespace: lightning.metastore.malaysia_env
-- Target Table: air_quality_obs
--
-- Source: live Open-Meteo REST federation through air_quality.hourly_observations.
-- Joins by stable location_id to attach the canonical location_index FK.
-- =============================================================================

ACTIVATE USL TABLE lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs AS
SELECT
    loc.location_index AS location_index,
    CAST(obs.observation_time AS TIMESTAMP) AS observation_time,
    CAST(obs.pm2_5_ug_m3 AS DOUBLE) AS pm2_5_ug_m3,
    CAST(obs.pm10_ug_m3 AS DOUBLE) AS pm10_ug_m3
FROM air_quality.hourly_observations obs
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON obs.location_id = loc.location_id;
