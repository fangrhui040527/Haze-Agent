# Windy Ingestion & Test

Test the Windy Point Forecast API for a coordinate. The script reads
`WINDY_API_KEY` from `.env` and never prints it.

## Test a single model (default: GFS weather at Kuala Lumpur)

```powershell
node --experimental-strip-types sources/windy/fetch_windy.ts
```

## Test both families (GFS weather and CAMS air quality)

```powershell
node --experimental-strip-types sources/windy/fetch_windy.ts --all
```

## Pick a location or custom coordinate

```powershell
# Pick any location from location.json by ID or name
node --experimental-strip-types sources/windy/fetch_windy.ts --location langkawi
node --experimental-strip-types sources/windy/fetch_windy.ts --location "George Town"

# Or specify custom lat/lon
node --experimental-strip-types sources/windy/fetch_windy.ts --lat 3.14 --lon 101.69
node --experimental-strip-types sources/windy/fetch_windy.ts --model cams --parameters pm2p5,pm10,aqi --levels surface
node --experimental-strip-types sources/windy/fetch_windy.ts --model gfs --parameters wind,temp,rh --levels surface,850h
```

## Save the raw response

```powershell
node --experimental-strip-types sources/windy/fetch_windy.ts --all --json windy_sample.json
```

## Options

| Flag | Default | Purpose |
| :--- | :--- | :--- |
| `--location`, `--loc` | `wp-kuala-lumpur` | Resolve coordinates by ID or name from `location.json` |
| `--lat` | `3.14` (from KL) | Latitude (WGS84, overrides `--location`) |
| `--lon` | `101.69` (from KL) | Longitude (WGS84, overrides `--location`) |
| `--model` | `gfs` | Forecast model id |
| `--parameters` | model default | Comma-separated parameter ids |
| `--levels` | `surface` | Comma-separated geopotential levels |
| `--all` | off | Run the GFS weather call and the CAMS air-quality call |
| `--json` | off | Write the raw response(s) to a file |

To allow the script to run (TypeScript type stripping), Node 22 or later is
required. Check with `node --version`.
