# Nightshift external waits recheck

Date: 27 October 2026, Asia/Singapore.

This rechecks the [plan 3 implementation report](nightshift-03-external-waits-implementation-report.md)
against current code and runtime readiness. Historical test counts and failed
live attempts in that report remain evidence of their original snapshots.

## Defects found and fixed

### Late optional results

Consuming every required dependency marked the wait consumed. The reconciliation
query then skipped that wait, so a later optional result could have a retained
job receipt but no delivery to its declared assignment target. Explicit result
use failed with `external_result_missing`.

Consumed waits with an undelivered optional dependency now remain eligible for
historical delivery. That delivery is deduplicated and emits a retained-only
audit event. The wait remains consumed: no readiness event, queue entry, wakeup
or successor is created. A still-authorized active assignment may explicitly
consume the optional result under its existing permit and lease. Pause and
closed grants retain the late result with fenced consumption.

Late results remain bound to exact authority. A new generation does not inherit
optional execution authority merely because a historical result exists.

### Completed-result replay

The completed `nightshift.result` operation path called current candidate
validation but ignored its returned eligibility list. If a chain expired while
the task was still active, the same operation could return its old raw candidate
text even though current eligibility was empty.

Replaying a receipt containing candidate text now requires a current eligible
candidate matching its job, complete artifact reference and exact text.
Otherwise it fails with `nightshift_result_no_longer_authorized`. The original
accepted receipt and resource charges remain unchanged. Valid idempotent replay
and metadata-only historical replay remain supported.

## Previously reported open items

- The two-task permit limit, external-only release exception, FIFO priority and
  authority checks remain enforced. The capacity audit found no additional
  confirmed defect. Human questions, runnable work, active local leases and
  unknown operations prevent the external-only release exception.
- Plan 2's strict-overlay compatibility and task-control defects are already
  corrected in the [local jobs recheck](nightshift-02-local-jobs-recheck-report.md).
  They are not unresolved plan 3 prerequisites anymore.
- Current graph topology identifiers are `manager.v3.automatic-chains` and
  `specialist.v3.automatic-chains`, superseding the original report's v2 snapshot.
  [Plan 4](nightshift-04-automatic-chains-implementation-report.md) implements
  bounded automatic successors behind a server-owned release gate. Production
  automatic mode remains unreleased.
- The genuine specialist submit/wait/result trace and interactive latency
  observation during local generation remain pending. Current read-only
  inspection confirms a reachable daemon, compatible local-only contract and
  reconciliation capability, but no usable local text lane: `ready:false` and
  `local_compute_available:false`. No job or provider inference was dispatched.

The fresh readiness evidence is
`../../.state/nightshift-plan3-audit/readiness/f24d349a-a29e-46be-860b-3e4f2088e65e/report.json`.
The existing Ollama model and native memory/setup constraints are recorded in
the plan 2 recheck; this work does not substitute a cloud lane or bypass those
resource checks to manufacture a live pass.

## Verification

- **77 tests passed across nine files**, using one worker: wait storage/ledger,
  result replay, tools, six isolated runtime traces, transfers, automatic grants
  and automatic-chain service/runtime controls. Report:
  `../../.state/nightshift-plan3-audit/focused-backend.json`.
- All **16 relevant source/test hashes remained unchanged** during that run.
  The before/after manifests are retained in the same audit directory.
- Changed source and tests passed focused ESLint and formatting checks.
- The production backend build passed. All **four compiled process-kill/restart
  scenarios passed** with the original limits and assertions: permit release,
  result/event commit, interrupted queue insertion and permit acquisition before
  graph dispatch. Report:
  `../../tmp/nightshift-wait-crash-verification/c44678fc-ea7a-416f-a874-4cce75547a18/report.json`.

The optional-result regression exercises both real job receipts and durable
deliveries, including late output after pause/chain close. The replay regression
uses the actual store and runtime receipt path, advances a controlled clock past
chain expiry while keeping the task deadline valid, and checks unchanged
receipts and charges. Providers in these tests are fixtures.

The original report's complete backend/frontend totals are historical. This
recheck uses checks focused on external waits, controlled results, capacity and
recovery; it does not claim a current whole-repository pass or live inference.
