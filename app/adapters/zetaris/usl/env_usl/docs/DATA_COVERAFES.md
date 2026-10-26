# Malaysia Environmental USL: Data Coverage and Refresh

Current coverage comes from the rows actually published or returned by each
configured source. A request limit is not a guarantee of data availability.

## Source coverage

| Source | Collection window or access path | Refresh boundary |
| --- | --- | --- |
| Open-Meteo air quality | Live per-location REST tables request `past_days=1`, `forecast_days=3`, UTC | `npm run zetaris:fetch:pm25` registers the selected REST tables and view |
| Open-Meteo wind | Live per-location REST tables request the same window at 10 m and 850 hPa, UTC | `npm run zetaris:fetch:wind` registers the selected REST tables and view |
| Data.gov.my weather | Current forecast returned through its REST registration | Queried through Zetaris |
| NASA FIRMS | Configured regional/day-range satellite detections | Rerun the FIRMS ingester to publish newer CSV data |
| NASA POWER | Date-keyed climate view | Rerun its registration/view generation for a newer target date |
| Windy GFS and CAMS | Forecast for the configured point, frozen in CSV snapshots | Rerun the Windy ingester on demand |

## Publication and task queries

A `SELECT` over `air_quality.hourly_observations` or
`open_meteo_wind.hourly_observations`
may call Open-Meteo through Zetaris. `--test` registers Kuala Lumpur only;
repeated `--location` IDs select specific locations, and `--dry-run` previews
SQL without changing Zetaris. Full registration creates one endpoint per
canonical location, so monitor provider usage and verify predicate pushdown
before broad queries.

The PM2.5 task reads the air-quality base view directly for an increasing UTC
interval of at most 31 days. That is an input bound; missing dates remain
coverage gaps. Activated environmental USL tables have a separate lifecycle;
registering a source alone does not establish that an existing USL copy was
refreshed.

## Historical examples

The examples below are dated illustrative outputs from the earlier source
setup around 22–23 October 2026. They do not establish current coverage.

## Historical illustrative outputs

### 🌫️ Air Quality (Kuala Lumpur — earlier Open-Meteo response)
```
observation_time          | pm2_5_ug_m3 | pm10_ug_m3 | note
--------------------------+-------------+------------+-------------------
2026-10-22T00:00+08:00    |   29.1      |   29.2     | Past (midnight)
2026-10-22T14:00+08:00    |   61.2      |   62.2     | Current hour
2026-10-22T20:00+08:00    |  103.6      |  103.8     | Tonight (forecast)
2026-10-26T16:00+08:00    |   56.7      |   56.7     | Last valid row
2026-10-26T17:00+08:00    |   null      |   null     | Beyond model boundary
```

### 🌤️ Weather Forecast (Langkawi — Live MET Malaysia API)
```
location  | date        | morning_forecast           | afternoon_forecast          | night_forecast
----------+-------------+----------------------------+-----------------------------+-------------------
Langkawi  | 2026-10-22  | Ribut petir di beberapa    | Ribut petir di beberapa     | Tiada Hujan
Langkawi  | 2026-10-25  | Ribut petir kebanyakan     | Ribut petir kebanyakan      | Tiada Hujan
Langkawi  | 2026-10-28  | Ribut petir di beberapa    | Ribut petir di beberapa     | Tiada Hujan
```

### 🛰️ NASA POWER (Kuala Lumpur — 2026-10-18)
```
date        | T2M (°C) | PRECTOTCORR (mm/day) | RH2M (%) | WS10M (m/s)
------------+----------+---------------------+----------+------------
2026-10-18  |  26.58   |       42.24         |  85.74   |    1.82
```

### 🔥 NASA FIRMS (East Malaysia — Real Satellite Hotspots 2026-10-21)
```
acq_date   | acq_myt (MYT)        | region        | satellite | confidence | frp (MW)
-----------+----------------------+---------------+-----------+------------+---------
2026-10-21 | 2026-10-21 13:48 MYT | Bario         | N20       | nominal    |  12.73
2026-10-21 | 2026-10-21 13:48 MYT | Pulau Sipadan | N20       | nominal    |  10.03
```
> *Note on FIRMS:* FIRMS is event-based. Locations with no active fire detections return 0 rows.

### 💨 Windy GFS (Kuala Lumpur — 2026-10-23, units converted)
```
forecast_time (UTC)   | temp_c | rh (%) | pressure_hpa | wind_speed_ms | wind_dir_deg | gust_ms
----------------------+--------+--------+--------------+---------------+--------------+--------
2026-10-23T03:00Z     |  27.55 |  88.64 |   1009.45    |      1.34     |     337.2    |   2.95
2026-10-23T06:00Z     |  24.43 |  95.91 |   1011.85    |      0.75     |       9.2    |   0.36
```
> *Note on Windy:* raw API values are Kelvin, Pascal and a `wind_u`/`wind_v` vector; the CSV stores converted °C, hPa, speed and direction.

### 💨 Windy CAMS (Kuala Lumpur — 2026-10-23)
```
observation_time (UTC) | pm2_5_ug_m3 | pm10_ug_m3 | aqi_us | no2_ug_m3 | dust_ug_m3
-----------------------+-------------+------------+--------+-----------+------------
2026-10-23T00:00Z      |    18.35    |    11.52   | 103.97 |   48.08   |    0.00
2026-10-23T06:00Z      |    26.83    |    26.96   | 115.35 |   76.59   |    0.00
```
> *Note on Windy:* the free Testing-tier key perturbs these values. They are for pipeline testing only and must not be used as evidence.
