# Malaysia Environmental USL: Table Architecture & Raw Topology

This document explains why certain data sources require 345 individual REST tables in Zetaris while others require only 1, and how the virtualization layer combines them into 8 clean semantic tables.

---

## 1. Raw Table Topology Matrix

| Data Source | Raw Tables | Table Pattern | Why / Technical Reason |
| :--- | :---: | :--- | :--- |
| **Open-Meteo Air Quality** | **345** | `aq_<loc>_raw` | **Point-based coordinate API** (`?latitude=X&longitude=Y`). Requires a separate endpoint per coordinate; combined into 1 view via `UNION ALL`. |
| **NASA POWER Climate** | **345** | `power_<loc>_raw` | **Point-based coordinate API** (`?latitude=X&longitude=Y`). Requires a separate endpoint per coordinate; combined into 1 view via `UNION ALL`. |
| **Data.gov.my Weather** | **1** | `forecasts_raw` | **Nationwide bulk API**. Single API response returns forecasts for all 440 Malaysian locations in one JSON array. |
| **NASA FIRMS Fires** | **1** | `active_fires` | **Bulk Bounding Box CSV**. Downloads nationwide satellite fire hotspots directly into a single CSV on disk. |
| **Windy Point Forecast** | **2** | `windy_gfs_raw`, `windy_cams_raw` | **FileStore CSV snapshot**. `fetch_windy.ts` writes one CSV per model (GFS weather, CAMS air quality) for a single point and registers them as FileStore tables. |
| **Location Dimension** | **2** | `location_dim`, `location_code` | **Canonical Reference Files**. Read directly from local static CSV reference datasets in FileStore. |

> **Summary:**
> * **Point-based coordinate APIs** (Open-Meteo & NASA POWER) 👉 **345 tables each** (690 total raw REST tables).
> * **Nationwide / bulk APIs** (Data.gov.my & NASA FIRMS) 👉 **1 table each**.
> * **Windy Point Forecast** 👉 **2 FileStore CSV tables** (one per model, single point).
> * **Total**: **696 Physical Raw Tables** (690 REST + 6 FileStore) → Virtualized into **8 clean semantic layer entities** in `lightning.metastore.malaysia_env_usl`.

---

## 2. How the 345-Table `UNION ALL` Works

Instead of exposing 345 individual tables to end-users or querying them one by one, Zetaris compiles them into a single virtual view:

```sql
-- Zetaris compiles all 345 location endpoints into a single virtual view
CREATE SCHEMASTORE VIEW hourly_observations WITH CONTAINER air_quality AS
SELECT 'Kangar' AS location_name, 6.4414 AS lat, ... FROM aq_kangar_raw
UNION ALL
SELECT 'Arau'   AS location_name, 6.4297 AS lat, ... FROM aq_arau_raw
UNION ALL
-- ... (all 345 location tables) ...
UNION ALL
SELECT 'Tawau'  AS location_name, 4.2447 AS lat, ... FROM aq_tawau_raw;
```

### Core Architecture Benefits:
1. **Zero-ETL Virtualization:** Data remains at the external REST API endpoints until runtime. No heavy database ingestion or data duplication is needed for live forecast queries.
2. **Predicate Pushdown:** When a user executes `WHERE location_name = 'Kuala Lumpur'`, Zetaris pushes the predicate down to call **only** Kuala Lumpur's REST endpoint, bypassing the other 344 network calls.
