# NASA POWER Daily Climate API

## Endpoint

NASA POWER (Prediction Of Worldwide Energy Resources) provides point-based daily agrometeorological and climate parameters via HTTP GET:

```text
https://power.larc.nasa.gov/api/temporal/daily/point?parameters=WS10M,WD10M,RH2M,QV2M,GWETTOP,GWETROOT,PRECTOTCORR,T2M,T2M_MAX,T2M_MIN,T2MDEW,WS10M_MAX,GWETPROF,WS2M,T2MWET,PS,WS50M,WD50M,TS,EVLAND&community=AG&longitude={lon}&latitude={lat}&start={day}&end={day}&format=JSON
```

## Parameters

| Parameter | Value | Purpose |
| :--- | :--- | :--- |
| `parameters` | 20 comma-separated variables (see below) | Climatology, heat stress, wind transport, and soil hydrology |
| `community` | `AG` | Agroclimatology user community |
| `latitude` | Decimal degrees (WGS84) | Location centroid latitude |
| `longitude` | Decimal degrees (WGS84) | Location centroid longitude |
| `start` / `end` | `YYYYMMDD` | Rolling date target (default: T-4 days for completed MERRA-2 assimilation) |
| `format` | `JSON` | Nested JSON response payload |

## The 20 Required USL Climate Variables

| # | Parameter | Description | Unit | Primary Agent Alignment |
| :-: | :--- | :--- | :--- | :--- |
| 1 | `T2M` | Air temperature at 2 metres | °C | WorkerShield |
| 2 | `T2M_MAX` | Daily maximum air temperature at 2 metres | °C | WorkerShield |
| 3 | `T2M_MIN` | Daily minimum air temperature at 2 metres | °C | WorkerShield |
| 4 | `T2MDEW` | Dew/frost-point temperature at 2 metres | °C | General |
| 5 | `T2MWET` | Wet bulb temperature at 2 metres (WBGT / Heat Stress) | °C | WorkerShield |
| 6 | `RH2M` | Relative humidity at 2 metres | % | WorkerShield |
| 7 | `QV2M` | Specific humidity at 2 metres | g/kg | General |
| 8 | `PRECTOTCORR` | Corrected total precipitation | mm/day | General |
| 9 | `PS` | Surface pressure (atmospheric stagnation & inversions) | kPa | HazeOps |
| 10 | `WS10M` | Wind speed at 10 metres | m/s | HazeOps |
| 11 | `WD10M` | Wind direction at 10 metres | degrees | HazeOps |
| 12 | `WS10M_MAX` | Daily maximum wind speed at 10 metres | m/s | HazeOps |
| 13 | `WS2M` | Wind speed at 2 metres (pedestrian/crew level cooling) | m/s | WorkerShield |
| 14 | `WS50M` | Wind speed at 50 metres (boundary-layer plume transport) | m/s | HazeOps |
| 15 | `WD50M` | Wind direction at 50 metres (plume trajectory) | degrees | HazeOps |
| 16 | `GWETTOP` | Top-layer soil wetness | fraction (0–1) | PeatFire Sentinel |
| 17 | `GWETROOT` | Root-zone soil wetness | fraction (0–1) | PeatFire Sentinel |
| 18 | `GWETPROF` | Soil wetness through the soil profile | fraction (0–1) | PeatFire Sentinel |
| 19 | `EVLAND` | Land evaporation (soil & vegetation drought desiccation) | mm/day | PeatFire Sentinel |
| 20 | `TS` | Earth skin temperature (ground/peat surface heating) | °C | PeatFire Sentinel |

## Integration Topology in Zetaris

- **345 Endpoints**: NASA POWER daily point API queries a single latitude/longitude per call. Zetaris registers 345 individual REST tables (`power_{safe_id}_raw`) under database `NASA_POWER` and container `power`.
- **Unified View**: Combined via `UNION ALL` into `power.power_daily`, linking each point to its canonical `location_index`.
- **Semantic Entity**: Activated as USL entity `power_daily` in `lightning.metastore.malaysia_env_usl`.
