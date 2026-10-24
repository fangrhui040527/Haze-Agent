-- =============================================================================
-- Register Malaysia Environmental Law Documents & Pages FileStore Tables
--
-- Exposes the 4 core legal instruments and 130 full-text pages:
--   - LAW_REF_DATA.law_documents_ref (4 rows, metadata per legal document)
--   - LAW_REF_DATA.law_pages_ref (130 rows, full-text pages)
--
-- Container Storage Path:
--   /home/zetaris/customer-data/shared/law/
-- =============================================================================

CREATE LIGHTNING DATABASE LAW_REF_DATA
DESCRIBE BY "Malaysia environmental legal acts, orders, and full-text pages reference";

CREATE LIGHTNING FILESTORE TABLE law_documents_ref
FROM LAW_REF_DATA
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/law/law_documents.csv",
    header "true",
    multiLine "true",
    inferSchema "true"
);

CREATE LIGHTNING FILESTORE TABLE law_pages_ref
FROM LAW_REF_DATA
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/law/law_pages.csv",
    header "true",
    multiLine "true",
    inferSchema "true"
);
