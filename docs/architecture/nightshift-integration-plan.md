# Implement Nightshift in Haze

## Summary

Integrate Meterless Nightshift through two paths:

- **Agent inference:** configurable provider and model routes for each agent.
- **Background jobs:** durable multi-attempt generation with progress, results, cancellation and bounded automatic follow-up runs.

Add a dedicated Nightshift screen. Keep Haze responsible for task coordination, resource grants, schema validation and evidence acceptance.

This plan changes Haze only. Cloud jobs remain disabled until Nightshift can enforce the spending cap entered by the user.

## Implementation

### Per-agent model routing

- Extend [agent-model.ts](../../app/adapters/agent-model.ts) with a `nightshift` provider using the local OpenAI-compatible endpoint and server-side runtime authentication.
- Add named route profiles through `HAZE_MODEL_ROUTES_JSON`, containing provider, model, optional base URL and credential environment reference. Map the five registered agent roles to profiles through `HAZE_AGENT_ROUTES_JSON`.
- Roles without an explicit mapping inherit the existing shared provider configuration. Explicit routes never fall back to another provider after failure.
- Resolve routes by assignment role in [TaskRuntime](../../app/tasks/runtime.ts). Cache adapters by effective route and preserve the existing injected-model override for tests.
- Validate configuration syntax at startup. Report missing credentials or unavailable models through readiness information without preventing the jobs screen from loading.
- Preserve admitted input/output limits, JSON action validation, cancellation, timeout handling and actual provider receipts. Validate Nightshift's token-limit fields, JSON-mode behavior and Nemotron reasoning settings explicitly.
- Persist the requested route separately from the returned model, response ID and usage. Snapshot route identities for each chain; configuration changes must not silently change an admitted chain's provider.

### Durable job execution

- Introduce a server-owned `NightshiftJobPort` for submit, inspect, outcome, result and cancellation. Implement it using the installed CLI, invoked without a shell, reusing the demo's discovery and parsing behavior.
- Initially support text `best_of_n` jobs with attempt count, configured fleet, judge, budget level and `now` or `quiet` execution. Model installation, lane administration and native schedules remain in Nightshift's cockpit.
- Add versioned SQLite migrations for jobs, chains, resource reservations and result deliveries. Use the existing authoritative database.
- Commit submission intent and resource reservations before contacting Nightshift. Persist the remote job ID immediately after acknowledgment.
- Never automatically repeat an unacknowledged submission. The installed CLI's idempotency flag does not provide remote deduplication. Mark these jobs `submission_unknown` and require explicit reconciliation against a verified remote job.
- Run a restartable supervisor that polls known jobs independently of browser sessions and active task runs. Retry reads with bounded backoff; reconnect to acknowledged jobs after restart.
- Retain immutable outputs, actual attempt metadata and judging outcomes as service-produced, derived artifacts. Missing metadata remains unknown. Nightshift judging does not establish Haze evidence acceptance.

### External waits and automatic continuation

- Register bounded `nightshift.submit`, `nightshift.result` and `nightshift.cancel` tools under explicit assignment grants. Agents receive local job handles, never arbitrary commands, credentials or remote endpoints.
- Extend specialist actions with an external-job wait. Waiting releases specialist slots; verified external-only waits also release active-task capacity.
- Make required pending jobs dependencies that prevent premature task finalization.
- Deliver terminal results through durable, targeted events. Reuse the ledger's event-before-park protection and deduplicate delivery.
- If the original run remains eligible, wake its waiting assignment. If its deadline expired, create a linked successor. If another run is active, retain the result in an inbox until that run becomes quiescent.
- Extract linked-run creation from [TaskStore](../../app/tasks/store.ts) and add a server-only automatic mode. It must verify predecessor identity, objective revision, permissions, expiry, remaining resources and absence of unresolved unknown operations.
- A continuation may submit further jobs only from the chain's remaining grant. Reserve cumulative Haze resources at admission from the existing investigation profile and admitted run count; automatic successors never replenish that grant.
- Pause freezes new submissions and continuations. Cancel or revoke closes the grant and requests cancellation of known jobs. Objective corrections invalidate the old chain's authority; late outputs remain historical.

## APIs and user interface

Add versioned, schema-validated contracts under `/api/nightshift`:

| Surface    | Purpose                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| Readiness  | Runtime status, sanitized agent routes, capabilities and permitted policies |
| Chains     | Create, list, inspect, pause, resume and cancel bounded chains              |
| Jobs       | Submit, list, inspect, cancel and reconcile jobs                            |
| Job events | Cursor-based progress and terminal-result observation                       |

All mutations require an `Idempotency-Key`; controls also require the current revision. Reuse existing identity, workspace and authorization checks.

Every job belongs to a task and chain. Manual submission can create a new task or attach to an authorized existing task. Agents can consume an admitted grant but cannot enlarge it.

Add `/nightshift/:jobId?` within the existing application layout:

- Runtime readiness and a read-only agent-route table.
- A submission form showing attempts, fleet, judge, execution window and chain limits.
- Persistent job list and detail view with progress, output, outcome, provenance and task linkage.
- Chain lineage, remaining resources, follow-up status and explicit stop reasons.
- Separate controls for stopping browser observation, cancelling one job and cancelling the chain.

Browser timers only observe state. Execution and continuation remain server-owned. Render generated text as untrusted content and distinguish cancellation requested from confirmed remote completion.

## Verification

- **Routing:** different Manager/specialist providers, inherited defaults, invalid configuration, concurrent calls, route provenance and failures without fallback.
- **Inference:** exact output caps, strict JSON actions, malformed/truncated responses, missing usage, authentication failures, cancellation and ambiguous timeouts.
- **Jobs:** rejected policy or budget requests, acknowledged restart recovery, unknown submission without replay, reconciliation, duplicate terminal events and cancellation races.
- **Continuations:** released slots, event-before-wait races, simultaneous job completions, results arriving during active work, expired runs, cumulative budget exhaustion and correction/revocation fencing.
- **UI:** submission deduplication, deep links, reconnects, progress cursors, unavailable runtime, cancellation receipts and escaped output.
- Run repository checks and isolated crash/restart scenarios. Then capture genuine Manager, specialist and background-job traces against Nightshift. CLI schema inspection alone cannot establish live readiness.

## Defaults and rollout

- Maximum **3 automatic follow-up runs**, **4 jobs**, **16 total requested attempts**, and **24 hours** per chain. Users may lower these limits.
- Default job: **4 attempts**, accuracy judge, low budget, immediate execution and runtime-selected fleet.
- Nightshift jobs default to **local-only with $0 cloud spend**.
- Cloud requires server permission, explicit opt-in and an entered chain cap; no positive cap is prefilled. Disable submission unless runtime capability checks establish enforceable caps. Direct agent-provider calls retain their separate Haze call/token limits.
- Reserve requested attempts before submission. Unknown outcomes remain charged; missing receipts never release assumed unused resources.
- Use additive migrations without rewriting historical results. Preserve existing public task protocols and replay guards.
- Roll out inference first, then durable jobs, then continuation chains and the UI. The last inspection found the daemon unreachable, so live verification remains a release gate.
- Jobs may continue inside Nightshift while Haze is offline. Haze resumes monitoring and eligible continuations when its server restarts; this implementation does not install an operating-system service.
