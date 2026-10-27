# 2c. A key requirement for a stronger USL

## Answer

### Key requirement

> For an approved haze-episode area and explicit time window, an analyst can
> get a repeatable report of air-quality readings, FIRMS detections, and
> weather data, with each source and its time and location coverage clearly
> shown.

This supports the episode-investigation use case in the
[Haze Agent Architecture v0.14](../../docs/architecture/Haze_Agent_Architecture_v0.14.pdf):
build a timeline from sources and show what data is available.

### Example feature: episode evidence bundle

Create a saved query over the existing Environmental USL. It should take a
selected area and time period, then show matching readings, detections,
forecasts, and missing data.

### Example resulting USL design (proposed, not deployed)

If the query needs to save its scope and results, two extra tables could track
the episode and per-source coverage. This is a design sketch, not Zetaris-ready
DDL:

```text
episode_scope(
  episode_id,
  scope_version,
  start_time_utc,
  end_time_utc,
  boundary_reference,
  created_at_utc
)

episode_source_coverage(
  episode_id,
  scope_version,
  source_entity,
  record_count,
  first_event_time,
  last_event_time,
  retrieved_at_utc,
  missing_count,
  invalid_count,
  coverage_notes
)
```

Keep measurement data in its existing source tables. These new tables would
only record the query scope and coverage.

## Why this improves the current state

The feature reuses current sources and makes an episode query easier to repeat
and review. It does not require new PM2.5 or FIRMS acquisition.
