# NASA FIRMS Schema & USL Output

## USL Entity Definition

- **Entity Name**: `active_fires`
- **Schema**: `lightning.metastore.malaysia_env_usl.active_fires`
- **Base Source**: FileStore table `active_fires_raw` (`/var/data/firms`)
- **Foreign Key**: `location_index` (referencing `location_dim.location_index`)
- **Grain**: 1 row per satellite detection incident

## Schema Fields

| Column | Type | Nullable | Description |
| :--- | :--- | :--- | :--- |
| `latitude` | DOUBLE | NO | Satellite detection latitude (WGS84) |
| `longitude` | DOUBLE | NO | Satellite detection longitude (WGS84) |
| `bright_ti4` | DOUBLE | YES | VIIRS I-4 Channel Brightness Temp (Kelvin) |
| `scan` | DOUBLE | YES | Along-scan pixel dimension (km) |
| `track` | DOUBLE | YES | Along-track pixel dimension (km) |
| `acq_date` | STRING | NO | Acquisition Date (`YYYY-MM-DD`) |
| `acq_time` | STRING | NO | Acquisition Time (`HHMM` UTC) |
| `satellite` | STRING | YES | Satellite name (`N` = Suomi NPP, `1` = NOAA-20) |
| `confidence` | STRING | YES | Detection confidence (`low`, `nominal`, `high`) |
| `version` | STRING | YES | Processing algorithm version |
| `bright_ti5` | DOUBLE | YES | VIIRS I-5 Channel Brightness Temp (Kelvin) |
| `frp` | DOUBLE | YES | Fire Radiative Power (Megawatts) |
| `daynight` | STRING | YES | Detection daylight flag (`D` = Day, `N` = Night) |
| `location_index` | INT | NO | Foreign key to `location_dim` (1..345) |

## Sample Query

```sql
SELECT 
    loc.name AS nearest_district,
    loc.state,
    f.acq_date,
    f.acq_time,
    f.confidence,
    f.frp
FROM lightning.metastore.malaysia_env_usl.active_fires f
JOIN lightning.metastore.malaysia_env_usl.location_dim loc
  ON f.location_index = loc.location_index
WHERE f.confidence = 'high'
ORDER BY f.frp DESC;
```
