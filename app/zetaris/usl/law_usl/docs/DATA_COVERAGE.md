# Malaysia Law USL: Data Coverage & Corpus

> **Corpus Snapshot:** Extracted from official Attorney General's Chambers (AGC) PDF publications.
> Data is static — coverage reflects the point-in-time extraction, not a live feed.

---

## 1. Corpus Summary

| Document ID | Instrument Code | Instrument Title | Pages (PDF) | Pages (Indexed) | Law As At |
| :--- | :--- | :--- | :---: | :---: | :--- |
| `PUA460` | `P.U.(A) 460/2003` | Environmental Quality (Open Burning) Order 2003 | — | — | Per AGC publication |
| `Act127` | `Act 127` | Environmental Quality Act 1974 | — | — | Per AGC publication |
| `Act341` | `Act 341` | Forestry Conservation Act | — | — | Per AGC publication |
| `A1712` | `A1712` | Amendment to Environmental Quality Act | — | — | Per AGC publication |

> **Total Corpus:** 4 legal instruments, 130 full-text pages indexed in `law_pages`.

---

## 2. Data Nature: Static vs. Live

| Attribute | Law USL | Environmental USL (for comparison) |
| :--- | :--- | :--- |
| **Update Frequency** | On demand (re-bootstrap) | Live REST (Weather, AQ) / Daily (FIRMS, POWER) |
| **Temporal Coverage** | Legislative snapshot (point-in-time) | Rolling window (today ± N days) |
| **Needs Daily Cron?** | ❌ No | ✅ Yes (for FIRMS & NASA POWER) |
| **Source Format** | JSON → CSV FileStore | REST API / CSV satellite download |

---

## 3. `law_pages` Row Distribution

All 130 indexed pages are distributed across the 4 documents. The `is_provenance_page` flag distinguishes cover/title/gazette header pages from substantive legal text.

```
law_documents (4 rows)
    ├── PUA460  →  N pages in law_pages
    ├── Act127  →  N pages in law_pages
    ├── Act341  →  N pages in law_pages
    └── A1712   →  N pages in law_pages
                   ─────────────────────
                   Total: 130 pages
```

To inspect the exact distribution:
```sql
SELECT
    doc.instrument_code,
    COUNT(p.page_number)                                     AS total_pages,
    SUM(CASE WHEN p.is_provenance_page THEN 1 ELSE 0 END)   AS provenance_pages,
    SUM(CASE WHEN NOT p.is_provenance_page THEN 1 ELSE 0 END) AS content_pages
FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc
JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p
  ON doc.document_id = p.document_id
GROUP BY doc.instrument_code
ORDER BY doc.instrument_code;
```

---

## 4. Source Integrity

Each document in `law_documents` carries:
- **`source_url`**: The canonical AGC URL the PDF was sourced from.
- **`source_pdf_sha256`**: SHA-256 checksum of the original PDF download, enabling agents to verify document integrity against a known baseline.
- **`extracted_at`**: ISO 8601 timestamp recording when the extraction was performed.

---

## 5. Extending the Corpus

To add a new legal instrument:

1. Download the PDF from [agc.gov.my](https://agc.gov.my) and extract text into a JSON file following the existing schema.
2. Place the JSON in `app/zetaris/sources/law/` and register it in `flatten_law_json.ts`.
3. Re-run the Law bootstrap:
   ```bash
   npx tsx app/zetaris/usl/bootstrap_usl.ts --law-only
   ```
