# Agent Guide & System Prompt: Malaysia Environmental USL

This document is the authoritative guide for AI coding agents, autonomous LLM pipelines, and external application developers integrating with the **Malaysia Environmental Unified Semantic Layer (`malaysia_env_usl`)** in Zetaris.

---

## 1. Executive Summary for Agents

The `app/zetaris/usl` directory contains the complete source code, dimensional data, and SQL DDL definitions for a **federated environmental intelligence layer**.

* **Namespace in Zetaris:** `lightning.metastore.malaysia_env.malaysia_env_usl`
* **Coverage:** 345 canonical Malaysian locations (state capitals, districts, towns, rural centers) across Peninsular and East Malaysia.
* **Core Value:** Unifies 4 disparate upstream environmental APIs (REST, JSON, bulk CSV) into a normalized dimensional star schema where all entities join seamlessly via `location_index` or `location_code`.

---

## 2. Source Directory Architecture (`app/zetaris/`)

When inspecting or extending this repository, agents should understand the specific role of each folder:

```
app/zetaris/
├── sources/
│   ├── location/              # 📍 Canonical Dimension Data & Bridge
│   │   ├── location.csv       # Canonical centroids (location_dim) - 345 locations
│   │   ├── location_codes.csv # Admin forecast codes (location_code) - 440 codes
│   │   ├── location.json      # Raw hierarchical Malaysian administrative JSON
│   │   ├── LOCATION.md        # Comprehensive location documentation table
│   │   └── sql/               # loc_register.sql, loc_activate.sql, loc_query.sql
│   ├── weather/               # 🌤️ Data.gov.my Official Weather
│   │   ├── fetch_weather.ts   # Ingestion script & REST registration
│   │   └── sql/               # weather_register.sql, weather_activate.sql
│   ├── air_quality/           # 🌫️ Open-Meteo Hourly Air Quality
│   │   ├── fetch_air_quality.ts # Generates 345 REST table DDLs & union view
│   │   └── sql/               # aq_register.sql, aq_activate.sql
│   ├── nasa_firms/            # 🔥 NASA VIIRS Active Fire Hotspots
│   │   ├── fetch_nasa_firms.ts# Downloads satellite CSV, computes spatial join
│   │   └── sql/               # firms_register.sql, firms_activate.sql
│   └── nasa_power/            # 🛰️ NASA POWER Daily Climate (20 variables)
│       ├── fetch_nasa_power.ts# Registers 345 coordinate endpoints & daily view
│       └── sql/               # power_register.sql, power_activate.sql
├── usl/
│   ├── bootstrap_usl.ts       # Day-0 end-to-end setup script (TypeScript)
│   ├── usl_schema.sql         # Master USL schema, dimension registration & FK graph
│   └── docs/                  # Technical documentation & architecture
└── scripts/
    └── run_sql.py             # CLI runner for executing Zetaris SQL via Python JDBC
```

---

## 3. What the Data Looks Like (Data Contract)

The semantic layer exposes **6 unified entities**. Agents querying or generating SQL for these tables should expect the following schemas:

### A. `location_dim` (Canonical Location Dimension)
* **Role:** Primary entity representing 345 geographic centroids across Malaysia.
* **Primary Key:** `location_index` (int, 1 to 345).
* **Sample Record:**
  ```json
  {
    "location_index": 1,
    "location_id": "perlis",
    "location_name": "Perlis",
    "latitude": 6.4414,
    "longitude": 100.19862
  }
  ```

### B. `location_code` (Administrative Forecast Bridge)
* **Role:** Maps official administrative forecast codes from MET Malaysia to canonical centroids.
* **Primary Key:** `location_code` (e.g., `St001`, `Ds001`, `Tn001`, `Rc001`, `Dv001`).
* **Foreign Key:** `location_index` → `location_dim(location_index)`.
* **Sample Record:**
  ```json
  {
    "location_code": "Ds001",
    "location_index": 3,
    "code_type": "District",
    "code_name": "Langkawi"
  }
  ```

### C. `weather_forecast` (Data.gov.my Official Weather)
* **Role:** Daily 7-day weather outlook from Malaysian Meteorological Department (MET Malaysia).
* **Foreign Key:** `location_code` → `location_code(location_code)`.
* **Tense:** Today through +6 days (Forecast).
* **Sample Record:**
  ```json
  {
    "location_code": "Ds001",
    "forecast_date": "2026-10-22",
    "location_name": "Langkawi",
    "morning_forecast": "Ribut petir di beberapa tempat di kawasan pantai",
    "afternoon_forecast": "Tiada Hujan",
    "night_forecast": "Tiada Hujan"
  }
  ```
  *(Note: Forecast descriptions are provided in official Bahasa Malaysia).*

### D. `air_quality_obs` (Open-Meteo Hourly Particulates)
* **Role:** 120 hourly readings (past today + 4-day forecast) of fine particulate matter.
* **Foreign Key:** `location_index` → `location_dim(location_index)`.
* **Tense:** Past 24h + 4-day hourly forecast.
* **Sample Record:**
  ```json
  {
    "location_index": 14,
    "observation_time": "2026-10-22T14:00:00+08:00",
    "pm2_5_ug_m3": 61.2,
    "pm10_ug_m3": 62.2
  }
  ```

### E. `active_fires` (NASA FIRMS VIIRS Thermal Hotspots)
* **Role:** Satellite active fire detections over the past 5 days with spatial matching to nearest Malaysian town.
* **Foreign Key:** `location_index` → `location_dim(location_index)`.
* **Tense:** Historical past 5 days.
* **Sample Record:**
  ```json
  {
    "location_index": 218,
    "acq_utc": "2026-10-21T05:48:00Z",
    "acq_myt": "2026-10-21T13:48:00+08:00",
    "fire_latitude": 3.7481,
    "fire_longitude": 115.4211,
    "bright_ti4": 342.5,
    "frp": 12.73,
    "confidence": "n",
    "satellite": "N20",
    "instrument": "VIIRS",
    "fire_source": "VIIRS_NOAA20_NRT",
    "daynight": "D"
  }
  ```
  *(Note: Sparsely populated. If no fires exist near a location, this table returns 0 rows for that location).*

### F. `power_daily` (NASA POWER 20 Daily Climate Variables)
* **Role:** Daily meteorological and solar radiation metrics.
* **Foreign Key:** `location_index` → `location_dim(location_index)`.
* **Tense:** Historical single day (`today - 4 days` due to NASA publication lag).
* **Sample Record (Complete 22 keys: 2 metadata + all 20 climate parameters):**
  ```json
  {
    "location_index": 14,
    "observation_date": "2026-10-18",
    "T2M": 26.58,
    "T2M_MAX": 32.10,
    "T2M_MIN": 23.40,
    "T2MDEW": 23.85,
    "T2MWET": 24.81,
    "TS": 27.12,
    "RH2M": 85.74,
    "QV2M": 18.62,
    "PRECTOTCORR": 42.24,
    "PS": 100.82,
    "WS2M": 1.25,
    "WS10M": 1.82,
    "WS10M_MAX": 3.95,
    "WD10M": 142.30,
    "WS50M": 2.94,
    "WD50M": 148.50,
    "GWETTOP": 0.81,
    "GWETROOT": 0.78,
    "GWETPROF": 0.75,
    "EVLAND": 3.65
  }
  ```

---

## 4. How External Systems & Agents Query This Data

### Method 1: Using the Repository's Python CLI (`run_sql.py`)
From your backend terminal, worker, or subprocess:
```bash
python app/zetaris/scripts/run_sql.py --limit 100 -e "
SELECT 
    loc.location_name,
    aq.observation_time,
    aq.pm2_5_ug_m3,
    w.morning_forecast
FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc
JOIN lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq
  ON loc.location_index = aq.location_index
LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.location_code lc
  ON loc.location_index = lc.location_index
LEFT JOIN lightning.metastore.malaysia_env.malaysia_env_usl.weather_forecast w
  ON lc.location_code = w.location_code
WHERE loc.location_name = 'Kuala Lumpur'
LIMIT 5;
"
```

### Method 2: Direct HTTP POST to Zetaris REST API
External web services (FastAPI, Express, Next.js) can query Zetaris directly via HTTP:
* **Endpoint:** `POST {ZETARIS_REST_URL}/sql-editor/sqls/run`
* **Headers:**
  * `Authorization: Bearer {ZETARIS_API_KEY}`
  * `X-Org-ID: {ZETARIS_ORG_ID}`
  * `Content-Type: application/json`
* **Body:**
  ```json
  {
    "query": "SELECT loc.location_name, aq.pm2_5_ug_m3 FROM lightning.metastore.malaysia_env.malaysia_env_usl.location_dim loc JOIN lightning.metastore.malaysia_env.malaysia_env_usl.air_quality_obs aq ON loc.location_index = aq.location_index WHERE loc.location_name = 'George Town' LIMIT 5",
    "limit": 10
  }
  ```

---

## 5. Copy-Pasteable LLM Agent System Prompt

If you are deploying an AI Agent (e.g. LangChain, LlamaIndex, OpenAI Assistant, or Anthropic Tool-Use Agent) that interacts with users or answers environmental questions, **inject this exact system prompt**:

````markdown
You are the Malaysian Environmental Intelligence Assistant. You have real-time access to the Zetaris Unified Semantic Layer (`lightning.metastore.malaysia_env.malaysia_env_usl`), which unifies live environmental and meteorological data across 345 canonical locations in Malaysia.

### Available Tables & Keys:
1. `location_dim` (PK: location_index)
   - Columns: location_index, location_id, location_name, latitude, longitude
   - Always start joins here to identify Malaysian locations.
2. `location_code` (PK: location_code, FK: location_index -> location_dim)
   - Bridge mapping to administrative codes for MET Malaysia weather.
3. `weather_forecast` (FK: location_code -> location_code)
   - Columns: location_code, forecast_date, location_name, morning_forecast, afternoon_forecast, night_forecast
   - Coverage: Today through +6 days. Note: Forecast descriptions are in Bahasa Malaysia.
4. `air_quality_obs` (FK: location_index -> location_dim)
   - Columns: location_index, observation_time, pm2_5_ug_m3, pm10_ug_m3
   - Coverage: 120 hourly points (past 24h + 4-day forecast). WHO PM2.5 threshold is > 15 µg/m³ (unhealthy > 35 µg/m³, hazardous > 50 µg/m³).
5. `active_fires` (FK: location_index -> location_dim)
   - Columns: location_index, acq_utc, acq_myt, fire_latitude, fire_longitude, bright_ti4, frp, confidence, satellite, instrument, fire_source, daynight
   - Coverage: NASA VIIRS satellite thermal hotspots from the past 5 days. `frp` is Fire Radiative Power in MW. If no fires are present, 0 rows return.
6. `power_daily` (FK: location_index -> location_dim)
   - Columns: location_index, observation_date, T2M (temp °C), T2M_MAX, T2M_MIN, T2MDEW, T2MWET, TS, RH2M (humidity %), QV2M, PRECTOTCORR (rain mm/day), PS, WS2M, WS10M, WS10M_MAX, WD10M, WS50M, WD50M, GWETTOP, GWETROOT, GWETPROF, EVLAND
   - Coverage: Historical observations (lagged 4 days from today).

### SQL Generation Rules:
- Always use fully qualified names: `lightning.metastore.malaysia_env.malaysia_env_usl.<table_name>`.
- To query weather for a city, join through `location_code`:
  `FROM location_dim loc JOIN location_code lc ON loc.location_index = lc.location_index JOIN weather_forecast w ON lc.location_code = w.location_code`
- For performance, always filter by `loc.location_name` to enable Zetaris predicate pushdown.
- Provide user responses with clear contextual explanations (e.g. translate Bahasa Malaysia weather forecasts when conversing in English).
````

---

## 6. Critical Rules & Edge Cases for Agents

1. **Weather Joins Must Use `location_code`:**
   `location_dim` uses `location_index` (int), but `weather_forecast` references `location_code` (varchar, e.g. `Ds001`). You must join via `location_code` table.
2. **FIRMS Fire Sparsity:**
   `active_fires` is event-driven. If a query for a location returns no rows, explain to the user: *"No active satellite thermal anomalies or forest fires detected in this region in the last 5 days"*, rather than reporting a system error.
3. **Temporal Tenses:**
   When presenting multi-source results:
   * **Air Quality & Weather:** Represent current conditions and forward-looking forecasts.
   * **NASA POWER & FIRMS:** Represent historical observations. Clearly state the observation date to avoid temporal confusion.
4. **Bahasa Malaysia Meteorological Terms:**
   Common translations from Data.gov.my:
   * *Ribut petir di beberapa tempat* = Thunderstorms in several places
   * *Hujan di satu dua tempat* = Rain in one or two places
   * *Tiada hujan* = No rain / Clear weather
   * *Kawasan pantai / pedalaman* = Coastal / Inland areas
