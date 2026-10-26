-- Read a bounded sample from the live, unified Zetaris REST view.
SELECT location_id, location_name, observation_time, pm2_5_ug_m3
FROM open_meteo_pm25.hourly_observations
WHERE location_id = 'kuala-lumpur'
ORDER BY observation_time DESC
LIMIT 100;
