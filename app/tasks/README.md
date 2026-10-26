# Tasks

This folder owns the lifecycle and authoritative state of a general v3 task:
admission, execution, corrections, controls, results and restart recovery. It is
the application boundary behind the task HTTP API and supplies the controlled
services used by Manager and specialist workflows.

## Responsibilities

- Admit objectives and imported sources under an identity, permissions, deadline
  and resource budget.
- Persist tasks, runs, assignments, charged attempts, actions, questions, peer
  messages, immutable artifacts and events in SQLite transactions.
- Apply idempotency and revision checks to mutations, reserve execution capacity
  and fence workers whose authority has changed.
- Dispatch independent Manager and specialist graph jobs and supply authorized
  model, tool, artifact and messaging services.
- Maintain World Model records, lineage, holds and policy-based acceptance using
  the same application database and transaction boundary.
- Recover accepted work after restart and require explicit controls for replacing
  remote calls whose outcomes are unknown.

## Key files

| File                                                                 | Job                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [http.ts](http.ts)                                                   | Routes task, artifact, capability and World Model requests; enforces the local HTTP boundary and mutation headers. |
| [runtime.ts](runtime.ts)                                             | `TaskRuntime`: connects the store, registered workflows, dispatcher and controlled execution services.             |
| [store.ts](store.ts)                                                 | `TaskStore`: owns transactional task state, reservations, leases, grants, artifact access and accepted results.    |
| [graph-dispatcher.ts](graph-dispatcher.ts)                           | Delivers durable graph jobs, serializes execution for each thread and manages local cancellation.                  |
| [graph-ledger.ts](graph-ledger.ts)                                   | Stores versioned execution identities, jobs, waits, operation attempts and effect receipts.                        |
| [runtime-owner.ts](runtime-owner.ts)                                 | Acquires an exclusive SQLite lock so one runtime owns a state directory.                                           |
| [world-store.ts](world-store.ts), [world-schema.ts](world-schema.ts) | Persist and migrate World Model records, events, relationships, support and acceptance state.                      |
| [world-policy.ts](world-policy.ts), [world-tools.ts](world-tools.ts) | Resolve acceptance policy and expose bounded lookup, context and lineage tools.                                    |
| [migrate.ts](migrate.ts)                                             | Explicitly copies supported legacy state into a separate target and archives its execution history.                |
| [contracts.ts](contracts.ts)                                         | Re-exports general protocol contracts; browser clients import `app/contracts/` directly.                           |

## Storage and execution boundaries

`storage-format.json` identifies `haze.general.sqlite.v2`. Application rows live
in `tasks.sqlite`; executable LangGraph state lives separately in
`execution-checkpoints-v1.sqlite`. Startup checks the format and acquires ownership
before execution. Migration is an explicit operation into a separate directory.

[Orchestration](../orchestration/README.md) defines reusable workflow interfaces,
validation and specialist execution. This folder supplies their services and
checks current authority before accepting effects. [Contracts](../contracts/README.md)
defines the exchanged data, and [checkpoints](../checkpoints/README.md) opens the
graph saver. A saved checkpoint is execution progress; application rows determine
permissions, charges and accepted results.

Resume retains the admitted deadline and recorded charges. A dispatched remote
call without an accepted receipt remains charged and has an unknown outcome;
replacement requires explicit Resume or Continue.

See the [general task engine guide](../../docs/orchestration/general-engine.md)
and [LangGraph runtime architecture](../../docs/architecture/langgraph-runtime.md)
for the full lifecycle and recovery rules.
