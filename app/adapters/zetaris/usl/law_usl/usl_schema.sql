-- =============================================================================
-- USL: malaysia_law_usl
-- Unified Semantic Layer for Malaysia environmental laws & fire regulations.
--
-- Exposes two normalized legal entities:
--   - law_documents : 4 primary acts & orders (PK: document_id)
--   - law_pages     : 130 full-text pages (PK: document_id, page_number)
--                     (FK: document_id -> law_documents.document_id)
-- =============================================================================

CREATE NAMESPACE IF NOT EXISTS lightning.metastore.malaysia_law;

COMPILE USL IF NOT EXISTS malaysia_law_usl DEPLOY NAMESPACE lightning.metastore.malaysia_law DDL
CREATE TABLE law_documents (
    document_id varchar(120) NOT NULL PRIMARY KEY,
    file_name varchar(120),
    instrument varchar(255),
    instrument_code varchar(50),
    law_as_at varchar(150),
    ingest_role varchar(50),
    pages_original int,
    pages_final int,
    source_url varchar(350),
    source_host varchar(100),
    source_pdf_sha256 varchar(64),
    extracted_at varchar(50)
);
CREATE TABLE law_pages (
    document_id varchar(120) NOT NULL FOREIGN KEY REFERENCES law_documents(document_id),
    page_number int NOT NULL,
    is_provenance_page boolean,
    page_text string,
    PRIMARY KEY (document_id, page_number)
);
