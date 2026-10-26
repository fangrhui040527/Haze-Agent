# PM2.5 evidence summary

This capability retrieves stored modeled PM2.5 samples for one town and a bounded
period, calculates coverage and concentration range, and independently checks the
result. It is registered as `pm25-evidence-summary`, version `3`, through
`createPm25Capability()` in [index.ts](index.ts).

## Inputs and source

Provide a location and an increasing start/end interval of at most 31 days. The
start is inclusive and the end is exclusive. An explicit request `scope` has this
shape:

```json
{
  "location": "Klang",
  "period": {
    "start": "2026-10-24T00:00:00Z",
    "end": "2026-10-25T00:00:00Z"
  }
}
```

The capability can also infer scope from an objective such as:

> Investigate PM2.5 evidence for Klang during 2026-10-24 to 2026-10-25.

Date-only values in this phrase mean midnight UTC. Conflicting explicit and
inferred scopes require clarification.

The read-only tool `zetaris-smokeledger-pm25` queries existing `sl_pg.pm25` and
`sl_pg.towns` data through Zetaris. It selects only model rows from
`open-meteo-air-quality` (Open-Meteo/CAMS), retains the exact response, SQL and raw
row indices, and selects the latest locally ingested row for each sample time.
The raw selection is bounded to 1,500 rows; truncation is recorded.

Live execution requires the existing Zetaris service and credentials described
in the [project setup guide](../../../README.md). This capability reads stored
data; the ingestion scripts are separate operator tooling. Fixture execution
explicitly uses synthetic captures. Replay requires an explicitly supplied
source, and a failed live request never silently substitutes fixture data.

## Work and outputs

| Assignment             | Role           | Responsibility                                                                                                                    |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `pm25.retrieve`        | HazeOps        | Retrieve and validate the exact scoped selection; save `pm25.capture` or an `evidence.gap`.                                       |
| `pm25.analyze`         | WorkerShield   | Save `pm25.analysis` with usable counts, expected hourly timestamp gaps, minimum/maximum, findings and source citations.          |
| `pm25.check`           | EvidenceCritic | Independently reconstruct counts, range, missingness and raw-source links; save a `review` naming the exact capture and analysis. |
| `pm25.observation-gap` | HazeOps        | Save an `evidence.gap` explaining that observation and attribution tools are unavailable.                                         |

Analysis and checking depend on retrieval and exchange the exact analysis
reference through a bounded `numerical-check` peer channel. The producer waits
for independent review. Coverage is `available`, `partial` or
`insufficient_evidence`; missing timestamps, null values and truncation remain
visible in the analysis.

The World Model adapter projects validated captures, analyses and reviews into
records with exact evidence references. It can propose an acceptance candidate
only for complete, untruncated evidence with matching scope and an independently
supported numerical review. That proposal does not itself grant accepted-state
authority.

## Limits

- Values are modeled instantaneous concentrations in µg/m³ at stored hourly
  timestamps. They are not ground-station observations or hourly averages.
- Provider issuance time, native model resolution and town-wide representativeness
  remain unverified. Local ingestion time does not establish a model run.
- No observation coverage, causal attribution, health advice or operational
  decision is established by this method.
- Fixture checks establish integration behavior. Live readiness requires a
  captured configured model and source-tool execution.

## Key files

| File                         | Purpose                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| [index.ts](index.ts)         | Capability, assignments, tool registration and peer review flow.                   |
| [contracts.ts](contracts.ts) | Scope validation, objective scope inference and coverage schema.                   |
| [evidence.ts](evidence.ts)   | Zetaris query construction, response validation and exact source selection.        |
| [methods.ts](methods.ts)     | Capture/analysis schemas, deterministic analysis and independent numerical checks. |
| [world.ts](world.ts)         | World Model projections, acceptance candidates and required review coverage.       |
| [fixtures.ts](fixtures.ts)   | Explicit synthetic evidence for fixture execution.                                 |

See the [capability index](../README.md) for related methods and the
[general engine guide](../../../docs/orchestration/general-engine.md) for task
execution.
