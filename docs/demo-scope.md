# Bounded demo scope and shared contracts

The reference design is [Haze Agent Architecture v0.13](Haze_Agent_Architecture_v0.13.pdf), especially sections 1, 3, 7, 15 and 19. It specifies behavior; it does not establish that an implementation or a workplace decision has been validated. The older [compatibility spike](compatibility-probe.md) remains an infrastructure result under its original v0.8 scope.

## Small demo boundary

The target demo compares activity start times for one crew in `my-selangor-klang` over one assessment horizon. Worker identities and assignments, activity identities, durations, locations, required service/quality, existing controls and resources stay fixed. Every worker's occupancy must be accounted for throughout the horizon, including breaks, travel, setup and waiting. Only permitted start times may move. There is no reassignment, overtime, new control or displacement of required work outside the horizon.

The delivered examples are fictional and use pseudonymous IDs. They exercise contract validation without employer participation, pollution-source access or provider credentials. The delivery surface is a separately labeled historical harness: `execution_surface=historical_harness`, publication disabled and operational recommendation eligibility false. A demo-local hash binds a local record; it does not make that record canonical or scientifically approved.

The eventual comparison must distinguish numerical improvement, policy threshold attainment, independently verified search scope, optimality and operational eligibility. An incomplete search can retain an independently checked improving candidate without proving a global optimum. Missing essential baseline evidence yields explicit insufficiency and null quantified results; it must never become zero exposure or an invented recommendation.

## Shared files and validation

| Contract           | Source                                      | JSON Schema                                                | Example                                             |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `haze.planning.v2` | [planning.ts](../app/contracts/planning.ts) | [planning schema](../schemas/haze.planning.v2.schema.json) | [planning.json](../input_examples/v2/planning.json) |
| `haze.run.v2`      | [index.ts](../app/contracts/index.ts)       | [run schema](../schemas/haze.run.v2.schema.json)           | [run.json](../input_examples/v2/run.json)           |
| `haze.result.v2`   | [result.ts](../app/contracts/result.ts)     | [result schema](../schemas/haze.result.v2.schema.json)     | [result.json](../output_examples/v2/result.json)    |

The planning bundle describes the fixed work, assessment, baseline and immutable references. The run request contains `schema_version`, `programme_id` and `input` with `operation=plan_outdoor_work`, `problem_id`, `bundle_ref` and optional explanatory `query`. It does not accept inline operating facts, a caller-selected mode or a caller-selected run ID. The result envelope keeps execution state, input assessment, evidence, decision axes, publication/currency, integration status, timing and limitations separate.

Zod definitions are the executable source of truth. Generated JSON Schemas use Draft 2020-12 and closed objects; semantic and format checks run in the application validator. A structural schema pass alone cannot prove evidence suitability, review authority, planner arithmetic, scientific applicability or canonical currency. Unsupported contract versions require explicit migration; they are not automatically coerced to v2.

From the repository root, after installing dependencies:

```sh
npm run build
npm run contracts:check
npm run contracts:validate -- planning input_examples/v2/planning.json
npm run contracts:validate -- run input_examples/v2/run.json --surface historical_harness
npm run contracts:validate -- result output_examples/v2/result.json
```

Use `npm run contracts:generate` after rebuilding a deliberate schema change. Check the generated schemas and matching fixture hashes into the same change. `contracts:check` detects schema drift, validates the fixtures and checks their bindings. `contracts:validate` reads and validates JSON; it does not run the solver, admit a job or publish a result. A run fixture requires the explicit historical surface because demo-local references are invalid on the canonical surface.

The local record manifest is [demo-records.json](../input_examples/v2/demo-records.json). It supplies the exact fictional bytes behind fixture references; the baseline record includes its assignments, and the policy record contains only the explicitly fictional thresholds for the engineering example. Other method, attestation and review records remain placeholders, not accepted authority or evidence. After deliberately editing the fixture, `npm run contracts:fixtures` refreshes these local reference hashes and the request/result bundle bindings. It never creates canonical records or computes a result.

The [two-worker fixture guide](two-worker-fixture.md) documents source mapping,
illustrative schedules, local hash regeneration, the synthetic hourly PM2.5
fixture and non-executable App/Planner/Verification/WorkerShield handoffs. The
fixture is not accepted environmental evidence and supports no operational
comparison or recommendation.

`haze.canonical-json.v1` hashes UTF-8 JSON without insignificant whitespace, with object keys sorted by UTF-16 code units, array order preserved, and ECMAScript finite-number/string encoding. This serializer is versioned independently of the domain contracts. JSON input is limited to 1 MiB and nesting depth 64; duplicate keys, nonfinite numbers, implicit coercion and unknown properties are rejected. The planning representation supports at most seven days, 64 workers, 64 resources, 128 locations and 256 activities, with whole-minute `+08:00` timestamps. These are explicit engineering limits, not operating or scientific thresholds.

## Defined versus implemented

| Area                              | Delivered here                                                                              | Remaining boundary                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Small scope                       | Written fixed-work timing boundary, synthetic example and explicit cut lines                | Supervisor-confirmed ordinary operating case and permissible alternative                                    |
| Planning/run/result formats       | Executable v2 contracts, generated schemas, semantic validation and matching local fixtures | Full controlled import, acceptance and authenticated API/job admission                                      |
| Result illustration               | Synthetic historical response with explicit gaps and no operational eligibility             | Actual planner-produced comparison and captured execution/result evidence                                   |
| Feasibility, exposure and ranking | Contract fields and validation rules                                                        | Deterministic interval integration, policy ranking, required scenarios and independent numerical checker    |
| Agent and explanation             | Status/provenance boundaries in the result contract                                         | Bounded WorkerShield investigation, typed fact checks, controlled rendering and exact EvidenceCritic review |
| Engines and persistence           | Existing pinned-engine/checkpoint compatibility spike                                       | v0.13 canonical accept/hold/publish/read/event capability and race/recovery proof                           |
| Operational usefulness            | Explicitly unverified                                                                       | Real-world feasibility gate, decision-time evidence, qualified intended-use review and approved policy      |

The result fixture is hand-authored contract data, not a successful agent run, a planner score, a reviewed engineering calculation or proof that pollution information distinguishes schedules. Unexecuted integrations remain labeled as such. The original `npm start` runner still validates checkpoint metadata; its `schemaVersion: 2` does not implement the v2 domain workflow.

## Cut lines and next implementation work

Keep regional damage modeling, field-effect evaluation, prevention dispatch, broad monitoring, extra providers, new controls, reassignment, overtime and automatic memory synthesis outside this slice. The demo must not issue roster changes or workplace instructions. Team distribution and member acknowledgments are excluded from this task.

The next implementation sequence is: deterministic producer and independent checker against the fixed contracts; checked facts and controlled material; exact independent review; then conditional canonical publication only after the installed engine's authority, current-read and recovery gates have been proved. Until those gates and real-use prerequisites pass, retain the historical surface and false operational eligibility. Contract validation and the existing compatibility probe do not close those gates.
