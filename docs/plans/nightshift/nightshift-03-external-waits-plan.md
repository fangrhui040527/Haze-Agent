# Nightshift plan 3: external waits and capacity handling

Status: implementation present; live exit gate unmet. See the
[implementation report](../../reports/nightshift/nightshift-03-external-waits-implementation-report.md)
for changes, verification and remaining live evidence. This specification does
not establish runtime or model readiness.

Depends on [plan 2: local jobs and manual consumption](nightshift-02-local-jobs-plan.md).
The preceding plans supply pinned model routes, durable job records, immutable
chain grants, historical result ingestion and basic job visibility. See the
[integration roadmap](nightshift-integration-plan.md) for the four-plan sequence.
Automatic successors remain disabled until
[plan 4: opt-in automatic chains](nightshift-04-automatic-chains-plan.md).

## Outcome and scope

An authorized specialist can submit a bounded Nightshift job, park without
holding its execution lease and consume a matching result when execution
capacity and current authority permit. Verified external-only waits can also
release an active-task permit. Result arrival never bypasses admission,
permissions, deadlines, applicability or independent review.

Background generation is limited initially to evidence-linked drafts,
alternative explanations and critique candidates. Source retrieval, numerical
calculations, deterministic methods and independent checks continue through
registered Haze capabilities. A Nightshift judge does not replace EvidenceCritic
or establish evidence acceptance.

This phase does not create automatic follow-up runs, native Nightshift schedules
or an alternative workflow engine. An expired run retains results in its inbox
and requires explicit user continuation under the existing chain's remaining
grant. Same-chain Continue must never replenish that grant.

## Ownership and contracts

| Location                   | Responsibility                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/adapters/nightshift/` | CLI transport, discovery, authentication and parsing behind `NightshiftJobPort`; no task, capacity or continuation policy.                                |
| `app/tasks/`               | Authorized job tools, pending dependencies, capacity permits, ready queue, targeted delivery and lifecycle controls in authoritative SQLite transactions. |
| `app/orchestration/`       | Restricted execution-service interfaces, external-wait action validation and separate effect and interrupt nodes.                                         |
| `app/contracts/`           | Browser-safe, versioned job references, wait/readiness views and event schemas.                                                                           |
| `app/composition.ts`       | Register concrete tools and inject adapters and policy into the existing runtime.                                                                         |

Register `nightshift.submit`, `nightshift.result` and `nightshift.cancel` only for
explicit task and assignment grants. Tool input accepts bounded typed data and
local job handles. It cannot contain arbitrary commands, credentials or remote
endpoints. Recheck identity, workspace, task, chain, objective revision and
assignment revision before every accepted effect. Agents can consume remaining
resources but cannot authorize a larger grant.

Add a versioned external-wait action with the exact local job handles and required
result dependencies. Persist its target run, generation, objective revision,
assignment ID/revision and event cursor. A required pending job blocks task
finalization; failed or cancelled jobs require an explicit supported failure,
partial-result or replanning decision rather than silently satisfying the
dependency.

## Durable wait and delivery flow

1. Submit through the receipt-backed operation path and plan 2's atomic
   intent/reservation transaction. Return a local handle after acknowledgment;
   an unacknowledged submission remains unknown and charged.
2. Commit the wait and release the specialist lease in an effect node. Call
   `interrupt()` only in a separate pure wait node. Never submit, save an artifact
   or change authority inside a replayed interrupt node.
3. Let the independent supervisor capture terminal receipts through plan 2's
   historical ingestion path, retaining original task/run/objective/assignment
   revisions and exact input references even when execution authority expired.
4. Commit a targeted result-delivery record and event together. Reuse
   `GraphLedger` event-before-park protection and thread/cursor deduplication.
   Match the intended job and assignment revision, rather than waking every
   assignment on any job event. Add a uniqueness constraint for each terminal
   result and target delivery; duplicate observations return the stored receipt.
5. Coalesce simultaneous completions into one pending wake per target thread.
   If that run is already executing, retain the material in its durable inbox
   and let the existing serialized workflow consume it when quiescent.
6. Acquire the required capacity and rehydrate authority before resuming. Only
   then may controlled execution attach the retained output to current work,
   with exact-reference, applicability and review checks. Do not weaken
   `assertCurrent` or call `saveArtifact` from the supervisor to force a late
   result into the current objective.

Keep historical receipt retention separate from current result delivery. A
stale, paused, expired, cancelled or revised target can retain bytes without
becoming executable or producing applicable evidence. Unknown job submissions
cannot serve as verified external waits and never trigger automatic replay.

## Capacity admission and fairness

Maintain the existing limits of **two active tasks** and **two shared specialist
slots**. Model task capacity as a durable permit rather than inferring it solely
from the public run status. A parked run may still be `waiting`; expose its wait
reason and capacity state through an additive validated view where needed.

Every specialist wait releases its execution lease. Release the active-task
permit only in a transaction that verifies all remaining work is blocked solely
on acknowledged external jobs, the Manager is parked, no assignment or remote
Haze operation is executing, and no other runnable assignment exists. Human,
peer, unresolved-unknown and mixed waits do not qualify merely because they also
reference a Nightshift job.

Use one transactional admission service for new task admission, external wake,
Resume, Continue and any other path that starts execution. It must acquire a
task permit before Manager or specialist execution and a specialist lease before
specialist execution. Generation changes, retries or supervisor wakeups cannot
manufacture extra permits.

When both task permits are occupied, persist an eligible wake in a bounded ready
queue. Order it by first eligible-ready sequence with a stable tie-breaker;
duplicate events and retries retain their place. New admissions cannot jump
already queued eligible work. Preserve existing admission rejection semantics
unless an explicit queue contract is introduced. Dispatch the oldest eligible
entry atomically with permit acquisition, rechecking its grant, deadline and
revisions. Remove fenced or expired entries with a recorded reason; paused
entries cannot block the queue. Resume makes paused work eligible again without
silently preserving priority across an authority-changing correction.

The ready queue, permit ownership and release are restartable SQLite state.
Recover abandoned local execution ownership through the existing generation
fences; recovery must not replay a remote submission. A result delivered while
capacity is full remains observable in the inbox, not lost or repeatedly
executed. There is no automatic successor in this phase.

## Bound the external backlog separately

Releasing a task permit must not allow an unbounded number of external jobs or
parked chains. Carry forward plan 2's server-configured limits with proposed
conservative defaults:

- **Two nonterminal remote jobs** globally, including queued jobs,
  `submission_unknown` and cancellation requests until a terminal state is
  verified or explicit reconciliation resolves the submission.
- **Eight open chains** globally; externally parked chains count against this
  same cap rather than receiving a separate additional allowance. Nonterminal
  closed-grant jobs continue to occupy the remote-job cap until resolved.

Enforce these limits alongside per-chain job, attempt, spend and absolute-expiry
limits before admitting intent. Users cannot raise server limits through tool
input. Unknown charges are retained; missing receipts never release assumed
unused resources. Local-only and $0 cloud-spend defaults remain in force.

Haze's task and specialist permits do not bound GPU contention inside Nightshift.
Keep the global job cap and readiness checks separate from those permits, and
measure interactive inference latency while background jobs run before enabling
broader concurrency. Runtime-selected fleets and low budget labels are not hard
Haze admission limits.

## Controls and user visibility

Apply ordinary task controls and Nightshift chain controls through the same
transactional authority boundary. Every mutation retains idempotency and current
revision checks. The UI must distinguish waiting for compute, waiting for Haze
capacity, waiting for a user and stopped work.

| Control or event                                | Required behavior                                                                                                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause                                           | Fence new submissions and local result consumption; suspend eligible queue entries. Continue observing known jobs and retaining receipts. Pause alone does not claim remote compute stopped.                |
| Resume                                          | Revalidate the same unexpired grant, remaining resources, original run deadline and current revisions; enter capacity admission before execution. No resource reset.                                        |
| Cancel                                          | Close the grant, fence queued wakes and execution, and request cancellation of known remote jobs. Retain late receipts as history and show cancellation requested separately from confirmed terminal state. |
| Relevant permission revocation                  | Close the affected chain grant and fence use of its results; request known-job cancellation without claiming termination.                                                                                   |
| Objective correction or assignment supersession | Invalidate old delivery authority, waits and queue entries. Retain original provenance; no automatic reassignment of an old result to the revised objective.                                                |
| Run deadline expires                            | Retain terminal results in the inbox and record the expiry reason. Explicit Continue may create a successor only within the same remaining chain grant and absolute expiry.                                 |
| Another run is current                          | Preserve the original result and target; do not revive the predecessor, interrupt current work or create a successor automatically. Explicit reuse needs current authorization and applicability checks.    |

Extend `/nightshift/:jobId?` and the task workspace with the owning task/chain,
required dependencies, target revision, retained outputs, delivery state,
capacity-queue state and actionable stop reasons. Browser observation remains
read-only. Stopping observation, cancelling a job and cancelling a chain remain
distinct actions.

## Migration and compatibility

Add versioned migrations for wait dependencies, delivery uniqueness, capacity
permits and ready-queue records in the existing authoritative database. Preserve
historical artifacts and public v3 task controls. Document any additive public
field or event in the shared schemas; do not introduce an incompatible run-status
value merely to represent released capacity.

Version the specialist topology and action schema for the external-wait variant,
and version the Manager topology if its wait/finalization semantics change.
Existing checkpoints must not be reinterpreted as the new topology. Define a
supported reconstruction from accepted application records or require explicit
linked continuation; in either case preserve charges, unknown-operation fences,
pinned routes and historical checkpoints. Update the runtime architecture guide
to record the new external-only capacity exception.

## Verification and exit gate

- Validate tool grants, bounded handles, cross-task/workspace rejection, original
  revisions and required-job finalization blocking.
- Exercise result-before-park, park-before-result, duplicate terminal events,
  simultaneous completions, targeted assignment delivery and active-run inboxes.
- Prove specialist-lease release and external-only task-permit release; mixed,
  human, peer and unknown waits must not incorrectly release task capacity.
- Saturate both task permits, complete several jobs together and verify FIFO
  eligibility, no queue jumping, no more than two active tasks, no more than two
  specialists and continued progress as permits are released.
- Crash after permit release, after result/event commit, after queue insertion
  and after permit acquisition but before graph dispatch. Verify recovery does
  not lose results, duplicate delivery or replay submissions.
- Cover pause/resume, stale controls, cancellation races, relevant revocation,
  correction, assignment supersession, deadline expiry and explicit same-chain
  Continue without replenishment. Outputs after fencing remain historical.
- Verify backlog caps include quiet-window, unknown and cancellation-pending
  jobs; enforce a single cap for open and externally parked chains.
- Test old/new topology recovery, deep links, reconnects, queue-state rendering,
  escaped output and truthful cancellation receipts.

Run the relevant repository and isolated crash/restart checks, then capture a
genuine specialist submit/wait/result trace and an interactive-inference latency
observation while a local background job runs. Fixture traces prove control flow
only. The previously observed unreachable daemon remains an unmet live gate
until a new successful trace is captured.

This plan is complete only when wait delivery and capacity invariants are proven
and explicit user continuation remains necessary after run expiry. Enabling
automatic successor creation belongs exclusively to
[plan 4](nightshift-04-automatic-chains-plan.md).
