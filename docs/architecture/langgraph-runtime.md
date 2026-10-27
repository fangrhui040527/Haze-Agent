# Executable LangGraph runtime

The v3 task facade remains in `app/tasks/runtime.ts`. Execution is split into independently checkpointed Manager and assignment workflows. SQLite task records remain authoritative for identity, permissions, resources, leases, artifacts, reviews and results. A graph checkpoint never grants authority to publish an effect.

The configured limits remain two active tasks and two globally shared specialist slots. Deterministic scientific methods and public v3 task controls retain their existing authority checks. Nightshift adds explicitly granted candidate-generation tools and an additive external-wait view; it adds no hosted LangGraph dependency or alternative agent framework.

## Execution boundaries

The Manager graph lives in `app/agents/manager/graph.ts` alongside its instructions, context assembly and decision logic. The Manager definition registers its graph factory through the shared contract in `app/orchestration/manager-workflow.ts`, keeping the core runtime independent of agent implementations. Shared specialist execution remains in `app/orchestration/specialist-graph.ts`; the dispatcher, checkpointing and operation ledger provide infrastructure across agents.

The Manager workflow hydrates current records, assembles bounded context, obtains a decision, validates it, applies the authorized action, dispatches eligible assignments and either waits or finalizes. Existing inspect, lookup, apply-plan, steer, coordinate, applicability, question, wait and finalize contracts retain their application validation. Artifact closure and independent-review checks remain finalization requirements.

Assignments have separate graph threads. Specialist model actions pass through context, model, validation and controlled effect nodes. Registered deterministic assignment implementations run as controlled graph nodes and receive the same restricted services. Saving an artifact, sending a message, raising a question or escalation, and calling a model or tool use the durable operation ledger.

A durable dispatcher delivers graph jobs and serializes jobs for each thread. It does not choose dependencies or specialist agents. Graph nodes make those choices, and SQLite lease acquisition enforces the shared specialist limit. The Manager can remain in a model call while an already dispatched specialist completes; there is no parent fan-out/join barrier. Waiting assignments release their execution lease.

Dispatcher invocations enter an independent `AsyncResource` context. This detaches inherited LangGraph `AsyncLocalStorage` configuration when a graph node schedules another graph. Without that boundary, a specialist launched during a Manager node can inherit the parent's checkpoint namespace despite receiving a distinct thread ID, and subsequent independent wakeups cannot find its saved execution.

## Authoritative storage and checkpoints

`storage-format.json` identifies `haze.general.sqlite.v2`. Application data remains in `tasks.sqlite`. Executable graph checkpoints use a fresh `execution-checkpoints-v1.sqlite` database, separate from archived reference checkpoints. Each graph invocation uses `durability: 'sync'`.

| Internal ledger                   | Responsibility                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `run_execution`                   | Engine ownership and Manager/specialist topology versions per run                     |
| `graph_jobs`                      | Durable invocation delivery with thread and event-cursor deduplication                |
| `graph_waits`                     | Persisted wait cursor and matching wakeup state                                       |
| `graph_operations`                | Stable operation identity, request fingerprint, authority and status                  |
| `graph_operation_attempts`        | Links between logical operations and charged attempts                                 |
| `graph_effect_receipts`           | Accepted results returned during replay                                               |
| `legacy_checkpoint_archive`       | Historical execution metadata retained without interpretation                         |
| `external_waits`                  | Exact job dependencies and target task/run/generation/assignment authority            |
| `external_result_deliveries`      | Unique terminal result delivery and the event cursor committed with it                |
| `external_delivery_targets`       | Database uniqueness for each job and exact target thread across separate wait batches |
| `external_dependency_resolutions` | Explicit current-authority candidate, partial-result, failure or replanning decisions |
| `task_capacity_permits`           | Durable admission ownership, independent of the public run status                     |
| `external_ready_queue`            | Bounded FIFO eligibility for results waiting for Haze task capacity                   |

Thread identity includes the engine/topology version, run ID and generation. Assignment threads additionally include assignment ID and revision. The runtime derives these IDs and validates topology before executing. Caller-provided checkpoint namespaces do not establish isolation.

Logical operation identity is stable across a recovery generation; execution authority is checked separately. An operation is prepared before dispatch. Remote operations reserve their budget and record dispatch before contacting the adapter. Accepted responses are retained before graph advancement. A completed operation returns its persisted response during replay. Local effects and their receipts share one application transaction.

There is no distributed transaction between SQLite and an external model or source. A dispatched remote operation with no accepted receipt has an unknown outcome. It remains charged and cannot automatically run again. Unenrolled tasks retain their explicit replacement controls; an enrolled chain blocks further dispatch until its outcome is verified. Continue admits a linked successor under bounded authority, and an enrolled chain supplies only its remaining cumulative allowance. An effect-node retry must never substitute for that user control.

## Waiting and recovery

Only side-effect-free graph wait nodes call `interrupt()`. The dispatcher resumes a matching checkpoint with `Command({ resume })`; the workflow rehydrates authoritative state after the wait. An execution generation change creates a new versioned thread reconstructed from accepted application records and receipts.

LangGraph restarts an interrupted node from its beginning, so an effect before `interrupt()` could otherwise repeat. Keeping effects in receipt-backed nodes and interrupts in separate wait nodes makes that replay boundary explicit. See [LangGraph interrupt rules](https://docs.langchain.com/oss/javascript/langgraph/interrupts).

Events and wakeups commit together. Parking a wait rechecks events after its cursor in the same transaction, covering an event that committed immediately before parking. Repeated delivery of the same thread/cursor reuses the job. The current task, generation, assignment revision, grant and deadline remain authoritative when the job executes.

### External-only waits and capacity

An authorized specialist can submit a bounded Nightshift job through the existing receipt-backed tool path, then emit `haze.external.wait.action.v1` with one to four unique local job handles and explicit required flags. The external-wait effect node commits those exact dependencies and releases the specialist lease before the separate pure interrupt node. An unacknowledged submission remains charged and cannot establish an external wait.

A waiting run can release its durable task permit only when the Manager is parked, every unfinished specialist is blocked directly or through assignment dependencies on acknowledged external jobs, and no specialist lease, open human question, runnable assignment or outstanding Haze operation remains. A queued reviewer behind an externally waiting producer qualifies only while its unresolved dependencies are all blocked on verified external work. Human, peer and mixed waits keep the permit. The public run status can remain `waiting`; the additive view separately reports compute, Haze-capacity, human and stopped states.

The independent supervisor retains receipts under their original provenance. A terminal delivery targets only the intended assignment revision and generation. Its delivery and `external_result` audit event commit together; that audit event cannot wake execution. An `external_result_ready` event becomes eligible only after all required dependencies are terminal. Duplicates reuse the delivery, and simultaneous readiness events coalesce into one pending thread wake. Required dependencies continue blocking finalization until controlled execution records an explicit supported decision. A Nightshift judge and a `use_candidate` decision never establish evidence acceptance or applicability.

All paths starting execution acquire a task permit; specialist execution also acquires a shared specialist lease. When both task permits are occupied, eligible result wakes enter the persisted bounded ready queue. The first eligible sequence and a stable thread identity determine order. Duplicate delivery retains its place; new task admissions cannot jump eligible queued work. Dispatch rechecks the original deadline, grant and exact target revisions before acquiring capacity. Paused work is suspended; fenced or expired entries retain a recorded reason. Capacity release does not expand Nightshift's separate default caps of two nonterminal jobs and eight open chains.

Manual-only grants require explicit Continue after run expiry. An explicitly opted-in chain may admit a successor only through the released automatic policy described below. Every successor consumes the same remaining immutable grant and absolute lifetime; Continue never replenishes that grant. Native Nightshift schedules are not created.

### Finite automatic chains

`LinkedRunService` owns shared user/automatic successor admission. Its transaction checks the predecessor, original grant, current purpose, canonical terminal result, topology, routes, unknown outcomes, unanswered questions and remaining resources. It claims a ticket in the same FIFO capacity queue as external wakes, enrolls at most one successor per predecessor/objective, delegates required and optional inbox dependencies, records the service or user actor and enqueues the Manager graph before commit. The coordinator asks this service to admit work; it never invokes a graph or submits a remote job itself.

Delegated results keep their original job and artifact provenance. A Manager names exact local handles in a specialist assignment's `input.nightshift_job_ids`; the current leased specialist still checks source applicability and independent review. Required dependencies block finalization until consumed, explicitly withdrawn, or named in `nightshift_unresolved_jobs` with an unfinished deliverable. Reporting a gap does not consume a pending result; a later terminal result remains eligible within the same grant. Local result decisions, tool charges and graph receipts are atomic.

Old v1 chain grants stay manual-only. V2 explicitly bounds total and automatic runs separately; exhausting automatic follow-ups leaves separately authorized manual runs usable. Increasing authority needs a separately admitted task and explicit new grant, optionally linked to a closed historical grant. There is no environment enable switch. Production automatic release remains blocked until genuine prerequisite and chain evidence passes; fixture evidence is explicitly labelled and cannot release ordinary live-provider execution.

### Topology compatibility

The current topology versions are `manager.v3.automatic-chains` and `specialist.v3.automatic-chains`. New execution records and thread identities use these versions. Existing v1/v2 checkpoints remain historical and are never interpreted as the new topology. Incompatible unfinished execution requires explicit linked continuation; it preserves existing charges, unknown-operation fences, route snapshots and historical checkpoints. Accepted application records can reconstruct a fenced generation only under the current supported topology and current authority. Neither a graph replay nor a supervisor wake can replay an unknown remote submission.

## Cancellation and publication

Pause, cancel, revoke, correction and supersession first fence database writes, then abort local graph execution. An adapter may ignore cancellation and return later. Such a response may be kept as history; it cannot publish a current artifact, completion or result after its authority changes. Controls continue returning `remote_termination_confirmed: false`.

Resume retains the same admitted deadline and all recorded charges. Continue creates a new run with `predecessor_run_id` under the same task ID. Artifact bytes remain immutable, but reuse requires current permission, exact hashes and applicability. A historical review is not automatic support for a successor run.

## Legacy state and operational cutover

Migration accepts an explicit source directory and creates a separate target. It must reject a running owner, executable leases, unresolved dispatched attempts and incompatible formats. Imported runs are tagged `legacy`; no startup recovery or lease acquisition may execute them. Legacy history remains readable, cancellation and revocation remain available, and unfinished work requires explicit Continue. Legacy Resume and objective update are rejected with the existing Manager upgrade explanation.

The [cutover and rollback runbook](../orchestration/langgraph-cutover-runbook.md) describes the operator procedure. The old executable and verified untouched snapshot form the rollback pair. New-format state is never downgraded or merged into that snapshot.

## Verification scope

The [implementation report](../reports/orchestration/langgraph-implementation-report.md) records the actual checks and remaining gaps. `scripts/verify-langgraph-crashes.mjs` kills a separate runtime process at prepared-operation, in-flight remote-call, persisted-response and local-effect/checkpoint boundaries, then starts a new process against the same isolated directory. Scripted model responses demonstrate runtime behavior, not model reasoning quality or successful live source retrieval.
