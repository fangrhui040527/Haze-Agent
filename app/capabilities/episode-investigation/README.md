# Episode investigation

This capability records an episode's supplied scope, links available analysis
artifacts and reports gaps in observation and causal-attribution evidence. An
independent reviewer checks the exact context and gap references while preserving
the unresolved branches.

The registered capability is `episode-investigation`, version
`episode-investigation.v3`. Its card lists HazeOps, WorkerShield and EvidenceCritic;
the two built-in assignments use WorkerShield and EvidenceCritic. The matching
predicate recognizes episode, investigation, haze and PM2.5 objectives, with an
exception for requests to explain supplied reports or sources.

## Inputs and use

The gap assignment accepts an explicit scope with an `episode_id` and `label`.
Geography and period are optional; any supplied period must have a positive,
end-exclusive interval:

```json
{
  "episode_id": "klang-2026-10-24",
  "label": "Klang haze investigation",
  "geography": { "id": "klang", "label": "Klang" },
  "period": {
    "start": "2026-10-24T00:00:00Z",
    "end": "2026-10-25T00:00:00Z"
  }
}
```

It links input artifacts whose kinds end in `.analysis`, preserving their exact
ID, version and hash. Invalid or absent scope remains unresolved; this assignment
does not infer one from the objective.

## Execution and outputs

| Assignment                     | Role           | Behavior and output                                                                                                                                   |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `episode-investigation.gaps`   | WorkerShield   | Saves `episode-investigation.evidence-gaps` and a generic `evidence.gap`. With valid scope, also saves `episode-investigation.context`.               |
| `episode-investigation.review` | EvidenceCritic | Reads exact context, gap and analysis artifacts, checks scope/reference consistency, and saves `episode-investigation.review` when scope is resolved. |

The default review depends on the gap assignment and receives references through
the `episode-review` peer channel. If scope is unresolved, review completes with
an explicit gap and no review artifact. A scoped review retains a `partial`
verdict because the observation and attribution branches remain unresolved.

`createEpisodeInvestigationCapability(methods)` can prepend other assignment
plans. The [composition root](../../composition.ts) currently supplies no such
plans, so this capability does not automatically run
[PM2.5 retrieval and analysis](../pm25/README.md). Those methods are registered
separately and can contribute analysis artifacts when included in a task plan.
The built-in episode assignments call no external tools.

The World Model adapter projects episode contexts, linked analyses, scoped gaps
and exact review references, with content-hash and scope checks. It also defines
review coverage and acceptance-candidate checks; a candidate does not itself
authorize an accepted-state decision.

## Limits

- Observation and independent causal-attribution adapters are not configured;
  both branches are reported as `unresolved` with `not_configured` availability.
- Missing adapter access does not establish that an event or measurements are
  absent in the world.
- Episode identity and geography are supplied labels rather than independently
  geocoded facts.
- Review checks references and declared evidence availability. It does not
  establish event occurrence, source authenticity, causal attribution or
  scientific applicability.

## Key files

| File                         | Responsibility                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| [index.ts](index.ts)         | Capability matching, optional method composition, gap reporting and review assignments. |
| [contracts.ts](contracts.ts) | Episode scope, context, evidence-gap and review schemas.                                |
| [world.ts](world.ts)         | World Model projections, review coverage and acceptance-candidate checks.               |

See the [capabilities overview](../README.md) for the other registered methods.
