# Open-Meteo Forecast API

The setup script registers one Zetaris REST table per selected canonical
location. Zetaris calls the Open-Meteo Forecast API when the REST table or its
unified view is queried.

```text
https://api.open-meteo.com/v1/forecast
```

## Complete example request

Click this complete request to see the JSON response for Kuala Lumpur
(`latitude=3.14`, `longitude=101.69`) in GMT:

[Open the Kuala Lumpur wind API response](https://api.open-meteo.com/v1/forecast?latitude=3.14&longitude=101.69&hourly=wind_speed_10m%2Cwind_direction_10m%2Cwind_speed_850hPa%2Cwind_direction_850hPa&wind_speed_unit=ms&past_days=1&forecast_days=3&timezone=GMT)

Equivalent URL:

```text
https://api.open-meteo.com/v1/forecast?latitude=3.14&longitude=101.69&hourly=wind_speed_10m%2Cwind_direction_10m%2Cwind_speed_850hPa%2Cwind_direction_850hPa&wind_speed_unit=ms&past_days=1&forecast_days=3&timezone=GMT
```

It requests hourly 10 m and 850 hPa wind speed and direction in metres per
second, in GMT, with one past day and three forecast days. Open-Meteo requires
no API key for this configured use.

Example request parameters:

```text
latitude=3.14
longitude=101.69
hourly=wind_speed_10m,wind_direction_10m,wind_speed_850hPa,wind_direction_850hPa
wind_speed_unit=ms
past_days=1
forecast_days=3
timezone=GMT
```

The response contains parallel `hourly.time` and wind-series arrays. The
Zetaris view expands them into rows and derives eastward (`u`) and northward
(`v`) components. See the [Open-Meteo API documentation](https://open-meteo.com/en/docs).

This integration is live REST federation: registering the REST table does not
copy or persist the response. Querying the full view can invoke the endpoint
for every registered location. Use location filters and the bounded query
examples where possible.
