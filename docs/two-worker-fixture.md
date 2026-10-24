# Fictional two-worker fixture

This guide describes the synthetic planning and verification inputs for the
25 October 2026 engineering example. It is a contract-fixture reference, not an
operating schedule, an approved policy, planner output, or a workplace
recommendation.

## Files and loading

| File                                                                                                | Use                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`input_examples/v2/planning.json`](../input_examples/v2/planning.json)                             | `haze.planning.v2` bundle: fixed work, workers, assessment, baseline, and immutable demo-local references.                                |
| [`input_examples/v2/verification-schedules.json`](../input_examples/v2/verification-schedules.json) | Two separate illustrative schedules for verification tests. The set is explicitly non-exhaustive; these schedules are not planner output. |
| [`input_examples/v2/demo-records.json`](../input_examples/v2/demo-records.json)                     | Local record bytes and hashes for planning, nominal/sensitivity environmental evidence, and illustrative schedule records.                |
| [`input_examples/v2/run.json`](../input_examples/v2/run.json)                                       | Historical-harness run-request shape referencing the planning bundle.                                                                     |
| [`output_examples/v2/result.json`](../output_examples/v2/result.json)                               | Hand-authored, publication-disabled result-contract example; not a calculation from these schedules.                                      |

Use the planning bundle with the normal contract validator:

```sh
npm run build
npm run contracts:validate -- planning input_examples/v2/planning.json
npm run contracts:validate -- run input_examples/v2/run.json --surface historical_harness
```

The illustrative schedules are a separate JSON fixture, not a `haze.planning.v2`
bundle and not a solver request. Tests load this file directly and check its
records against the planning bundle. Read those schedules as verification
inputs; do not pass them to Planner as answers or infer that they enumerate
every feasible schedule.

After intentionally changing fixture records, regenerate their demo-local
hashes and bundle bindings:

```sh
npm run contracts:fixtures
npm run contracts:check
npx vitest run --project unit tests/unit/planning-contract.test.ts
```

The fixture command binds local record bytes and updates dependent references.
It accepts no evidence, runs no planner, and produces no calculated result.
Keep its generated hashes and bundle bindings together with the edited fixture
files.

## Provenance and limits

### Source-derived example details

Architecture v0.13 §§3, 6, 17 and 23 define the fixture's intended mechanics:

- 25 October 2026, 08:00-12:00, `Asia/Kuala_Lumpur`, on a 15-minute planning
  grid.
- Two pseudonymous workers share inspection (60 minutes, yard), maintenance
  (60 minutes, yard, after inspection), and administration (120 minutes,
  office).
- Baseline starts are inspection 08:00, maintenance 09:00, administration
  10:00. Each worker's example occupancy covers the complete horizon.
- The two verification schedules are inspection 08:00 / administration 09:00 /
  maintenance 11:00 and administration 08:00 / inspection 10:00 /
  maintenance 11:00. They are illustrative, not an exhaustive feasible set.
- The fictional benefit floor is at least 10% in each of the nominal and
  `+20` sensitivity scenarios. Movement caps are 360 total activity-minutes,
  at most 3 changed activities, and at most 120 minutes per activity. Count a
  shared activity once for movement.

The +20 case is an artificial sensitivity perturbation, not supported forecast
uncertainty or an operational uncertainty policy. The architecture's pollution
example uses native hourly intervals and a piecewise-constant convention; a
15-minute planning grid does not create quarter-hour pollution measurements.

### Fixture-only assumptions

- Worker IDs, locations, services, policy, constraints, and schedule records are
  fictional and pseudonymous. Their local hashes bind fixture bytes only; they
  do not prove canonical acceptance, real operating practice, or scientific
  applicability.
- The no-travel/no-setup and no-relevant-resource-bottleneck records are limited
  to this fictional fixture and explicitly are not operational attestations.
- The policy record is `not_approved` and `operational_use_allowed: false`.
- The planning bundle references the demo-local nominal and fictional +20
  yard/office evidence records in
  [`input_examples/v2/environmental/`](../input_examples/v2/environmental/).
  These are synthetic, not accepted evidence. Their hashes and references bind
  fixture bytes only; they do not support a scientific or operational
  comparison.
- Synthetic origin and historical-harness surface remain distinct from
  execution mode. Publication is disabled and operational recommendation
  eligibility remains false.

## Handoff examples

These examples describe the intended boundary between future roles. They are
not implemented Planner or Verification executions.

### Planner handoff

```text
Input:
  planning bundle: input_examples/v2/planning.json
  baseline: demo:fictional-ordinary-baseline
  policy: demo:fictional-policy
  allowed work: inspection, maintenance, administration
  environmental evidence:
    fictional demo-local yard/office nominal and +20 series;
    not accepted for scientific or operational use

Request:
  Treat worker assignments, activity IDs, services, durations, locations,
  controls, and resource assumptions as fixed. Use only each activity's
  declared allowed_starts and preserve finish-to-start maintenance precedence.
  Do not select or return either illustrative verification schedule as a
  computed result. Since the supplied environmental evidence is fictional and
  unaccepted, do not calculate or claim exposure reduction or an eligible
  recommendation.
```

### Verification handoff

```text
Inputs:
  planning bundle: input_examples/v2/planning.json
  illustrative schedules: input_examples/v2/verification-schedules.json

For each supplied schedule, independently check:
  - the exact activity ID set and unchanged worker assignments;
  - start membership, release/deadline, duration, and horizon bounds;
  - maintenance finish-to-start precedence;
  - capacity and complete, non-overlapping occupancy for both workers;
  - movement counted once per shared activity against the fictional policy.

Report:
  These are two illustrative fixture checks, not planner output, a proved
  exhaustive set, canonical verification, or operational approval. The
  pollution series are fictional test inputs only; report operational
  environmental applicability and comparison as unavailable.
```

The repository currently provides contract validation and focused fixture
tests; it does not implement the Planner or an independent numerical
Verification engine described by these handoff examples.
