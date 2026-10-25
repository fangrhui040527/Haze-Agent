-- =============================================================================
-- Register Canonical Malaysia Locations & Codes File Store Tables
--
-- Exposes the 345 canonical locations and 440 unique codes (St, Rc, Ds, Tn, Dv)
-- as queryable tables inside Zetaris:
--   - LOCATION_REF_DATA.location_ref
--   - LOCATION_REF_DATA.location_code_ref
-- =============================================================================

CREATE LIGHTNING DATABASE LOCATION_REF_DATA
DESCRIBE BY "Canonical Malaysia locations and 5-prefix code dimension reference";

CREATE LIGHTNING FILESTORE TABLE location_ref
FROM LOCATION_REF_DATA
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/locations/location.csv",
    header "true",
    inferSchema "true"
);

CREATE LIGHTNING FILESTORE TABLE location_code_ref
FROM LOCATION_REF_DATA
FORMAT CSV
OPTIONS (
    PATH "/home/zetaris/customer-data/shared/locations/location_codes.csv",
    header "true",
    inferSchema "true"
);
