# Plan 02 implementation report: conditional planning preview

Recorded: 27 October 2026 (Asia/Singapore).

The local application now supports a saved conditional planning preview for one
physical target, one ordinary-management comparator and one proposed digital
intervention. The operator imports exact scenario evidence, selects numerical
rows, declares the proposed rules and constraints, and receives a retained
assessment, conditional plan and independent reviews. A below-target result,
blocked option or precise evidence gap is a valid saved outcome.

The engineering preview remains scientifically **unqualified**. It sends no
alerts, changes no schedules and establishes no achieved reduction. A named
non-synthetic reference case, applicability dossier and configured live-model
evaluation remain outstanding. Plans 03–05 were not implemented.

## What changed

| Area                    | Result                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser-safe contracts  | `app/contracts/damage-reduction-plan.ts` defines the versioned preview request, candidate, rules/approval attestation, constraints, costs, dependencies, prerequisites, objections, conditional plan and independent review. `damage-reduction-view.ts` defines the governed read projection.     |
| Conditional planning    | `planning.ts` consumes exact selection, assessment, arithmetic review, candidate versions and retained sources. Fixed planning actions require exact supporting references or explicit prerequisites. Missing rules, ownership, costs, capacity and scientific applicability stay visible.        |
| Independent plan review | `planning-checker.ts` independently reconstructs required prerequisites, objections, source closure, plan state and allowed recommendations. It also verifies numerical support through the independent arithmetic checker. It never calls the planning producer.                                 |
| WorkerShield            | Versioned instructions advance to `workershield.v4`, adding conditional planning while preserving evidence assurance. WorkerShield drafts `reduction.conditional-plan`; EvidenceCritic saves `reduction.plan-review`.                                                                             |
| Existing orchestration  | `preview-workflow.ts`, capability registration and composition append `reduction.plan` and `reduction.plan-check` after the original exact assessment and arithmetic review. Manager, HazeOps, DamageAccountant, WorkerShield and EvidenceCritic retain their existing authority boundaries.      |
| Current support         | `view.ts` rechecks exact artifact access, applicability, grants, holds, producer/reviewer revisions and both reviews whenever a saved preview is read. Historical review bytes alone cannot establish current eligibility.                                                                        |
| HTTP boundary           | A small domain-neutral registered task-view reader exposes `GET /api/tasks/:taskId/views/reduction-preview`. It uses the existing loopback/same-origin/local-identity boundary and composition-supplied domain code. No programme database or arbitrary write route was added.                    |
| Dedicated interface     | `/damage-reduction` provides intake; `/damage-reduction/tasks/:taskId` reopens saved work. Target, Assessment and Conditional plan show server-calculated figures, review state, exact sources, objections and next inputs. Existing imports, corrections, controls and task services are reused. |
| Repeatable checks       | Frozen supported/below-target/gap/blocked cases, focused backend/frontend tests and `scripts/verify-damage-reduction-preview.mjs`. `npm run reduction:preview:verify` builds and runs the retained API/restart trace; the integration command includes it.                                        |

The original Plan 01 assessment-only scope and immutable decimal input contract
remain supported. Preview requests wrap that selection with a candidate under
`haze.reduction.preview-request.v1`. Explanatory questions do not require the new
planning assignments, and damage planning takes precedence over broad appraisal
matching.

## Support and claim boundaries

Plans bind the exact target, source versions, selected rows, assessment,
independent arithmetic review and candidate hash. They preserve the intended
digital action, affected scope, proposed trigger/action rules, human rule owner,
approval attestation, constraints, costs and service dependencies. The planner
does not infer efficacy, available capacity, prices or delivered effects from
product specifications or imported prose.

A hard constraint violation or unsupported effect/delivery assertion blocks the
option even when its point estimate meets the numerical target. Unknown
quantities produce an evidence-gap plan. Below-target scenarios retain a material
objection; they do not become evidence that every possible intervention fails.
Supplied positive feasibility declarations still require human review of their
source alignment. An accessible reference establishes integrity/access, not
semantic entailment, authenticity or professional approval.

Synthetic provenance is retained from both numerical evidence and material
candidate evidence, including generated artifacts and JSON/string origin labels.
Unselected context does not become numerical input or material plan support.
Costs remain planning inputs, separate from the physical damage target.

The strongest planning label is **reviewed conditional planning preview**.
Unresolved scientific applicability stays an explicit prerequisite. Approval is
a retained local human attestation; this application does not authenticate
external reviewer identities. Scientific qualification, digital delivery,
achieved effects and World Model acceptance remain separate gates.

## Shared runtime changes

The existing final-artifact closure validator originally rejected every
EvidenceCritic artifact, including a review needed as a downstream dependency.
It now permits an exact supported registered review **only as a dependency** of
a current product. Direct reviewer artifacts and arbitrary critic opinions
remain prohibited as factual work products. Checks still enforce current
objective/run/revision, applicability and supported review coverage. Focused
tests cover stale/rejected reviews and the case where direct selection follows
an earlier dependency visit, preventing deduplication from bypassing the rule.

The frontend task hook gains an optional `restoreFromStorage` setting. The new
page disables implicit restoration so “Create another preview” opens a blank
intake while saved task URLs remain authoritative. Existing callers retain
their previous behavior. Governed reads refresh after task changes, controls,
window focus and an explicit recheck; stale asynchronous responses cannot replace
a newer run/objective view.

## Verification and retained evidence

Frozen representative cases are recorded in
`docs/testing/cases/damage-reduction-preview-cases.json` and the planning fixture
module. They cover a supported 12% point estimate, a 5% below-target estimate,
unknown quantities, a hard subgroup violation and specifications asserted as
effects. Deterministic expected outcomes were fixed before method/instruction
changes.

The API verification retains exact tasks, artifacts, events, projections,
resource limits, measured usage and a sequential computational baseline. It
checks original-source GET inspection, duplicate admission, fresh-process
readback, explicit correction/replacement history, revocation, and HTTP method,
query, unknown-view and cross-origin rejection. A separate control task preserves
the supported 12% task as a current result.

Browser verification used an isolated fixture state directory. It confirmed:

- Explicit synthetic source loading and per-row selection.
- Submission and navigation to saved task `2a97c097-91ce-41c7-972c-b0ecd2488858`.
- Exact server figures `1000`, `880`, difference `120`, ratio `120 / 1000`.
- Supported arithmetic and conditional-plan reviews with prominent synthetic,
  unqualified and not-delivered labels.
- Exact original-source inspection with matching version/hash and no observed
  browser console errors at that point.
- Desktop rendering and a 390 px mobile viewport with document width and scroll
  width both 390 px, without horizontal overflow.

The verified mobile screenshot is retained at
[mobile.jpg](../../../.state/damage-reduction-preview-ui/mobile.jpg). Desktop
rendering was inspected in the browser; a later desktop capture during hot
reload was blank and is not retained as verification evidence.
Later browser automation ended because the tool could not reliably determine
the current browser URL. A subsequent manual browser reload was not verified;
direct-route rendering is covered by frontend tests and server restart readback
by the API verifier. No further browser interaction was attempted after that
stop.

The final retained API report is:

`.state/damage-reduction-preview-verification/27e7ef3d-f4a9-43a2-846a-50dc6537c5b4/report.json`

The retained current supported task is
`1fbccabf-7ad0-4828-9f60-3a8b4e8fe293`. A separate control task retains its 15%
target correction, replacement history and subsequent permission revocation.
HTTP checks return the expected unknown-view `404`, unsupported-method `405`,
query `400` and cross-origin `403` responses.

| Frozen fixture                     | Governed task latency | Sequential kernel baseline | Result                                           |
| ---------------------------------- | --------------------: | -------------------------: | ------------------------------------------------ |
| Supported `1000 → 880`             |               3178 ms |                   62.27 ms | Conditional; point estimate meets target         |
| Below target `1000 → 950`          |               2748 ms |                   10.31 ms | Conditional; point estimate does not meet target |
| Unknown intervention quantity      |               2456 ms |                    9.41 ms | Evidence gap                                     |
| Hard subgroup constraint violation |               2383 ms |                    9.06 ms | Blocked despite numerical success                |
| Unsupported effect assertion       |               2417 ms |                    9.54 ms | Blocked despite numerical success                |

Every fixture used **0 model calls, 5 tool calls, 10 charged artifacts and 6
assignments**, within the unchanged 40/40/64/16 ceilings and two specialist
slots. The supported request serialized to 2347 bytes, original source to 1792
bytes, plan to 8263 bytes, final review to 4543 bytes and all artifacts to 38,049
bytes. The largest material dependency list had nine references. The supported
plan retained eight prerequisites. Measurements vary with machine load and do
not demonstrate a maximum live candidate bundle.

The normal backend build and full TypeScript checks pass. The frontend production
build and **213 tests across 32 files** pass. Focused planning/provenance tests
pass **25 cases**, review-dependency boundary tests pass **8 cases**, and preview
task/control/restart tests pass **7 cases**. Scoped TypeScript ESLint and
`git diff --check` pass. The existing React quality review was applied to hooks,
abortable reads, source inspection, responsive layout and accessible controls.
The complete backend regression run, `npm test -- --maxWorkers=4`, passes
**801 tests across 70 files**, including existing accounting, PM2.5, general
tasks, corrections and World Model behavior. WorkerShield retains its original
assurance safeguards while the new planning branch blocks unsupported
operational recommendations.

`npm run check` verifies engine pins but stops on formatting in four unrelated
files under `tools/damage_data_discovery/`: `CRAWLER_CAPABILITIES_AND_DATA_GAPS.md`,
`DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md`, `PILOT_READINESS_MATRIX.md` and
`seed_sources.json`. Those existing files were preserved. Applicable build,
type, lint, unit, frontend and fresh-process checks were run separately as
recorded above.

## Benchmark interpretation and remaining work

The sequential baseline invokes the same deterministic arithmetic/planning
kernels against the same original evidence with explicit review identities. It
compares computed outcomes and computational overhead with the governed task
trace. It omits task admission, persistence, governance and model behavior;
therefore it is **not** a live single-agent intelligence, usefulness or monetary
cost comparison. Fixture runs make no charged model calls, and live latency or
cost cannot be inferred from them.

A configured live coordinated trace and a fair live single-agent comparison
remain required before claiming model-level usefulness, coordination efficiency
or readiness. A non-synthetic reference and scientific-owner applicability
review remain required before operational qualification. Live adapters,
programme coordination, pilot registration, delivery/evaluation records and any
optional simulated action preview are deferred as allowed by Plan 02.
