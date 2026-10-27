# Open-Meteo Air Quality API

The setup script registers one Zetaris REST table per selected canonical
location. Zetaris calls the Open-Meteo Air Quality API when the REST table or
its unified view is queried.

```text
https://air-quality-api.open-meteo.com/v1/air-quality
```

The base URL by itself does not return data. Include coordinates and requested
fields in the query string. For example, this complete request returns hourly
PM2.5 for Kuala Lumpur:

```text
https://air-quality-api.open-meteo.com/v1/air-quality?latitude=3.1412&longitude=101.68653&hourly=pm2_5&past_days=1&forecast_days=3&timezone=GMT
```

It requests the hourly `pm2_5` series in GMT, with one past day and three
forecast days. Open-Meteo requires no API key for this configured use.

Example request parameters:

```text
latitude=3.14
longitude=101.69
hourly=pm2_5
past_days=1
forecast_days=3
timezone=GMT
```

The API response contains parallel `hourly.time` and `hourly.pm2_5` arrays.
The Zetaris view expands those arrays into one row per timestamp. See the
[Open-Meteo Air Quality API documentation](https://open-meteo.com/en/docs/air-quality-api).

This integration is live REST federation: registering the REST table does not
copy or persist the response. Querying the full view can invoke the endpoint
for every registered location. Use location filters and the bounded query
examples where possible.
