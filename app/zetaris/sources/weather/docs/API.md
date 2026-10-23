# Data.gov.my Official Weather Forecast API

## Endpoint

Data.gov.my provides official Malaysian meteorological forecasts (METMalaysia) across all locations nationwide in a single response array:

```text
https://api.data.gov.my/weather/forecast/
```

## Response Topology

- Unlike Open-Meteo or NASA POWER, this endpoint does not require point-by-point latitude/longitude coordinates.
- A single HTTP GET returns a JSON array containing forecasts for all 440 location codes covering 5 administrative levels:
  - `St` = State (16)
  - `Rc` = Recreation Centre (24)
  - `Ds` = District (159)
  - `Tn` = Town (238)
  - `Dv` = Division (3)
- Because a single GET covers the entire nation, only **1 REST table** (`forecasts_raw`) is required in Zetaris under database `DATA_GOV_MY_WEATHER` and container `weather`.
