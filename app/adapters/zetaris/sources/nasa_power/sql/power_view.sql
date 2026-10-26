-- =============================================================================
-- NASA POWER Daily Unified Schemastore View
-- =============================================================================

CREATE SCHEMASTORE VIEW power_daily WITH CONTAINER power AS
SELECT
    'kuala-lumpur' AS region,
    CAST(geometry.coordinates[1] AS VARCHAR(32)) AS requested_latitude,
    CAST(geometry.coordinates[0] AS VARCHAR(32)) AS requested_longitude,
    CAST('2026-10-18' AS DATE) AS observation_date,
    properties.parameter.WS10M.`20261018` AS WS10M,
    properties.parameter.WD10M.`20261018` AS WD10M,
    properties.parameter.RH2M.`20261018` AS RH2M,
    properties.parameter.QV2M.`20261018` AS QV2M,
    properties.parameter.GWETTOP.`20261018` AS GWETTOP,
    properties.parameter.GWETROOT.`20261018` AS GWETROOT,
    properties.parameter.PRECTOTCORR.`20261018` AS PRECTOTCORR,
    properties.parameter.T2M.`20261018` AS T2M,
    properties.parameter.T2M_MAX.`20261018` AS T2M_MAX,
    properties.parameter.T2M_MIN.`20261018` AS T2M_MIN,
    properties.parameter.T2MDEW.`20261018` AS T2MDEW,
    properties.parameter.WS10M_MAX.`20261018` AS WS10M_MAX,
    properties.parameter.GWETPROF.`20261018` AS GWETPROF,
    properties.parameter.WS2M.`20261018` AS WS2M,
    properties.parameter.T2MWET.`20261018` AS T2MWET,
    properties.parameter.PS.`20261018` AS PS,
    properties.parameter.WS50M.`20261018` AS WS50M,
    properties.parameter.WD50M.`20261018` AS WD50M,
    properties.parameter.TS.`20261018` AS TS,
    properties.parameter.EVLAND.`20261018` AS EVLAND
FROM NASA_POWER_REST.power_kuala_lumpur_raw;

