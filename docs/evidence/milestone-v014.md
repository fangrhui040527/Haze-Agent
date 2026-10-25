# First v0.14 milestone: read-only PM2.5 evidence

Implemented locally; **live integration readiness remains blocked**. This is an informational evidence summary, not canonical acceptance, publication, a notification, monitoring or an operational action. The original scheduling contracts, fixtures and connected demo UI were subsequently [retired](../history/legacy-retirement.md). This document describes the retained v1 PM2.5 milestone; the opt-in [v2 orchestration scaffold](../orchestration/orchestration-scaffold.md) adds separate role assignments and server cancellation.

## Implementation plan and delivered path

1. Inspect the architecture, existing adapters and baseline; recover the exact pinned runtime and locked installations.
2. Add a small new task namespace, atomic admission/idempotency, durable events/artifacts and access checks.
3. Retrieve one exact PM2.5 selection through Zetaris, compute coverage, synthesize once with the selected provider and record review limits.
4. Connect the existing chat/office to actual receipts and exact citations; test success, gaps, denials, failures and restart.

`app/tasks/contracts.ts` defines `haze.task.request.v1`, task records, event pages and evidence results. An objective is preserved with objective revision 1; optional exact version/hash context references, constraints and deliverables are accepted. Explicit scope can be supplied, or the narrow date-range sentence below is parsed. Ambiguous location/time and conflicting prose/structured scope are rejected before execution. Intervals are UTC, start inclusive/end exclusive, maximum 31 days. No place or time is a global default. Retired scheduling payloads are not migrated into task requests.

`app/tasks/http.ts` handles transport; `runtime.ts` admits/executes bounded work; `store.ts` uses built-in SQLite with WAL and FULL synchronous durability. Admission, scoped operation key and first event commit atomically before HTTP 202. Idempotency is scoped to principal, workspace, operation and contract version with a canonical fingerprint of the submitted JSON value. Reusing a key with different content returns 409. JSON duplicate keys, self-assigned grants/identity/status and legacy scheduling payloads are rejected.

This local release assigns the same server-controlled `local-user` / `local-workspace` identity to local callers. It enforces loopback address, local Host, same-origin POST and cross-site denial. It is a single-user development boundary, not an authenticated multi-user deployment. Context metadata and artifact content require matching principal/workspace and exact version/hash before admission and again before execution. References do not expand grants or change scope; the first capability uses its source selection rather than treating context artifacts as additional evidence sources.

The Manager selects one retrieval, deterministic analysis and one model synthesis turn. Runtime limits are two concurrent tasks, one tool attempt, one model attempt, 16,000 bytes of model input, 700 output tokens, four artifacts and a 90-second absolute deadline. Attempts are charged before calls; no retries or source/provider/mode fallback occur. The existing model adapter enforces its response bounds and cancellation; optional provider receipts record the returned model/response ID/token counts, with unknown fields explicitly null. Configured route and returned model are distinct. Shutdown fences late results; interrupted tasks become explicit failures on restart without replay or a fresh budget. One process owns a state directory.

Artifacts preserve exact raw evidence and query/row selection, analysis, generated model text/receipt and deterministic checks under immutable hashes. Coverage counts expected hourly sample timestamps, never continuous measurements or hourly averages. Readback verifies hashes and recomputes coverage. Review covers scope, numbers, citation linkage and integrity; it is not independent scientific review or proof of prose entailment. Useful insufficient-evidence results are completed domain findings; adapter/model failures are execution failures.

The [source inspection and limitations](pm25-evidence-source.md) explain the sole candidate source: stored Open-Meteo/CAMS modeled PM2.5 through the registered Zetaris `sl_pg` datasource. No direct Postgres/public API fallback is used. Actual source access, available fields and live temporal/spatial coverage cannot yet be verified. Provider issuance is unknown: ingestion now writes NULL instead of collection time, while old raw values remain visible but untrusted. Units and spatial-support limitations of legacy ingestion are explicit.

## Run and try

Use Node **24.22.1** and npm **11.8.0** from the repository pins, then install without changing the lockfiles:

```sh
npm ci
npm --prefix frontend ci
npm run build
```

Configure the existing model route in server-only root `.env` (`HAZE_PROVIDER` plus its key/model settings). Configure existing Zetaris REST access in `third_party/zetaris/.env.local` or the process environment (`ZETARIS_API_KEY`, `ZETARIS_REST_URL`, `ZETARIS_ORG_ID`). No service is provisioned by this implementation. Do not use browser `VITE_*` variables for credentials.

The existing frontend also reads the exact Zetaris `.env.local` file server-side; process environment takes precedence. Start it with:

```sh
npm --prefix frontend run dev
```

Ask, editing both the location and dates for the request:

> Summarize the PM2.5 evidence available for Klang during 2026-10-24 to 2026-10-25, distinguish modeled values from observations, and identify coverage gaps.

General chat uses `HttpAgentService`; the old crew-scheduling prompt and route have been removed. Only persisted server receipts animate the evidence workflow. “Stop waiting” stops browser polling, not the durable server task. A retry keeps the submission's idempotency key. Source/table sample data remains visibly separate from live evidence execution. Exact artifact links open the captured source selection; findings, gaps, assumptions, review and execution provenance appear in the answer.

The standalone local API is also available:

```sh
npm run tasks:serve
```

It listens at `http://127.0.0.1:8787` (override `HAZE_TASK_PORT`). POST JSON with the matching `Origin`, `Content-Type: application/json` and a stable `Idempotency-Key`:

```json
{
  "schema_version": "haze.task.request.v1",
  "objective": "Summarize the PM2.5 evidence available for Klang during 2026-10-24 to 2026-10-25, distinguish modeled values from observations, and identify coverage gaps."
}
```

The response supplies `/api/tasks/:id` and `/api/tasks/:id/events`. Poll events with `?after=CURSOR`; cursors are globally monotonic durable integers and can have gaps for a single task. Artifacts are available at `/api/tasks/:id/artifacts/:artifactId` with the same access checks. Static frontend hosting alone cannot run this API. Vite and standalone serving must use distinct state directories if run simultaneously.

Run the real configured path, including a fresh server-process restart/readback:

```sh
npm run tasks:verify -- Klang 2026-10-24T00:00:00Z 2026-10-25T00:00:00Z
```

This writes a local report under `STATE_DIR/task-verification/<uuid>/report.json` and exits unsuccessfully unless the actual adapters complete. It never installs test doubles or changes execution mode.

## Historical verification evidence — 25 October 2026

These results record the original milestone before scheduling retirement. Test counts and references to the then-present contract/demo fixtures describe that earlier tree; they are not post-retirement check results.

The initial working tree had only untracked architecture PDFs; these and a later user-added damage-account PDF were preserved. No dependency or lockfile changes were needed. Host Node was 24.11.0; checks used a task-local pinned Node 24.22.1 with npm 11.8.0. Locked installs restored missing local `@types/pg` and `lucide-react`. Original HEAD passed root typecheck/lint/build and 324 unit tests; frontend typecheck/build and 75 tests also passed.

The real configured HTTP attempt for Klang, 2026-10-24T00:00:00Z through 2026-10-25T00:00:00Z (end exclusive), reached persisted admission, task start, path selection and the Zetaris tool attempt. It ended `failed` / `unavailable`: **ZETARIS_API_KEY is missing**. Actual usage was one tool attempt, zero model calls, zero evidence artifacts; no remote retrieval or inference succeeded. The independent Zetaris preflight also reported missing `.env.local`/credentials. A fresh server process read back identical persisted task status and events. The final local receipt is `.state/task-verification/c331b96d-e284-46f6-a005-92749b89a9dd/report.json` (ignored runtime state).

Synthetic adapter tests establish wiring, cited results, missing/zero coverage, authorization and context isolation, malformed/self-grant rejection, duplicate/conflicting/scoped idempotency, truthful provider failure, deadline and late-result fencing, and durable completed/interrupted state/events. Separate transport tests check exact row selections, SQL bounds, unknown issuance, null values, response limits, credential handling and provider-returned model receipts. These fixtures do not establish live readiness.

Root `npm run check` passed: pin verification, formatting, root/SmokeLedger typechecks, ESLint, build, unchanged contract/demo/input fixtures, 365 unit tests, and the engine suites (13 H-MEM / 8 World Model). Frontend typecheck, 82 tests and production build passed. The task suite includes 20 checks; NUL, DEL and backslash locations are rejected before any task/event persistence or adapter execution.

Browser verification used a separate local Vite server and state directory, preserving the user's existing servers. Submitting a general PM2.5 question displayed the actual missing-source failure and five persisted receipts, with no substituted answer; roles that did not execute stayed idle. Desktop and 390-pixel layouts were inspected, including chat text and the timeline, with no horizontal overflow. Source samples remained labeled fictional. A complete live cited-answer UI check remains blocked by source access; synthetic rendering tests verify result/citation components separately.

A real programmatic Vite `server.restart()` replaced the server/configuration and then returned identical persisted task state and five events (cursor 5), all HTTP 200. Lazy state acquisition and awaited shutdown prevent the overlapping-server lock race. The local check report is `.state/ui-programmatic-restart-final-20261025/report.json`; verification servers were stopped and existing user servers were preserved.

## Remaining limitations

- Zetaris credentials/reachability, actual query response shape, registered fields and live location/time coverage remain unverified. The milestone is not fully verified until a real source-backed answer is captured.
- Only stored modeled PM2.5 is queried. Observation availability, native model grid support and authoritative provider issuance are not established by legacy ingestion.
- Date framing is deliberately narrow. Other question families, corrections/revision updates, task continuation and user-facing cancellation are deferred. A failed/interrupted task is readable but is never automatically resumed.
- Free-text constraints/deliverables are preserved and supplied to synthesis; runtime permissions, scope, read-only source selection and aggregate budgets are enforced in code. Domain constraints requiring another method/source cannot become available through prose.
- Model prose can still be scientifically wrong. Deterministic findings and exact evidence are exposed with explicit review limits; consequential advice, authoritative state and external effects remain outside this release.
