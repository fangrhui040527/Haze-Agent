# 1a. Haze episode investigation and data sources

## Answer

The use case is to investigate haze in a selected Malaysian area and time
period. Combine air-quality readings, satellite fire detections, and weather
data into a timeline that shows what data is available. The
[Haze Agent Architecture](../../docs/architecture/Haze_Agent_Architecture_v0.14.pdf)
describes this as an episode investigation. Keep observations, forecasts, and
possible causes separate.

### Selected sources

| Source | USL data | Use |
| --- | --- | --- |
| Open-Meteo air quality | `air_quality_obs`: hourly PM2.5 and PM10 | Air-quality timeline |
| NASA FIRMS | `active_fires`: fire detections, time, location, and FRP | Satellite fire context |
| NASA POWER | `power_daily`: daily climate values | Weather context |
| Data.gov.my weather | `weather_forecast`: forecast text by location code and date | Forecast context |

These four sources exceed the three-source minimum. The
[Environmental USL DDL](../../app/adapters/zetaris/usl/env_usl/usl_schema.sql)
defines their tables and location links. See the
[coverage guide](../../app/adapters/zetaris/usl/env_usl/docs/DATA_COVERAFES.md)
for refresh details.

## What the demo should show

Show the available records, their time and location coverage, and any missing
or invalid values. Do not present a time or location match as proof that a
fire caused a pollution reading.

## Evidence status

This document describes the use case and sources; it does not report a live
investigation. Record query results and run time when performing the demo.
