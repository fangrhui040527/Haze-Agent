# Orchestration

This folder provides shared execution machinery for registered agents,
capabilities, assignments and tools. It defines how workflows request controlled
services, validates plans and work products, and implements the independently
checkpointed specialist workflow.

## Responsibilities

- Register versioned agent, capability, assignment and tool implementations through
  an `ExecutionRegistry` assembled by [composition.ts](../composition.ts).
- Define typed service interfaces so agents can call models and tools, read or save
  artifacts, ask questions and exchange authorized peer messages.
- Validate assignment dependencies, registered prerequisites, grants and required
  independent review before work is admitted.
- Run specialist model actions and registered deterministic implementations through
  graph nodes, with separate wait nodes and durable operation identities.
- Validate exact artifact revisions and their dependency closure before final
  selection, including required independent reviews.
- Bound asynchronous execution by its deadline and cancellation signal.

## Key files

| File                                       | Job                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [ports.ts](ports.ts)                       | Registration interfaces, `ExecutionRegistry`, restricted execution services and bounded model-call helpers.   |
| [contracts.ts](contracts.ts)               | Internal Zod schemas for specialist actions, assignment outputs and the delegate/question/respond plan shape. |
| [runtime.ts](runtime.ts)                   | Assignment-plan validation, independent-review assessment and final artifact dependency validation.           |
| [specialist-graph.ts](specialist-graph.ts) | Specialist graph state, action routing, deterministic execution, waits and versioned thread invocation.       |
| [manager-workflow.ts](manager-workflow.ts) | Shared Manager graph state, runtime hooks and the factory interface supplied by a registered Manager.         |

The concrete Manager graph lives in
[agents/manager/graph.ts](../agents/manager/graph.ts), alongside its instructions
and decision logic. The Manager registers its factory through the shared workflow
interface. Specialist graphs can continue independently while the Manager makes
another decision; waiting releases their execution lease.

## How it fits

[Tasks](../tasks/README.md) owns durable jobs, budgets, leases, permission checks
and accepted effect receipts. It invokes these workflows and implements their
services. Registration makes an implementation available; the task's current
grants determine whether a particular call is authorized.

[Contracts](../contracts/README.md) holds shared data schemas. Agent behavior lives
in `app/agents/`, domain methods in `app/capabilities/`, and provider integrations
in `app/adapters/`. Add concrete implementations there and register them in
`app/composition.ts`; shared execution interfaces and validation belong here.

See the [LangGraph runtime architecture](../../docs/architecture/langgraph-runtime.md)
for graph topology, replay, waits and recovery.
