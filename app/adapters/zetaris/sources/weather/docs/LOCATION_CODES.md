# Data.gov.my Forecast Location Codes (440 Codes)

## Prefix Classification

METMalaysia organizes forecasts into 5 administrative levels using prefix codes:

| Prefix | Type | Count | Description |
| :--- | :--- | :--- | :--- |
| `St` | State | 16 | 13 states + 3 federal territories (KL, Labuan, Putrajaya) |
| `Rc` | Recreation Centre | 24 | High-traffic tourist and park locations (e.g., Genting, Cameron) |
| `Ds` | District | 159 | Official administrative districts |
| `Tn` | Town | 238 | Urban municipalities and townships |
| `Dv` | Division | 3 | Sarawak administrative divisions |
| **Total** | | **440** | Total official forecast locations |

## Linking to the 345 Canonical Location Centroids

Because `weather_forecast` rows are keyed by `location_code`, the USL incorporates `location_code` as a bridge dimension:

- `location_dim` (345 canonical district & subdistrict centroids)
- `location_code` (440 official codes with foreign key `location_index` pointing to the nearest canonical centroid)

This ensures any weather forecast can be joined with air quality, satellite fires, or NASA climate metrics via standard SQL foreign keys.
