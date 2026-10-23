# NASA FIRMS API

## Endpoint

NASA FIRMS provides satellite-detected active fire / thermal anomaly hotspots via HTTP GET. The ingestion pipeline queries active fires using geographic bounding box coordinates (Area API):

```text
https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{WEST,SOUTH,EAST,NORTH}/{DAY_RANGE}
```

> **Note on Country vs Area Endpoints:**  
> The country polygon endpoint (`/api/country/csv/...`) is marked as `* Feature currently not available` by NASA FIRMS. The **Area API** (`/api/area/csv/...`) with bounding box coordinates is the official and active method recommended by NASA.

## Runnable Real-World Examples (Malaysia Regions)

Our pipeline queries nationwide Malaysia using two official regional bounding boxes configured in `fetch_nasa_firms.ts`:

### 1. Peninsular Malaysia (Bounding Box: `99.5, 1.0, 104.5, 7.5`)
Queries all active thermal hotspots across Peninsular Malaysia for the past 3 days (`DAY_RANGE=3`):

#### Direct URL (Click or paste in browser)
```text
https://firms.modaps.eosdis.nasa.gov/api/area/csv/ea17d5820daffb2467bc6afd1ed2e15a/VIIRS_NOAA20_NRT/99.5,1.0,104.5,7.5/3
```

#### cURL
```bash
curl -s "https://firms.modaps.eosdis.nasa.gov/api/area/csv/ea17d5820daffb2467bc6afd1ed2e15a/VIIRS_NOAA20_NRT/99.5,1.0,104.5,7.5/3"
```

#### Sample Response (Peninsular Real Hotspots)
```csv
latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
6.97718,104.17696,316.63,0.46,0.39,2026-10-21,1826,N20,VIIRS,n,2.0NRT,290.9,4.68,N
1.37954,104.15904,321.99,0.41,0.37,2026-10-21,1828,N20,VIIRS,n,2.0NRT,292.84,2.1,N
1.67166,101.47615,305.39,0.56,0.43,2026-10-21,1828,N20,VIIRS,n,2.0NRT,286.98,2.27,N
2.26694,102.12493,311.61,0.52,0.41,2026-10-21,1828,N20,VIIRS,n,2.0NRT,290.7,3.41,N
2.53459,101.80875,307.21,0.54,0.42,2026-10-21,1828,N20,VIIRS,n,2.0NRT,282.4,0.93,N
3.14627,102.67091,308.05,0.5,0.41,2026-10-21,1828,N20,VIIRS,n,2.0NRT,289.25,1.37,N
4.00648,103.34444,309.9,0.47,0.4,2026-10-21,1828,N20,VIIRS,n,2.0NRT,292.07,1.53,N
```

---

### 2. East Malaysia (Sabah & Sarawak, Bounding Box: `109.5, 0.8, 119.5, 7.5`)
Queries all active thermal hotspots across Sabah and Sarawak for the past 3 days (`DAY_RANGE=3`):

#### Direct URL (Click or paste in browser)
```text
https://firms.modaps.eosdis.nasa.gov/api/area/csv/ea17d5820daffb2467bc6afd1ed2e15a/VIIRS_NOAA20_NRT/109.5,0.8,119.5,7.5/3
```

#### cURL
```bash
curl -s "https://firms.modaps.eosdis.nasa.gov/api/area/csv/ea17d5820daffb2467bc6afd1ed2e15a/VIIRS_NOAA20_NRT/109.5,0.8,119.5,7.5/3"
```

#### Sample Response (East Malaysia Real Hotspots)
```csv
latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
4.74157,113.72909,332.32,0.40,0.37,2026-10-21,550,N20,VIIRS,n,2.0NRT,291.93,2.22,D
5.42037,116.24930,332.25,0.40,0.37,2026-10-21,550,N20,VIIRS,n,2.0NRT,291.11,2.60,D
5.24588,115.23868,346.26,0.33,0.55,2026-10-21,1826,N20,VIIRS,n,2.0NRT,288.20,3.78,N
2.58403,112.33249,306.01,0.46,0.47,2026-10-21,1828,N20,VIIRS,n,2.0NRT,288.89,0.92,N
3.30241,113.10283,326.02,0.51,0.49,2026-10-21,1828,N20,VIIRS,n,2.0NRT,273.76,2.07,N
4.74202,113.72845,314.46,0.53,0.50,2026-10-21,1828,N20,VIIRS,n,2.0NRT,280.63,3.45,N
```

## Parameters

| Parameter | Value | Purpose |
| :--- | :--- | :--- |
| `MAP_KEY` | Hex token (32 chars, e.g. `ea17d5820daffb2467bc6afd1ed2e15a`) | NASA Earthdata Map Key |
| `SOURCE` | `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, `VIIRS_SNPP_NRT` | VIIRS 375m active fire sensor |
| `AREA` | `west,south,east,north` (WGS84 decimal degrees) | Regional bounding box coordinates (`peninsular_malaysia` or `east_malaysia`) |
| `DAY_RANGE` | `1` to `5` (e.g. `3`) | Lookback window in days. **Strictly bounded to `1..5`**; passing any value outside this range (e.g. `> 5`) returns `Invalid day range. Expects [1..5].` |

## Integration Topology in Zetaris

- **Dual Bounding Box Ingestion**: FIRMS satellite hotspots across Peninsular and East Malaysia are queried in two regional requests via `fetch_nasa_firms.ts`.
- **Spatial Nearest Neighbor**: The script computes the nearest canonical `location_index` (1..345) from `locations.json` using Haversine distance, assigning each hotspot to its nearest Malaysian town or district.
- **FileStore Table**: The normalized CSV is saved to `data/firms_flat/` and mirrored to `/home/zetaris/customer-data/shared/firms_flat` inside the Zetaris driver container, registered as table `active_fires`.
- **Semantic Entity**: Activated as USL entity `active_fires` in `lightning.metastore.malaysia_env_usl`.
