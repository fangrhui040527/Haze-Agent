# The data you fetch, and how it plugs in

You download the files; SmokeLedger loads them into Postgres, and Zetaris federates that
store for every evidence query. Print the exact API calls for your date range with:

```bash
npm run sl -- urls --from 2026-10-01 --to 2026-10-08
```

Put downloads anywhere (for example `data/raw/`, which is git-ignored), then load them in this order:
maps first, then fires (fires get tagged with concession and peat as they load).

| # | Data | Source | Save as | Load with |
|---|---|---|---|---|
| 1 | Concession boundaries | GFW / NGO compilations (GeoJSON) | `concessions.geojson` | `load concessions <file> --source "..." --date "..."` |
| 2 | Peat map | Indonesia peat map (GeoJSON) | `peat.geojson` | `load peat <file>` |
| 3 | Company groups | You compile it | `companies.csv` | `load companies <file>` |
| 4 | Fire hotspots | NASA FIRMS area API (CSV) | `firms_*.csv` | `load fires <files...>` |
| 5 | Wind grid | Open-Meteo forecast API (JSON) | `wind_*.json` | `load wind <files...>` |
| 6 | Model PM2.5 for towns | Open-Meteo air quality API (JSON) | `pm25_model.json` | `load pm25 <file> --kind model [--issued now]` |
| 7 | Observed PM2.5 | APIMS readings you record, or OpenAQ (CSV) | `pm25_observed.csv` | `load pm25 <file> --kind observed` |
| 8 | Town coordinates (optional) | DOE station coordinates | `towns.csv` | `load towns <file>` |

If you load maps after fires, run `npm run sl -- overlay` to re-tag the fires.

## 1. Concession boundaries (GeoJSON)

- Polygons or MultiPolygons in WGS84 (lon/lat).
- The loader auto-detects common property names. If yours differ, map them:
  `--id OBJECTID --name nama --company company --group group_comp --type commodity --country country`
- Always pass `--source` and `--date`. Both appear next to every concession in the dossiers,
  because public concession maps can be years old.
- Large files: clip to the region (lon 95–120, lat −6–8) and simplify first, for example
  with mapshaper: `mapshaper in.geojson -clip bbox=95,-6,120,8 -simplify 10% -o out.geojson`.
  Node cannot read a single JSON file over about 500 MB.
- You can load several maps (oil palm, wood fibre). Each gets its own id prefix from its file name.

## 2. Peat (GeoJSON)

Peat polygons only, with any properties. A fire inside one gets `on_peat = true`, and its smoke is
weighted by `PARAMS.peatEmissionFactor` in `src/config.ts` (3x placeholder: cite or tune before presenting).

## 3. companies.csv (you compile this)

```
group_name,parent_country,rspo_member,grievance_contact,known_buyers,notes
Example Group,Malaysia,yes,grievance@example.com,Buyer A; Buyer B,source of each fact
```

`group_name` must match the group names in your concession map. This table drives the
"by parent-company country" section and the escalation routes (RSPO, buyers, Malaysian regulators).
Record where each fact came from in `notes`.

## 4. NASA FIRMS (CSV)

- Free MAP_KEY: firms.modaps.eosdis.nasa.gov/api/map_key
- `/api/area/csv/<KEY>/<SOURCE>/95,-6,120,8/<DAYS 1-5>/<YYYY-MM-DD>` returns DATE through DATE+DAYS−1.
- Use VIIRS_SNPP_NRT, VIIRS_NOAA20_NRT and VIIRS_NOAA21_NRT for recent weeks
  (`*_SP` for archived seasons). Limit: 5,000 transactions per 10 minutes per key.
- Required columns: `latitude, longitude, acq_date, acq_time, frp, confidence` (others are kept if present).
  Low-confidence detections (`l`, or MODIS < 30) are dropped. Duplicate rows are ignored, so overlapping downloads are safe.

## 5. Open-Meteo wind (JSON)

- The `urls` command prints the grid: 1° spacing over lon 95–120, lat −6–8 (390 points, split into requests of 100).
- Required: `hourly=wind_speed_850hPa,wind_direction_850hPa,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=GMT`.
  850 hPa (about 1.5 km up) carries transported smoke; 10 m is used as a second ensemble level.
- Dates: `start_date/end_date` on `api.open-meteo.com` for the last 92 days; `historical-forecast-api.open-meteo.com`
  for older seasons. For live use: `&past_days=4&forecast_days=4` (forward runs need future wind).
- Open-Meteo returns grid-snapped coordinates; the loader snaps them back to your grid using `WIND_GRID_STEP` in `.env`.
  If you fetch a 0.5° grid, set `WIND_GRID_STEP=0.5`.

## 6. Open-Meteo PM2.5 (JSON)

- One request with all receptor towns, in the order printed by `urls` (the same order as `DEFAULT_TOWNS` in `src/config.ts`).
  If you change the order, pass `--towns "A,B,C"` in request order.
- Two ways to load it, and the difference matters for the backtest:
  - **Live forecasts:** fetch daily with `&past_days=2&forecast_days=5` and load with `--issued now`.
    Backtests then only use forecasts that existed at the time, so the lead time is honest.
  - **Hindsight downloads:** past dates loaded without `--issued`. Fine for testing the method;
    run `forecast`/`replay` with `--hindsight` and say so in the demo.
- This is the CAMS global model at about 45 km resolution, and it usually under-reads haze peaks.
  Observed data (below) fixes the "now" part of every projection.

## 7. Observed PM2.5 (CSV)

```
town,valid_utc,pm25
Batu Pahat,2026-10-06T10:00:00Z,182.4
```

Hourly PM2.5 in µg/m³. APIMS has no documented public API, so record the station readings you need
(or use OpenAQ stations near each town). The backtest uses this to find when the 24-hour API actually crossed 200;
you can also pass the official closure time with `replay --actual 2026-10-06T23:00:00Z`.

## 8. towns.csv (optional)

```
town,district,state,lat,lon
Batu Pahat,Batu Pahat,Johor,1.8548,102.9325
```

The defaults are approximate town centres. Replace them with DOE station coordinates if you have them.

## Try everything first with fictional data

`npm run demo:synthetic` writes a made-up episode in exactly these formats (`data/raw/synthetic/`)
and runs the whole pipeline. Company names in it are invented. Never show it as real.
