# Nightshift plan 4: Opt-in automatic chains

Status: implementation present behind a closed production release gate. See the
[implementation report](nightshift-04-automatic-chains-implementation-report.md)
for changes, verification and remaining live evidence. This specification does
not establish live readiness.

Depends on [plan 3: external waits and capacity handling](nightshift-03-external-waits-plan.md), including the route snapshots from plan 1 and the durable jobs, receipts and manual-only grants from plan 2. See the [integration roadmap](nightshift-integration-plan.md) for shared policies and limits.

## Outcome and scope

Let a user explicitly authorize a finite chain of Haze runs that consumes Nightshift results and may submit further permitted jobs. Automatic successors spend the original cumulative grant. They never receive fresh authority, resources or a renewed chain expiry merely because a new run is created.

Keep automatic follow-ups disabled by default. Existing manual-only chains stay manual-only after upgrade. Only explicit admission may authorize automatic follow-ups; an agent, model response, restored checkpoint or successful Nightshift judge cannot enable them.

Background generation remains limited to evidence-linked drafts, alternative explanations and critique candidates. Source retrieval, numerical calculations, deterministic methods and independent checks continue through registered Haze capabilities. Candidate generation cannot replace EvidenceCritic, scientific checking or Haze finalization.

## Ownership

- Extract shared linked-run admission from [TaskStore.control](../../app/tasks/store.ts) into a server-only lifecycle service under `app/tasks/`. Both user Continue and the automatic supervisor call this service with an explicit actor and admission mode.
- Keep grant accounting, predecessor selection, authority checks, result delivery and lifecycle decisions in `app/tasks/`, using the existing authoritative SQLite transaction boundary and exclusive runtime owner.
- Keep remote submission, inspection, authentication and CLI parsing behind the `NightshiftJobPort` adapter established in plan 2. The adapter cannot create runs, enlarge grants or accept evidence.
- Reuse graph jobs, operations, waits and event delivery. Register tools through `app/composition.ts`; agents receive restricted orchestration services. Do not introduce a second task orchestrator.

## 1. Enforce one cumulative grant across every execution path

Extend plan 2's versioned manual-only chain envelope. At explicit automatic-chain admission, record:

- Task identity, workspace, objective revision, admitting actor, permissions and the exact route snapshots established in plan 1.
- Initial run, maximum total admitted runs (at most four), and separately authorized automatic follow-ups (at most three). Count any same-chain user-created successor against the same total; manual Continue cannot evade the bound. Zero automatic follow-ups does not prevent an explicitly admitted user-triggered successor.
- Immutable totals for Haze model calls, tool calls, assignments and artifacts, calculated from the resolved investigation profile and admitted run count. Preserve per-call input/output bounds and required synthesis/review reservations.
- Maximum four jobs, sixteen requested attempts, absolute expiry within twenty-four hours, and the admitted privacy/spending policy. Users may lower these limits.

Reserve the cumulative allowance at admission; this is budget authority, not an execution-slot reservation for the chain's lifetime. Give each run a bounded slice of the remaining grant. Its deadline is no later than either the resolved run-duration limit or the original chain expiry. Enrollment of an existing run retains its original limits, route snapshot, deadline, charges and unresolved reservations as specified in plan 2. Reservations, charges and actual receipts remain separate records.

Every model call, tool call, artifact save, assignment admission, replacement attempt, job submission and successor must check both its run allowance and the chain grant in the transaction that reserves or charges it. Per-run usage may start at zero for reporting, but the chain ledger never resets. All same-chain manual Continue, Resume and automatic paths use these checks; a manual run cannot shed chain membership.

Unknown dispatched outcomes remain charged or reserved. Missing usage does not imply zero consumption. Known local rejection before dispatch may release a provisional reservation; never reclaim dispatched resources on an assumption that work stopped. Increasing the allowance requires separate explicit admission with a new grant and historical linkage, after closing the old grant. It is not an ordinary Continue operation.

Retain plan 3's global limits and fair capacity acquisition. Remaining budget does not bypass active-task, specialist or remote-job capacity.

## 2. Admit successors atomically and once

Use one open chain per task, as established in plan 2. Add a database uniqueness constraint for `(chain_id, predecessor_run_id, objective_revision)` so simultaneous job completions, repeated events, manual Continue and supervisor recovery cannot create competing successors.

For each claimed terminal-result delivery, the lifecycle service must atomically:

1. Revalidate identity, objective revision, permissions, route availability, chain revision, opt-in, expiry, remaining resources and execution-topology compatibility.
2. Reject paused, cancelled, revoked or invalidated authority, unresolved unknown operations, unanswered required human questions, completed deliverables and unchanged failed work.
3. Inspect the current run. Wake its targeted waiting assignment if eligible within its deadline, using plan 3's capacity acquisition. If another run is active, leave the result in the durable inbox; do not fence or replace it to make room.
4. Create a successor only for the verified quiescent predecessor and an authorized outstanding purpose. An expired run does not extend its own deadline; the successor receives a slice of the original chain grant and retains `predecessor_run_id`.
5. Coalesce eligible inbox deliveries, reserve successor resources, record the actor and reason, register its versioned graph identity, and assign those deliveries to that successor.

Commit successor creation and its durable graph job together. Kick the existing dispatcher after commit; restart recovery finds the same job if the process stops before the kick. Repeated requests return the recorded successor or waiting decision. If capacity is full, retain a durable ready entry with its original queue position and recheck eligibility when admitted.

Before admitting a successor, record which pending jobs are required or optional and how results transfer. Required work remains a dependency until consumed, explicitly withdrawn under authority, or reported as an unresolved deliverable. Run expiry and successor creation do not complete that dependency.

## 3. Stop on completion, missing authority or lack of progress

Evaluate stopping conditions before each new job and successor. Persist a machine-readable reason, triggering cursor, exact references and remaining resources.

| Condition                                                                                | Required behavior                                                                         |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Haze finalization accepts requested deliverables                                         | Complete the chain; submit no further jobs or successors.                                 |
| Required work remains and a new permitted result is available                            | Allow one eligible wake or successor to inspect it within the remaining grant.            |
| The same job purpose, inputs and unresolved failure are proposed without a changed cause | Pause with `no_progress`; require an explicit revised instruction or supported change.    |
| Required user input or authority is missing                                              | Pause with the exact outstanding question or missing grant.                               |
| An operation or submission outcome is unknown                                            | Block further dispatch and automatic continuation until explicit verified reconciliation. |
| Run/job/attempt/Haze resource limits or absolute expiry are reached                      | Close admission with an exhaustion or expiry reason; retain results and history.          |
| Objective revision or permissions invalidate the grant                                   | Close the old grant; retain subsequent outputs as historical.                             |

Use versioned, runtime-validated progress records: unresolved deliverables or review objections, accepted exact input/output references, known failure causes and the last consumed result cursor. A new UUID, timer tick, changed prose or higher Nightshift judge score alone is not useful progress. A refinement proposal must identify the new input, review objection or changed failure cause it addresses. Haze's existing applicability, review and finalization checks determine success.

Budgets remain the hard bound even when a progress proposal passes validation. Progress never replenishes resources or permits repeating an unknown submission.

## 4. Apply controls to the task and chain together

Use the same authority fence for generic task controls and Nightshift controls. Update chain, current run and grant state atomically before aborting local work or requesting remote cancellation. Record automatic actions as service actions, not user actions.

| Control                    | Required effect                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause task or chain        | Fence current chain execution and freeze new submissions and continuations. Preserve counters, expiry, inbox and acknowledged remote monitoring; do not claim remote jobs paused. |
| Resume                     | Recheck authority and unresolved outcomes, reacquire capacity fairly, retain charges and original expiry. Never enable automatic mode on a manual-only chain.                     |
| Cancel task or chain       | Close the grant, fence local effects and durably request cancellation of known nonterminal jobs. Distinguish requested cancellation from confirmed termination.                   |
| Cancel one job             | Cancel only that job; retain its unresolved dependency and require a new validated decision before any replacement. Never automatically resubmit it.                              |
| Revoke relevant permission | Close affected chain authority and request cancellation of its known jobs. Later output cannot become current evidence.                                                           |
| Correct the objective      | Invalidate the old chain's authority and applicability, preserve historical receipts, and require explicit new admission for automatic work against the revised objective.        |

Use plan 2's historical receipt-ingestion path for late outputs. Capturing immutable bytes after cancellation or expiry must not bypass `assertCurrent`, mark them applicable automatically, or publish into another run. A successor explicitly inspects exact references and passes current applicability and review checks before using them.

## 5. Extend contracts and the existing Nightshift UI

- Add versioned chain admission and controls under `/api/nightshift`, including explicit automatic opt-in, limits, current revisions and stable idempotency keys. Reuse server-owned local identity/workspace authorization; reject client-supplied authority.
- Agents cannot enlarge the envelope, enable automatic mode or select arbitrary commands/endpoints. Their continuation requests are bounded proposals for runtime validation.
- Extend plan 2's screen with lineage, predecessor links, original and remaining grant, admitted/used run counts, inbox deliveries, queue state, next purpose, automatic-mode state and exact stop reasons.
- Show job spend separately from direct agent-provider call/token limits. Cloud stays disabled until verified runtime capabilities enforce each allocated cap and Haze atomically keeps spent plus outstanding allocations within the chain cap.
- Keep stopping browser observation, cancelling one job and cancelling the chain distinct. Browser timers observe state only.
- Add versioned migrations and topology compatibility checks. Preserve historical tasks and receipts without reinterpretation or silently enrolling old tasks.

## Verification and exit gate

- Race two terminal results, manual Continue and the supervisor: at most one successor per predecessor/revision, all intended deliveries retained and no duplicate charges.
- Restart before/after successor reservation, commit, graph enqueue and result assignment; recover the same durable decision and grant.
- Exhaust model calls, tools, assignments, artifacts, jobs, attempts and total runs through mixed manual/automatic paths. Resume, retries and new per-run counters never replenish chain allowance.
- Verify unchanged expiry across downtime, pauses and successor creation; late receipts cannot restore expired authority.
- Verify completed deliverables, repeated inputs/failures, missing user input and unknown outcomes stop dispatch with exact reasons. A higher judge score cannot override these checks.
- Exercise active-run inbox delivery, saturated capacity, fair admission, multiple required jobs, correction/revocation fences, cancel races and route changes after restart.
- Verify synthesis and independent-review reservations remain available, with registered domain methods and Haze acceptance still required.
- Run relevant repository checks and isolated crash/restart scenarios. Capture genuine Manager, specialist and background-job traces for an opt-in bounded chain; retain failures alongside successes.

Release automatic mode only after plans 1-3 pass their gates and cumulative-grant, authority, progress and recovery invariants pass end to end. Schema inspection and fixture success alone are insufficient. Jobs may run inside Nightshift while Haze is offline; monitoring and eligible continuations resume only while the Haze server runs. This plan installs no operating-system service.
