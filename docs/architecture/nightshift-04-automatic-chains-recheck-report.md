# Nightshift automatic chains recheck

Date: 27 October 2026, Asia/Singapore.

This rechecks the [plan 4 implementation report](nightshift-04-automatic-chains-implementation-report.md)
against current code and runtime readiness. The original report's verification
counts and failed attempts remain evidence of their original snapshots.

## Defects found and fixed

### Pause could bypass the no-progress stop

A same-purpose repeat correctly stopped the chain with `no_progress`, and direct
Resume correctly rejected it. However, another explicit chain Pause replaced the
reason with `Manual submission paused.`. Resume then accepted the chain without
a validated refinement.

Chain Pause now preserves the `no_progress` reason. Resume continues to require
validated changed inputs, review objections or a supported changed failure cause.
The regression exercises a real repeated job, redundant Pause, rejected Resume
and successful refinement using an exact changed input.

The related duplicate-stop path also returned before enforcing the pause when its
fingerprint already existed. Redelivery now restores the chain fence using the
original accepted explanation if mutable state no longer reflects that stop.
It creates no additional stop record, event or resource charge and does not renew
expiry. Repeated identical state stays unchanged. Observational stops cannot undo
an independent user pause, and duplicate stops cannot reopen terminal grants.

Files: `app/tasks/nightshift-store.ts` and
`tests/unit/nightshift-automatic-grants.test.ts`.

### Release could close during admission discovery

V2 admission checked automatic release before awaiting native runtime readiness.
If release evidence was withdrawn during that await, the old accepted release
state could still allow a new automatic grant. The coordinator's separate gate
continued to block execution, but admission itself was incorrect.

The service now checks release again after runtime discovery, immediately before
the synchronous store admission. The initial check remains so an already blocked
request avoids native discovery. A deferred-readiness regression reproduces the
race and verifies rejection without a chain, job, resource charge or submission.
Stable v2 admission and v1 admission under a blocked automatic policy also pass.

Files: `app/tasks/nightshift-service.ts` and
`tests/unit/nightshift-service.test.ts`.

## Previously reported open items

| Item                                                          | Current result                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Successor admission, cumulative grants and FIFO recovery      | No additional confirmed defect found. Current tests and all six compiled crash scenarios pass.                                                                                                                                     |
| Required/optional inbox transfer and gap reporting            | Exact authority, independent-review requirements and unresolved-dependency retention remain enforced. Manager finalization and its gap report share a transaction, so later finalization validation failures roll back the report. |
| Browser/API release boundary                                  | Default opt-out, blocked production release, strict versioned controls and GET-only observation remain enforced. The asynchronous admission gap above is fixed.                                                                    |
| Historical pilot timeout                                      | The exact outcome-aware amendment case now passes in isolation in **39,607 ms** under its unchanged **40,000 ms** timeout. This leaves little timing margin and does not establish a passing unfiltered backend suite.             |
| Four historical formatting warnings                           | A fresh targeted Prettier check passes for all four files under `tools/damage_data_discovery/`; no formatting edits were needed.                                                                                                   |
| Genuine local generation and automatic-chain release evidence | Still pending: the installed daemon has no eligible local text lane. Production automatic mode remains unreleased.                                                                                                                 |

The isolated pilot evidence is
`../../.state/nightshift-plan4-audit/pilot-recheck.json`; its retained phase
snapshot is `pilot-phase-snapshot.json` in the same directory. The test completed
its assessment, planning, initial pilot and amended pilot phases. Its timeout,
resource limits and assertions were not relaxed. The full backend suite was not
rerun for this recheck.

The four formatting files are `CRAWLER_CAPABILITIES_AND_DATA_GAPS.md`,
`DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md`, `PILOT_READINESS_MATRIX.md` and
`seed_sources.json`.

## Verification

- **144 tests passed across 12 files**, using one worker: automatic grants,
  chain coordinator/runtime, job store/service/HTTP, transfers, external wait
  store/ledger/runtime, controlled result replay and tools. Evidence:
  `../../.state/nightshift-plan4-audit/focused-backend.json`.
- The production backend build passed. All **six compiled process-kill/restart
  scenarios passed**: before successor reservation, during reservation, during
  result assignment, during graph enqueue, after commit before dispatch and after
  graph claim. They verify one successor, one admission, retained required work,
  original routes/expiry, unchanged remote submission identity and resource
  accounting. Evidence:
  `../../tmp/nightshift-chain-crash-verification/7596023d-034d-42ef-a1b1-56f49eb0243f/report.json`.
- All **207 recorded source, test and configuration files remained unchanged**
  between the initial snapshot, focused tests, build and crash checks. Manifests
  are retained in `../../.state/nightshift-plan4-audit/` as
  `source-before-verification.json`, `source-after-verification.json` and
  `source-after-build-and-crashes.json`.
- Changed code and tests pass targeted ESLint and formatting checks.

Tests use isolated state and synthetic providers. They establish the tested
control flow and recovery behavior; they do not establish live model quality or
a current whole-repository test pass.

## Remaining live gate

A fresh read-only installed-runtime check confirms `runtime_reachable:true`,
`schema_compatible:true`, `local_only_enforced:true` and `can_reconcile:true`, but
`local_compute_available:false` and `ready:false`. Evidence:
`../../.state/nightshift-plan4-audit/readiness/445ed326-1f38-47cd-8bc8-1e3383afb42a/report.json`.

The daemon is running; a usable native local text lane is still missing. Genuine
specialist submit/wait/result, background generation, interactive latency and
explicitly opted-in automatic-chain evidence remain pending, along with the
independent routing-quality release review described in the earlier reports.
The [plan 2 recheck](nightshift-02-local-jobs-recheck-report.md) records the native
model setup and memory constraints. This recheck submitted no native job or live
inference, changed no fleet/model configuration and left production release
blocked.
