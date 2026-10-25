# Malaysia Law USL: Operations & Queries

Operational execution guide and SQL queries for the Zetaris Unified Semantic Layer (`malaysia_law_usl`).

---

## 1. Operational Playbook

### Cold Start / Day-0 Bootstrap
When setting up a fresh environment with no existing Law USL tables:

```bash
# Bootstrap ONLY the Law USL (malaysia_law_usl)
node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --law-only
npx tsx app/zetaris/usl/bootstrap_usl.ts --law-only

# Bootstrap BOTH Environmental USL + Law USL (default — no flag needed)
node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts
npx tsx app/zetaris/usl/bootstrap_usl.ts

# Preview execution steps without applying changes
node --experimental-strip-types app/zetaris/usl/bootstrap_usl.ts --law-only --dry-run
```

### What `--law-only` Does (Step by Step)

| Step | Action | Script / SQL |
| :--: | :--- | :--- |
| **1** | Flatten 4 law JSON files → `law_documents.csv` (4 rows) + `law_pages.csv` (130 rows) | `flatten_law_json.ts` |
| **2** | Copy `data/` directory into Docker container at `/home/zetaris/customer-data/shared/law/` | `docker cp` |
| **3** | Register `LAW_REF_DATA` FileStore database and 2 CSV tables in Zetaris | `law_register.sql` |
| **4** | Compile USL schema — `malaysia_law_usl` namespace & entity DDL | `usl_schema.sql` |
| **5** | Activate `law_documents` and `law_pages` as queryable USL entities | `law_activate.sql` |

---

### Re-Bootstrap After JSON Source Update
If the source law JSON files are updated (e.g. new act versions added):

```bash
# Re-flatten the JSON sources into CSVs
npx tsx app/zetaris/sources/law/flatten_law_json.ts

# Then re-run the Law bootstrap to re-register and re-activate
npx tsx app/zetaris/usl/bootstrap_usl.ts --law-only
```

---

## 2. Query Reference

### List All Registered Legal Documents
```sql
SELECT
    document_id,
    instrument,
    instrument_code,
    law_as_at,
    pages_final,
    extracted_at
FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents
ORDER BY document_id;
```

### Browse All Pages for a Specific Act
```sql
SELECT
    doc.document_id,
    doc.instrument,
    doc.instrument_code,
    doc.law_as_at,
    doc.pages_final,
    p.page_number,
    p.is_provenance_page,
    p.page_text
FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc
JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p
  ON doc.document_id = p.document_id
WHERE doc.instrument_code = 'P.U.(A) 460/2003'
ORDER BY p.page_number;
```

### Browse Pages for Multiple Acts
```sql
SELECT
    doc.instrument_code,
    p.page_number,
    p.is_provenance_page,
    p.page_text
FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc
JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p
  ON doc.document_id = p.document_id
WHERE doc.instrument_code IN ('P.U.(A) 460/2003', 'Act 127')
ORDER BY doc.instrument_code, p.page_number;
```

### Full-Text Search Across All Pages
```sql
SELECT
    doc.instrument_code,
    p.page_number,
    p.page_text
FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc
JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p
  ON doc.document_id = p.document_id
WHERE LOWER(p.page_text) LIKE '%open burning%'
ORDER BY doc.instrument_code, p.page_number;
```

### Page Count & Coverage Summary
```sql
SELECT
    doc.instrument_code,
    doc.instrument,
    doc.law_as_at,
    doc.pages_final,
    COUNT(p.page_number)                                     AS indexed_pages,
    SUM(CASE WHEN p.is_provenance_page THEN 1 ELSE 0 END)   AS provenance_pages
FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc
LEFT JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p
  ON doc.document_id = p.document_id
GROUP BY doc.instrument_code, doc.instrument, doc.law_as_at, doc.pages_final
ORDER BY doc.instrument_code;
```

---

## 3. Using `run_sql.py` Directly
```bash
python app/zetaris/scripts/run_sql.py --limit 10 -e "
SELECT
    doc.instrument_code,
    p.page_number,
    p.page_text
FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc
JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p
  ON doc.document_id = p.document_id
WHERE doc.instrument_code = 'Act 127'
ORDER BY p.page_number;
"
```
