# Executable LangGraph runtime

The v3 task facade remains in `app/tasks/runtime.ts`. Execution is split into independently checkpointed Manager and assignment workflows. SQLite task records remain authoritative for identity, permissions, resources, leases, artifacts, reviews and results. A graph checkpoint never grants authority to publish an effect.

This change preserves the model selection, agent instructions and roles, tool registrations, deterministic scientific methods, public v3 schemas and HTTP routes. The configured limits remain two active tasks and two globally shared specialist slots. It adds no hosted LangGraph dependency or alternative agent framework.

## Execution boundaries

The Manager workflow hydrates current records, assembles bounded context, obtains a decision, validates it, applies the authorized action, dispatches eligible assignments and either waits or finalizes. Existing inspect, lookup, apply-plan, steer, coordinate, applicability, question, wait and finalize contracts retain their application validation. Artifact closure and independent-review checks remain finalization requirements.

Assignments have separate graph threads. Specialist model actions pass through context, model, validation and controlled effect nodes. Registered deterministic assignment implementations run as controlled graph nodes and receive the same restricted services. Saving an artifact, sending a message, raising a question or escalation, and calling a model or tool use the durable operation ledger.

A durable dispatcher delivers graph jobs and serializes jobs for each thread. It does not choose dependencies or specialist agents. Graph nodes make those choices, and SQLite lease acquisition enforces the shared specialist limit. The Manager can remain in a model call while an already dispatched specialist completes; there is no parent fan-out/join barrier. Waiting assignments release their execution lease.

Dispatcher invocations enter an independent `AsyncResource` context. This detaches inherited LangGraph `AsyncLocalStorage` configuration when a graph node schedules another graph. Without that boundary, a specialist launched during a Manager node can inherit the parent's checkpoint namespace despite receiving a distinct thread ID, and subsequent independent wakeups cannot find its saved execution.

## Authoritative storage and checkpoints

`storage-format.json` identifies `haze.general.sqlite.v2`. Application data remains in `tasks.sqlite`. Executable graph checkpoints use a fresh `execution-checkpoints-v1.sqlite` database, separate from archived reference checkpoints. Each graph invocation uses `durability: 'sync'`.

| Internal ledger             | Responsibility                                                         |
| --------------------------- | ---------------------------------------------------------------------- |
| `run_execution`             | Engine ownership and Manager/specialist topology versions per run      |
| `graph_jobs`                | Durable invocation delivery with thread and event-cursor deduplication |
| `graph_waits`               | Persisted wait cursor and matching wakeup state                        |
| `graph_operations`          | Stable operation identity, request fingerprint, authority and status   |
| `graph_operation_attempts`  | Links between logical operations and charged attempts                  |
| `graph_effect_receipts`     | Accepted results returned during replay                                |
| `legacy_checkpoint_archive` | Historical execution metadata retained without interpretation          |

Thread identity includes the engine/topology version, run ID and generation. Assignment threads additionally include assignment ID and revision. The runtime derives these IDs and validates topology before executing. Caller-provided checkpoint namespaces do not establish isolation.

Logical operation identity is stable across a recovery generation; execution authority is checked separately. An operation is prepared before dispatch. Remote operations reserve their budget and record dispatch before contacting the adapter. Accepted responses are retained before graph advancement. A completed operation returns its persisted response during replay. Local effects and their receipts share one application transaction.

There is no distributed transaction between SQLite and an external model or source. A dispatched remote operation with no accepted receipt has an unknown outcome. It remains charged and cannot automatically run again. Explicit Resume may admit its replacement with the existing deadline and remaining budget; Continue admits a linked successor with fresh bounded resources. An effect-node retry must never substitute for that user control.

## Waiting and recovery

Only side-effect-free graph wait nodes call `interrupt()`. The dispatcher resumes a matching checkpoint with `Command({ resume })`; the workflow rehydrates authoritative state after the wait. An execution generation change creates a new versioned thread reconstructed from accepted application records and receipts.

LangGraph restarts an interrupted node from its beginning, so an effect before `interrupt()` could otherwise repeat. Keeping effects in receipt-backed nodes and interrupts in separate wait nodes makes that replay boundary explicit. See [LangGraph interrupt rules](https://docs.langchain.com/oss/javascript/langgraph/interrupts).

Events and wakeups commit together. Parking a wait rechecks events after its cursor in the same transaction, covering an event that committed immediately before parking. Repeated delivery of the same thread/cursor reuses the job. The current task, generation, assignment revision, grant and deadline remain authoritative when the job executes.

## Cancellation and publication

Pause, cancel, revoke, correction and supersession first fence database writes, then abort local graph execution. An adapter may ignore cancellation and return later. Such a response may be kept as history; it cannot publish a current artifact, completion or result after its authority changes. Controls continue returning `remote_termination_confirmed: false`.

Resume retains the same admitted deadline and all recorded charges. Continue creates a new run with `predecessor_run_id` under the same task ID. Artifact bytes remain immutable, but reuse requires current permission, exact hashes and applicability. A historical review is not automatic support for a successor run.

## Legacy state and operational cutover

Migration accepts an explicit source directory and creates a separate target. It must reject a running owner, executable leases, unresolved dispatched attempts and incompatible formats. Imported runs are tagged `legacy`; no startup recovery or lease acquisition may execute them. Legacy history remains readable, cancellation and revocation remain available, and unfinished work requires explicit Continue. Legacy Resume and objective update are rejected with the existing Manager upgrade explanation.

The [cutover and rollback runbook](../orchestration/langgraph-cutover-runbook.md) describes the operator procedure. The old executable and verified untouched snapshot form the rollback pair. New-format state is never downgraded or merged into that snapshot.

## Verification scope

The [implementation report](../orchestration/langgraph-implementation-report.md) records the actual checks and remaining gaps. `scripts/verify-langgraph-crashes.mjs` kills a separate runtime process at prepared-operation, in-flight remote-call, persisted-response and local-effect/checkpoint boundaries, then starts a new process against the same isolated directory. Scripted model responses demonstrate runtime behavior, not model reasoning quality or successful live source retrieval.
