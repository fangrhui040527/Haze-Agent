# Nightshift plan 2: local jobs, basic visibility and manual consumption

Status: **Proposed; not implemented.** Depends on [plan 1: routing and role-specific evaluation](nightshift-01-routing-plan.md). Part of the [Nightshift integration roadmap](nightshift-integration-plan.md). [Plan 3](nightshift-03-external-waits-plan.md) adds assignment tools, external waits and capacity handling after this release gate passes.

## Outcome and scope

Users can submit bounded local text `best_of_n` jobs, leave the browser, inspect progress after a Haze restart, and explicitly select retained results for authorized task use. Jobs remain server-owned. This phase does not register agent submission tools, park assignments on external jobs, wake assignments automatically or create automatic successor runs.

Background generation initially supports **evidence-linked drafts, alternative explanations and critique candidates**. Source retrieval, numerical calculations, deterministic domain methods and independent checks continue through registered Haze capabilities. Generated agreement and Nightshift's judge outcome do not establish scientific validity, evidence acceptance or an independent EvidenceCritic review. Every candidate retains the exact references used to construct its brief; generated citations must be checked against those inputs before use.

Only Haze changes. Model installation, individual lane administration, fleet setup and native schedules remain in Nightshift's cockpit. Haze retains its local single-user, single-runtime-owner boundary and authoritative SQLite database. No operating-system service is installed.

## Ownership and dependency direction

| Location                     | Responsibility                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/adapters/nightshift/`   | CLI discovery, server-side authentication, invocation without a shell, envelope/NDJSON parsing, capability discovery and transport error classification. |
| `app/tasks/`                 | Job admission, grants, reservations, submission intent, reconciliation, the restartable supervisor, receipt ingestion, identity checks and controls.     |
| `app/orchestration/ports.ts` | The narrow `NightshiftJobPort` interface for submit, inspect, outcome, result and cancellation; transport implementations do not import task policy.     |
| `app/contracts/`             | Browser-safe, versioned readiness, job, chain, event, provenance and mutation schemas.                                                                   |
| `app/composition.ts`         | Construct the concrete adapter and inject it into task services.                                                                                         |
| `frontend/`                  | Submit authorized requests and observe persisted server state.                                                                                           |

Reuse the demo's installed-CLI discovery and parsing behavior through the adapter. Do not import the demo loop into runtime code. The adapter cannot choose agents, enlarge grants, create runs, decide applicability or accept evidence. The supervisor monitors external jobs; it does not become a second task orchestrator.

## Admission and durable data

1. Add versioned, additive migrations in the existing application database for chains, immutable grant envelopes, jobs, submission attempts, resource reservations, remote observations and result deliveries. Preserve historical task/result bytes and existing v3 public protocols.
2. Every job has a local handle and belongs to an authorized task and chain. Manual submission may create a task or attach to an authorized existing task. A task has at most one open Nightshift chain; additional work uses its remaining grant or a separate explicit admission after closure.
3. Establish manual-only chains in this phase with `automatic_followup_runs = 0` and one admitted Haze run by default. Explicit admission may authorize up to four total runs for user-triggered successors without enabling automatic follow-ups. Persist an immutable cumulative envelope covering Haze model calls, tool calls, assignments, artifacts, admitted total run count, job count, requested attempts, spending policy and an absolute chain expiry. Derive Haze allowances from the resolved investigation profile and admitted total run count, and attach plan 1's pinned route identities. Mutable usage and reservation records may consume this envelope; they cannot enlarge it.
4. Enforce the same chain envelope for task controls and job endpoints. A user Continue within an enrolled chain cannot reset chain usage, refresh its absolute expiry or replenish its run allowance. Reject continuation when its admitted resources or run allowance are exhausted; increasing authority requires an explicit new admission, recorded separately from the old chain. The shared manual/automatic continuation service is completed in [plan 4](nightshift-04-automatic-chains-plan.md).
5. Commit the canonical request fingerprint, original authority references, submission intent, requested-attempt reservation and available resource/capacity reservations in one transaction before contacting Nightshift. Persist the acknowledged remote job ID immediately in a second transaction. Identical local redelivery returns the recorded receipt; conflicting content under the same key fails.
6. Retain task ID, chain ID, submitting run ID, generation, objective revision, assignment ID/revision when applicable, exact input artifact IDs/versions/hashes, route identity, job policy and adapter/runtime/schema versions. These original references never change when the task advances.

Requested attempts are reserved before submission. An unknown remote outcome stays charged; missing receipts never imply unused resources. Release a reservation only on verified evidence that the operation was rejected before remote acceptance or on explicit reconciliation under the recorded policy. Chain expiry closes new authority without erasing outstanding reservations or receipts.

When enrolling an existing run, preserve its admitted limits, deadline and pinned routes. Initialize chain accounting from that run's existing charges, accepted effects and unresolved reservations; attachment never resets usage or enlarges the current run. Future run slices require their own admitted remaining allowance. Extract the shared manual linked-run/grant checks in this phase; plan 4 extends that same service with an automatic admission mode rather than replacing an unguarded Continue path later.

## Submission, recovery and cancellation

- Support configured fleet selection, attempt count, judge, budget level and `now` or `quiet` execution for text `best_of_n` only. Validate requested options against the installed schema and running capability discovery; schema availability alone is not runtime readiness.
- Invoke the installed CLI without a shell and pass bounded prompts as data. Keep credentials server-side and sanitize diagnostics. Enforce explicit prompt, result and attempt-metadata size limits; an oversized response is retained as a bounded diagnostic with an explicit retrieval error, not silently truncated into a usable candidate.
- Never automatically repeat an unacknowledged submission. The installed CLI's idempotency flag does not establish remote deduplication. A crash or ambiguous response after dispatch leaves `submission_unknown`, with its reservations and capacity held. Require explicit reconciliation against a verified remote job and matching original request/ownership; do not infer identity from timestamps or similar prompt text alone.
- Run the task-owned supervisor independently of browsers and active graph runs. Poll acknowledged IDs, retry reads with bounded backoff, persist observations/cursors, and reconnect after restart. Polling never submits replacement work. Missing jobs or unsupported result fields become visible unresolved states.
- Distinguish execution state, Nightshift judging outcome, receipt availability, cancellation requested and confirmed remote termination. Persist cancellation intent before invoking the adapter; retry cancellation only where the installed contract establishes safe semantics. An acknowledgement alone does not release compute capacity or claim that the remote job stopped.
- Pause freezes new submissions. Cancel or revoke closes the grant and requests cancellation of known jobs. Objective corrections invalidate the old chain's authority. Continue monitoring known jobs and retaining historical receipts after these controls. Apply task controls and Nightshift controls through the same transactional policy hooks.
- Nightshift may continue jobs while Haze is offline. Haze resumes observation on restart; this phase promises no automatic task continuation or always-on Haze availability.

## Receipt capture and explicit consumption

Introduce a narrow, server-only receipt-ingestion path distinct from ordinary [`saveArtifact`](../../app/tasks/store.ts). It authenticates the stored job mapping and original ownership, validates bounded remote data, and atomically records the immutable output, actual attempt metadata, judge outcome and a deduplicated delivery record. Missing usage, lane, model or judging metadata remains unknown.

This path must work after the originating run expires, pauses, is cancelled, is superseded or has its permissions revoked. Retain outputs as service-produced, derived historical artifacts bound to the **original** task/run/objective/assignment revisions and exact input references. Do not rewrite them onto the current run or mark them applicable, accepted or reviewed. Do not weaken `saveArtifact`/`assertCurrent`, call the normal artifact-saving path under fabricated current authority, or spend a replacement run's artifact allowance. Reserve receipt-retention capacity at submission and charge ingestion to its original reservation.

Result capture does not publish an execution effect. A separate explicit selection/attachment operation must revalidate current identity, permissions, task/run/generation, objective and assignment revisions, deadline, exact hashes, applicability, remaining grant and required independent review. It records the historical candidate as a dependency of any current work; it cannot promote Nightshift's judge result into a Haze review verdict. A fenced or expired task can still show its historical result, but cannot consume it under stale authority. New work requiring a new grant uses explicit admission.

Receipt capture, delivery deduplication and explicit consumption have distinct durable identities. Repeating a terminal observation or refreshing the browser does not create another artifact or task effect. This phase exposes an inbox for manual selection, without graph wakeups or automatic result consumption.

## Limits and cloud policy

- Default job: **4 attempts**, accuracy judge, low budget, immediate execution and runtime-selected fleet. A chain permits at most **4 jobs**, **16 requested attempts** and **24 hours**; users may lower these limits. Automatic follow-ups remain **0**.
- Default privacy is **local-only**, with **$0 cloud spend**. Cloud submission remains disabled in this phase unless server permission, explicit user opt-in, an entered chain cap and live capability checks establish an enforceable aggregate cap across concurrent jobs and their attempts. Admission must enforce `recorded spend + outstanding spending reservations <= chain cap`, allocate a bounded cap to each job, and establish that the runtime enforces that allocated cap. Unknown usage retains its reservation. No positive cap is prefilled. An advertised `--max-spend` flag alone is insufficient proof.
- Direct agent-provider calls keep their separate Haze call/token limits. The UI must not describe the Nightshift job cap as a cap on every provider used by the app.
- Add configurable application-wide admission bounds, initially **2 nonterminal external jobs** and **8 open chains**. Submitting, remotely queued, running, cancellation-unconfirmed and `submission_unknown` jobs occupy the job bound. Reserve capacity before submission and reject excess admission visibly; do not create an unbounded local queue. Verified terminal state releases compute capacity, while unresolved accounting remains retained.
- Keep these external bounds separate from Haze's two active-task and two specialist-slot limits. [Plan 3](nightshift-03-external-waits-plan.md) adds parked-wait bounds and fair capacity reacquisition. Test interactive provider latency while background jobs use the same local runtime before increasing external concurrency.

## API and basic interface

Add versioned, schema-validated contracts under `/api/nightshift` for readiness, manual chain admission/list/inspect/pause/resume/cancel, job submit/list/inspect/cancel/reconcile, explicit result selection, and cursor-based job events. Resume preserves the original envelope, expiry and manual-only mode. All mutations require `Idempotency-Key`; controls, reconciliation and result selection also require current revisions and applicable task authority. Reuse existing server-owned identity, workspace, local HTTP and same-origin checks.

Add `/nightshift/:jobId?` in the existing application layout with readiness and sanitized route information, a bounded submission form, persistent job list/details, task/chain links, progress cursor, output, judge outcome, provenance, unresolved operations, remaining grant and explicit stop reasons. Restore deep links and observations after reload/reconnect. Render generated content as untrusted text and retain its candidate status.

Expose separate controls for stopping browser observation, requesting cancellation of one job and closing/cancelling a chain. Browser timers only read persisted state. The UI labels manual-only chains clearly and offers no automatic-follow-up control before plan 4 is released.

## Verification and exit gate

- Admission rejects unsupported policies/options, unavailable capabilities, excessive job/chain counts, depleted grants and unverified cloud enforcement. Concurrent requests cannot over-reserve resources; a same-chain manual Continue cannot replenish them.
- Exercise genuine process crashes after committed intent but before dispatch, during ambiguous submission, after remote acknowledgement but before local ID persistence, after ID persistence, and between result capture, delivery recording and explicit consumption. Reopen isolated state and verify no replayed submission or duplicate artifact/effect.
- Verify acknowledged restart recovery, explicit unknown-submission reconciliation, duplicate terminal observations, missing/oversized metadata, read backoff, cancellation races and cancellation-unconfirmed capacity retention.
- Verify late receipt capture after expiry, pause, cancellation, correction, revocation and a newer current run. Assert original provenance is preserved and no current applicability, evidence acceptance or automatic wakeup appears. Explicit selection must fail under stale authority and preserve exact input dependencies when authorized.
- Verify UI submission deduplication, deep links, unavailable runtime, reconnect cursors, manual selection, escaped output and separate observation/cancellation controls.
- Run repository checks appropriate to the implemented backend/contracts/frontend changes and isolated restart scenarios. Capture a real local job's request, acknowledgement, progress, output, outcome, receipt and restart readback. Fixture results and installed-schema inspection are separate evidence.

The last review inspection found the installed CLI schema available but the daemon unreachable. Treat that as a historical limitation, not a current readiness claim. This phase exits only with the recorded checks above and genuine live local-job evidence; automatic chains remain disabled regardless of this phase's success.
