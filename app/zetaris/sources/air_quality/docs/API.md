# Open-Meteo Air Quality API

## Endpoint

Open-Meteo provides point-based hourly air quality data via HTTP GET:

```text
https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lat}&longitude={lon}&hourly=pm2_5,pm10&timezone=Asia%2FKuala_Lumpur
```

## Parameters

| Parameter | Value | Purpose |
| :--- | :--- | :--- |
| `latitude` | Decimal degrees (WGS84) | Center latitude of the district / subdistrict |
| `longitude` | Decimal degrees (WGS84) | Center longitude of the district / subdistrict |
| `hourly` | `pm2_5,pm10` | Hourly particulate matter concentrations (µg/m³) |
| `timezone` | `Asia/Kuala_Lumpur` | Timestamps matched to Malaysia standard time (MYT, UTC+8) |

## Integration Topology in Zetaris

- **345 Endpoints**: Because Open-Meteo does not accept a nationwide bounding box in a single GET request, 345 individual REST tables (`aq_{safe_id}_raw`) are registered in database `OPEN_METEO_AIR_QUALITY` and container `air_quality`.
- **Unified View**: Combined via SQL `UNION ALL` into `air_quality.hourly_observations` linking each point to its canonical `location_index`.
- **Semantic Entity**: Activated as USL entity `air_quality_obs` in `lightning.metastore.malaysia_env_usl`.
