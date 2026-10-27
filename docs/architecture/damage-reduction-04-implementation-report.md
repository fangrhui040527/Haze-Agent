# Damage reduction pilot and delivery implementation report

The original verification results below are historical. The
[engineering follow-up](#engineering-follow-up-27-october-2026) records the later
recheck, fixes and current evidence.

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

## Engineering follow-up, 27 October 2026

This recheck covers engineering and recordkeeping. Scientific qualification is
unchanged. The user explicitly confirmed that live alert/scheduling adapters
should remain deferred; no external digital action was sent or scheduled.

Two delivery-record defects were found and fixed in `pilot-records.ts`:

- One logical action ID could change its trigger references, occurrence time or
  registration and use the changed receipt to reconcile an earlier unknown
  outcome. Append validation now binds those fields, and projection rechecks
  retained historical records. A mismatched historical reconciliation remains
  unknown. An exact reconciliation still succeeds, including equivalent
  timestamp instants expressed with different UTC offsets.
- A self-consistent receipt could publish recorded delivery while citing an
  unrelated trigger. Governed recorded delivery now requires coverage of every
  exact trigger input declared by the registered rule. Incomplete imported
  records and their receipt-confirmed status remain visible with an explicit
  reason; they do not gain the governed delivery label. Held original inputs
  continue to withhold eligibility.

All **23 focused pilot domain/history-latch tests** pass, including both
regressions. Scoped ESLint and formatting pass.

The earlier browser verification gap is closed. The actual Pilot and Delivery
UI was exercised at desktop and 390 px mobile widths, through explicit pilot
admission, supplied-input import, registration, deviation entry, revision
fencing, exact source inspection, manual reload and a fresh-process restart.
Record-only operations created no new agent run. A long classification badge
overflowed its nested mobile card; `PilotResults.tsx` now uses the existing
wrapping class. The frontend build and **12 focused pilot UI tests** pass.
The retained [browser report](../../.state/damage-reduction-pilot-ui-recheck/report.json)
and [restart comparison](../../.state/damage-reduction-pilot-ui-recheck/restart-comparison.json)
contain the checks, exact counts and screenshots. Readback excludes only the two
regenerated `preview.claims.checked_at` projection timestamps; retained refs,
records, history and capacity match.

The fresh-process pilot verifier now supports `--live`, retains unsuccessful
reports and model attempts, measures API startup/peak RSS, and requires actual
charged model calls with successful, accepted, non-synthetic provider receipts
for each live phase. Synthetic inputs and delivery records remain labelled
synthetic in either mode. `npm run reduction:pilot:live:verify` runs the
configured model workflow without contacting a digital delivery service.

The enhanced [fixture trace](../../.state/plan04-live-recheck/fixture/damage-reduction-pilot-verification/659d5380-c6ef-49ea-b166-d8aeecbde74a/report.json)
passes four explicit runs, eight typed records and exact restart readback. It
used zero model calls and twelve tool calls; peak API RSS was 268,324,864 bytes.
These fixture measurements do not establish configured model performance.

The wider recheck also fixed the inherited Continue declaration handoff: a
successor now retains all exact admitted `bound.selected_refs`, including the
operator selection original. Restart, source-hold, blocked-Continue and
hold-release regressions pass without bypassing applicability checks.

Configured attempts exposed two prompt/runtime boundaries. Phase objectives
now explicitly request the registered workflow and its retained products and
independent review; they state that attached exact refs can be resolved rather
than asking the operator to attach them again. Manager receives at most one
charged correction for malformed received output, using a complete corrected
proposal and the original authority checks. Its bounded feedback envelope has
a shared 1,024-byte ceiling and reserved room inside the unchanged 24 KiB model
input limit. A regression fills the initial context budget and verifies both
charged inputs remain within the ceiling, with only one accepted action.
Provider failures, unknown operations and custom authority failures are not
retried. No reference or hash is filled in. Compact output guidance preserves
the unchanged 1,200-token output ceiling.

The first broad recheck passed engine pins, formatting, TypeScript, repository
ESLint and build, then recorded **1,224 passing and three failing backend
tests**. One failure exposed the Continue defect above; two hit existing
integration-test timeouts. The pilot attempt-budget test now explicitly proves
that cancelled admitted successors consume allowances and release reservations,
without rerunning the same phase methods just to count admissions. The combined
synthetic-wrapper/timing/missing-proof case is split into two focused API tests;
all assertions and the original 40-second per-test timeout remain. These three
previously failing checks now pass individually. This is not an aggregate pass;
the complete aggregate command has not subsequently passed. A later attempt
stopped on formatting in a concurrently added Nightshift report; that file was
formatted. After the user asked to leave minor matters, another complete run
was not started solely for test-structure or formatting cleanup. Final build
and **53 focused Manager tests** pass, including the full-input-budget case.

### Still unresolved: configured live model readiness

The final configured attempts used the frozen `manager.v15` build and actual
NVIDIA responses. They did not close the live-workflow gate:

- The [pilot live attempt](../../.state/plan04-live-recheck/live/damage-reduction-pilot-verification/d9719df9-1f3e-49ac-9790-8274ac0a1fd9/report.json)
  failed during assessment because the proposed plan omitted the required
  independent reviewer. The runtime rejected it with
  `independent_review_required` before dispatching workers.
- The [maximum-input live attempt](../../.state/plan04-live-recheck/live-capacity/damage-reduction-programme-envelope-verification/de3ac1a1-54aa-4585-a3cc-9beb030eaef4/report.json)
  made one charged model call and zero tool calls. The provider returned HTTP
  200 with a `length` response status at the unchanged 1,200-token output limit;
  the incomplete response was rejected. Its original `not_tested` summary
  predates the verifier's failed-attempt summary fix; its retained model attempt
  and error are authoritative evidence that live execution was attempted and
  unsuccessful.
- The latest [general live verifier attempt](../../.state/plan04-live-recheck/general-live/general-verification/ae470f4e-88ff-4067-bb1d-fa1362a01ca8/report.json)
  also failed: malformed retained assignment IDs and repeated queued work
  remained after the bounded correction. It does not establish a successful
  general live regression.

Earlier unsuccessful attempts remain retained beside these results. Some
completed numerical selection, arithmetic and independent checking, but failed
final model output or omitted the requested retained workflow products. Actual
provider calls and passing deterministic fixtures do not establish a successful
configured live workflow. Review, reference and token limits remain enforced;
this report does not claim that every non-scientific release gate is resolved.

The older preview's fair single-agent comparison was rechecked separately. Its
latest [six-arm trace](../../.state/plan04-live-recheck/model-benchmark/e6fadec0-3bc2-4b45-af81-c9f05f38c31f/report.json)
has real provider coverage, but a baseline context overflow makes one arm
unscorable and the coordinated answers remain unsuccessful. The
[interpretation](../../.state/plan04-live-recheck/model-benchmark/e6fadec0-3bc2-4b45-af81-c9f05f38c31f/interpretation.md)
explains why this does not close the full fair comparison gate. That engineering
benchmark is separate from Scientific qualification.
