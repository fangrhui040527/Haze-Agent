# Manager and specialist integration scaffold

The opt-in v2 task path runs Manager planning, HazeOps evidence investigation, WorkerShield deterministic analysis and explanation, EvidenceCritic independent checking, and Manager synthesis. Each model turn has a separate assignment/context and actual receipt. The first static capability is a bounded PM2.5 evidence summary. Existing v1 PM2.5 requests retain their execution path. The historical scheduling package and connected demo UI have been [retired](legacy-retirement.md); scheduling requests no longer route to that workflow.

## Run and connect

Use the repository-pinned Node 24.22.1 and npm 11.8.0, then `npm ci` and `npm --prefix frontend ci`.

```sh
npm run orchestration:verify -- --fixture
npm run test:integration
npm run orchestration:test
npm run tasks:serve
```

The verifier starts its own loopback HTTP server, completes the explicit fixture path, captures exact artifacts/events and starts a fresh process to verify readback. Its report is written under `.state/orchestration-verification/<uuid>/report.json`. `test:integration` runs the same fixture verifier without rebuilding, so run `npm run build` first when invoking it directly. Fixture model responses and evidence are deterministic synthetic examples. They establish wiring, not live source quality or agent reasoning quality. The verifier's fixture report always sets `live_readiness_pass=false`.

For the existing interface, set `VITE_HAZE_ORCHESTRATION=true` in the frontend environment and run the normal frontend development command. The earlier `VITE_HAZE_HYBRID` flag remains a fallback for existing configuration. The default remains v1. Ask with an explicit location/UTC interval, for example:

> Summarize PM2.5 evidence for Klang during 2026-10-24T00:00:00Z to 2026-10-25T00:00:00Z, distinguish modeled samples from observations, and identify gaps.

The normal frontend and standalone API use configured live adapters. They never select fixtures automatically. To run an explicit local fixture API for development, build first and run `node scripts/serve-tasks.mjs --orchestration-fixture`. Its startup message and returned provenance label the fixture mode.

Configure the existing server-only model route and Zetaris environment as described in the v0.14 milestone. Then verify a real path:

```sh
npm run orchestration:verify -- --live Klang 2026-10-24T00:00:00Z 2026-10-25T00:00:00Z
```

The live factory currently wraps the existing configured model adapter; that does not establish a working teammate NightShift service. Optional H-Mem recall and World Model snapshots initially return explicit unavailable results. Reviewed-memory capture and all accepted-state writes/effects remain disabled. A model review never enables them.

## Teammate handoff

`IntegrationPorts` contains asynchronous inference, bounded evidence retrieval, memory recall and versioned World Model reads. Inject an implementation through `createTaskHandler({ stateDirectory, orchestrationPorts })` or `OrchestrationRuntime({ taskStore, stateDirectory, ports })`. The Manager and specialists depend only on those interfaces. The adapter guide documents execution context, cancellation, exact snapshot hashes, receipts and reusable conformance checks.

Ownership is split: the integration owner maintains contracts, coordinator, runtime, development fixtures and conformance tests; each component owner maintains their adapter and live readiness evidence. Preserve immutable upstream engine sources and wrap their facades. A World Model entity schema version is not an immutable snapshot revision.

## API and persisted records

`POST /api/tasks` accepts the opt-in `haze.task.request.v2` request using the existing local same-origin boundary and a stable `Idempotency-Key`:

```json
{
  "schema_version": "haze.task.request.v2",
  "objective": "Summarize PM2.5 evidence for Klang during 2026-10-24 to 2026-10-25 and identify gaps.",
  "constraints": [],
  "desired_deliverables": [],
  "context_refs": []
}
```

Optional explicit scope uses `{ "location": "Klang", "period": { "start": "2026-10-24T00:00:00Z", "end": "2026-10-25T00:00:00Z" } }`. The existing narrow PM2.5 capability frames/validates this scope; intervals are end-exclusive and at most 31 days. Missing/conflicting scope and unsupported requests fail before admission. The shared assignment capability identifier is extensible; adding a domain does not require another permanent role or assignment envelope.

Admission returns task/status/events URLs. `GET /api/tasks/:id` returns `haze.task.v2`, including versioned assignments, charged usage and result/error. Events have `haze.task.event.v2`, actor, optional assignment identity, objective revision, generation and durable cursor. Poll with `?after=CURSOR`; cursor gaps are valid and pages contain at most 100 records. Artifacts remain accessible only within their principal/workspace and owning task URL, with immutable hashes and exact dependency references.

`POST /api/tasks/:id/cancel` accepts `{}` with the same local authority and a stable cancellation operation key. It returns `{task_id,status,generation}`. Recording cancellation advances the generation once, stops new admission and rejects late outputs before artifact/result acceptance. Repeated cancellation is idempotent. Remote termination or billing is not asserted. The UI exposes **Cancel task** separately from **Stop waiting**; stopping browser polling does not cancel server work.

The SQLite task database is authoritative for admission, assignments, permissions, charged attempts, artifacts and terminal state. V2 uses additive `hybrid_*` tables, preserving v1 records. LangGraph checkpoints live in a separate `hybrid-checkpoints-v1` directory and contain task/generation/artifact references. Those storage names, persisted thread IDs and JSON schema identifiers remain unchanged for compatibility while implementation names use orchestration. Checkpoints never authorize work, accept artifacts or replenish resources. Interrupted tasks become explicit failures after restart; no automatic replay/resume occurs.

## Runtime and review limits

The server-owned orchestration scaffold profile defaults to a 300-second absolute deadline, five model calls, six tool operations, sixteen artifacts, 16 KiB per model input and 700 output tokens per turn. Overrides are server-only. Attempts are charged durably before invocation; there are no retries or provider/source fallbacks. Insufficient reservations fail before investigation. At most two tasks are active across v1/v2, with two shared specialist execution slots for v2 tasks.

Manager model output selects only the admitted static capability and its evidence → calculation → review dependency order. It cannot create grants, extend budgets, delegate recursively or choose arbitrary SQL. Roles read authorized exact artifacts. Optional context is stored in full; bounded excerpts supplied to planning include explicit omission metadata. Oversized required model context fails without silent truncation.

WorkerShield computes sample coverage/range using deterministic code. A separate checker independently scans exact source rows, reconstructs missing sample intervals and compares numerical outputs. EvidenceCritic then reviews exact producer artifacts in a distinct model context. Its verdict is `supported`, `needs_review` or `rejected`; scientific qualification and complete prose entailment remain unproved.

Results separately record completion as full, partial or blocked. Rejected reviews use a controlled gap answer, empty findings and null coverage so rejected quantities cannot leak through the UI. Needs-review/coverage gaps remain visible. Model/provider failures retain artifacts and charged attempts without returning a substituted successful answer. Model prose can still be wrong.

## Readiness and subsequent work

The checked-in `orchestration-readiness.json` records component owners, verified stages, missing prerequisites and recheck triggers. Re-run the verifier and update evidence after changing an implementation or configuration. `input_examples/orchestration/pm25-request.json` and `output_examples/orchestration/fixture-trace.json` provide the sample request and a complete captured synthetic trace.

Track each component independently through specified, implemented, fixture-tested, live-executed and independently checked. No stage implies the next. Capability-specific qualification for scientific or operational use requires separate evidence. Live failures leave the affected integration unverified.

Next milestones are user corrections with dependency invalidation, bounded peer exchanges, and safe restart/resume. Conditional World Model writes, canonical decisions, alerts and other effects require their own tested authority/fencing boundaries. Multi-user authentication and distributed execution remain outside this local scaffold.
