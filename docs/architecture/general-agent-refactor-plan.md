# Haze v0.14: reusable task engine and separate agent modules

Status: planned; implementation has not started.

Recorded: 25 October 2026.

Reference: [Haze Agent Architecture v0.14](Haze_Agent_Architecture_v0.14.pdf), particularly sections 3–9, 11–16, and 22.

## Summary and agreed decisions

Deliver the practical A–C release from Architecture v0.14: remove domain coupling, deliver a general hybrid execution path, and implement corrections and recovery.

Use a clean break: replace the current v1/v2 paths with one general protocol. Keep TypeScript, LangGraph, SQLite, and the existing application.

Success means a new task family can be added through capability registration and tests, without changing core request/result schemas, HTTP handling, storage, or orchestration.

The frontend changes alongside the backend to support general results, clarification questions, corrections, source uploads, and task controls. The existing visual style can stay.

## Implementation changes

### A. Separate contracts, infrastructure, agents, and capabilities

#### General contracts

- Replace the coupled v1/v2 contracts with independently defined general contracts.
- Introduce the `haze.task.request.v3` protocol and corresponding task, event, result, and artifact contracts.
- Require only an objective and protocol version. Context references, scope, constraints, and deliverables remain optional.
- Scope is bounded JSON interpreted by the selected capability. Location, dates, pollutant, and assessment windows are not global requirements.
- Centralize stable primitives and immutable artifact references. Keep external snapshot references distinct where their semantics differ.
- Keep public contracts browser-safe. Serialization, hashing, storage, and provider code remain server-side.
- Put answer, work products, sources, covered scope, uncertainty, review, currency, next requirements, and actual provenance in the general result. PM2.5 coverage becomes a domain artifact.

#### Agent and capability ownership

Give each agent an executable module:

```text
app/
  agents/
    manager/
    hazeops/
    workershield/
    evidence-critic/
  capabilities/
    evidence-synthesis/
    episode-investigation/
    pm25/
  contracts/
  tasks/
  orchestration/
  adapters/
  checkpoints/
```

- Agent modules own versioned instructions, action/result validation, execution loops, and focused evaluations.
- Capability modules own domain inputs, retrieval guidance, methods, calculations, applicability rules, checks, artifact schemas, and optional workflow templates.
- Move PM2.5 scope parsing, SQL construction, evidence semantics, calculations, independent checking, and domain prompts into its capability.
- Keep transport/authentication in adapters and lifecycle controls in the runtime.
- Register capabilities, agents, and tools at one composition root. Enforce dependency rules preventing core infrastructure from importing domain packages.

### B. Implement reusable, bounded execution

#### Manager and specialist execution

- Replace the fixed five-call workflow with Manager-directed execution.
- The Manager discovers authorized capability cards and chooses direct response, one specialist, parallel assignments, deterministic methods, or a staged investigation.
- Only the Manager creates or revises assignments. Start at delegation depth one with two shared specialist execution slots.
- Represent work as a persisted dependency graph. Validate registered definitions, prerequisites, cycles, grants, readiness, and resource reservations before admitting work.
- Pin exact input artifacts when assignments become runnable. Definition versions and dependency references are persisted.
- Specialists use bounded local loops: retrieve context, change queries or methods, call granted tools, save work, request clarification, or finish.
- Use strict JSON action schemas over the existing completion transport. Persist each response and validated action ID before dispatch.
- Expose controlled execution services for models, tools, artifacts, and messages. Agents receive neither raw database access nor unrestricted adapter access.
- Replace fixed source-specific ports with a typed tool registry. Validate tool inputs and outputs centrally; model-generated SQL or executable code is not accepted.
- Pass admitted output-token limits through to provider requests, removing the adapter's hard-coded 700-token assumption.

#### Authoritative concurrency and resource accounting

- Use atomic SQLite reservations, attempt charging, and compare-and-swap transitions. Eliminate whole-task snapshot writes that can overwrite parallel updates.
- Reserve synthesis and required-review capacity before allocating specialist work.
- Recheck current permissions before metadata disclosure, artifact reads, provider disclosure, tool admission, and output acceptance.
- Keep execution state, evidence support, and output usability separate. A completed assignment may return an evidence gap.
- Prevent producer assignments from approving their own outputs. Preserve the independent numerical checker as a separate implementation.

#### Bounded peer collaboration

- Support one purpose-bound channel per run between named assignment instances and revisions.
- Persist and deduplicate messages; enforce recipient access, expiry, message counts, and byte limits.
- Waiting releases specialist slots. Channels close on completion, exhaustion, cancellation, revocation, or relevant revision changes.

### C. Implement correction, control, and recovery

#### Corrections and controls

- Store the original request and every exact correction passage.
- Separate task objective revision, assignment revision, run identity, and execution lease generation.
- Apply corrections atomically: advance the objective revision, identify dependent branches, mark affected work stale, and fence affected execution.
- Require workers to acknowledge revised briefs before further affected tool admission.
- Preserve immutable artifact contents and hashes. Store currency, supersession, and applicability separately.
- Reuse unaffected artifacts only after recording an explicit applicability check.
- Persist questions and human/data waits rather than repeatedly calling the model while information is missing.
- Implement pause, cancel, resume, permission revocation, and explicit continuation. Control receipts distinguish requested state from confirmed state.

#### Recovery from persisted boundaries

- LangGraph checkpoints reference authoritative task, assignment, action, and artifact records; essential execution material must not live only in closures.
- On restart, acquire new leases and fence old workers. Reuse accepted results and resume unstarted work.
- Interrupted remote calls without receipts remain charged with an unknown outcome. Pause the affected branch until an explicit resume requests a replacement attempt.
- Fence the original attempt before replacement; retain late receipts historically without accepting them as current output.
- Resume preserves the deadline and remaining budget. Expired work requires an explicitly admitted linked run with a new reservation.

## Public interfaces, frontend, and state transition

### General API

Keep the `/api` prefix and expose:

| Interface                     | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `POST /api/tasks`             | Admit a natural-language objective                 |
| `GET /api/tasks/:id`          | Read current task, runs, work products, and result |
| `GET /api/tasks/:id/events`   | Poll durable events after a cursor                 |
| `POST /api/tasks/:id/updates` | Submit corrections or clarification                |
| `POST /api/tasks/:id/control` | Pause, cancel, resume, or explicitly continue      |
| `GET /api/capabilities`       | Read authorized capability/readiness metadata      |
| `POST /api/artifacts`         | Import bounded source material                     |
| `GET /api/artifacts/:id`      | Read an authorized exact artifact version          |

- Mutations carry idempotency keys and expected objective/run revisions. Repeated identical operations return their original receipt; conflicting reuse or stale mutations fail explicitly.
- Control mutations also identify the expected run and generation/state revision, so pause/resume/cancel races cannot pass on objective revision alone.
- Continuation creates a new run under the same task, linked to its predecessor, with revalidated inputs and fresh bounded resources.
- Initially support UTF-8 text, Markdown, CSV, and JSON imports: maximum 1 MiB decoded content, transported as base64 within a maximum 2 MiB request.
- Imported sources can precede tasks and have user/service producers. Store original-byte hashes separately from parsed-content hashes.
- Source location and declared origin are attribution, not proof of authenticity. Keep evidence origin separate from live, fixture, or replay execution mode.

### Frontend behavior

- Update the frontend to one general service and result shell.
- Provide source import, questions, corrections, controls, work products, review, and stale-result display.
- Render PM2.5 details through an optional domain renderer.
- Update agent execution displays to reflect actual assignments, waiting states, and persisted receipts.
- Remove active v1/v2 routing, orchestration feature flags, and obsolete verifier paths together. Reject old protocol tags with migration guidance.

### Fresh state and archival handling

- Default to `.state/general-v1`.
- Validate the storage-format marker before opening SQLite.
- Leave existing databases and checkpoints untouched.
- Incompatible configured directories fail without modification. Do not automatically migrate or reinterpret old rows.
- Historical v1/v2 records are not served through the new API.

## Validation and release gates

Deliver incrementally, with these completion gates:

1. **General intake:** a source-backed explanation succeeds without location, dates, PM2.5 fields, or compulsory specialists.
2. **Hybrid investigation:** an episode investigation retrieves available evidence, runs reproducible analysis and independent checks, uses a bounded peer exchange, and reports unavailable observation or attribution evidence as a truthful partial branch.
3. **Correction:** change the investigation scope; invalidate affected analysis/review, exclude late results, and reuse unaffected material only through recorded applicability checks.
4. **Recovery and races:** verify duplicate delivery, concurrent reservations, pause/cancel/resume, revocation, restart, unknown attempts, and unchanged remaining-budget semantics.
5. **Extensibility:** register a non-PM2.5 test capability with different inputs/results and more than five assignments, without editing core contracts or runtime.
6. **Evidence integrity:** retain numerical/source validation, exact citations, independent checking, and rejected-material exclusion.
7. **Frontend:** verify generic and PM2.5 rendering, questions, controls, correction history, stale results, and desktop/mobile layouts.

Run the repository checks using pinned Node 24.22.1. Keep fixture and live verification explicit and separate. Capability readiness advances only with captured evidence; a genuine configured model/tool trace is required to claim live execution.

## Defaults and boundaries

| Profile       |    Deadline | Model turns | Tool attempts | Assignments | Artifacts |
| ------------- | ----------: | ----------: | ------------: | ----------: | --------: |
| Short lookup  |  90 seconds |           6 |             6 |           6 |        16 |
| Investigation | 300 seconds |          20 |            20 |          16 |        64 |

- These are configurable engineering ceilings, not targets. Start with 16 KiB per model input and 1,200 output tokens per turn, bounded by remaining reservations.
- Allow two active tasks and two shared specialist slots. Peer channels allow six messages and 12 KiB total, expiring after ten minutes or the run deadline, whichever comes first.
- No automatic retries, provider switching, or fixture substitution.
- Retain the local single-user boundary. Additional authentication infrastructure and distributed services are outside this release.
- Production scope is evidence synthesis and episode investigation, including the existing PM2.5 methods. Additional scientific domain packages belong to phase D.
- Accepted World Model decisions, external effects, memory capture, and scheduled monitoring remain disabled.
- Preserve current uncommitted work and source documents. The clean break does not authorize deleting historical state.

## Expected file-change map

This is the expected implementation inventory, not an existing diff. Helper-file boundaries may be refined during implementation while preserving the ownership and interface decisions above.

### Existing backend files

| Area                 | Existing files affected                                  | Change                                                                                           |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `app/contracts/`     | `common.ts`, `json.ts`                                   | Shared primitives, references, validation, and serialization                                     |
| `app/tasks/`         | `contracts.ts`, `http.ts`, `runtime.ts`, `store.ts`      | Replace narrow contracts; implement general admission, APIs, persistence, controls, and recovery |
| `app/tasks/`         | `evidence.ts`                                            | Move PM2.5-specific retrieval into its capability                                                |
| `app/orchestration/` | `contracts.ts`, `runtime.ts`, `store.ts`, `ports.ts`     | Dynamic assignments, budgets, dependencies, leases, peer channels, and corrections               |
| `app/orchestration/` | `pm25.ts`, `fixtures.ts`, `example.ts`, `conformance.ts` | Move domain code and adapt fixtures/adapter verification                                         |
| `app/adapters/`      | `agent-model.ts`                                         | Enforce per-call limits and support bounded agent action loops                                   |
| `app/checkpoints/`   | `sqlite.ts`                                              | Integrate with the new state layout and recovery lifecycle                                       |

New backend modules include the agent and capability directories shown above, plus general contracts such as:

```text
app/contracts/
  tasks.ts
  artifacts.ts
  controls.ts
  capabilities.ts
```

Superseded v1/v2 modules are moved, replaced, or retired as part of the clean break; they are not retained as active compatibility layers.

### Existing frontend files

| Existing file                                        | Change                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `frontend/src/services/agents/HttpAgentService.ts`   | Use the general protocol and new update/control/artifact endpoints                  |
| `frontend/src/services/agents/AgentService.ts`       | Extend the service interface for questions, corrections, imports, and controls      |
| `frontend/src/services/agents/index.ts`              | Remove v1/v2 selection flags                                                        |
| `frontend/src/shared/types/agents.ts`                | Replace narrow task/result types                                                    |
| `frontend/src/features/dashboard/useAgentRun.ts`     | Track waiting, paused, revised, resumed, and continued runs                         |
| `frontend/src/features/chat/ChatPanel.tsx`           | Connect questions, corrections, source import, and controls                         |
| `frontend/src/features/chat/ChatPanel.module.css`    | Style the added chat interactions and general result components                     |
| `frontend/src/features/chat/EvidenceResult.tsx`      | Extract PM2.5 details into an optional renderer; introduce general result rendering |
| `frontend/src/features/agent-office/officeModel.ts`  | Model dynamic assignments, waiting states, and execution receipts                   |
| `frontend/src/features/agent-office/AgentOffice.tsx` | Display the updated assignment state                                                |
| `frontend/scripts/demo-chat-plugin.ts`               | Serve all general API routes; rename to reflect its current purpose                 |
| `frontend/vite.config.ts`                            | Update the API plugin registration/import if renamed                                |

New frontend components cover `TaskResult`, `WorkProducts`, `TaskControls`, `TaskQuestions`, and `SourceImport`, with corresponding styles and tests.

### Scripts, checks, and documentation

- Update `scripts/serve-tasks.mjs` for the general runtime and fresh state directory.
- Consolidate `scripts/verify-task.mjs` and `scripts/verify-orchestration.mjs` into general verification with explicit fixture/live modes.
- Adapt backend task, orchestration, source, and model-adapter tests to the new contracts and ownership boundaries.
- Adapt frontend service, chat, result, agent-office, and API-plugin tests; add coverage for the new interactions.
- Update `package.json`, CI, environment examples, READMEs, and orchestration documentation to describe the new protocol, commands, state layout, readiness, and retired flags.

The largest implementation change is the backend runtime and persistence model. Frontend work makes the new capabilities usable and visible.
