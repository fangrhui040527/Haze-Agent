-- Read a bounded sample from the live, unified Zetaris REST view.
SELECT location_id, location_name, observation_time, level,
       wind_speed_ms, wind_direction_deg, u_ms, v_ms
FROM open_meteo_wind.hourly_observations
WHERE location_id = 'kuala-lumpur'
ORDER BY observation_time DESC, level
LIMIT 100;
