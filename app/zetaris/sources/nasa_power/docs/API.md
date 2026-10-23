# NASA POWER Daily Climate API

## Endpoint

NASA POWER (Prediction Of Worldwide Energy Resources) provides point-based daily agrometeorological and climate parameters via HTTP GET:

```text
https://power.larc.nasa.gov/api/temporal/daily/point?parameters=WS10M,WD10M,RH2M,QV2M,GWETTOP,GWETROOT,PRECTOTCORR,T2M,T2M_MAX,T2M_MIN,T2MDEW,WS10M_MAX,GWETPROF,WS2M,T2MWET,PS,WS50M,WD50M,TS,EVLAND&community=AG&longitude={lon}&latitude={lat}&start={day}&end={day}&format=JSON
```

## Runnable Real-World Example (Kuala Lumpur)

Using the canonical coordinates for **WP Kuala Lumpur** (`latitude=3.14`, `longitude=101.69`, `location_index=9`) targeting date `20261018` (due to MERRA-2 assimilation lag of `today - 4 days`):

### Direct URL (Click or paste in browser)
```text
https://power.larc.nasa.gov/api/temporal/daily/point?parameters=WS10M,WD10M,RH2M,QV2M,GWETTOP,GWETROOT,PRECTOTCORR,T2M,T2M_MAX,T2M_MIN,T2MDEW,WS10M_MAX,GWETPROF,WS2M,T2MWET,PS,WS50M,WD50M,TS,EVLAND&community=AG&longitude=101.69&latitude=3.14&start=20261018&end=20261018&format=JSON
```

### cURL
```bash
curl -s "https://power.larc.nasa.gov/api/temporal/daily/point?parameters=WS10M,WD10M,RH2M,QV2M,GWETTOP,GWETROOT,PRECTOTCORR,T2M,T2M_MAX,T2M_MIN,T2MDEW,WS10M_MAX,GWETPROF,WS2M,T2MWET,PS,WS50M,WD50M,TS,EVLAND&community=AG&longitude=101.69&latitude=3.14&start=20261018&end=20261018&format=JSON"
```

### Sample Response (Real API Output)
```json
{
  "type": "Feature",
  "geometry": {
    "type": "Point",
    "coordinates": [101.69, 3.14, 231.94]
  },
  "properties": {
    "parameter": {
      "WS10M": { "20261018": 0.79 },
      "WD10M": { "20261018": 154.7 },
      "RH2M": { "20261018": 85.74 },
      "QV2M": { "20261018": 18.84 },
      "GWETTOP": { "20261018": 0.81 },
      "GWETROOT": { "20261018": 0.82 },
      "PRECTOTCORR": { "20261018": 42.24 },
      "T2M": { "20261018": 26.58 },
      "T2M_MAX": { "20261018": 30.22 },
      "T2M_MIN": { "20261018": 23.83 },
      "T2MDEW": { "20261018": 23.9 },
      "WS10M_MAX": { "20261018": 1.3 },
      "GWETPROF": { "20261018": 0.86 },
      "WS2M": { "20261018": 0.54 },
      "T2MWET": { "20261018": 25.24 },
      "PS": { "20261018": 99.05 },
      "WS50M": { "20261018": 1.17 },
      "WD50M": { "20261018": 157.1 },
      "TS": { "20261018": 26.26 },
      "EVLAND": { "20261018": 96.72 }
    }
  },
  "header": {
    "title": "NASA/POWER Source Native Resolution Daily Data",
    "api": { "version": "v2.10.1", "name": "POWER Daily API" },
    "sources": ["GEOSIT", "POWER"],
    "fill_value": -999.0,
    "time_standard": "LST",
    "start": "20261018",
    "end": "20261018"
  }
}
```

## Parameters

| Parameter | Value | Purpose |
| :--- | :--- | :--- |
| `parameters` | 20 comma-separated variables (see below) | Climatology, heat stress, wind transport, and soil hydrology |
| `community` | `AG` | Agroclimatology user community |
| `latitude` | Decimal degrees (WGS84, e.g. `3.14`) | Location centroid latitude |
| `longitude` | Decimal degrees (WGS84, e.g. `101.69`) | Location centroid longitude |
| `start` / `end` | `YYYYMMDD` (e.g. `20261018`) | Rolling date target (default: T-4 days for completed MERRA-2 assimilation) |
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
