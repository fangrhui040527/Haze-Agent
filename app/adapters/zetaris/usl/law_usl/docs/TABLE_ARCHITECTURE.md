# Malaysia Law USL: Table Architecture & Raw Topology

This document explains the raw table topology underpinning `malaysia_law_usl` — how static law JSON files are flattened into CSVs, registered in Zetaris as FileStore tables, and virtualized as two clean semantic entities.

---

## 1. Raw Table Topology Matrix

| Data Source | Raw Tables | Table Pattern | Storage Type | Why |
| :--- | :---: | :--- | :--- | :--- |
| **Malaysia Law JSON Files** | **2** | `law_documents_ref`, `law_pages_ref` | FileStore CSV | Static reference data. 4 JSON files flattened into 2 CSVs (documents + pages) and read directly from disk. |

> **Summary:**
> * **2 Physical Raw FileStore Tables** → Virtualized into **2 clean semantic USL entities** in `lightning.metastore.malaysia_law.malaysia_law_usl`.
> * No REST tables. No UNION ALL views. All data is static, file-based, and schema-defined at compile time.

---

## 2. Pipeline Architecture

```
4 × Law JSON files (PUA460, Act127, Act341, A1712)
        |
        v
flatten_law_json.ts
        |
   ┌────┴────┐
   |         |
   v         v
law_documents.csv   law_pages.csv
(4 rows)            (130 rows)
   |                    |
   └────────┬───────────┘
            v
  docker cp → /home/zetaris/customer-data/shared/law/
            |
            v
     law_register.sql
  ┌──────────────────────────────────┐
  │ CREATE LIGHTNING DATABASE        │
  │   LAW_REF_DATA                   │
  │ CREATE LIGHTNING FILESTORE TABLE │
  │   law_documents_ref              │
  │ CREATE LIGHTNING FILESTORE TABLE │
  │   law_pages_ref                  │
  └──────────────────────────────────┘
            |
            v
     usl_schema.sql
  ┌──────────────────────────────────┐
  │ COMPILE USL malaysia_law_usl     │
  │   TABLE law_documents (PK)       │
  │   TABLE law_pages (PK + FK)      │
  └──────────────────────────────────┘
            |
            v
     law_activate.sql
  ┌──────────────────────────────────────────────────────────┐
  │ ACTIVATE USL TABLE ...malaysia_law_usl.law_documents     │
  │   AS SELECT CAST(...) FROM LAW_REF_DATA.law_documents_ref│
  │ ACTIVATE USL TABLE ...malaysia_law_usl.law_pages         │
  │   AS SELECT CAST(...) FROM LAW_REF_DATA.law_pages_ref    │
  └──────────────────────────────────────────────────────────┘
            |
            v
  lightning.metastore.malaysia_law.malaysia_law_usl
    ├── law_documents  (4 rows)
    └── law_pages      (130 rows)
```

---

## 3. Comparison: Law USL vs Environmental USL Table Topology

| Attribute | Law USL (`malaysia_law_usl`) | Environmental USL (`malaysia_env_usl`) |
| :--- | :--- | :--- |
| **Source Type** | Static JSON → CSV FileStore | Mix of REST APIs + FileStore CSVs |
| **Raw Tables** | 2 FileStore tables | 694 (690 REST + 4 FileStore) |
| **UNION ALL Views** | None | 2 views (345 Open-Meteo + 345 NASA POWER) |
| **Semantic Entities** | 2 (`law_documents`, `law_pages`) | 6 (location_dim, location_code, weather_forecast, air_quality_obs, active_fires, power_daily) |
| **Live / Static** | Static (re-bootstrap required for updates) | Mixed (REST = live, FileStore = static) |
| **Temporal Nature** | Point-in-time legislative snapshot | Rolling time window (forecast + historical) |

---

## 4. Architecture Benefits

1. **Zero ETL Complexity:** No live REST endpoints. Law data is entirely static and read directly from FileStore CSV at query time.
2. **Reproducible Snapshots:** SHA-256 checksums in `law_documents` enable verification of source document integrity.
3. **Provenance Tracking:** `is_provenance_page` column in `law_pages` allows agents to distinguish cover/title pages from substantive legal content.
4. **Extensibility:** Adding new acts requires only dropping a new JSON file in `sources/law/`, re-running `flatten_law_json.ts`, and re-running `--law-only` bootstrap.
