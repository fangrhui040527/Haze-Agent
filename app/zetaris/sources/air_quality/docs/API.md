# Open-Meteo Air Quality API

## Endpoint

Open-Meteo provides point-based hourly air quality data via HTTP GET:

```text
https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lat}&longitude={lon}&hourly=pm2_5,pm10&timezone=Asia%2FKuala_Lumpur
```

## Runnable Real-World Example (Kuala Lumpur)

Using the canonical coordinates for **WP Kuala Lumpur** (`latitude=3.14`, `longitude=101.69`, `location_index=9`):

### Direct URL (Click or paste in browser)
```text
https://air-quality-api.open-meteo.com/v1/air-quality?latitude=3.14&longitude=101.69&hourly=pm2_5,pm10&timezone=Asia%2FKuala_Lumpur
```

### cURL
```bash
curl -s "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=3.14&longitude=101.69&hourly=pm2_5,pm10&timezone=Asia%2FKuala_Lumpur"
```

### Sample Response (Truncated)
```json
{
  "latitude": 3.1,
  "longitude": 101.7,
  "generationtime_ms": 0.21,
  "utc_offset_seconds": 28800,
  "timezone": "Asia/Kuala_Lumpur",
  "timezone_abbreviation": "GMT+8",
  "elevation": 62.0,
  "hourly_units": {
    "time": "iso8601",
    "pm2_5": "μg/m³",
    "pm10": "μg/m³"
  },
  "hourly": {
    "time": [
      "2026-10-23T00:00",
      "2026-10-23T01:00",
      "2026-10-23T02:00",
      "..."
    ],
    "pm2_5": [
      45.5,
      25.7,
      17.6,
      "..."
    ],
    "pm10": [
      45.8,
      25.8,
      17.7,
      "..."
    ]
  }
}
```

## Parameters

| Parameter | Value | Purpose |
| :--- | :--- | :--- |
| `latitude` | Decimal degrees (WGS84, e.g. `3.14`) | Center latitude of the district / subdistrict |
| `longitude` | Decimal degrees (WGS84, e.g. `101.69`) | Center longitude of the district / subdistrict |
| `hourly` | `pm2_5,pm10` | Hourly particulate matter concentrations (µg/m³) |
| `timezone` | `Asia/Kuala_Lumpur` | Timestamps matched to Malaysia standard time (MYT, UTC+8) |

## Integration Topology in Zetaris

- **345 Endpoints**: Because Open-Meteo does not accept a nationwide bounding box in a single GET request, 345 individual REST tables (`aq_{safe_id}_raw`) are registered in database `OPEN_METEO_AIR_QUALITY` and container `air_quality`.
- **Unified View**: Combined via SQL `UNION ALL` into `air_quality.hourly_observations` linking each point to its canonical `location_index`.
- **Semantic Entity**: Activated as USL entity `air_quality_obs` in `lightning.metastore.malaysia_env_usl`.

