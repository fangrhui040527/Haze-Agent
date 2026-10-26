# Evidence collection

This capability performs one bounded collection from a selected haze source. It
shares the same `collectOnce` implementation and provider adapters as the dashboard
watchers. Timers, recurring jobs, watcher status and dashboard persistence remain
in `server/`.

The registered ID is `evidence-collection`, version `evidence-collection.v1`.
HazeOps executes the `evidence-collection.collect` assignment through the granted
`haze-evidence-collect` tool. Registration does not itself grant tool access.

Requests explicitly identify this capability in their scope:

```json
{
  "capability": "evidence-collection",
  "provider": "open-meteo",
  "locations": [
    {
      "id": "klang",
      "name": "Klang",
      "region": "Southeast Asia",
      "country": "Malaysia",
      "countryCode": "MY",
      "lat": 3.0333,
      "lon": 101.45,
      "timeZone": "Asia/Kuala_Lumpur",
      "aqiStandard": "Malaysia API",
      "populationBand": "large"
    }
  ]
}
```

The scope selects one provider (`open-meteo`, `openaq`, `firms`, or `zetaris`) and
1–25 locations with unique IDs. Each provider retains its existing current-window
selection; arbitrary historical start/end dates are unsupported. OpenAQ retains
its Malaysian-station boundary; FIRMS retains its configured regional bounding box.
Unsupported locations remain coverage exclusions, never invented observations.

Live clients use only host-supplied configuration. OpenAQ needs `OPEN_AQ_KEY`,
FIRMS needs `FIRMS_MAP_KEY`, and Zetaris needs its credentials plus host-supplied
approved pinned queries. Requests cannot provide SQL. `SAMPLE_MODE=true` disables
live source clients. No environment files are read by this capability.

The `evidence.collection.capture` artifact retains exact evidence records, raw
bytes encoded as base64, station and fact drafts, source selection and coverage.
The raw byte count and SHA-256 must match each evidence record. The complete
capture must fit the task engine's 1 MiB artifact limit; oversized results fail
explicitly rather than silently truncating evidence.

Collection does not write to either World Model, grant acceptance or supply an
independent scientific review. The dashboard writes through its own storage
adapter; task execution saves immutable artifacts through task services. Existing
PM2.5 summary behavior continues to read stored modeled data separately.

Fixture mode uses explicitly synthetic deterministic material and makes no network
requests. Replay requires an explicitly injected source resolver. Live failures
never switch to fixtures or another provider.
