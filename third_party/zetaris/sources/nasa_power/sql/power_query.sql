-- =============================================================================
-- Query Verified USL Fact Table: power_daily
-- =============================================================================

SELECT
    loc.location_index,
    loc.location_id,
    loc.location_name,
    p.observation_date,
    p.T2M          AS temp_c,
    p.T2M_MAX      AS temp_max_c,
    p.T2M_MIN      AS temp_min_c,
    p.RH2M         AS humidity_pct,
    p.PRECTOTCORR  AS precip_mm,
    p.WS10M        AS wind_speed_m_s
FROM lightning.metastore.malaysia_env.malaysia_env_usl.power_daily p
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
  ON p.location_index = loc.location_index
WHERE loc.location_id = 'kuala-lumpur'
ORDER BY p.observation_date DESC
LIMIT 10;
