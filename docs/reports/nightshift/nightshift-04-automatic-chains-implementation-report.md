# Nightshift plan 4 implementation report

Implementation date: 27 October 2026.

Current follow-up: the [automatic chains recheck](nightshift-04-automatic-chains-recheck-report.md)
fixes a no-progress Pause/Resume bypass and an admission release-check race,
records current focused verification, and distinguishes resolved historical
warnings from the remaining live release gates. The results below describe the
original implementation snapshot.

Finite automatic-chain support is implemented behind a server-owned release
gate. Production automatic mode remains unreleased because the earlier live
routing, local generation, specialist-wait and latency gates have not passed.
Fixture success does not release production mode. Existing manual grants stay
manual-only; no environment setting, browser request, agent proposal or restored
checkpoint can enable automatic authority on them.

## Changes

- Added explicit v2 chain admission with automatic opt-in, a maximum of four
  total runs and three separately authorized automatic follow-ups. Manual
  Continue and automatic successors spend the same immutable cumulative grant;
  automatic quota exhaustion leaves any separately authorized manual runs usable.
- Preserved existing run enrollment, pinned routes, deadline, limits, charges and
  receipt reservations. Successors receive bounded slices of the remaining Haze
  model/tool/assignment/artifact allowance, retaining input/output limits and
  synthesis/review reservations. Their deadlines never exceed the original chain
  expiry. The existing four-job, sixteen-attempt, twenty-four-hour and local-only/
  $0 ceilings remain hard limits alongside global task, specialist and job caps.
- Extracted linked-run admission from `TaskStore.control` into the server-only
  `LinkedRunService`. User Continue and the automatic coordinator share its
  authority, cumulative-resource, quiescence, progress, route and capacity checks.
  Database uniqueness covers the chain/predecessor/objective and task/predecessor/
  objective decisions. Successor enrollment, source transfer, actor audit and a
  durable Manager graph job commit together before dispatch is kicked.
- Extended the existing FIFO capacity queue with continuation tickets. Two busy
  tasks leave a durable waiting decision; new admission cannot jump an eligible
  successor or external wake. A ticket is claimed in the same transaction before
  predecessor fencing and converted into a permit for the exact successor.
  Recovery retains eligible position; stale authority is fenced with a reason.
- Added a coordinator that observes retained terminal results while the Haze
  server runs. It rechecks release evidence, topology, permissions, objective,
  unknown outcomes, required questions, original routes, progress and remaining
  resources before asking the shared lifecycle to admit a successor. Active runs
  keep results in their inbox; arrivals never replace an executing run.
- Added explicit run-to-run inbox delegation for required and optional jobs,
  including acknowledged jobs still pending. Original job/artifact ownership and
  source references remain immutable. The Manager must explicitly assign local
  handles through `assignment.input.nightshift_job_ids`; controlled consumption
  requires the current specialist lease, grant, exact revisions, source rights,
  applicability and result proof. A raw historical receipt cannot become ordinary
  input or accepted evidence.
- Added typed reporting of unresolved required jobs to Manager finalization.
  `nightshift_unresolved_jobs` needs an explicit unfinished deliverable and
  current Manager authority. It permits a partial/blocked gap report without
  pretending the job was consumed or cancelled. A later result remains eligible
  for the original outstanding purpose within the remaining grant. Explicit
  supported failure, partial-result use and replanning remain separate decisions.
- Made local `nightshift.result` decisions, their Haze tool charges and graph
  receipts atomic. Accepted candidate context can be reconstructed after restart
  or Resume from authoritative generation-admission and consumed-result records,
  with current permissions, applicability and provenance rechecked. This retains
  `artifact.external_candidates` and independent-review requirements without
  generating another receipt, wake, job or charge.
- Added runtime-validated progress records and bounded refinement proposals.
  Records retain accepted exact input/output references. A new refinement needs
  changed exact input content, independent review objections or a verified changed
  failure cause. Changed prose,
  identifiers, timer ticks and Nightshift judge scores do not authorize repetition.
  Controlled result consumption alone advances the consumed-result cursor.
  Agents can submit such a proposal with a permitted job request; they cannot
  enlarge limits, renew expiry or create grants.
- Added durable machine-readable decisions and stops for completion, missing
  purpose/permission/input, unknown outcomes, no progress, resource exhaustion,
  invalidation and expiry. Cancellation remains a request until native terminal
  observation confirms it. Capturing late bytes remains independent of authority
  to execute or publish.
- Added optional historical linkage when explicitly admitting a new task and new
  v2 grant after the previous grant is closed, expired or invalidated. The server
  verifies the same identity/workspace and stores the link in immutable admission
  metadata. Ordinary Continue cannot shed membership or refresh a closed grant.

## Controls and compatibility

Task and chain controls commit authority changes before local cancellation or
remote cancellation requests. Service actions are recorded as Runtime/service
actions rather than user actions. Pause preserves counters, expiry and remote
observation. Restoring a chain does not itself resume its task; task Resume must
pass admission and retain the original run deadline. A paused chain freezes manual
Continue too: restore the chain first, then Resume within the old deadline or
Continue explicitly after expiry. Unknown dispatched outcomes require verified
reconciliation. Resume cannot bypass a `no_progress` stop without a validated
refinement.

An objective correction invalidates the old chain and pauses its local work.
That objective's grant cannot fund corrected execution. A separately admitted,
historically linked grant is required for new automatic work. Saved receipts,
old assignment revisions and checkpoints remain historical.

The new topology identities are `manager.v3.automatic-chains` and
`specialist.v3.automatic-chains`. Earlier checkpoints are preserved and require
explicit linked continuation; they are not reinterpreted. Versioned migrations
add successor/progress/consumption/stop ledgers, linked admissions, result-event
decisions and delegated inbox records. No historical task is silently enrolled
in an automatic grant.

## API and UI

The existing `/nightshift` screen now shows release gates, explicit opt-in,
initial and successor lineage, original and remaining allowances, automatic versus
manual run usage, pending/retained inbox references, next purpose and exact stop
reasons. Haze agent call/input/output limits are shown separately from local-job
spending. Text remains escaped; browser timers only observe saved state.

New readbacks are `GET /api/nightshift/automation/readiness` and
`GET /api/nightshift/chains/:id/automation`. Existing chain admission/control
routes accept the versioned v2 contracts. Explicit progress proposals use
`POST /api/nightshift/chains/:id/progress`, with current revisions and stable
idempotency keys. All routes retain local identity/workspace and same-origin
checks. Stopping observation, cancelling one job and cancelling a chain remain
distinct controls.

See [the verification guide](../../testing/nightshift-automatic-chains.md) for the
contracts, UI checks and release boundary.

## Main files

| Area                        | Files                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versioned contracts         | `app/contracts/nightshift.ts`, `nightshift-records.ts`, `nightshift-chains.ts`, `nightshift-automatic.ts`, `manager.ts`                                                                    |
| Grant, progress and stops   | `app/tasks/nightshift-store.ts`                                                                                                                                                            |
| Shared continuation         | `app/tasks/linked-run-service.ts`, `store.ts`                                                                                                                                              |
| Coordination and delegation | `app/tasks/automatic-chain-service.ts`, `nightshift-transfer-store.ts`, `external-wait-store.ts`                                                                                           |
| Runtime and APIs            | `app/tasks/runtime.ts`, `nightshift-service.ts`, `nightshift-tools.ts`, `nightshift-http.ts`, `graph-ledger.ts`                                                                            |
| Browser                     | `frontend/src/features/nightshift/`                                                                                                                                                        |
| Verification                | `tests/unit/automatic-chain-*.test.ts`, `nightshift-automatic-grants.test.ts`, `nightshift-transfers.test.ts`, `scripts/verify-nightshift-chains.mjs`, `nightshift-chain-crash-worker.mjs` |

## Verification

All fixture tasks, receipts and process-kill state use isolated directories. The
normal application database is not used for fixtures. Concurrent damage-reduction
work in this shared checkout is outside this change's scope; regression totals
include the checked shared snapshot.

- Six actual process-kill/restart scenarios passed against the compiled build:
  before reservation, inside reservation, inside result assignment, inside graph
  enqueue, after commit before dispatch kick, and after graph claim before
  execution. They retain one successor, one admitted decision, required
  dependencies, original routes/expiry, charges and remote submission identity.
  Evidence: `tmp/nightshift-chain-crash-verification/b9a6d7cd-11bc-4568-b4fb-157b4677078d/report.json`.
- The earlier job, wait and LangGraph crash suites passed all fifteen scenarios.
  Evidence: `tmp/nightshift-crash-verification/73a293f9-5a0a-4cd8-9db8-0084d7a65efb/report.json`,
  `tmp/nightshift-wait-crash-verification/b10186f7-e941-4a62-8046-babf0b1f37f2/report.json`,
  and `tmp/langgraph-crash-verification/79a9b9f0-c575-4ed0-a452-c346baa14aa3/report.json`.
- Seventeen coordinator tests include real shared-lifecycle races, required and
  optional late dependencies, reporting an unresolved partial deliverable,
  cumulative manual/automatic limits, route and release failures, and two occupied
  permits with FIFO admission across SQLite reopen. Two injected-provider runtime
  traces exercise the actual Manager/specialist submit, wait, expiry, successor,
  explicit inbox assignment, exact candidate consumption and review-required
  partial finalization. They establish control flow, not live model quality.
- A fresh read-only installed-runtime check found the daemon reachable, schema
  compatible and local-only policy enforced, but no eligible local text lane:
  `local_compute_available:false`, `ready:false`. No job was submitted.
  Evidence: `tmp/nightshift-automatic-live-gate/976fcb6e-fc78-4e58-9af2-ba57d986fdc4/report.json`.
- Failed harness evidence remains at
  `tmp/nightshift-chain-crash-verification/300257ed-0d15-444b-963b-5a4629efcff5/report.json`.
  Its initial assertion counted a successor's observation decision as another
  admission. The corrected assertion checks one admitted decision and successor;
  the separate charge, receipt, dependency and graph-job invariants remain tested.

The frontend production build and **271 tests across 38 files** passed; one
opt-in live UI test remained skipped. Backend build, `npm run typecheck`,
repository-wide ESLint and `git diff --check` passed in the checked snapshot.

The unfiltered backend run did not pass: 83 files and 952 tests passed, while
`tests/unit/damage-reduction-pilot-integration.test.ts` timed out in its
outcome-aware amendment case. Its stalled, isolated Vitest worker was stopped;
Vitest also recorded that worker exit as an unhandled error. The diagnostic is
retained at `tmp/nightshift-automatic-verification/full-suite-failure.json`.
The remaining suite passed **937 tests across 83 files** using
`npm test -- --maxWorkers=4 --exclude tests/unit/damage-reduction-pilot-integration.test.ts`.
No test configuration or pilot assertion was changed for this report. The
unfiltered failure is not counted as a successful full-suite check.

The full formatting check reports four unrelated files under
`tools/damage_data_discovery/`: `CRAWLER_CAPABILITIES_AND_DATA_GAPS.md`,
`DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md`, `PILOT_READINESS_MATRIX.md` and
`seed_sources.json`. They were left with their owner. Nightshift and changed
shared-file formatting checks pass.

## Remaining release gate

Production composition provides a blocked release policy. There is deliberately
no environment enable flag. Tests inject explicitly labelled fixture evidence and
synthetic providers; fixture evidence cannot release ordinary live-provider
execution. The installed local-only configuration still needs a genuine eligible
local text lane and retained Manager, specialist, background-job and latency
evidence. No fleet/model changes, model downloads, cloud-spend authorization,
native schedules or operating-system service were installed by this work.
