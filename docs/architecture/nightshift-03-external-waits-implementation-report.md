# Nightshift plan 3 implementation report

Implementation date: 27 October 2026.

The external-wait and capacity implementation is present. The live exit gate
remains unmet: the installed Nightshift configuration has no eligible local text
lane, so a genuine specialist submit/wait/result trace and interactive inference
latency measurement during local background generation cannot yet be captured.
Fixture traces and process-kill tests establish application behavior only.

## Changed behavior

- Added a versioned `external_wait` specialist action with one to four exact local
  handles and explicit required dependencies. A receipt-backed effect commits the
  wait and releases the specialist lease. A separate pure interrupt node parks
  the graph without executing effects during interrupt replay.
- Registered bounded `nightshift.submit`, `nightshift.result` and
  `nightshift.cancel` contracts. Tasks opt in through the additive
  `nightshift_tools` request field, exposed as an unchecked chat option. Registered
  specialists receive optional tools only from that explicit task grant. Every
  effect also checks the persisted assignment grant, identity, workspace, exact
  revisions, existing chain and deadline. Submission enforces the remaining
  grant and resource reservations.
- Added durable wait, terminal delivery, dependency resolution, task permit and
  FIFO ready-queue tables with versioned migrations and immutable identity
  constraints. Historical capture remains in the plan 2 supervisor path.
- Split terminal `external_result` audit events from targeted
  `external_result_ready` events. All required dependencies must be terminal
  before readiness is emitted. Events identify the assignment revision and
  generation; duplicate observations reuse stored deliveries and simultaneous
  readiness coalesces into one pending wake per thread.
- Preserved the two-task and two-specialist limits. A task permit is independent
  of public run status. Only a verified external-only wait can release it: the
  Manager must be parked, every unfinished specialist blocked directly or through
  assignment dependencies on acknowledged jobs, and no local execution, unknown Haze operation, human question, peer wait
  or runnable assignment may remain. Unknown submissions cannot establish this
  exception.
- Routed new admission, graph delivery, Resume and Continue through durable
  permit admission. Eligible external wakes retain FIFO position while capacity
  is full; new tasks cannot jump them. Dispatch rechecks authority and acquires a
  permit before specialist lease acquisition. Deadline expiry stops local work
  and retains late results without creating a successor.
- Added explicit result decisions for candidate use, partial results, supported
  failure and replanning. Required work blocks finalization until resolved.
  Accepted Manager replanning records its decision when superseding work.
- Added server-derived `artifact.external_candidates` exact-reference provenance
  and inherited tool requirements. Candidate-derived selected products require
  registered independent review. A candidate-only summary cannot establish full
  supported completion; missing review remains an explicit gap. Candidates are
  never made applicable through their historical receipt or a Nightshift judge.
- Extended the Nightshift page, Manager workspace and task reports with a
  validated, read-only wait/capacity view: compute, Haze capacity, human and stopped
  reasons; required handles; exact target revisions; retained delivery references;
  queue position and stop reasons. Browser observation remains separate from job,
  chain and task controls.

## Controls and recovery

Task pause, cancel, revocation and correction fence local delivery while known
remote jobs remain observable. Closing or cancelling a grant requests known-job
cancellation where applicable and retains truthful unconfirmed termination
receipts. Chain controls and associated consumer fencing share the task database
transaction. A chain pause/cancel/close with a current wait also pauses its Haze
consumer; resuming the chain does not automatically resume the task. Ordinary
Resume must revalidate authority and obtain capacity.

Resume keeps the original deadline and remaining grant. Continue is explicit and
uses the same chain's remaining cumulative allowance and absolute expiry. There
are no automatic successor runs, native schedules or cloud-spend grants.

The Manager and specialist topologies are now `manager.v2.external-waits` and
`specialist.v2.external-waits`. Existing topology checkpoints remain historical;
unfinished incompatible runs are paused and require explicit linked Continue.
Current-topology recovery reconstructs targets from accepted application records,
retains charges and pinned routes, and never replays a remote submission.

## Main files

| Area                          | Files                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts                     | `app/contracts/external-waits.ts`, `tasks.ts`, `artifacts.ts`                                                                                                                  |
| Authority and capacity        | `app/tasks/external-wait-store.ts`, `store.ts`, `runtime.ts`, `graph-ledger.ts`                                                                                                |
| Tools and control integration | `app/tasks/nightshift-tools.ts`, `nightshift-service.ts`, `app/composition.ts`, `app/orchestration/ports.ts`                                                                   |
| Graphs and review             | `app/orchestration/contracts.ts`, `specialist-graph.ts`, `runtime.ts`                                                                                                          |
| HTTP and browser              | `app/tasks/nightshift-http.ts`, `http.ts`, `frontend/src/features/nightshift/`, Manager/task/chat views and agent clients                                                      |
| Verification                  | `tests/unit/external-wait-*.test.ts`, `nightshift-wait-runtime.test.ts`, `nightshift-tools.test.ts`, `scripts/verify-nightshift-waits.mjs`, `nightshift-wait-crash-worker.mjs` |

The runtime architecture guide and
[verification guide](../Testing/nightshift-external-waits.md) document the public
additions and the external-only capacity exception.

## Verification results

Test data uses isolated directories; the normal task database is not used for
fixture runs. Concurrent damage-reduction work in this shared checkout is outside
this report's implementation scope.

- The final compiled external-wait crash harness passed all four actual process
  kill/restart scenarios: permit release; result/event commit; interrupted queue
  insertion transaction; and permit acquisition before graph dispatch. It checks
  receipt/delivery/event uniqueness, FIFO position, retained charge and request
  identity, and unchanged submission/dispatch counts.
  Evidence: `tmp/nightshift-wait-crash-verification/3e305309-3d15-4cd8-a53c-8de6858bc177/report.json`.
- The existing manual-job crash harness passed all seven scenarios after these
  changes. Evidence:
  `tmp/nightshift-crash-verification/2abce2ad-047b-4d74-a5fc-bcf0931e58fa/report.json`.
- The existing LangGraph crash harness passed all four scenarios. Its trace
  assertion now reads the exported topology version instead of hardcoding v1;
  the expected nodes, charges and no-replay assertions remain enforced.
  Evidence:
  `tmp/langgraph-crash-verification/2033543e-b0d0-41c9-99a8-7acad643f4d7/report.json`.
- Six isolated runtime traces cover both completion orders, pause and late
  capture, chain/task Resume separation, correction and assignment supersession,
  deadline expiry, and explicit same-chain Continue without replenishment.
- A fresh read-only readiness check found the daemon reachable and the schema
  and local-only policy compatible, but `local_compute_available:false` and
  `ready:false`. It made no submission. Evidence:
  `tmp/nightshift-wait-live-gate/74193a2f-bc7c-4d13-a08e-29036cb45de0/report.json`.

The final checked backend snapshot passed `npm run build`, `npm run typecheck`
and **871 tests across 76 files** using `npm test -- --maxWorkers=4`.
Repository-wide ESLint and `git diff --check` passed.
`npm run frontend:check` passed its production build and **251 tests across 35
files**; the opt-in live UI test remained skipped. These totals include the
shared checkout's other features as a regression check.

The repository-wide formatting check also encountered four unrelated files in
`tools/damage_data_discovery/`: `CRAWLER_CAPABILITIES_AND_DATA_GAPS.md`,
`DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md`, `PILOT_READINESS_MATRIX.md` and
`seed_sources.json`. They were left with their owner. Formatting checks for the
Nightshift implementation and changed shared files passed.

## Remaining live gate

The prior real local-only attempt was refused with
`privacy_floor_refuses_pinned_model`; all ready lanes were cloud lanes. This work
does not change fleets, install models, start remote schedules or relax the
local-only/$0 policy. Until a local lane is configured and verified, the live
specialist trace and background-load latency observation remain pending. Plan 4
automatic continuation remains disabled.
