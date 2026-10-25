# General task engine (v3)

The task API is a clean replacement for the historical v1/v2 paths. It retains TypeScript, LangGraph, SQLite and the existing application. The Manager may respond directly, ask a question or create a bounded dependency graph from registered executable definitions. Specialists cannot delegate.

## Ownership

- `app/contracts/`: browser-safe request, task, result, event, source/artifact, correction, control and capability schemas. `json.ts` is explicitly server-only serialization and hashing.
- `app/agents/`: versioned Manager, HazeOps, WorkerShield and EvidenceCritic instructions and action validation.
- `app/capabilities/`: applicability, input parsing, retrieval guidance, deterministic methods, checks, artifact schemas and optional assignment templates.
- `app/tasks/`: authoritative row persistence, atomic reservations, task lifecycle, execution services and HTTP.
- `app/orchestration/`: executable registry, strict action protocol and LangGraph reference checkpoints.
- `app/adapters/`: provider and authenticated transport; models never submit SQL or executable code.
- `app/composition.ts`: the single registration point. Core-to-domain imports are prohibited by lint and architecture tests.

PM2.5 scope, SQL construction, retained-source semantics, producer calculations and the separate independent checker live in `app/capabilities/pm25`. Numerical availability is a PM2.5 artifact, not a required global result field.

## API

All routes use the `/api` prefix and retain the local same-origin boundary. Every mutation needs a stable `Idempotency-Key`. Identical redelivery returns the recorded receipt; different content under the same key fails. Client-supplied identity, permissions and resource authority are rejected.

| Route                               | Behavior                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/tasks`                   | Admit `haze.task.request.v3` with an objective and optional bounded JSON scope, context references, constraints and deliverables   |
| `GET /api/tasks/:id`                | Current task, runs, assignments, corrections, questions, applicability and general result                                          |
| `GET /api/tasks/:id/events?after=0` | Durable events with an exclusive numeric cursor                                                                                    |
| `POST /api/tasks/:id/updates`       | `haze.task.update.v3` exact correction/clarification passage and optional revised scope, imported source references or question ID |
| `POST /api/tasks/:id/control`       | `haze.task.control.v3` pause, cancel, resume, continue or revoke                                                                   |
| `GET /api/capabilities`             | Registered capability and readiness metadata                                                                                       |
| `POST /api/artifacts`               | `haze.artifact.import.v3` bounded source import                                                                                    |
| `GET /api/artifacts/:id`            | Authorized immutable artifact with exact version and hash                                                                          |

Example intake:

```json
{
  "schema_version": "haze.task.request.v3",
  "objective": "Explain the supplied report and identify its unresolved evidence gaps.",
  "context_refs": [
    { "id": "ARTIFACT_UUID", "version": 1, "sha256": "EXACT_SHA256" }
  ]
}
```

Updates and controls include `expected_objective_revision`, `expected_run_id`, `expected_generation` and `expected_state_revision` copied from the latest task. A correction advances the objective revision, preserves its exact passage, stales affected branches and fences previous execution. Unaffected immutable material requires a separately recorded applicability check. The original request is retained unchanged.

Control receipts distinguish requested and confirmed local state. They explicitly do not assert that a remote provider stopped running. Resume keeps the same deadline and remaining charged resources. Continue creates a fresh run linked to its predecessor and revalidates its sources and grants. Revocation checks apply at admission, artifact reads and acceptance boundaries.

Source imports accept UTF-8 plain text, Markdown, CSV and JSON using `filename`, `media_type`, `content_base64` and optional `declared_origin`/`source_location`. Decoded content is at most 1 MiB; transport is at most 2 MiB. Original-byte and parsed-content hashes are separate. Sources may be imported before a task or supplied while answering a question. User attribution does not prove authenticity. Synthetic fixture origin is distinct from live/fixture/replay execution mode.

## Execution and resources

The Manager alone creates assignments. Definitions and versions, dependencies, exact inputs, grants and leases are persisted. Definitions, prerequisites, cycles and reservations are checked before admission. Tools validate both input and output through registered schemas. Agents receive controlled model, tool, artifact and message services, never raw database or adapter handles.

| Profile       | Deadline    | Model calls | Tool attempts | Assignments | Artifacts |
| ------------- | ----------- | ----------- | ------------- | ----------- | --------- |
| Short lookup  | 90 seconds  | 6           | 6             | 6           | 16        |
| Investigation | 300 seconds | 20          | 20            | 16          | 64        |

Defaults permit two active tasks and two shared specialist slots. Each model call is capped by the admitted 16 KiB input and 1,200 output-token allowance. Required review and synthesis retain capacity before specialist work consumes the budget. Failed and unknown remote attempts remain charged. The adapter forwards the admitted output limit unchanged.

One purpose-bound peer channel can join two named assignment instances and revisions. It expires after ten minutes or the run deadline, whichever is sooner, and permits six messages and 12 KiB total. Messages are persisted and deduplicated. Waiting releases a specialist slot; revised, cancelled, revoked or completed participants close the channel. Closed history remains auditable. PM2.5 analysis shares an exact analysis reference, the separate checker replies with its independent verdict, and the waiting producer resumes from its saved work.

Execution completion, evidence support and output usability are separate. An assignment can complete with an evidence gap. Rejected numerical/source material never enters final synthesis. The result carries its answer, exact sources and work products, covered scope, uncertainty, review, currency, next requirements and actual recorded provenance.

## Persistence and restart

Use `.state/general-v1` or an explicitly configured fresh `STATE_DIR`. `storage-format.json` is validated before SQLite is opened. A nonempty unmarked or incompatible directory fails without modification. Existing databases/checkpoints are never migrated, deleted or reinterpreted by this engine.

SQLite transactions own reservations and state transitions; assignment updates do not rewrite a whole-task execution snapshot. LangGraph checkpoints contain authoritative record references. On restart, old leases are fenced, completed accepted material is retained and unstarted work can resume. A dispatched remote attempt without a receipt is recorded as unknown and its branch pauses until explicit resume admits replacement work. Late receipts remain historical and cannot become current output. Resume never replenishes a budget or extends a deadline.

## Verification

Use pinned Node 24.22.1 and npm 11.8.0. `npm run check` runs the repository checks, frontend verification and explicit fixture process/restart verification. `npm run tasks:verify -- --fixture` captures a durable synthetic report; `--live LOCATION UTC_START UTC_END` exercises configured model/source adapters without fallback. Only a captured genuine model/tool trace can establish live readiness. See [general-engine-verification.md](general-engine-verification.md).

The legacy source and orchestration documents remain historical references. Public v1/v2 protocol tags and frontend routing flags are retired. Accepted World Model decisions, effects, memory capture, monitoring and additional scientific domain families are outside this release.
