# Nightshift local jobs recheck

Date: 27 October 2026, Asia/Singapore.

This rechecks the unresolved items in the
[original implementation report](nightshift-02-local-jobs-implementation-report.md)
against current source and the installed runtime. The original failed native job
and its receipts remain historical evidence.

## Defects found and fixed

- The durable dispatch fence previously checked only the job's `submitting`
  state. Two calls before acknowledgement could both record a dispatch. The
  store now atomically changes the submission attempt from `intent` to
  `dispatched` exactly once, before the dispatch event. Repeated dispatch is
  rejected both within one process and after reopening the database.
- Task controls applied before the first chain existed did not fence a newly
  admitted chain. New chains and jobs now require a queued, running or waiting
  task. Paused, cancelled, revoked and terminal tasks cannot acquire new work.
  Original idempotency receipts, historical reads, capture, reconciliation and
  cancellation remain available.
- Installing the reviewed strict inference overlay from plan 1 changed the
  pinned host hash and made the job adapter reject that installation. Adapter
  v2 accepts either the original reviewed source set or the exact reviewed
  strict variant, including its imported overlay modules. Missing or changed
  required files still fail closed. Existing v1 provenance is not rewritten.
- The installed runtime treats explicit `fleet_id` as metadata rather than a
  compute selector. The adapter must not advertise it as effective fleet
  selection. New explicit fleet requests are rejected before CLI dispatch;
  original fleet metadata remains usable for historical reconciliation. Default
  local-only generation remains subject to verified local compute and the
  native privacy floor.
- Local readiness previously counted ready lanes excluded by the host's actual
  roster. Disabled and non-racing local lanes now remain unavailable, matching
  the installed host's defaults for omitted flags.

## Current installation

The daemon was stopped: CLI status returned `E_UNREACHABLE` and the expected
control pipe was absent. Before restarting it, a read-only audit found ten native
jobs and ten make records, all terminal, one disabled schedule and no watchers
or pending make records. The existing daemon was started hidden using its
existing profile; configuration and cloud spending authority were not changed.
The start record is `../../.state/nightshift-plan2-audit/daemon-start.json`.

After restart, current-source readiness confirms that the reviewed privacy
contract and reconciliation work: `local_only_enforced:true` and
`can_reconcile:true`. Generation is correctly blocked: `ready:false` and no
local compute. The current `imported-v2` roster contains three ready cloud lanes
and no local lane. The historical failed job still reports
`privacy_floor_refuses_pinned_model`; it was not resubmitted.

An existing Ollama service has `qwen2.5:7b` installed, with a genuine 4.68 GB GGUF
blob. The daemon does not use the browser's Ollama connector. Reusing the blob
would require a native local lane, active-roster changes and a verified memory
fit. The GPU has 6 GB total with roughly 4 GB free, physical RAM is low, and the
daemon reports critical memory pressure with admission paused. Loading the model
or disabling safeguards would not establish a safe release pass. No model was
downloaded, linked, loaded or reconfigured. Details and a possible no-download
setup are retained in
`../../.state/nightshift-plan2-audit/local-model-preflight.json`.

Closing or quitting the desktop app could stop an app-managed daemon; the
installed source does not establish whether the window's close button exits or
hides it. Graceful shutdown logs do not identify the cause of the earlier stop.

## Reported limits checked

| Original item                                                        | Current status                                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native browser `fetch` receiver bug                                  | Already fixed; receiver-sensitive test passes.                                                                                                                   |
| Unrelated `ProgrammeViews.tsx` syntax error                          | Already resolved; current TSX parses without syntax errors.                                                                                                      |
| Agent submission tools, external waits, capacity parking and wakeups | Implemented by [plan 3](nightshift-03-external-waits-implementation-report.md), with explicit grants and controls. The original report predates them.            |
| Automatic successors                                                 | Implemented behind the server-owned [plan 4](nightshift-04-automatic-chains-implementation-report.md) release gate; production remains unreleased.               |
| Increasing authority after a closed grant                            | Intentionally requires separately admitted authority; no silent allowance refresh.                                                                               |
| Bounded inbox and exact-proof reconciliation                         | Intentional bounds remain; known job deep links are readable and ambiguous ownership stays rejected.                                                             |
| Unconfirmed cancellation                                             | Still reported truthfully where native provider termination is not proven; capacity is not released merely on acknowledgement.                                   |
| Successful live local job                                            | Requires a verified eligible local lane and a genuine bounded job, output, receipt and restart readback. Historical acknowledgement/failure does not satisfy it. |

## Verification

- Store/service: **36 tests passed**, including the new dispatch and task-control
  regressions, original idempotency and historical recovery.
- HTTP: **26 tests passed**.
- Nightshift frontend: **31 passed**, with one opt-in manual readback skipped.
- The final adapter run passed **37 tests**, covering both reviewed source
  variants, tampering, fleet semantics, lane eligibility and historical proof.
- The broader focused run passed the other **110 backend checks** across nine
  files, including stores, service, HTTP, tools, transfers, external waits and
  automatic-chain controls. That run also reproduced the two newly added lane
  eligibility failures before their fix; the final adapter rerun passed them.
  Together these cover **147 distinct backend checks**. Reports are
  `../../.state/nightshift-plan2-audit/focused-backend.json` and
  `../../.state/nightshift-plan2-audit/adapter-final.json`.
- The backend production build passed after the fixes. All **seven compiled
  process-crash/reopen scenarios passed** against that build, with the existing
  assertions and limits. Report:
  `../../tmp/nightshift-crash-verification/9552c4ba-4f1d-4dda-88f6-7aed256f4bba/report.json`.
- A source-mode attempt failed its existing worker startup deadline before any
  scenario completed; it is retained separately at
  `../../tmp/nightshift-crash-verification/c62a9518-6d33-44f9-bb50-b86ecad93e67/report.json`.
  No timeout was increased. The subsequent fresh build and compiled checks above
  passed.
- The final compiled read-only readiness report is
  `../../.state/nightshift-plan2-audit/final-readiness/313eabc1-5306-4e02-a8db-23dbb8fd5cd4/report.json`.
  It correctly fails the generation-ready check because local compute is absent;
  it made no submission and reports no live inference or remote acceptance.
- Changed store and adapter files passed focused lint and formatting checks.

These are focused checks for this recheck. The original report's full-suite and
frontend-build counts describe its earlier snapshot; they are not current
repository-wide pass claims. No synthetic fixture is counted as live inference.
