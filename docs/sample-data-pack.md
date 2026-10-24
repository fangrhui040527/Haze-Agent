# Fictional sample data pack and source notes

This is the release note for the demonstration data pack: what is in it, where
every value came from, how to import and run it, what each fixture is expected
to produce, and what it does not establish. The reference design is
[Haze Agent Architecture v0.13](Haze_Agent_Architecture_v0.13.pdf), especially
sections 4, 17-19 and 23-24.

Everything here is fictional. The pack supplies no Malaysian observation, no
employer practice, no approved policy and no operational approval. It
demonstrates input mechanics only.

## What the pack establishes, and what it does not

| Established by this pack                                                              | Not established                                             |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Closed v2 contracts parse, validate and bind to exact bytes                           | That any value is a measurement, forecast or operating fact |
| Every occupied worker/activity interval resolves to the exact hourly record behind it | That the proxy is scientifically applicable to a workplace  |
| Missing, flat and invalid inputs produce precise, coded diagnostics                   | That a planner, checker or UI exists to consume them        |
| Import is deterministic over bytes, and altered bytes change the hashes               | Evidence acceptance, review authority or canonical currency |
| The architecture's section 23 arithmetic is reproducible from the fixture             | That any schedule should be recommended or acted on         |

`execution_surface` is `historical_harness`, `publication_status` is
`publication_disabled`, and `recommendation_eligible` is `false` throughout.
Validation is a local engineering check; it is never acceptance.

## Files

The manifest is [`input_examples/v2/MANIFEST.json`](../input_examples/v2/MANIFEST.json).
It records 38 files with byte lengths and SHA-256 hashes, the contract and
serializer versions, the pinned sensitivity method, the source-selection rule,
the timezone, window, planning step, canonical unit and native resolution, the
bundle and evidence references, and the capabilities this repository does not
implement.

| Group                 | Files                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid planning inputs | [`planning.json`](../input_examples/v2/planning.json), [`run.json`](../input_examples/v2/run.json), [`demo-records.json`](../input_examples/v2/demo-records.json), [`verification-schedules.json`](../input_examples/v2/verification-schedules.json) |
| Valid environmental   | [`environmental/`](../input_examples/v2/environmental/): `nominal-pm25.csv`, `nominal-evidence.json`, `nominal-series.json` and the `plus-20-*` triple                                                                                               |
| Negative cases        | [`negative/`](../input_examples/v2/negative/): one directory per case plus [`scenario-matrix.json`](../input_examples/v2/negative/scenario-matrix.json)                                                                                              |
| Outputs               | [`result.json`](../output_examples/v2/result.json) (hand-authored contract example), [`fixture-ledger.json`](../output_examples/v2/fixture-ledger.json) (case/outcome ledger)                                                                        |

The pinned bundle is `demo:klang-fixture-input-v2` revision 1. Its four
evidence references are `demo:pm25-yard-nominal`, `demo:pm25-office-nominal`,
`demo:pm25-yard-plus-20` and `demo:pm25-office-plus-20`, each at revision 1.
The manifest carries their exact hashes; a demo-local hash binds local bytes
and makes nothing canonical.

## Import and run

```sh
npm ci
npm run build

# Contract-level validation of the valid pack
npm run contracts:check
npm run contracts:validate -- planning input_examples/v2/planning.json
npm run contracts:validate -- run input_examples/v2/run.json --surface historical_harness

# Input and evidence validation, with coverage diagnostics
npm run inputs:validate
npm run inputs:validate -- --case missing-baseline-coverage

# Deterministic import across the shared boundary
npm run inputs:import

# Evidence linkage traces for one scenario
npm run inputs:links -- --case valid --scenario nominal

# Every case against its declared expectation
npm run inputs:ledger
```

Regeneration, after a deliberate fixture edit:

```sh
npm run contracts:fixtures   # rebind demo-local hashes and bundle bindings
npm run inputs:negative      # re-derive the negative cases from the valid pack
npm run inputs:manifest      # rewrite the manifest hashes
npm run inputs:ledger        # re-check every case outcome
```

`npm run check` runs the whole sequence including `inputs:check`, which fails
if any case stops matching its declared expectation.

## Case matrix and expected outcomes

Each case declares its own expected outcome category in its `case.json`, written
by hand and independently of the code under test. The generator records the
exact transformation that produced it.

| Case                                                                                                 | Expected outcome                              | Import           | Quantified comparison | Key finding code                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------- | --------------------- | ----------------------------------------- |
| valid pack                                                                                           | `admitted_with_supported_coverage`            | `imported`       | available             | none                                      |
| [`missing-baseline-coverage`](../input_examples/v2/negative/missing-baseline-coverage/case.json)     | `admitted_with_environmental_insufficiency`   | `imported`       | null                  | `environmental_baseline_coverage_missing` |
| [`missing-candidate-coverage`](../input_examples/v2/negative/missing-candidate-coverage/case.json)   | `admitted_with_supported_coverage`            | `imported`       | available             | `environmental_coverage_gap`              |
| [`flat-pollution`](../input_examples/v2/negative/flat-pollution/case.json)                           | `admitted_with_supported_coverage`, zero gain | `imported`       | available             | none                                      |
| [`invalid-baseline-precedence`](../input_examples/v2/negative/invalid-baseline-precedence/case.json) | `operating_input_invalid`                     | `draft_rejected` | null                  | `precedence_violation`                    |

Three distinctions the matrix exists to protect:

- **Missing is not zero.** A withheld hour stays an explicit null with a reason.
  The baseline case returns a null quantified comparison and the precise gaps;
  nothing is interpolated, zero-filled or replaced by an invented indoor ratio.
- **A gap can be scoped.** When the absent hour is one the baseline does not
  occupy, the baseline stays covered and only the alternatives needing that hour
  are excluded. A supported-subset conclusion proves nothing about the excluded
  options, and the exclusions are reported.
- **Flat sources give zero gain, and that is a correct answer.** With each
  location constant and coverage complete, fixed-duration activities contribute
  the same integral wherever they start. The case names its checked search scope
  — the baseline and the two illustrative schedules, explicitly non-exhaustive —
  rather than implying anything about undiscovered schedules.

An environmental insufficiency is a completed domain answer, not a server
fault: the validator maps it to `200`, malformed or unsupported contracts to
`400`, and invalid operating semantics to `422`.

## Source notes: where every value came from

All of the following are fictional engineering choices, not observations,
approvals or operating practice.

| Item                                       | Origin                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Window and grid                            | 25 October 2026, 08:00-12:00, `Asia/Kuala_Lumpur`, 15-minute planning step (Architecture v0.13 §23)                                        |
| Workers `worker-a`, `worker-b`             | Pseudonymous inventions. No diagnosis, restriction or physiological profile is represented                                                 |
| Activities and locations                   | Inspection 60 min yard, maintenance 60 min yard after inspection, administration 120 min office; identities, durations and locations fixed |
| Baseline starts                            | Inspection 08:00, maintenance 09:00, administration 10:00 (§23)                                                                            |
| Yard PM2.5, nominal                        | 100, 80, 50, 30 ug/m3 by hour, transcribed from the §23 table                                                                              |
| Office PM2.5, nominal                      | 20 ug/m3 each hour, **independently invented**. Not a filtration ratio, not derived from the yard series                                   |
| `+20` sensitivity                          | Pinned method `fixture:pm25-add-20-ug-m3` version `1.0.0`, adding exactly 20 ug/m3 to every location-hour                                  |
| Benefit floor, movement caps               | 10% in each required scenario; 360 total activity-minutes, at most 3 changed activities, at most 120 minutes per activity (§23)            |
| Illustrative schedules                     | I08/A09/M11 and A08/I10/M11. Two examples for verification tests, **not** an exhaustive feasible set and not planner output                |
| No-travel, no-setup, no-bottleneck records | Fixture-only assumptions with `operational_attestation: false`                                                                             |
| Policy record                              | `approval_status: not_approved`, `operational_use_allowed: false`                                                                          |

The `+20` case is an artificial perturbation for testing software behaviour. It
is not a forecast-error distribution, a supported scientific uncertainty, a
confidence interval or an operational uncertainty treatment.

### Hourly values on a 15-minute grid

Each hourly concentration applies as a piecewise-constant value over its
half-open source interval `[start, end)`. An activity crossing an hour boundary
takes each interval's value for the overlapping duration — 08:45-09:15 is 15
minutes of the 08:00 hour and 15 minutes of the 09:00 hour. The allocation is a
calculation trace over declared hourly information. It creates no quarter-hour
observation, and the trace records say so (`derived_segment: true`,
`creates_new_observation: false`).

### Reproduced section 23 arithmetic

The linkage traces reproduce the architecture's example exactly, from the
fixture bytes rather than from a stored answer. Per worker, matched-activity
integrals are inspection 100, maintenance 80, administration 40, giving 220 per
worker and 440 for the crew on the baseline; 170 and 340 for I08/A09/M11; and
120 and 240 for A08/I10/M11. Under `+20` the same figures are 300/600, 250/500
and 200/400. Per-worker units are `ug/m3 * hours`; crew units are
`person-hours * ug/m3`.

These are reproductions of a fictional example's arithmetic. They are not a
planner result, a policy decision, a verified search, or evidence that pollution
information distinguishes real schedules.

### Supplied source versus inherited references

The supplied architecture is `docs/Haze_Agent_Architecture_v0.13.pdf`. The
original reference package named in §23.2 — its reported 1,521 combinations,
three feasible plans and 21 prior checks — was **not supplied and has not been
rerun here**. Nothing in this pack re-executes that enumerator, and the three
displayed schedules are illustrative rather than a proved exhaustive set.

## Known limitations and unavailable capabilities

The importer reports these explicitly rather than simulating them:

| Capability                                    | Why it is unavailable                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `authenticated_post_run_admission`            | No HTTP server exists here. Demo-local references are rejected on the canonical surface by the contract validator    |
| `evidence_acceptance_and_review`              | No authorized reviewer or acceptance record exists; `disposition` stays `not_assessed`                               |
| `canonical_epoch_head_and_publication`        | Canonical state, current-read and publication gates are unproved; epoch, head and publication stay null with reasons |
| `qualified_intended_use_applicability_review` | Occupational-hygiene and environmental-method review are outside this slice; applicability stays `not_assessed`      |
| `planner_and_independent_numerical_checker`   | This boundary delivers pinned inputs only; no schedule is scored, ranked or selected                                 |

Stage status is recorded in the ledger: canonical JSON parsing, contract
validation, input and evidence validation, deterministic import and evidence
linkage are **run**; planner, independent numerical verification, the
application interface, evidence acceptance review and canonical publication are
**not run**.

### Unresolved interface decisions

- **No backend contract between the data layer and the frontend.** The pack is
  loadable through `app/import/loader.ts`, but no HTTP API serves it, so the
  app-side adapter shape is still open. The owner of that interface should
  choose it before adapters are written.
- **Series values are only bound to their source through the locator.** The
  pinned chain is raw bytes -> `raw_sha256` -> locator rows ->
  `selection_sha256`; `linkEvidence` additionally re-checks every resolved value
  against its source row. There is no separate hash over the resolved series
  document itself, so that cross-check is the integrity guarantee.
- **Required scenarios are supplied by the caller.** The validator does not read
  the policy record to discover which scenarios are required; callers pass
  `requiredScenarios`. Wiring that to the policy record is a decision for whoever
  owns policy loading.
- **One series per location.** The pinned selection rule
  `single_declared_series_per_location_v1` rejects conflicts rather than ranking
  alternatives. A real multi-run source needs a versioned successor rule.

## Data protection

The pack contains no secret, credential, identifiable worker data or clinical
information. Worker identities are pseudonymous inventions; `.env.example`
holds placeholders only.

## Presentation wording

Use this, or wording no stronger:

> This is a concentration-time screening proxy over fictional hourly PM2.5
> data. It compares when fixed work happens, using modelled exposure
> screening — not a worker-safety guarantee, a dose model or a health
> assessment. All workers, locations, concentrations, thresholds and scenarios
> are invented. Workplace usefulness and operational applicability are
> unverified, publication is disabled, and no schedule here is eligible for an
> operational recommendation.

Do not describe the `+20` case as forecast uncertainty, do not present any value
as a live condition or forecast, and do not present a selected engineering
candidate as an instruction to change work.
