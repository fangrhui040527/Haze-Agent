# Damage reduction pilot and delivery implementation report

Implemented the recordkeeping milestone from
[Plan 04](damage-reduction-04-pilot-delivery.md) on 27 October 2026. Programmes
can explicitly draft and review pilot feasibility/protocols, register immutable
protocols, append amendments and retain exact delivery, deviation and
verification evidence through restart. Live alert/scheduling adapters remain
deferred. All qualification and achieved-reduction fields remain unqualified
and false respectively.

## Contracts and bounded pilot workflow

Added browser-safe pilot contracts in `app/contracts/damage-reduction-pilot.ts`,
re-exported through `app/contracts/damage-reduction.ts`. They define supplied
design inputs, feasibility, protocol drafts, independent review, registration,
amendments, versioned digital actions, service receipts, deviations and delivery
verification. Existing programme contracts accept the new typed records and
optional pilot fields without rewriting older snapshots or history.

The new explicit `pilot` phase requires a selected current reviewed planning
attempt and its exact assessment dependency. A programme revision selects an
immutable `pilot_input_ref`; saving or importing that input does not start a
task. WorkerShield drafts feasibility/protocol artifacts and EvidenceCritic
independently reconstructs their scope, copied declarations, classification,
provenance and missing prerequisites from the original inputs. No universal
power, sample-size or causal-estimation method is introduced.

Feasibility retains design/comparator identification, baseline availability,
measurement, outcome latency, precision/power, attrition/clustering, budget and
timing findings, exact calculations, assumptions and a supplied independent
scientific-review attestation. Missing or unusable inputs produce conditional
or delivery/exposure/feasibility-only classifications. A capable-design label
reports supplied reviewed design support; it does not authenticate credentials,
reproduce scientific calculations or grant scientific qualification. Synthetic
upstream evidence and unresolved current-plan objections remain prerequisites.

Protocol drafts bind programme/target/scope hashes, exact assessment and plan
references, endpoint/unit/population/comparator, baseline and outcome windows,
analysis/method versions and uncertainty interpretation, threshold relation,
missingness/deviation rules, stopping criteria and delivery checks. Digital
rules retain owner approval, trigger sources, permitted actions, operating
scope, safeguards and pause/disable instructions.

The phase shares Plan 03's atomic admission, exact run binding, one-active-phase
rule, three attempts per phase, twelve total runs and 400 model/tool allowances.
Actual admitted run maxima are reserved and authoritative terminal usage is
reconciled. Generic task corrections/Continue cannot bypass programme bounds.
Registration and amendments must adopt the exact current reviewed pilot attempt
admitted by that programme; a separate task cannot contribute unreserved work.
Record appends create no agent run or service action.

## Registration and amendment history

The existing records route and SQLite repository retain all new families under
the same expected-revision, idempotency, identity, workspace and mode boundary.
Original records remain immutable. Records have a shared ceiling of 32 and
128 KiB total retained record data; supplied pilot inputs and programme
snapshots are bounded to 64 KiB. Oversized work is rejected explicitly.

Registration records use server record time and exact reviewed artifact
references. Outcome-access attestations and supporting external registration
evidence remain labelled attestations. Imported earlier dates cannot backdate
the local registration. Unknown, late, contradictory or outcome-aware timing
does not become prespecified through a new target, fresh arithmetic or a later
`not_started` declaration. Known outcome access remains latched even when its
older supporting source becomes held or inaccessible.

Amendments retain reasons, timestamps, actual affected fields and outcome-access
stage. Declared fields must cover the real protocol changes; operational rule
changes require a new rule identity/version. Original registered analysis is
preserved beside prospective amended or exploratory analysis. Amendments fence
the affected pilot use through the programme fingerprint and cancel any
affected active draft without automatically starting a replacement. Current
record projections recheck the exact current assessment/plan lineage and
source/review access on every read.

## Delivery evidence and verification

Digital-action records bind action ID/version, permitted action, exact rule
version, trigger references, time and affected scope. Imported receipt fields
must agree with that identity and payload. Provider acceptance means submission;
alert transmission, recipient receipt and an applied schedule change are
separate confirmation levels. Later approval cannot retroactively authorize an
earlier action. Missing, incompatible, failed and unknown receipts remain
visible; human reports cannot replace service confirmation.

Simulations remain simulated across later records and missing evidence. Receipt
wrappers, raw receipt evidence, trigger/rule proofs and verification evidence
retain synthetic provenance. Incomplete historical proof cannot erase known
simulation or unresolved-unknown state. An unknown outcome requires exact
receipt reconciliation against its retained unresolved event before confirmed
reuse. New operation keys may append duplicate evidence history; they do not
execute or replay a digital action.

Independent verification binds only the exact supported action subset,
including action version, permitted action, trigger references, rule, scope and
confirmation level. Future or pre-action attestations, unavailable proof and
synthetic evidence cannot publish verified action labels. Coverage updates are
applied only after validation completes, and later partial coverage cannot
downgrade an existing valid verification. Material deviations, unresolved
failures and current-source gaps remain explicit. Delivery confirmation alone
does not establish reduced exposure or damage.

## Runtime and browser integration

Composition registers the new bounded methods, assignments and
`reduction-pilot` task view under the existing capability and roles. The generic
task store can resolve producer provenance for exact explicitly admitted
context references, enforcing current applicability, identity, mode, grants
and holds. The coordinator explicitly pins the bounded dependency closure.
Supporting independent reviews remain dependencies; they cannot become direct
factual products. This supplies the exact cross-run handoff needed for pilot
drafts without granting World Model acceptance.

The programme page now has Pilot and Delivery panels, supplied-input import and
revision, explicit reviewed-plan selection, bounded typed record entry, exact
draft/source links, registration/amendment history, action/receipt levels,
deviations and verification. Failed current reads withhold pilot eligibility.
Standalone previews and prior programme routes remain available. No adapter
contacts recipients or changes schedules; the UI labels live execution as
deferred.

## Verification

All **17 pilot API/integration tests** pass, including real
assessment/planning/pilot workflows, missing scientific inputs, immutable
registration, outcome-aware corrections, exact receipts, partial verification,
identity/mode boundaries, rollback, restart and direct-task adoption/budget
bypass checks. **21 focused domain/history-latch tests** and **4 admitted-source
provenance tests** pass. Existing review-boundary and programme-domain checks
also pass 23 cases.

The frontend production build and **271 tests** pass, with one existing skipped
test. React/accessibility review covered explicit mutations, revision-pinned
forms, abortable reads, current/stale labels, unique headings, source inspection
and responsive long identifiers. No browser automation was attempted because
the earlier browser session ended under an automation guard.

The fresh-process pilot verifier passes. Its retained
[JSON trace](../../.state/damage-reduction-pilot-verification/d453c6e1-15b8-4e9d-a61e-24256d735a0c/report.json)
contains four explicit runs and eight typed records, exact restart projections,
immutable original registration, historical receipt replay, unknown-outcome
reconciliation, simulation/human-report isolation, partial verification,
material deviations and required-grant revocation.

| Explicit run                   | Latency |
| ------------------------------ | ------: |
| Assessment                     |  1.94 s |
| Planning                       |  3.64 s |
| Pilot draft and review         |  4.00 s |
| Amended pilot draft and review |  8.39 s |

The four runs used **0 model calls, 12 tool calls, 26 charged artifacts and 16
assignments**. After reconciliation, reservations are zero and remaining
capacity is 400 model calls, 388 tool calls and eight runs, with two assessment,
two planning and one pilot attempt remaining. Record-only operations add no
agent calls or runs. These engineering timings vary with machine load and do
not measure live model/provider performance.

Run `npm run reduction:pilot:verify` to reproduce the fresh-process trace. It is
also included in `npm run test:integration`. The frozen verification themes are
in `docs/Testing/damage-reduction-pilot-cases.json`.

The broader backend regression command
`npm test -- --maxWorkers=4 --exclude '**/damage-reduction-pilot-integration.test.ts'`
passes **937 tests across 83 files**. The separately run 17-case pilot API suite
takes about six minutes and was excluded from this second run to avoid
duplicating it. Both groups passed. The normal backend build, TypeScript checks,
engine-pin verification and scoped ESLint/formatting pass.

Fresh-process compatibility verifiers also pass for
[Plan 03 programme coordination and same-task crash recovery](../../.state/damage-reduction-programmes-verification/a9a10d13-c1ff-4ec3-837a-6653f8192646/report.json)
and [Plan 02 preview cases, restart and controls](../../.state/damage-reduction-preview-verification/c0f70fa0-5c8e-4d7d-9ea0-d97acac1e5f9/report.json).
No build was run concurrently with those verification processes.

Five route-evaluation checks and the pinned H-MEM/World Model conformance
checks pass. `git diff --check` and formatting for the changed feature files
also pass. Repository-wide ESLint reports one issue in the concurrently changed
Nightshift automatic-chain callback `TaskRuntime.routesAvailable`: it is marked
`async` without an `await`. That callback was preserved; the Plan 04 contracts,
methods, records, frontend and verification files pass scoped ESLint.

`npm run check` verifies engine pins and then stops at four existing formatting
failures under `tools/damage_data_discovery/`:
`CRAWLER_CAPABILITIES_AND_DATA_GAPS.md`,
`DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md`, `PILOT_READINESS_MATRIX.md` and
`seed_sources.json`. Those files were preserved. The applicable checks above
were run separately, so the aggregate command is not reported as passing.

## Remaining release gates

Live delivery readiness requires a verified provider adapter that enforces
agreed rules, action idempotency, accurate receipts, pause/disable controls and
unknown-outcome reconciliation. Imported records and simulations do not satisfy
that gate. A named non-synthetic reference, scientific-owner applicability
review and configured live workflow measurements remain outstanding. Comparative
outcome evaluation and achieved-damage claims belong to Plan 05.
