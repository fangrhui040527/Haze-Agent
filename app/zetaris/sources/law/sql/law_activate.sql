-- =============================================================================
-- Activate USL Law Entities: law_documents & law_pages
--
-- Model: malaysia_law_usl
-- Namespace: lightning.metastore.malaysia_law
--
-- Tables:
--   1. law_documents (PK: document_id [4 legal acts & orders])
--   2. law_pages     (PK: document_id, page_number [130 full-text pages])
-- =============================================================================

ACTIVATE USL TABLE lightning.metastore.malaysia_law.malaysia_law_usl.law_documents AS
SELECT
    COALESCE(CAST(document_id AS VARCHAR(120)), '') AS document_id,
    CAST(file_name AS VARCHAR(120)) AS file_name,
    CAST(instrument AS VARCHAR(255)) AS instrument,
    CAST(instrument_code AS VARCHAR(50)) AS instrument_code,
    CAST(law_as_at AS VARCHAR(150)) AS law_as_at,
    CAST(ingest_role AS VARCHAR(50)) AS ingest_role,
    CAST(pages_original AS INT) AS pages_original,
    CAST(pages_final AS INT) AS pages_final,
    CAST(source_url AS VARCHAR(350)) AS source_url,
    CAST(source_host AS VARCHAR(100)) AS source_host,
    CAST(source_pdf_sha256 AS VARCHAR(64)) AS source_pdf_sha256,
    CAST(extracted_at AS VARCHAR(50)) AS extracted_at
FROM LAW_REF_DATA.law_documents_ref;

ACTIVATE USL TABLE lightning.metastore.malaysia_law.malaysia_law_usl.law_pages AS
SELECT
    COALESCE(CAST(document_id AS VARCHAR(120)), '') AS document_id,
    COALESCE(CAST(page_number AS INT), 0) AS page_number,
    CAST(is_provenance_page AS BOOLEAN) AS is_provenance_page,
    CAST(page_text AS STRING) AS page_text
FROM LAW_REF_DATA.law_pages_ref;
