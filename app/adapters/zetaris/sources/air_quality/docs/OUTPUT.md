# Air Quality Schema & USL Output

## USL Entity Definition

- **Entity Name**: `air_quality_obs`
- **Schema**: `lightning.metastore.malaysia_env_usl.air_quality_obs`
- **Base Source**: View `air_quality.hourly_observations` (combining 345 `aq_*_raw` REST tables)
- **Primary / Foreign Key**:
  - `location_index` (Foreign Key referencing `location_dim.location_index`)
  - Grain: 1 observation per location per hour (`location_index`, `observation_time`)

## Schema Fields

| Column | Type | Nullable | Description | Unit / Format |
| :--- | :--- | :--- | :--- | :--- |
| `location_index` | INT | NO | Foreign key to `location_dim` (1..345) | Reference ID |
| `location_name` | STRING | NO | Canonical name (e.g., `Batu Pahat`, `Klang`) | String |
| `observation_time` | TIMESTAMP | NO | Measurement timestamp (Asia/Kuala_Lumpur) | ISO 8601 |
| `pm2_5_ug_m3` | FLOAT | YES | PM2.5 fine particulate concentration | µg/m³ |
| `pm10_ug_m3` | FLOAT | YES | PM10 coarse particulate concentration | µg/m³ |

## Sample Query

```sql
SELECT 
    loc.name AS location,
    loc.state,
    aq.observation_time,
    aq.pm2_5_ug_m3,
    aq.pm10_ug_m3
FROM lightning.metastore.malaysia_env_usl.air_quality_obs aq
JOIN lightning.metastore.malaysia_env_usl.location_dim loc
  ON aq.location_index = loc.location_index
WHERE aq.pm2_5_ug_m3 > 35.0
ORDER BY aq.pm2_5_ug_m3 DESC;
```
