# Contracts

This folder defines the shared data language used by the frontend, HTTP API,
task engine, agents and capabilities. Zod schemas validate runtime values, and
inferred TypeScript types keep callers aligned with those schemas.

## Live and fixture runs

These contracts apply to real execution as well as synthetic tests. A contract
specifies the required data structure and validation rules; it does not supply
the data or select the execution mode.

Both modes use the same `haze.task.request.v3` intake and
`haze.task.result.v3` result schemas. In a live run, the task runtime calls the
configured model and registered live tools, validates their outputs, and saves
artifacts and results under these contracts. Fixture runs use explicitly selected
synthetic implementations to exercise the same boundaries.

Execution mode and evidence origin are separate fields: tasks and result
provenance record `live`, `fixture` or `replay`, while artifacts can identify
`user_supplied`, `external_source`, `synthetic_fixture` or `derived` evidence.
Running in live mode does not by itself establish the authenticity or scientific
validity of supplied data.

Start the configured live task API with `npm run tasks:serve`; the separate
`node scripts/serve-tasks.mjs --fixture` option explicitly selects fixture mode
after building. The [compatibility probe](../compatibility/README.md) uses
synthetic inputs for its infrastructure checks independently of the live task
API. See the [project setup guide](../../README.md) for model and data-source
configuration.

## Responsibilities

- Define versioned request, result, event, artifact and control payloads.
- Specify identifiers, timestamps, representation bounds and exact immutable
  references using an ID, version and SHA-256 hash.
- Describe Manager decisions, capability metadata and World Model records,
  services and API responses.
- Keep schemas usable by browser clients, with the explicit server-only
  serialization module described below.

## Key files

| File                                   | Job                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [common.ts](common.ts)                 | Shared identifiers, timestamps, reasons, origin tags and engineering representation limits.                                      |
| [tasks.ts](tasks.ts)                   | v3 task requests, task/run/assignment records, resource limits, questions, results, events and `TaskError`.                      |
| [controls.ts](controls.ts)             | Corrections, clarifications, pause/cancel/resume/continue/revoke requests, revision expectations and control receipts.           |
| [artifacts.ts](artifacts.ts)           | Bounded JSON, immutable artifact references, content, provenance, applicability and source-import payloads.                      |
| [manager.ts](manager.ts)               | Manager interpretations, actions, decisions, context, inspections, plan revisions, dispatch receipts and artifact-review checks. |
| [capabilities.ts](capabilities.ts)     | Agent roles and public capability cards.                                                                                         |
| [world.ts](world.ts)                   | World Model records, events, relationships, support revisions, assessments, acceptance outcomes, holds and lineage.              |
| [world-services.ts](world-services.ts) | Scoped lookup, context and lineage service inputs and outputs.                                                                   |
| [world-api.ts](world-api.ts)           | HTTP query and response schemas for World Model reads.                                                                           |
| [damage-account.ts](damage-account.ts) | Versioned damage-account imports, scope, inputs, accounting components and reviews.                                              |
| [damage-world.ts](damage-world.ts)     | Typed queries, selections and resolution receipts for World Model damage inputs.                                                 |
| [json.ts](json.ts)                     | Server-only strict JSON parsing, canonical serialization and contract hashing using `node:crypto`.                               |

## Import and validation boundaries

Browser code imports the relevant schema or type directly from this folder.
Keep browser-safe modules free of Node, persistence, provider and execution
dependencies. `json.ts` is explicitly server-only; its hashing and serialization
helpers must stay out of browser imports.

Schemas establish the shape of a value. [Tasks](../tasks/README.md) checks current
identity, permissions, revisions, budgets and lifecycle authority when that value
is used. [Orchestration](../orchestration/README.md) adds execution validation such
as dependency and review checks; its `contracts.ts` contains internal action
shapes. The `app/tasks/contracts.ts` file is a re-export of general protocol
schemas.

When changing a shared payload, update its schema and consumers together and
preserve explicit version handling. Existing public v1/v2 task tags are retired;
the current intake tag is `haze.task.request.v3`.

See the [general task engine guide](../../docs/orchestration/general-engine.md)
for API behavior and the [schema catalog](../../docs/architecture/schema-catalog-v014.md)
for the wider schema inventory.
