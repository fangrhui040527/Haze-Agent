SELECT location_name, observation_time, level, u, v, ingested_utc
FROM wind.hourly_observations
WHERE location_name = 'Kuala Lumpur'
ORDER BY observation_time DESC, level
LIMIT 10;
