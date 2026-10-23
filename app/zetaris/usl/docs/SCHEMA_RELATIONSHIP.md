# Malaysia Environmental USL: Schema & Foreign Keys

Federated environmental intelligence layer deployed in Zetaris (`malaysia_env_usl`), unifying four live environmental data sources under a normalized **Location Dimension Model** across 345 canonical Malaysian locations.

---

## 1. Entity-Relationship Diagram (ERD)

```mermaid
erDiagram
    LOCATION_DIM ||--o{ LOCATION_CODE : "1-to-Many (location_index)"
    LOCATION_DIM ||--o{ AIR_QUALITY_OBS : "FK: location_index"
    LOCATION_DIM ||--o{ ACTIVE_FIRES : "FK: location_index"
    LOCATION_DIM ||--o{ POWER_DAILY : "FK: location_index"
    LOCATION_CODE ||--o{ WEATHER_FORECAST : "FK: location_code"

    LOCATION_DIM {
        int location_index PK "1 - 345"
        varchar location_id "e.g. kuala-lumpur"
        varchar location_name "e.g. Kuala Lumpur"
        double latitude
        double longitude
    }

    LOCATION_CODE {
        varchar location_code PK "St, Ds, Tn, Rc, Dv prefixes (440 total)"
        int location_index FK "References location_dim(location_index)"
        varchar code_type "State / District / Town / Recreation / Division"
        varchar code_name "e.g. Perlis, Langkawi"
    }

    WEATHER_FORECAST {
        varchar location_code FK "References location_code(location_code)"
        date forecast_date
        varchar location_name
        varchar morning_forecast
        varchar afternoon_forecast
        varchar night_forecast
    }

    AIR_QUALITY_OBS {
        int location_index FK "References location_dim(location_index)"
        timestamp observation_time
        double pm2_5_ug_m3
        double pm10_ug_m3
    }

    ACTIVE_FIRES {
        int location_index FK "References location_dim(location_index)"
        timestamp acq_utc
        timestamp acq_myt
        double fire_latitude
        double fire_longitude
        double bright_ti4
        double frp
        varchar confidence
        satellite varchar
        instrument varchar
        fire_source varchar
        varchar daynight
    }

    POWER_DAILY {
        int location_index FK "References location_dim(location_index)"
        date observation_date
        double T2M "Temp at 2M (°C)"
        double T2M_MAX "Max Temp at 2M (°C)"
        double T2M_MIN "Min Temp at 2M (°C)"
        double T2MDEW "Dew Point at 2M (°C)"
        double T2MWET "Wet Bulb Temp at 2M (°C)"
        double TS "Earth Skin Temp (°C)"
        double RH2M "Relative Humidity at 2M (%)"
        double QV2M "Specific Humidity at 2M (g/kg)"
        double PRECTOTCORR "Precipitation Corrected (mm/day)"
        double PS "Surface Pressure (kPa)"
        double WS2M "Wind Speed at 2M (m/s)"
        double WS10M "Wind Speed at 10M (m/s)"
        double WS10M_MAX "Max Wind Speed at 10M (m/s)"
        double WD10M "Wind Direction at 10M (deg)"
        double WS50M "Wind Speed at 50M (m/s)"
        double WD50M "Wind Direction at 50M (deg)"
        double GWETTOP "Surface Soil Wetness (0-1)"
        double GWETROOT "Root Zone Soil Wetness (0-1)"
        double GWETPROF "Profile Soil Moisture (0-1)"
        double EVLAND "Evaporation Land (MJ/m2/day)"
    }
```

---

## 2. Semantic Entities & Foreign Key Reference

| Table Name | Primary Key | Foreign Key / Target | Total Attributes | Purpose |
| :--- | :--- | :--- | :---: | :--- |
| **`location_dim`** | `location_index` (int) | — | 5 | 345 canonical centroid locations with lat/long coordinates |
| **`location_code`** | `location_code` (varchar) | `location_index` → `location_dim(location_index)` | 4 | 440 administrative forecast codes mapped to centroids |
| **`weather_forecast`** | *(composite on query)* | `location_code` → `location_code(location_code)` | 6 | Daily 7-day weather forecasts from Data.gov.my |
| **`air_quality_obs`** | *(composite on query)* | `location_index` → `location_dim(location_index)` | 4 | 120-hour hourly PM2.5 & PM10 from Open-Meteo |
| **`active_fires`** | *(composite on query)* | `location_index` → `location_dim(location_index)` | 12 | NASA FIRMS VIIRS satellite thermal hotspots |
| **`power_daily`** | *(composite on query)* | `location_index` → `location_dim(location_index)` | **22** (2 meta + **20 parameters**) | NASA POWER daily solar & climate variables |

---

## 3. NASA POWER 20 Parameters Specification

`power_daily` maps all 20 NASA POWER meteorological and surface parameters:

| Category | Parameter | Full Name | Unit |
| :--- | :--- | :--- | :--- |
| **Temperature** | `T2M` | Temperature at 2 Meters | °C |
| | `T2M_MAX` | Maximum Temperature at 2 Meters | °C |
| | `T2M_MIN` | Minimum Temperature at 2 Meters | °C |
| | `T2MDEW` | Dew/Frost Point at 2 Meters | °C |
| | `T2MWET` | Wet Bulb Temperature at 2 Meters | °C |
| | `TS` | Earth Skin Temperature | °C |
| **Wind** | `WS2M` | Wind Speed at 2 Meters | m/s |
| | `WS10M` | Wind Speed at 10 Meters | m/s |
| | `WS10M_MAX` | Maximum Wind Speed at 10 Meters | m/s |
| | `WD10M` | Wind Direction at 10 Meters | Degrees |
| | `WS50M` | Wind Speed at 50 Meters | m/s |
| | `WD50M` | Wind Direction at 50 Meters | Degrees |
| **Humidity & Moisture** | `RH2M` | Relative Humidity at 2 Meters | % |
| | `QV2M` | Specific Humidity at 2 Meters | g/kg |
| | `GWETTOP` | Surface Soil Wetness | 0 – 1 |
| | `GWETROOT` | Root Zone Soil Wetness | 0 – 1 |
| | `GWETPROF` | Profile Soil Moisture | 0 – 1 |
| **Precipitation & Land**| `PRECTOTCORR`| Precipitation Corrected | mm/day |
| | `EVLAND` | Evaporation Land | MJ/m²/day |
| **Pressure** | `PS` | Surface Pressure | kPa |
