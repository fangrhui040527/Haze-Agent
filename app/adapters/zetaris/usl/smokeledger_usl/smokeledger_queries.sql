-- Run after compiling and activating the SmokeLedger USL.

-- Recent source-backed fire detections.
SELECT location_index, acq_utc, fire_latitude, fire_longitude, frp, satellite, confidence
FROM lightning.metastore.smokeledger.smokeledger_usl.fires
ORDER BY acq_utc DESC
LIMIT 20;

-- Recent PM2.5 values, with source provenance preserved.
SELECT location_index, observation_time, api_source, pm2_5_ug_m3, pm10_ug_m3
FROM lightning.metastore.smokeledger.smokeledger_usl.pm25
ORDER BY observation_time DESC
LIMIT 20;

-- Recent Open-Meteo wind-vector components.
SELECT location_index, level, observation_time, u_ms, v_ms, ingested_utc
FROM lightning.metastore.smokeledger.smokeledger_usl.wind
WHERE level = '10m'
ORDER BY observation_time DESC
LIMIT 20;
