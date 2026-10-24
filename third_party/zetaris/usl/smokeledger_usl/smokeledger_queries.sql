-- Run after compiling and activating the SmokeLedger USL.

-- Recent fire detections.
SELECT fire_id, acq_utc, lat, lon, frp, satellite, confidence
FROM lightning.metastore.smokeledger.smokeledger_usl.fires
ORDER BY acq_utc DESC
LIMIT 20;

-- Most recent stored hourly PM2.5 forecasts by town.
SELECT town, valid_utc, issued_utc, pm25, api_source
FROM lightning.metastore.smokeledger.smokeledger_usl.pm25
WHERE kind = 'model'
ORDER BY valid_utc DESC
LIMIT 20;

-- Latest 10 m wind observations per stored grid point.
SELECT lat, lon, valid_utc, u, v
FROM lightning.metastore.smokeledger.smokeledger_usl.wind
WHERE level = '10m'
ORDER BY valid_utc DESC
LIMIT 20;
