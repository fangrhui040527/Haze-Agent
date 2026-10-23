# Agent Guide & System Prompt: Malaysia Law USL

This document is the authoritative guide for AI coding agents, autonomous LLM pipelines, and external application developers integrating with the **Malaysia Law Unified Semantic Layer (`malaysia_law_usl`)** in Zetaris.

---

## 1. Executive Summary for Agents

The `app/zetaris/usl/law_usl/` directory contains the SQL DDL and documentation for a **federated legal intelligence layer** over Malaysian environmental law.

* **Namespace in Zetaris:** `lightning.metastore.malaysia_law.malaysia_law_usl`
* **Coverage:** 4 Malaysian environmental legal instruments (acts, orders, amendments).
* **Core Value:** Exposes 130 full-text pages of legislative text as two queryable semantic tables, enabling agents to perform structured legal lookups, keyword searches, and document retrieval without any PDF parsing at runtime.

---

## 2. Source Directory Architecture (`app/zetaris/`)

When inspecting or extending this repository, agents should understand the role of each folder:

```
app/zetaris/
├── sources/
│   └── law/                        # 📜 Malaysia Environmental Law Corpus
│       ├── PUA460.json             # Environmental Quality (Open Burning) Order 2003
│       ├── Act127.json             # Environmental Quality Act 1974
│       ├── Act341.json             # Forestry Conservation Act
│       ├── A1712.json              # Amendment to Environmental Quality Act
│       ├── flatten_law_json.ts     # Flattens JSON → law_documents.csv + law_pages.csv
│       ├── manifest.json           # Source manifest for all registered law documents
│       ├── DISCLAIMER.md           # Legal usage disclaimer
│       ├── NOTICE.md               # Attribution notice
│       ├── README.md               # Law corpus overview
│       └── sql/
│           ├── law_register.sql    # Registers LAW_REF_DATA FileStore tables
│           ├── law_activate.sql    # Activates USL entities from FileStore
│           └── law_query.sql       # Verification & reference query
├── usl/
│   ├── bootstrap_usl.ts            # Day-0 end-to-end setup (--law-only flag)
│   └── law_usl/
│       ├── usl_schema.sql          # USL DDL: law_documents + law_pages entities
│       └── docs/                   # ← This documentation folder
└── scripts/
    └── run_sql.py                  # CLI runner for Zetaris SQL via Python JDBC
```

---

## 3. What the Data Looks Like (Data Contract)

The semantic layer exposes **2 unified entities**:

### A. `law_documents` (Legal Instrument Registry)
* **Role:** One row per registered legal instrument. Primary metadata table.
* **Primary Key:** `document_id` (varchar — e.g. `PUA460`, `Act127`).
* **Sample Record:**
  ```json
  {
    "document_id": "PUA460",
    "file_name": "PUA460.json",
    "instrument": "Environmental Quality (Open Burning) Order 2003",
    "instrument_code": "P.U.(A) 460/2003",
    "law_as_at": "...",
    "ingest_role": "env_law",
    "pages_original": 8,
    "pages_final": 8,
    "source_url": "https://agc.gov.my/...",
    "source_host": "agc.gov.my",
    "source_pdf_sha256": "abc123...",
    "extracted_at": "2026-10-23T00:00:00Z"
  }
  ```

### B. `law_pages` (Full-Text Page Store)
* **Role:** One row per page. Full extracted UTF-8 text of each law page.
* **Primary Key:** Composite `(document_id, page_number)`.
* **Foreign Key:** `document_id` → `law_documents(document_id)`.
* **Sample Record:**
  ```json
  {
    "document_id": "PUA460",
    "page_number": 3,
    "is_provenance_page": false,
    "page_text": "3. Prohibition of open burning\n\n(1) No person shall carry on or cause ..."
  }
  ```
  *(Note: `is_provenance_page = true` marks cover, title, and gazette header pages which contain administrative metadata rather than substantive legal text.)*

---

## 4. How External Systems & Agents Query This Data

### Method 1: Using the Repository's Python CLI (`run_sql.py`)
```bash
python app/zetaris/scripts/run_sql.py --limit 50 -e "
SELECT
    doc.instrument_code,
    p.page_number,
    p.page_text
FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc
JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p
  ON doc.document_id = p.document_id
WHERE LOWER(p.page_text) LIKE '%open burning%'
ORDER BY doc.instrument_code, p.page_number;
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
    "query": "SELECT doc.instrument_code, p.page_number, p.page_text FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p ON doc.document_id = p.document_id WHERE doc.instrument_code = 'Act 127' ORDER BY p.page_number",
    "limit": 50
  }
  ```

---

## 5. Copy-Pasteable LLM Agent System Prompt

If you are deploying an AI Agent (e.g. LangChain, LlamaIndex, OpenAI Assistant, or Anthropic Tool-Use Agent) that answers legal questions, **inject this exact system prompt**:

````markdown
You are the Malaysian Environmental Law Intelligence Assistant. You have access to the Zetaris Unified Semantic Layer (`lightning.metastore.malaysia_law.malaysia_law_usl`), which contains the full text of 4 key Malaysian environmental legal instruments across 130 indexed pages.

### Available Tables & Keys:
1. `law_documents` (PK: document_id)
   - Columns: document_id, file_name, instrument, instrument_code, law_as_at, ingest_role, pages_original, pages_final, source_url, source_host, source_pdf_sha256, extracted_at
   - Always start here to identify which act or order to retrieve.
2. `law_pages` (PK: (document_id, page_number), FK: document_id → law_documents)
   - Columns: document_id, page_number, is_provenance_page, page_text
   - Contains the full extracted text of each page.
   - Filter `is_provenance_page = false` to exclude cover/title pages.

### Registered Instruments:
| document_id | instrument_code    | Description |
|-------------|-------------------|-------------|
| PUA460      | P.U.(A) 460/2003  | Environmental Quality (Open Burning) Order 2003 |
| Act127      | Act 127           | Environmental Quality Act 1974 |
| Act341      | Act 341           | Forestry Conservation Act |
| A1712       | A1712             | Amendment to Environmental Quality Act |

### SQL Generation Rules:
- Always use fully qualified names: `lightning.metastore.malaysia_law.malaysia_law_usl.<table_name>`.
- To retrieve a specific act, join law_documents and law_pages on document_id.
- Use `LOWER(p.page_text) LIKE '%keyword%'` for full-text keyword searches.
- Filter `WHERE p.is_provenance_page = false` when the user wants substantive legal text only.
- Quote instrument codes exactly as they appear (e.g. `'P.U.(A) 460/2003'`, `'Act 127'`).
````

---

## 6. Critical Rules & Edge Cases for Agents

1. **Static Data — Not Live:**
   `law_pages` is not a live REST feed. The text reflects the PDF at extraction time. If the user asks about the "latest" version of an act, clarify that the corpus reflects the `law_as_at` version recorded in `law_documents`.

2. **Provenance Pages:**
   Pages with `is_provenance_page = true` contain gazette headers, cover images, and administrative metadata — not legal text. Always filter these out when answering substantive legal questions.

3. **No Location Join:**
   The Law USL (`malaysia_law_usl`) is independent of the Environmental USL (`malaysia_env_usl`). There is no shared join key. They operate in separate namespaces (`malaysia_law` vs `malaysia_env`).

4. **Full Text — No Truncation:**
   `page_text` contains the complete page content. Do not apply `SUBSTRING` or `LIMIT` when a user requests the full text of a specific page or act.

5. **Instrument Code Matching:**
   Use exact string matching for `instrument_code`. The codes are case-sensitive strings from the official AGC gazette (e.g. `'P.U.(A) 460/2003'`, `'Act 127'`).
