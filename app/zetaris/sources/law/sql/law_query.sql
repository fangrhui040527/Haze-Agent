-- =============================================================================
-- Query Verified USL Law Tables: law_documents & law_pages
-- =============================================================================

SELECT
    doc.document_id,
    doc.instrument,
    doc.instrument_code,
    doc.law_as_at,
    doc.pages_final,
    p.page_number,
    p.is_provenance_page,
    SUBSTRING(p.page_text, 1, 150) AS page_snippet
FROM lightning.metastore.malaysia_law.malaysia_law_usl.law_documents doc
JOIN lightning.metastore.malaysia_law.malaysia_law_usl.law_pages p
  ON doc.document_id = p.document_id
WHERE doc.instrument_code = 'P.U.(A) 460/2003'
ORDER BY p.page_number
LIMIT 5;
