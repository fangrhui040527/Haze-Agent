# Open-Meteo wind output

The setup script creates live Zetaris REST tables and the unified view
`open_meteo_wind.hourly_observations`. It does not write a local database or
materialize a snapshot.

| Column | Meaning |
| --- | --- |
| `location_id` | Canonical location identifier |
| `location_name` | Canonical location name |
| `requested_latitude`, `requested_longitude` | Coordinates sent to the API |
| `observation_time` | Hourly timestamp returned by the API, requested in GMT |
| `level` | `10m` or `850hPa` |
| `wind_speed_ms` | Wind speed in m/s |
| `wind_direction_deg` | Wind direction in degrees |
| `u_ms` | Eastward wind component in m/s |
| `v_ms` | Northward wind component in m/s |

The components are derived from Open-Meteo's speed and direction:
`u = -speed × sin(direction)` and `v = -speed × cos(direction)`. The requested
coordinates do not establish the underlying model grid-cell support. The
API's default model selection is used; the model run is not recorded. The API
response is live and may change between queries; a query result is not an
immutable historical capture.

Use the read-only [query](../sql/wind_query.sql) in Zetaris to inspect the live
view.
