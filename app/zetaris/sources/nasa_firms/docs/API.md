# NASA FIRMS API

## Overview

NASA FIRMS (Fire Information for Resource Management System) provides satellite-detected thermal anomalies / active fires across Malaysia.

## API Endpoint & Parameters

Hotspot detections are queried using the FIRMS country/area CSV API:

```text
https://firms.modaps.eosdis.nasa.gov/api/country/csv/{MAP_KEY}/{SOURCE}/{COUNTRY}/{DAYS}
```

| Parameter | Value | Purpose |
| :--- | :--- | :--- |
| `MAP_KEY` | Hex token (32 chars) | NASA Earthdata Map Key (from `.env` or `.env.local`) |
| `SOURCE` | `VIIRS_SNPP_NRT` / `VIIRS_NOAA20_NRT` | VIIRS satellite instrument sensor |
| `COUNTRY` | `MYS` | ISO-3 country code for Malaysia |
| `DAYS` | `1` to `5` (default: `3`) | Acquisition window in days (defaults to 3 days to avoid zero-fire gaps) |

## Topology & Storage

Unlike point-based APIs, FIRMS downloads all fire hotspots across the entirety of Malaysia in a single CSV payload:
1. `fetch_nasa_firms.py` downloads the raw detection CSV.
2. The script computes the nearest canonical `location_index` (1..345) using Haversine distance.
3. The enriched CSV is saved locally in `data/firms_flat/` and mirrored to the Zetaris driver container at `/var/data/firms`.
4. Zetaris queries it as a FileStore table (`active_fires_raw`).
5. Activated as USL entity `active_fires`.
