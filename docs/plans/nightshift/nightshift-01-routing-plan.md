# Nightshift plan 1: routing with role-specific evaluation

Status: proposed; this document does not establish implementation or live readiness.

Prerequisite: none. This is the first stage of the [Nightshift integration roadmap](nightshift-integration-plan.md). The next stage is [local jobs with basic visibility and manual consumption](nightshift-02-local-jobs-plan.md).

## Outcome and scope

Allow Manager, HazeOps, WorkerShield, EvidenceCritic and DamageAccountant to use independently configured provider/model routes through the existing controlled model-call boundary. Establish real evaluation evidence for each proposed role/route combination before changing its default.

This stage adds inference routing and read-only readiness information. It does not submit background jobs, release task capacity, add external-job waits or create automatic continuation runs. Keep the existing local, single-owner runtime and public task controls.

## Ownership

| Location                                                     | Responsibility                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `app/adapters/agent-model.ts` and `app/adapters/nightshift/` | Provider transport, server-side runtime authentication, provider-specific request/response handling and safe receipts. |
| `app/tasks/`                                                 | Route admission, authoritative snapshots, model-operation identity, permission/resource checks and recovery policy.    |
| `app/orchestration/`                                         | Shared internal model-service and capability interfaces; provider-independent agent actions and validation.            |
| `app/contracts/`                                             | Browser-safe, versioned readiness and sanitized route schemas.                                                         |
| `app/composition.ts`                                         | Register concrete implementations; domain agents and capabilities do not import provider transports.                   |

Nightshift supplies inference. Haze remains authoritative for identity, permissions, charged attempts, strict action validation, accepted effects and evidence acceptance. A provider response or model agreement confers no additional authority.

## Implementation

### Configure and resolve routes

- Add `HAZE_MODEL_ROUTES_JSON` named profiles with provider, requested model, optional base URL and server-side credential environment reference. Map the five registered roles through `HAZE_AGENT_ROUTES_JSON`.
- Preserve `HAZE_PROVIDER`, `HAZE_MODEL` and existing shared-provider settings as the inherited default for unmapped roles. Resolve inherited values into an effective route at admission; do not re-read a mutable default during each model turn.
- Reject malformed configuration, unknown role/profile references, embedded URL credentials and invalid provider parameters at startup. Unavailable credentials or models appear as readiness failures and block affected inference, without preventing read-only readiness or the later jobs screen from loading.
- Explicit routes never silently fall back to another provider or model after rejection, timeout, cancellation or restart. Configuration and credential resolution remain server-owned; agent output cannot choose endpoints or credentials.
- Resolve the route by assignment role in `TaskRuntime`. Cache adapters by effective route identity and credential generation, with isolated immutable configuration rather than mutation of `process.env` or shared request objects. Preserve the injected-model override for tests and mark injected receipts as synthetic when applicable.

### Freeze routes for every admitted task and run

- Persist a versioned immutable role-to-route snapshot for every newly admitted ordinary task/run, not only future Nightshift chains. Each assignment references its admitted role's snapshot, including assignments created after initial admission.
- The server snapshot contains a stable route ID, snapshot version, provider, requested model, normalized credential-free base URL, credential reference and provider capability-contract version/hash. Store credential references rather than secret values. Public readback excludes credential references and sensitive endpoint details.
- Resolve mutable aliases to an exact model identity when the runtime supports it. Otherwise record the alias and actual response model distinctly; do not claim a fixed underlying model or silently accept an incompatible capability change.
- Include the immutable route ID and capability-contract identity in the durable model operation's request fingerprint before reserving/dispatching the remote call. Keep the requested route separately from returned model, response ID, actual usage and response status.
- Recovery and replacement attempts within an admitted run retain that snapshot. A configuration edit applies to newly admitted authority; it cannot alter the provider of existing ordinary tasks, assignments or future enrolled chains. Secret rotation may refresh credentials for the same route without changing provider/model authority.
- Future chain successors must inherit the chain's pinned route map. Do not clone current environment configuration when creating a successor.

### Preserve provider-specific inference contracts

- Extend the adapter with a `nightshift` provider using its supported local OpenAI-compatible endpoint and server-side runtime authentication. Keep runtime discovery and secret access inside the adapter; do not expose tokens in logs, artifacts, errors or browser responses.
- Define and verify the provider capability contract: supported token-limit field, admitted output cap, JSON-object/schema behavior, response and usage fields, reasoning configuration and model availability. OpenAI compatibility alone does not establish equivalent behavior.
- Validate Nightshift's exact token-limit semantics and Nemotron reasoning settings. Preserve local strict action/schema validation even when native structured output is enabled. No stripping or rewriting of invalid model actions into successful actions.
- Retain Haze input/output limits, deadlines, bounded response sizes, cancellation, safe partial/error receipts and unknown-outcome handling. Missing usage remains unknown, and an ambiguous dispatched call stays charged without automatic replay.
- Treat direct inference policy separately from background-job policy. A local endpoint alone does not prove local-only compute. Expose the admitted route's actual supported policy and fail closed if a configured restriction cannot be enforced. Direct provider calls retain Haze call/token limits and must not be presented as covered by a future job-chain cloud-spend cap.

## Contracts, persistence and visibility

- Add versioned schemas for configuration, server-only route snapshots and sanitized readiness responses. Add additive migrations in the authoritative task database for snapshots and operation-route linkage; checkpoints remain references/execution progress rather than route authority.
- Preserve immutable historical receipts. Historical operations with no requested-route snapshot remain explicitly unknown; do not infer their provider from today's configuration.
- Fence unfinished pre-snapshot runs from further model dispatch and explain the route-upgrade requirement. An explicit linked continuation admits a new snapshot through the existing control boundary; migration must not silently remap an active or unknown operation.
- Add read-only `/api/nightshift/readiness` information and an agent-route table: configured route, sanitized provider/model identity, capability/schema inspection, reachability and live-verification status. Keep configured, schema-compatible, reachable and live-verified states distinct.
- The table must describe unavailable routes without hiding failures or claiming that every configured model has passed role evaluation. Use the existing application layout; full job controls belong to plan 2.

## Role-specific evaluation

Freeze scenarios, acceptance criteria, route/model identities and matched resource limits before comparing candidate routes. Retain every attempted scenario, including rejected actions, truncations, unknown outcomes and missing receipts. Compare against the current route without changing fixtures or budgets to favor a candidate.

| Role             | Required evaluation focus                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manager          | Direct response versus delegation, exact references, plan supervision, independent-review requirements, correction/revocation fences, bounded recovery, valid stopping and finalization. |
| HazeOps          | Authorized registered evidence retrieval, exact source selection, unavailable-source reporting and untrusted-source handling.                                                            |
| WorkerShield     | Evidence-linked intervention options, uncertainty, unsupported-claim avoidance and granted-tool boundaries.                                                                              |
| EvidenceCritic   | Independent review of exact artifact revisions, rejected/unsupported claims, invalid provenance and producer/reviewer separation.                                                        |
| DamageAccountant | Correct selection of registered deterministic accounting methods, exact inputs, omissions/uncertainty and independently checked results.                                                 |

Capture strict-action success, correct task outcomes, source/reference integrity, latency and actual provider usage separately. Fixture/control-flow success does not establish real reasoning quality or live evidence retrieval. The [Manager report](../../reports/orchestration/manager-completion-report.md) records unresolved historical real-model failures; those results remain historical evidence and are not a current pass or a fresh benchmark run.

Do not change a role's default route until its predefined quality and latency gates pass with retained genuine traces. A failed candidate can remain explicitly selectable and marked unverified, but must not be promoted through a fallback path. Keep deterministic source retrieval, numerical calculations and independent checks in registered capabilities; generation proposes actions and text rather than replacing those methods.

## Verification and exit gates

- Verify mixed Manager/specialist routes, inherited defaults, invalid configuration, missing credentials, concurrent calls, adapter isolation and injected-model behavior.
- Verify that ordinary-task and assignment routes survive restart and configuration changes, operation fingerprints contain the pinned route, missing historical route identity stays unknown, and future chain inheritance is supported by the snapshot contract.
- Verify exact output caps, strict JSON actions, malformed/truncated/oversized replies, reasoning behavior, rejected credentials, absent usage, cancellation, timeout ambiguity and failures without provider fallback.
- Verify readiness access through the existing local identity/workspace boundary and ensure no secret or credential-reference leakage in public output.
- Run relevant repository checks and isolated restart/replay scenarios. Capture genuine Manager and specialist inference traces against Nightshift separately from fixtures and schema-only inspection.
- Release the routing feature only with honest readiness and retained validation evidence. Promotion of individual role defaults additionally requires that role's evaluation gate. The last recorded inspection found the daemon unreachable; new live checks must establish readiness for the installed build before a live claim is made.

Completion of this plan does not authorize background submission or autonomous work. Those are separately admitted by the later plans.
