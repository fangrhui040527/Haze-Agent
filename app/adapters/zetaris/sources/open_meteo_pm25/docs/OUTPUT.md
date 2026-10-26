# Open-Meteo PM2.5 output

The setup script creates live Zetaris REST tables and the unified view
`open_meteo_pm25.hourly_observations`. It does not write a local database or
materialize a snapshot.

| Column | Meaning |
| --- | --- |
| `location_id` | Canonical location identifier |
| `location_name` | Canonical location name |
| `requested_latitude`, `requested_longitude` | Coordinates sent to the API |
| `observation_time` | Hourly timestamp returned by the API, requested in GMT |
| `pm2_5_ug_m3` | Modeled PM2.5 concentration in µg/m³ |

Rows are modeled values, not ground-monitor measurements. Requested
coordinates do not establish the model grid-cell support. The API response is
live and may change between queries; a query result is not an immutable
historical capture.

Use the read-only [query](../sql/pm25_query.sql) in Zetaris to inspect the live
view.
