-- =============================================================================
-- NASA POWER Daily Climate REST Table & Container Registration
-- =============================================================================

CREATE LIGHTNING DATABASE NASA_POWER_REST
DESCRIBE BY "NASA POWER daily weather REST source";

CREATE SCHEMASTORE CONTAINER power;

-- Sample REST table registration for Kuala Lumpur (20 climate variables):
CREATE LIGHTNING REST TABLE power_kuala_lumpur_raw
FROM NASA_POWER_REST
REQUEST(
    endpoint "https://power.larc.nasa.gov/api/temporal/daily/point?parameters=WS10M,WD10M,RH2M,QV2M,GWETTOP,GWETROOT,PRECTOTCORR,T2M,T2M_MAX,T2M_MIN,T2MDEW,WS10M_MAX,GWETPROF,WS2M,T2MWET,PS,WS50M,WD50M,TS,EVLAND&community=AG&longitude=101.68653&latitude=3.1412&start=20261018&end=20261018&format=JSON",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER () BODY ();
