# Weather Forecast Schema & USL Output

## USL Entity Definition

- **Entity Name**: `weather_forecast`
- **Schema**: `lightning.metastore.malaysia_env_usl.weather_forecast`
- **Base Source**: View `weather.forecasts_all`
- **Foreign Key**: `location_code` (referencing `location_code.location_code`, which in turn links to `location_dim.location_index`)
- **Grain**: 1 record per `location_code` per forecast date

## Schema Fields

| Column | Type | Nullable | Description |
| :--- | :--- | :--- | :--- |
| `location_code` | STRING | NO | Forecast location code (e.g., `St001`, `Ds023`, `Tn145`) |
| `location_name` | STRING | NO | Forecast location name |
| `date` | STRING | NO | Forecast date (`YYYY-MM-DD`) |
| `forecast` | STRING | YES | General day forecast summary (e.g., `Hujan di beberapa tempat`) |
| `morning_forecast` | STRING | YES | Morning forecast summary |
| `afternoon_forecast` | STRING | YES | Afternoon forecast summary |
| `night_forecast` | STRING | YES | Night forecast summary |
| `min_temp` | FLOAT | YES | Minimum expected temperature (°C) |
| `max_temp` | FLOAT | YES | Maximum expected temperature (°C) |

## Bridging to District Centroids

Because `weather_forecast` uses `location_code`, it joins through the bridge table `location_code`:

```sql
SELECT 
    dim.name AS canonical_district,
    dim.state,
    wf.date,
    wf.forecast,
    wf.min_temp,
    wf.max_temp
FROM lightning.metastore.malaysia_env_usl.weather_forecast wf
JOIN lightning.metastore.malaysia_env_usl.location_code lc
  ON wf.location_code = lc.location_code
JOIN lightning.metastore.malaysia_env_usl.location_dim dim
  ON lc.location_index = dim.location_index
WHERE wf.max_temp > 34.0;
```
