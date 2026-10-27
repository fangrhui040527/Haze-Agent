# Compare historical haze days

To identify the worst day in Kuala Lumpur over a month, first establish the
metric and obtain evidence covering the whole period. Increasing the Manager's
chat turn limits does not supply missing historical data.

## Define the comparison

Choose one metric before ranking dates:

| Metric                             | Meaning                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily mean PM2.5                   | Mean of usable samples for each local calendar date. With the current source, this is a mean of modeled hourly sample values, not a measured daily average. |
| Highest hourly PM2.5 sample        | Largest sample value during each date; report its timestamp. A brief peak can rank differently from a daily mean.                                           |
| Official Air Pollutant Index (API) | Compare the published index for the selected station and reporting period. PM2.5 concentrations are not automatically an official API record.               |

For a daily comparison, use `Asia/Kuala_Lumpur` throughout. On October 27, 2026,
the previous 30 complete local dates are **September 27 through October 26**.
Their end-exclusive interval is:

```text
Local: 2026-09-27T00:00:00+08:00 <= timestamp < 2026-10-27T00:00:00+08:00
UTC:   2026-09-26T16:00:00Z      <= timestamp < 2026-10-26T16:00:00Z
```

Advance both boundaries for a later run. Do not include today's incomplete date
or future forecast dates in a retrospective ranking.

## Check what evidence is available

The current PM2.5 task reads the published Zetaris
`air_quality.hourly_observations` snapshot for one location and an interval of
at most 31 days. Its deterministic analysis reports hourly coverage, missing
intervals and the overall concentration range. It does not currently produce a
daily ranking or identify the timestamp of the maximum sample.

Use this objective in Manager chat or with `tasks run "<objective>"` at the
`haze>` prompt after `npm run dev`:

> Investigate the available PM2.5 evidence for Kuala Lumpur for September 27
> through October 26, 2026, using Asia/Kuala_Lumpur calendar dates. The exact
> interval is 2026-09-26T16:00:00Z inclusive to 2026-10-26T16:00:00Z exclusive.
> Report which dates and hourly samples are available, missing coverage, and
> whether the evidence is observed or modeled. Exclude future forecasts. Do not
> declare a worst day unless the complete comparison can be supported.

Check the admitted scope in the task workspace. Date-only task scope inference
uses midnight UTC. If the scope needs correction, open **Correct or clarify
this task**, explain the boundary correction, and supply this **Revised scope**:

```json
{
  "location": "Kuala Lumpur",
  "period": {
    "start": "2026-09-26T16:00:00Z",
    "end": "2026-10-26T16:00:00Z"
  }
}
```

The separate ingestion command can preview collection and publication without
calling an API or writing data. Run it in a normal terminal at the repository
root:

```sh
npm run zetaris:fetch:pm25 -- --location kuala-lumpur --dry-run
```

This previews the current collection window: one past day and three forecast
days. It **does not backfill a month**. Collection merges location/timestamp
pairs into the local cache and retains previously collected hours, but a new
cache cannot reconstruct missing weeks. There are no `--start` or `--end`
options for historical backfill. See the [ingestion guide](../../app/adapters/zetaris/sources/air_quality/docs/RUN.md).

## Supply existing historical records

If you already have historical records, retain enough metadata to distinguish
their meaning:

| Field                                | Required interpretation                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Location and station/grid identifier | Identify the actual sampling location; record coordinates where supplied.                           |
| Sample timestamp and timezone        | Preserve the original offset or UTC timestamp; derive dates in `Asia/Kuala_Lumpur`.                 |
| PM2.5 value and units                | Use consistent units; preserve missing values rather than converting them to zero.                  |
| Evidence kind                        | Mark ground-station observations separately from modeled values.                                    |
| Forecast or historical status        | Retain validity time and available model issuance metadata; exclude future values.                  |
| Source and retrieval metadata        | Retain the source/export reference and collection time. Collection time is not model issuance time. |
| Quality and coverage                 | Preserve invalid flags, duplicates, missing hours and partial dates.                                |

An existing task's Manager workspace supports **Correct or clarify this task**
→ **Attach source material**. Import a UTF-8 CSV, JSON, Markdown or text file up
to 1 MiB, then write a correction explaining the source and save it. **Paste a
source instead** is also available. Confirm the filename appears before saving.
The plain Manager chat composer has no attachment control.

This import retains a source artifact with the task. It does not load rows into
the Zetaris PM2.5 snapshot or add a verified CSV calculation method. A prepared
daily-summary file can support an explanation, but its import alone does not
establish that its arithmetic or source coverage was independently checked.

## What a complete result still requires

When history is missing, a historical acquisition/import path must first supply
the requested samples. A daily comparison method must then validate units and
timestamps, resolve duplicates, exclude ineligible forecasts, group by local
date, and calculate the chosen metric. Report each date's usable sample count
and coverage; a complete local date expects 24 hourly timestamps. Establish the
minimum coverage rule before ranking, and keep insufficient dates visible.

The result should retain exact input references, all tied highest dates, the
chosen metric and timezone, and an independent numerical check. With incomplete
coverage, report the highest date **among the available eligible dates**, with
the missing period stated; do not claim it was the worst date of the whole month.

See the [PM2.5 capability guide](../../app/capabilities/pm25/README.md) for the
existing retrieval and coverage analysis.
