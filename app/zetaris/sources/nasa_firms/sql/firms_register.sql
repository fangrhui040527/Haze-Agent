-- =============================================================================
-- Register NASA FIRMS Active Fires File Store Table
--
-- Exposes the processed and flattened NASA FIRMS active fire CSVs
-- as queryable FileStore table inside Zetaris:
--   - NASA_FIRMS_FILES.active_fires
-- =============================================================================

CREATE LIGHTNING DATABASE NASA_FIRMS_FILES
DESCRIBE BY "NASA FIRMS active-fire CSV output";

CREATE LIGHTNING FILESTORE TABLE active_fires
FROM NASA_FIRMS_FILES
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/firms_flat",
    header "true",
    inferSchema "true"
);
