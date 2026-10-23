# Windy Point Forecast API

## Which key you have

Windy issues **one API key per product**, and the keys are not
interchangeable. A key created for Map Forecast or Webcams will be rejected by
the Point Forecast API with `{"message":"Invalid API key"}`.

The key in `.env.local` (`WINDY_API_KEY`) is a **Point Forecast** key. It was
verified against `POST https://api.windy.com/api/point-forecast/v2` and returns
`HTTP 200`, so this is the only Windy product it drives.

| Product | What it does | Key from |
| :--- | :--- | :--- |
| Point Forecast | Raw forecast JSON for a coordinate (this key) | <https://api.windy.com/keys> |
| Map Forecast | A JavaScript map widget, no raw data endpoint | <https://api.windy.com/map-forecast/pricing> |
| Webcams | Webcam index JSON | <https://api.windy.com/webcams/keys> |

## Endpoint

```text
POST https://api.windy.com/api/point-forecast/v2
Content-Type: application/json
```

## Request body

```json
{
  "lat": 3.14,
  "lon": 101.69,
  "model": "gfs",
  "parameters": ["wind", "temp", "rh", "pressure"],
  "levels": ["surface"],
  "key": "<WINDY_API_KEY>"
}
```

| Field | Value | Notes |
| :--- | :--- | :--- |
| `lat` | Decimal degrees (WGS84) | Rounded to 2 decimals by Windy (~1 km error) |
| `lon` | Decimal degrees (WGS84) | Rounded to 2 decimals by Windy (~1 km error) |
| `model` | Forecast model id (see below) | One model per request |
| `parameters` | Array of parameter ids | See the parameter tables below |
| `levels` | Array of geopotential levels | Default `["surface"]`; only `wind`, `temp`, `dewpoint`, `gh`, `rh` use it |
| `key` | The API key | Send in the body, never in the URL |

## Models worth knowing for Malaysia

| Model | Coverage | Typical parameters | Cadence |
| :--- | :--- | :--- | :--- |
| `gfs` | Global | `wind`, `temp`, `rh`, `pressure`, `windGust`, `precip` | 3-hourly |
| `cams` | Global air quality | `pm2p5`, `pm10`, `aqi`, `no2`, `so2sm`, `dustsm`, `go3` | 3-hourly |
| `icon` | Global | as `gfs` | 3-hourly |
| `gfsWave` | Global sea | `waves`, `swell1`, `windWaves` | 3-hourly |

Regional models (`arome`, `iconEu`, `namConus`, `hrrrConus`, `canHrdps`, ...)
do not cover Malaysia. Use `gfs` for weather and `cams` for air quality.

## Parameters and the response key they map to

The response does **not** use the parameter id you asked for. Each parameter is
returned under a derived key, often split into components or suffixed with the
level.

| Request parameter | Response key(s) | Unit source |
| :--- | :--- | :--- |
| `temp` | `temp-{level}` | `K` (Kelvin) |
| `dewpoint` | `dewpoint-{level}` | `K` |
| `rh` | `rh-{level}` | `%` |
| `wind` | `wind_u-{level}` and `wind_v-{level}` | `m*s-1` |
| `windGust` | `gust-surface` | `m*s-1` |
| `pressure` | `pressure-surface` | `Pa` |
| `precip` | `past3hprecip-surface` | water column |
| `pm2p5` | `pm2p5-surface` | `µg*m-3` |
| `pm10` | `pm10-surface` | `µg*m-3` |
| `aqi` | `aqi_us-surface` | unitless (`units` value is `null`) |
| `no2` | `no2-surface` | `µg*m-3` |
| `dustsm` | `chem_dustsm-surface` | `µg*m-3` |

### Getting wind speed and direction

`wind` is a two-component vector, not a speed:

- `u` is the West-to-East component (negative means blowing East-to-West).
- `v` is the South-to-North component (negative means blowing North-to-South).

```text
speed        = sqrt(u^2 + v^2)
direction    = (atan2(-u, -v) * 180 / pi + 360) % 360   # degrees FROM which it blows
```

## Response body

```json
{
  "ts": [1761188400000, 1761199200000, "..."],
  "units": { "temp-surface": "K", "rh-surface": "%", "...": "..." },
  "temp-surface": [300.62, "...", "..."],
  "wind_u-surface": [2.53, "...", "..."],
  "wind_v-surface": [-0.92, "...", "..."],
  "warning": "The testing API version is for development purposes only. This data is randomly shuffled and slightly modified."
}
```

- `ts` is epoch **milliseconds**, so `new Date(ts[i])` works directly.
- All series arrays are the same length; index `i` lines up across every key.
- A `null` value means the model has no value for that time and parameter.
- A missing key entirely means the model never produces that parameter.
- `warning` is a scalar string, not a series.

### HTTP status codes

| Code | Meaning |
| :--- | :--- |
| 200 | OK |
| 204 | The model has none of the requested parameters |
| 400 | Invalid request body |
| 500 | Windy backend error (retry later) |

## Pricing tiers

| Tier | Cost | Requests/day | Data quality |
| :--- | :--- | :--- | :--- |
| Testing | Free | 500 | **Randomly shuffled and slightly modified** |
| Professional | 990 EUR/year | 10 000 | Production-grade |

The current key is on the **Testing** tier. Every response carries the
`warning` string that says so. This is fine for wiring up and testing the
pipeline, but the values must not be used as evidence in the Haze Agent: they
are deliberately perturbed. Switch to Professional before relying on them.

## See also

- Point Forecast docs: <https://api.windy.com/point-forecast/docs>
- Pricing: <https://api.windy.com/point-forecast/pricing>
