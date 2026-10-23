# Malaysia Environmental USL: Data Coverage & Temporal Range

> **Reference Date:** `2026-10-22` (MYT).  
> All date ranges shift dynamically relative to the pipeline execution date.

---

## 1. Temporal Coverage Summary

| Source | Code Config | Output Date Range (run: 2026-10-22) | Rows / Location | Tense | Needs Daily Update? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 🌤️ **Weather** | No date → API default | `2026-10-22` → `2026-10-28` | ~7 daily | Today + Forecast | ❌ Live on query |
| 🌫️ **Air Quality** | No date → API default | `2026-10-22T00:00` → `2026-10-26T23:00` | 120 hourly | Today + Forecast | ❌ Live on query |
| 🔥 **FIRMS** | `--day-range 5` via `bootstrap_usl.ts` | `2026-10-17` → `2026-10-21` | Varies (fires only) | Historical | ✅ Daily |
| 🛰️ **NASA POWER** | `today − 4 days`, single day | `2026-10-18` only | 1 daily | Historical | ✅ Daily |

---

## 2. Visual Calendar Timeline

```
        Oct 17  Oct 18  Oct 19  Oct 20  Oct 21  Oct 22  Oct 23  Oct 24  Oct 25  Oct 26  Oct 27  Oct 28
           |       |       |       |       |       |       |       |       |       |       |       |
FIRMS    [===========================================]
          <- last 5 days ----------------------->|
NASA PWR         [=]
                  ^ today-4 only (1 row, pub. lag)
Air Qual                                         [================================================]
                                                  ^ today T00:00                          ^ +5 days
Weather                                          [==============================================]
                                                  ^ today                                 ^ today+6
         PAST <----------------------------------------- TODAY ------------------------------> FUTURE
```

---

## 3. Daily Updates vs. Live Virtualization

### Why Weather & Air Quality Need NO Daily Updates
Both sources use live **REST tables** in Zetaris. Every `SELECT` query triggers an HTTP call to the external upstream API at runtime:
* **Open-Meteo**: Returns a rolling window from today midnight forward 5 days.
* **Data.gov.my**: Updated twice daily by MET Malaysia; always serves the current 7-day outlook.
* No data synchronization or cron job is needed for these two sources.

### Why FIRMS & NASA POWER DO Need Daily Updates
* **NASA FIRMS (FileStore CSV):** Satellites output raw unmapped coordinates. Python must run nearest-neighbor spatial matching against all 345 centroids to assign `location_index` and copy the resulting CSV into `/home/zetaris/customer-data/shared/firms_flat/`.
* **NASA POWER (Date-Keyed JSON):** Upstream NASA returns parameter objects where the keys are literal date strings (e.g. `properties.parameter.T2M."20261018"`). As the calendar advances, the view definition must be recompiled to target the new date key (`today − 4 days`).

---

## 4. Example Outputs per Source

### 🌫️ Air Quality (Kuala Lumpur — Live Open-Meteo API)
```
observation_time          | pm2_5_ug_m3 | pm10_ug_m3 | note
--------------------------+-------------+------------+-------------------
2026-10-22T00:00+08:00    |   29.1      |   29.2     | Past (midnight)
2026-10-22T14:00+08:00    |   61.2      |   62.2     | Current hour
2026-10-22T20:00+08:00    |  103.6      |  103.8     | Tonight (forecast)
2026-10-26T16:00+08:00    |   56.7      |   56.7     | Last valid row
2026-10-26T17:00+08:00    |   null      |   null     | Beyond model boundary
```

### 🌤️ Weather Forecast (Langkawi — Live MET Malaysia API)
```
location  | date        | morning_forecast           | afternoon_forecast          | night_forecast
----------+-------------+----------------------------+-----------------------------+-------------------
Langkawi  | 2026-10-22  | Ribut petir di beberapa    | Ribut petir di beberapa     | Tiada Hujan
Langkawi  | 2026-10-25  | Ribut petir kebanyakan     | Ribut petir kebanyakan      | Tiada Hujan
Langkawi  | 2026-10-28  | Ribut petir di beberapa    | Ribut petir di beberapa     | Tiada Hujan
```

### 🛰️ NASA POWER (Kuala Lumpur — 2026-10-18)
```
date        | T2M (°C) | PRECTOTCORR (mm/day) | RH2M (%) | WS10M (m/s)
------------+----------+---------------------+----------+------------
2026-10-18  |  26.58   |       42.24         |  85.74   |    1.82
```

### 🔥 NASA FIRMS (East Malaysia — Real Satellite Hotspots 2026-10-21)
```
acq_date   | acq_myt (MYT)        | region        | satellite | confidence | frp (MW)
-----------+----------------------+---------------+-----------+------------+---------
2026-10-21 | 2026-10-21 13:48 MYT | Bario         | N20       | nominal    |  12.73
2026-10-21 | 2026-10-21 13:48 MYT | Pulau Sipadan | N20       | nominal    |  10.03
```
> *Note on FIRMS:* FIRMS is event-based. Locations with no active fire detections return 0 rows.
