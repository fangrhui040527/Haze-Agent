# Damage reduction programme coordination

The `reduction-programmes` runtime extension coordinates existing bounded
`damage-reduction-planning` tasks. Composition registers its HTTP handler and
task mutation guard. It introduces no agent, scientific method or automatic
phase start.

## Persistence and current results

`repository.ts` owns additive tables on `TaskStore.db` for scoped current
pointers, immutable revisions, phase attempts, notes/attachments and operation
receipts. Principal, workspace and execution mode partition every lookup.
`service.ts` uses the host's synchronous transaction boundary so revision,
admission, exact binding, reservation and receipt commit together. Execution
starts through the generic runtime only after the outer commit.

Attempts bind an exact task/run/objective, programme revision, selected source
references and relevant-input fingerprint. Planning additionally binds an
explicitly selected current reviewed assessment. Its task independently
reconstructs the same original inputs; the predecessor review is retained as
programme lineage and is never submitted as a direct factual source.

`projection.ts` rebuilds status and capacity from those exact run records on
every read. `TaskStore.runResult` retains committed results by run and objective
revision. Superseded or changed attempts expose historical references while
current eligibility rechecks source permissions, applicability and World Model
holds. Notes and titles do not alter phase fingerprints. Selected scenario
changes stale assessment, planning and pilot drafts; candidate changes or a
replacement assessment stale planning and pilot drafts. A replacement plan,
pilot-input change, scientific-owner change or protocol amendment fences the
affected pilot use. Historical registrations remain available with their exact
original and amended analysis versions.

## API and limits

The loopback task server exposes:

- `GET/POST /api/reduction-programmes`
- `GET /api/reduction-programmes/:id`
- `GET /api/reduction-programmes/:id/history`
- `POST /api/reduction-programmes/:id/revisions`
- `POST /api/reduction-programmes/:id/phases`
- `POST /api/reduction-programmes/:id/records`

Strict versioned mutation bodies require expected revisions and an
`Idempotency-Key`. Creation uses revision zero. Identity is server-owned.
List/history use `limit` 1–10 and nonnegative `offset`; records retain at most 32
context/pilot/delivery records, with a 128 KiB total record envelope; snapshots
and supplied pilot inputs are bounded to 64 KiB. Attachments remain
historical context and consume no phase reservation.

Default programme ceilings are 400 model calls, 400 tool calls, 12 runs and 3
attempts per phase, with one active phase including paused/waiting runs.
Admission reserves actual run maxima; authoritative terminal usage releases
only unused reservation. Unknown charged attempts are never refunded. Explicit
budget revisions can reduce ceilings only above usage, reservations and already
admitted counts. Runtime ceilings still apply.

Generic task corrections of bound objectives are rejected: revise programme
inputs and explicitly start a replacement. Coordinated Continue requires the
programme ID/current revision and atomically revalidates/binds a successor.
Resume keeps the unchanged run's reservation and deadline. Pause, cancel and
permission revocation remain available through existing task controls.

## Browser and verification

`/damage-reduction/programmes/new` creates a saved programme without starting a
task. `/damage-reduction/programmes/:programmeId` exposes explicit phase starts,
remaining capacity, exact task links, input/budget edits, history and context
records. `/damage-reduction` and saved standalone preview URLs remain available.

Run `npm run reduction:programmes:verify` for a fixture trace through assessment,
planning, correction, historical attachment, restart and a separate process
crash before dispatch. Unit tests cover atomicity, isolation, exact result
history, stale sources and direct task route guards. Fixture verification does
not establish scientific qualification, live delivery or achieved reduction.

## Pilot and delivery records

Plan 04 adds an explicitly started `pilot` phase after a selected current
assessment and reviewed conditional plan. Save a versioned supplied pilot-input
artifact through `pilot_input_ref`, then select `planning_attempt_id` when
starting the phase. WorkerShield drafts design-specific feasibility and a
protocol; EvidenceCritic independently checks the retained original inputs,
classification, target and rule lineage. Missing scientific information remains
an explicit conditional or delivery/exposure/feasibility limitation. No generic
power or causal estimator is introduced.

The existing records route accepts immutable `pilot_registration`,
`pilot_amendment`, `digital_action`, `pilot_deviation` and
`delivery_verification` records. Larger protocol, receipt and verification
contents use exact artifact references. Registration uses the server's record
time and retained outcome-access declarations. Imported earlier dates cannot
create earlier local prespecification. Amendments retain the original analysis
and identify amended or exploratory uses; known outcome access cannot be reset
by a later attestation or missing source.

Action records bind action/rule versions, permitted action, trigger versions,
scope, status and receipt confirmation level. Provider acceptance means
submission, while alert transmission, receipt and applied schedule changes are
separate confirmation levels. Missing/incompatible receipts and unresolved
unknown outcomes cannot confirm delivery. Simulations remain simulations.
Independent verification covers only its exact supported action subset;
material deviations and stale evidence remain visible.

The programme page renders server-owned Pilot and Delivery status. Live
alert/scheduling adapters are deferred: this implementation stores drafts,
simulations and imported evidence and sends no external action. Neither a
receipt nor a verified digital action establishes reduced exposure or damage.
Run `npm run reduction:pilot:verify` for the recordkeeping/restart trace.

## External evaluation and learning

Select `evaluation_input_ref` and an optional `evaluation_dossier_ref` through an
explicit programme revision, then start `evaluation` with its retained
`registration_id`. Inputs bind exact external method/design, target, protocol,
rules, delivery, deviations and original expected outputs. The phase shares
existing programme ceilings and retains result, independent technical review and
learning artifacts. Unsupported uncertainty remains a gap.

Append `evaluation_qualification` records for explicit human adoption or
withdrawal and `evaluation_objection` records for material/minor objections.
The server rebuilds effective qualification and claim eligibility on every read;
imported flags, numerical agreement and delivery receipts cannot establish an
achieved effect alone. The programme page displays the server conclusion and its
reproduction limits. The engineering verifier is
`npm run reduction:evaluation:verify`; operational release requires a reviewed
non-synthetic reference trace. See the [Plan 05 report](../../../docs/reports/damage-reduction/damage-reduction-05-implementation-report.md).
