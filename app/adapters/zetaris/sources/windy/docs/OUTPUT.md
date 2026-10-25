# Windy Output

Output of `fetch_windy.ts --all` for Kuala Lumpur (`lat 3.14`, `lon 101.69`).
Rows are truncated to the first 8 of each series.

## GFS weather

```text
model=gfs point=(3.14, 101.69) series=80 rows
columns: wind_u-surface, wind_v-surface, temp-surface, rh-surface, pressure-surface, gust-surface
  2026-10-23T03:00:00.000Z  wind_u-surface=0.52  wind_v-surface=-1.24  temp-surface=300.70  rh-surface=88.64  pressure-surface=100944.58  gust-surface=2.95
  2026-10-23T06:00:00.000Z  wind_u-surface=-0.12  wind_v-surface=-0.74  temp-surface=297.58  rh-surface=95.91  pressure-surface=101184.93  gust-surface=0.36
  2026-10-23T09:00:00.000Z  wind_u-surface=1.95  wind_v-surface=-0.85  temp-surface=297.43  rh-surface=90.79  pressure-surface=101068.66  gust-surface=1.63
  2026-10-23T12:00:00.000Z  wind_u-surface=1.16  wind_v-surface=-0.00  temp-surface=298.96  rh-surface=92.94  pressure-surface=101206.67  gust-surface=1.31
  2026-10-23T15:00:00.000Z  wind_u-surface=0.05  wind_v-surface=-0.43  temp-surface=296.15  rh-surface=90.30  pressure-surface=101156.18  gust-surface=1.57
  2026-10-23T18:00:00.000Z  wind_u-surface=-0.25  wind_v-surface=-1.03  temp-surface=296.62  rh-surface=79.59  pressure-surface=101192.17  gust-surface=1.33
  2026-10-23T21:00:00.000Z  wind_u-surface=-0.38  wind_v-surface=0.04  temp-surface=303.32  rh-surface=96.44  pressure-surface=101083.74  gust-surface=1.31
  2026-10-24T00:00:00.000Z  wind_u-surface=0.21  wind_v-surface=-0.14  temp-surface=298.29  rh-surface=95.71  pressure-surface=101108.78  gust-surface=0.61
units: {"wind_u-surface":"m*s-1","wind_v-surface":"m*s-1","temp-surface":"K","rh-surface":"%","pressure-surface":"Pa","gust-surface":"m*s-1"}
extra: {"warning":"The testing API version is for development purposes only. This data is randomly shuffled and slightly modified."}
```

## CAMS air quality

```text
model=cams point=(3.14, 101.69) series=33 rows
columns: pm2p5-surface, pm10-surface, aqi_us-surface, no2-surface, chem_dustsm-surface
  2026-10-23T00:00:00.000Z  pm2p5-surface=18.35  pm10-surface=11.52  aqi_us-surface=103.97  no2-surface=48.08  chem_dustsm-surface=0.00
  2026-10-23T03:00:00.000Z  pm2p5-surface=29.66  pm10-surface=65.14  aqi_us-surface=94.92  no2-surface=66.23  chem_dustsm-surface=0.17
  2026-10-23T06:00:00.000Z  pm2p5-surface=26.83  pm10-surface=26.96  aqi_us-surface=115.35  no2-surface=76.59  chem_dustsm-surface=0.00
  2026-10-23T09:00:00.000Z  pm2p5-surface=9.97  pm10-surface=19.40  aqi_us-surface=68.68  no2-surface=35.86  chem_dustsm-surface=0.00
  2026-10-23T12:00:00.000Z  pm2p5-surface=30.64  pm10-surface=69.38  aqi_us-surface=77.69  no2-surface=103.62  chem_dustsm-surface=0.00
  2026-10-23T15:00:00.000Z  pm2p5-surface=20.44  pm10-surface=15.87  aqi_us-surface=85.21  no2-surface=36.60  chem_dustsm-surface=0.00
  2026-10-23T18:00:00.000Z  pm2p5-surface=17.67  pm10-surface=23.40  aqi_us-surface=150.65  no2-surface=88.70  chem_dustsm-surface=0.01
  2026-10-23T21:00:00.000Z  pm2p5-surface=19.39  pm10-surface=18.23  aqi_us-surface=63.83  no2-surface=45.87  chem_dustsm-surface=0.00
units: {"pm2p5-surface":"µg*m-3","pm10-surface":"µg*m-3","aqi_us-surface":null,"no2-surface":"µg*m-3","chem_dustsm-surface":"µg*m-3"}
extra: {"warning":"The testing API version is for development purposes only. This data is randomly shuffled and slightly modified."}
```

## Notes

- `ts` is epoch milliseconds; the script renders it with `Date#toISOString()`
  (UTC). Malaysia is UTC+8, so add 8 hours for local time.
- `temp-surface` is in **Kelvin**, not Celsius. Subtract `273.15`.
- `pressure-surface` is in **Pascal**, not hectopascal. Divide by `100`.
- `wind_u` / `wind_v` are vector components; see `API.md` for speed and
  direction.
- The `warning` string confirms the response is from the free **Testing** tier,
  which perturbs the values. Do not treat these numbers as ground truth.
