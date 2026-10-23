# NASA POWER Schema & USL Output

## USL Entity Definition

- **Entity Name**: `power_daily`
- **Schema**: `lightning.metastore.malaysia_env_usl.power_daily`
- **Base Source**: View `power.power_daily` (combining 345 `power_*_raw` REST tables)
- **Foreign Key**: `location_index` (referencing `location_dim.location_index`)
- **Grain**: 1 observation per location per day (`location_index`, `observation_date`)

## Schema Fields (20 Climate Parameters + Keys)

| Column | Type | Nullable | Description | Unit | Agent Alignment |
| :--- | :--- | :---: | :--- | :--- | :--- |
| `location_index` | INT | NO | Canonical location dimension key (1..345) | Reference ID | General |
| `observation_date` | DATE | NO | Daily observation date (`YYYY-MM-DD`) | Date | General |
| `T2M` | DOUBLE | YES | Air temperature at 2 metres | °C | WorkerShield |
| `T2M_MAX` | DOUBLE | YES | Daily maximum air temperature at 2 metres | °C | WorkerShield |
| `T2M_MIN` | DOUBLE | YES | Daily minimum air temperature at 2 metres | °C | WorkerShield |
| `T2MDEW` | DOUBLE | YES | Dew/frost-point temperature at 2 metres | °C | General |
| `T2MWET` | DOUBLE | YES | Wet bulb temperature at 2 metres (WBGT / Heat Stress) | °C | WorkerShield |
| `RH2M` | DOUBLE | YES | Relative humidity at 2 metres | % | WorkerShield |
| `QV2M` | DOUBLE | YES | Specific humidity at 2 metres | g/kg | General |
| `PRECTOTCORR` | DOUBLE | YES | Corrected total precipitation | mm/day | General |
| `PS` | DOUBLE | YES | Surface pressure (atmospheric stagnation & inversions) | kPa | HazeOps |
| `WS10M` | DOUBLE | YES | Wind speed at 10 metres | m/s | HazeOps |
| `WD10M` | DOUBLE | YES | Wind direction at 10 metres | degrees | HazeOps |
| `WS10M_MAX` | DOUBLE | YES | Daily maximum wind speed at 10 metres | m/s | HazeOps |
| `WS2M` | DOUBLE | YES | Wind speed at 2 metres (pedestrian/crew level cooling) | m/s | WorkerShield |
| `WS50M` | DOUBLE | YES | Wind speed at 50 metres (boundary-layer plume transport) | m/s | HazeOps |
| `WD50M` | DOUBLE | YES | Wind direction at 50 metres (plume trajectory) | degrees | HazeOps |
| `GWETTOP` | DOUBLE | YES | Top-layer soil wetness | fraction (0–1) | PeatFire Sentinel |
| `GWETROOT` | DOUBLE | YES | Root-zone soil wetness | fraction (0–1) | PeatFire Sentinel |
| `GWETPROF` | DOUBLE | YES | Soil wetness through the soil profile | fraction (0–1) | PeatFire Sentinel |
| `EVLAND` | DOUBLE | YES | Land evaporation (soil & vegetation drought desiccation) | mm/day | PeatFire Sentinel |
| `TS` | DOUBLE | YES | Earth skin temperature (ground/peat surface heating) | °C | PeatFire Sentinel |

## Sample Queries

### 1. High Heat Stress & Outdoor Worker Exposure (WorkerShield)
```sql
SELECT 
    loc.name AS location,
    loc.state,
    p.observation_date,
    p.T2M_MAX AS max_temp_c,
    p.T2MWET AS wet_bulb_temp_c,
    p.RH2M AS humidity_pct,
    p.WS2M AS wind_speed_crew_ms
FROM lightning.metastore.malaysia_env_usl.power_daily p
JOIN lightning.metastore.malaysia_env_usl.location_dim loc
  ON p.location_index = loc.location_index
WHERE p.T2MWET > 28.0
ORDER BY p.T2MWET DESC;
```

### 2. Peatland Drought & Fire Risk (PeatFire Sentinel)
```sql
SELECT 
    loc.name,
    loc.state,
    p.observation_date,
    p.TS AS surface_temp_c,
    p.GWETTOP AS top_soil_wetness,
    p.GWETROOT AS root_soil_wetness,
    p.EVLAND AS evaporation_mm_day
FROM lightning.metastore.malaysia_env_usl.power_daily p
JOIN lightning.metastore.malaysia_env_usl.location_dim loc
  ON p.location_index = loc.location_index
WHERE p.GWETTOP < 0.30 AND p.TS > 32.0
ORDER BY p.GWETTOP ASC;
```

### 3. Plume Dispersion & Transport Winds (HazeOps)
```sql
SELECT 
    loc.name,
    loc.state,
    p.observation_date,
    p.WS50M AS upper_wind_speed_ms,
    p.WD50M AS upper_wind_dir_deg,
    p.PS AS surface_pressure_kpa
FROM lightning.metastore.malaysia_env_usl.power_daily p
JOIN lightning.metastore.malaysia_env_usl.location_dim loc
  ON p.location_index = loc.location_index
WHERE p.WS50M > 5.0;
```
