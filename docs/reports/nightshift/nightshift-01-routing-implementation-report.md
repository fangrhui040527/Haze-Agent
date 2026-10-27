# Nightshift routing implementation report

Date: 27 October 2026, Asia/Singapore.

Routing infrastructure, persistence, sanitized readiness and evaluation tooling
are implemented. The three direct-inference contract blockers below are now
fixed through a separate, versioned strict endpoint on the installed Nightshift
1.2.1 runtime. Genuine bounded probes passed for structured output and truthful
token-limit truncation through Haze's adapter.

**Plan 1 still requires role-quality release evidence.** Contract compatibility
does not establish accepted Manager or specialist quality. No role default was
promoted, and this routing remediation adds no background jobs or automatic
chains.

Latest recheck: the [role-decision quality follow-up](nightshift-01-role-quality-fix-report.md)
records additional reference/schema fixes and a **15/15 direct, 15/15 Nightshift**
Ultra contract comparison. The failed comparison below remains historical
evidence; independent role-quality review and end-to-end traces remain open.

## Changes delivered

| Area                              | Changes                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and adapters        | Added versioned named profiles and mappings for all five roles; preserved inherited shared-provider settings. Reject malformed JSON, duplicate keys, unknown mappings, invalid parameters and credential-bearing URLs. Cache adapters by immutable route identity and credential generation. Secret rotation can refresh the same admitted credential reference.                                                                 |
| Strict Nightshift transport       | Added exact-model NVIDIA/Nemotron dispatch through authenticated `/v1/haze/contract` and `/v1/haze/chat/completions`. A fresh read-only contract/model preflight runs before Haze charges a call. Preserve raw provider finish/usage fields and required reasoning controls; reject unsupported policy, models and parameters. No provider retry, model fallback, race, judge call or server tool injection occurs in this path. |
| Admission and persistence         | Added versioned additive migrations and immutable `run_model_routes`, `assignment_model_routes` and `operation_model_routes` tables. Every new task and explicit continuation stores the complete role map in the authoritative task database.                                                                                                                                                                                   |
| Assignment and recovery authority | Late assignments, rebriefs, replacement attempts and restart recovery resolve the stored role route. Resume retains the admitted map. Explicit Continue admits new authority. The server snapshot contract also accepts an inherited map for future chain successors.                                                                                                                                                            |
| Remote operations                 | Added admitted route and capability identity to the durable request fingerprint and an immutable operation linkage. Operation preparation and route linkage commit together before dispatch. Known unavailable routes fail before charging a call; successful receipt replay remains available without current credentials.                                                                                                      |
| Historical runs                   | Historical operations without route linkage remain unknown. Unfinished pre-snapshot runs pause with a route-upgrade explanation; Resume cannot silently attach current configuration. An explicit linked continuation obtains a new snapshot.                                                                                                                                                                                    |
| Receipts and validation           | Preserve requested route separately from actual response model, ID, usage and response/HTTP status. Missing usage stays null. Partial, truncated, malformed, oversized and rejected responses retain safe known metadata. Injected and fixture receipts are marked synthetic. Existing strict action validation, limits, cancellation and unknown-outcome handling remain in force.                                              |
| Readiness and UI                  | Added read-only `/api/nightshift/readiness` through the existing local identity/workspace boundary and an **Agent Routes** page in the existing layout. Configuration, schema compatibility, reachability, live verification, role evaluation and requested policy are separate fields. Public output excludes endpoint details and credential references.                                                                       |
| Policy                            | Explicit routes do not fall back to another provider/model. Unsupported local-only restrictions fail closed. Direct calls retain Haze call/token limits and are not represented as covered by a future job-chain spending cap.                                                                                                                                                                                                   |
| Evaluation                        | Added 15 frozen single-decision scenarios covering the five roles, baseline/candidate comparison with matched limits, original inputs/outputs, actual receipts, independent schema/reference/outcome/latency checks and an append-only attempt journal. These probes execute no tools and never promote defaults.                                                                                                                |

Implementation is concentrated in:

- `app/contracts/model-routes.ts`, `app/adapters/model-routes.ts` and
  `app/adapters/nightshift/runtime.ts`.
- `app/orchestration/model-service.ts` and `app/composition.ts` for the internal
  service boundary and registration.
- `app/tasks/model-route-store.ts`, `runtime.ts`, `store.ts`, `graph-ledger.ts`
  and `http.ts` for authority, persistence and access.
- `frontend/src/features/nightshift/`, application navigation/router and the
  local API middleware for the read-only page.
- `scripts/evaluate-routes.mjs`, its scoring helper/tests and
  `docs/testing/cases/route-evaluation-cases.json` for retained evaluation evidence.
- `app/adapters/nightshift/strict-model.ts`,
  `scripts/nightshift-strict/{handler,integration}.mjs`,
  `scripts/install-nightshift-strict.mjs` and
  `scripts/verify-nightshift-strict.mjs` for strict dispatch, reproducible
  installation and bounded verification.

The [evaluation guide](../../testing/model-route-evaluation.md) and
[environment template](../../../.env.example) document configuration and operation.
`routes:evaluate` and `routes:test` are available as npm scripts; the latter is
also part of `check` after the build step.

## Nightshift contract remediation

A fresh authenticated, bounded `/v1/models` inspection succeeded on this
installation. The requested Nemotron model was advertised. This supersedes the
plan's historical daemon-unreachable observation **only for reachability and
model advertisement**.

The original inspection identified three blockers in the general compatible
endpoint. The remediation keeps that endpoint's app-routing behavior intact and
gives Haze a separate strict transport:

| Original blocker                                                                                                | Implemented resolution                                                                                                                                                                                                                                                                                                          | Verification                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bound app could override the requested model, and unknown model names could enter mode routing.               | Resolve the exact registered model before provider dispatch. Reject aliases, changed native IDs, unavailable/disabled models and incompatible app bindings. The current supported target is NVIDIA-hosted Nemotron chat with its registered reasoning control. Haze also rejects a missing or mismatched actual response model. | Negative conformance tests make zero upstream calls; the genuine completion and truncation receipts identify the exact requested Lightning model.                                                                   |
| Token-cap selection alone did not establish enforcement; buffered responses could invent `stop` and zero usage. | Normalize a bounded integer cap into NVIDIA's `max_tokens`; reject conflicting fields. Forward provider JSON without reconstructing model, ID, finish reason or usage. Haze rejects non-`stop` decisions and known cap violations; absent usage remains null in receipts.                                                       | A genuine eight-token request returned `length` and eight reported output tokens. Haze retained the receipt and rejected the truncated output. Fixture tests separately distinguish missing usage and genuine zero. |
| The forwarding allowlist discarded `chat_template_kwargs`.                                                      | Explicitly validate and forward `chat_template_kwargs: { enable_thinking: false }` at the final provider boundary. Preserve supported JSON-object/native-schema requests and agent-owned strict action validation.                                                                                                              | A real loopback HTTP provider fixture captures the exact outgoing reasoning setting, cap and schema. The genuine structured-output probe returned the expected JSON object with `stop`.                             |

Haze now requires capability contract `nightshift-haze-strict-v1`, SHA-256
`620b391969989be38c6b52a1f1fa25a8982482cbd115dd3bc6ee4fa83968790e`.
Authenticated `GET /v1/haze/contract?model=<exact-id>` resolves current model,
credential and operator-policy eligibility without inference. Every successful
completion identifies this contract in its response header. The original
unverified capability identity is incompatible; old snapshots are retained and
require an explicit linked continuation to admit new route authority.
Exact model authority here means the registered provider API identity; provider
weights or an immutable underlying model revision are not attested by these
receipts.

The strict facade uses the fixed `haze-agent` application policy. Privacy floors,
lane restrictions, withholding, redaction, mandatory quality stages and explicit
app budgets/bindings are checked. Requirements that this single-call path cannot
satisfy are rejected; settings and credentials are not changed. The path does
not claim local-only compute or Nightshift job-chain spending-cap coverage.
Dispatched gateway timeouts/network failures carry an unknown-outcome marker
that Haze retains as charged, non-replayable work.

`npm run nightshift:contract:install -- --check` verifies seven inspected source
hashes before any write. Installation retains byte-exact backups under
`%LOCALAPPDATA%/Nightshift/engine/haze-strict-backup-v1/`, adds the two overlay
modules, and patches only the host facade and authenticated server route.
Repeated installation is idempotent. Unknown builds, modified installed files
and conflicting backups fail closed. `--restore` restores original host/server
bytes and preserves backups and overlay files, including operator changes.
Runtime upgrades require inspection and conformance validation before updating
the supported source hashes; there is no force/bypass option.

The installed idle engine worker was reloaded through the daemon's supervised
respawn after checking that queued/running/paused/open job counts were all zero.
This was an abrupt worker reload, not a claimed graceful flush. The daemon and
GUI remained running, and no job records or task databases were deleted.

Original source hashes retained for identifying the inspected build under
`%LOCALAPPDATA%/Nightshift`:

| File                        | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `engine/openai.mjs`         | `7a8cfc0a0dec8b45d5c70e5baee54303d29c583ab6514a6e677737d2edbfb066` |
| `engine/js/engine/proxy.js` | `f562ed24daefd01890a8fa4d3432a24cad93d41653c9210ed0e57003f22d58e1` |
| `cli/lib/transport.mjs`     | `2ba85dbdd7ea8e4d31fc76c60d44e9c4267b097a194d0123e24612d3284eb3a7` |

These three original files remain unchanged. The installation manifest at
`%LOCALAPPDATA%/Nightshift/engine/haze-strict-installation.json` retains the
original dependency hashes and installed host/server/overlay hashes.

## Validation results

The contract-remediation validation is recorded separately from the historical
routing run below:

The final focused agent-model, route, persistence and LangGraph run passed
**134 tests across five files** with two workers.

The current complete backend suite did **not** pass: `npm test -- --maxWorkers=4`
finished with **1,033 passed and 10 timed-out tests**, across 91 files. Nine
timeouts occurred in the existing pilot integration file at its 40-second per-test
limit; the merge/world integration helper exhausted its five-second completion
poll while its task was still running. The merge/world case passed in isolation,
and the first affected pilot case passed all assertions in isolation (about
30 seconds of test execution). These isolated passes are consistent with timing
contention, but do not establish a clean full-suite rerun. Domain fixtures,
acceptance assertions, prompts and timeout limits were left unchanged.

| Check                                                | Result                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run routes:test`                                | **38 tests passed**, zero skipped. Covers evaluation scoring, strict transport/facade conformance, installed-server HTTP authentication and cancellation, and guarded installation/restore.                                                                       |
| Focused Haze adapter and persistence tests           | Passed, including fresh negotiation before charge, credential rotation, old-contract rejection, unknown gateway outcomes, cancellation/correction during preflight and credentialless completed-receipt replay.                                                   |
| `npm run typecheck`, `npm run lint`, `npm run build` | Passed.                                                                                                                                                                                                                                                           |
| `npm run frontend:check`                             | Production build passed; 283 tests passed and one existing test was skipped across 41 files.                                                                                                                                                                      |
| `npm run verify:pins`, `npm run test:engines`        | Passed; H-MEM 13/13 and World Model 8/8 conformance checks.                                                                                                                                                                                                       |
| `node scripts/verify-langgraph-crashes.mjs`          | All four process-crash barriers passed after asynchronous preflight was added.                                                                                                                                                                                    |
| Read-only installed endpoint verification            | Passed: missing authentication returns 401; an unknown model returns 409; the exact supported model negotiates the new contract. Zero inference calls.                                                                                                            |
| Two bounded genuine Nightshift probes through Haze   | Passed. Structured JSON: 50 input / 6 output tokens, HTTP 200 / `stop`, 1,139 ms. Forced truncation: 58 input / 8 output tokens, HTTP 200 / `length`, 529 ms; rejected as a decision with its actual receipt retained.                                            |
| Frozen live role comparison after remediation        | **Quality/acceptance gate not passed.** All 30 attempts reached inference and retained genuine HTTP 200 / `stop` provider receipts; zero routes were blocked. The Nightshift candidate passed 11/15 scenarios; the direct inherited NVIDIA baseline passed 10/15. |

This table retains the original comparison. Subsequent action-contract and
instruction fixes, with their retained live comparisons, are documented in the
[role-decision quality follow-up](nightshift-01-role-quality-fix-report.md).

The two live calls used `nvidia/nemotron-3.5-lightning-30b-a3b`. Their combined
reported usage was 108 input tokens and 14 output tokens. They establish the
tested transport contract, not accepted role quality or live evidence retrieval.

The subsequent frozen comparison used the original fifteen scenarios and matched
2,400-token/120-second limits. Candidate role mappings were scoped to the
evaluation child process; saved environment configuration and role defaults were
not changed. Both routes used the same requested model. Candidate failures were
`hazeops-unavailable` and `critic-exact-revision` (strict schema rejection),
`workershield-tool-boundary` (incorrect action/outcome), and
`accountant-independent-check` (incorrect action/support/reference handling).
The baseline also failed those four scenarios and `critic-producer-separation`.
These retained model-action failures keep the frozen acceptance gate closed.
No scenario, prompt, acceptance criterion or budget was changed to produce a pass.
Each route reported 32,742 input tokens; the baseline reported 1,831 output tokens
and the candidate 1,640. Candidate latency ranged from 1,135 to 5,406 ms; baseline
latency ranged from 866 to 3,780 ms. This single retained comparison does not
establish a statistically meaningful quality or latency advantage.

Historical validation from the original routing implementation:

| Check                                                                     | Result                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test -- --maxWorkers=4`                                              | **594 tests passed**, 59 files. The initial unrestricted run had three example subprocess timeouts; the isolated examples rerun and the complete bounded-concurrency rerun passed.                                                      |
| `npm run frontend:check`                                                  | Production build passed; **185 tests passed**, 28 files. Existing main-chunk size and ineffective dynamic-import warnings remain.                                                                                                       |
| `npm run routes:test`                                                     | **5 tests passed**, including duplicate-key/overflow rejection, ungranted tools, stale references and sanitized evaluation readback.                                                                                                    |
| `npm run typecheck`, `npm run lint`, `npm run build`                      | Passed.                                                                                                                                                                                                                                 |
| `npm run verify:pins`, `npm run test:engines`                             | Passed; engine conformance checks were 13/13 H-MEM and 8/8 World Model.                                                                                                                                                                 |
| `node scripts/evaluate-manager.mjs --scripted`                            | **12/12 scenarios passed**. All receipts are explicitly synthetic; this is control-flow evidence.                                                                                                                                       |
| `node scripts/verify-langgraph-crashes.mjs`                               | All four process-crash barriers passed: before dispatch, during remote work, after receipt and after local effect. Unknown outcomes were not automatically replayed.                                                                    |
| Damage-account fixture verification                                       | Passed, including restart, review and exact output selection.                                                                                                                                                                           |
| Browser → readiness API → table                                           | Passed in isolated local state: five rows rendered, refresh completed, no browser console errors, HTTP 200 and no endpoint/credential-reference leakage.                                                                                |
| Formatting of changed implementation/report files; `git diff --check`     | Passed. Whole-repository formatting does **not** pass because six unrelated planning/data-discovery files need formatting; they were left untouched.                                                                                    |
| General verification with configured NVIDIA inference and synthetic tools | **Not passed.** Restart, accepted/held record checks and task completion passed, but `pm25.retrieve` repeated tool calls until its bounded turn limit. No `pm25.capture` was retained; dependent analysis/review assignments cancelled. |
| Nightshift live role quality                                              | **Not passed.** Thirty retained scenario attempts were blocked before invoking an inference adapter. Zero inference calls and zero provider receipts were produced.                                                                     |

The general verification failure retains eight genuine inherited-NVIDIA
completion receipts: 26,777 reported input tokens and 648 reported output tokens,
with HTTP 200/`stop` statuses. Its tools were synthetic. These receipts establish
transport behavior and a failed specialist outcome, not live source retrieval or
a role-quality pass. Fixtures and budgets were not changed to turn this failure
into a success.

Relevant local evidence, retained in gitignored runtime directories:

- Readiness:
  `.state/routing-validation/nightshift-readiness-2026-10-27.json`.
- Thirty blocked role probes and their intent/completion journal:
  `.state/route-evaluation/1793046237280-24098b9a-18e9-4bbb-a063-872f4910b294/`.
- Scripted Manager suite:
  `.state/manager-evaluation/scripted-supervised-1793046434903-9bfa6830-5ce2-44e6-a24d-f861934d7777/report.json`.
- Process-crash verification:
  `tmp/langgraph-crash-verification/787a0461-1f01-4d00-907b-4be0f7bc24c1/report.json`.
- General verification with retained NVIDIA receipts:
  `.state/general-verification/5191437e-1e48-4b54-9250-7c31e7717e45/report.json`.
- Damage-account fixture verification:
  `.state/damage-verification/4bca414f-d3d6-4e4d-ae8f-3a15516dda5f/report.json`.
- Strict installed-endpoint read-only verification:
  `.state/routing-validation/nightshift-strict/1793063346576-02236bca-cafc-4634-b9ed-d571d49e869d/report.json`.
- Genuine structured-output and truncation probes:
  `.state/routing-validation/nightshift-strict/1793063361301-a8ea56ab-726d-4643-b040-6e27b1d69eff/report.json`.
- Frozen thirty-attempt direct-baseline/strict-Nightshift role comparison:
  `.state/route-evaluation/1793063515152-c2d087c8-160d-46bb-a59f-46741ede1356/report.json`
  and its `attempts.ndjson` intent/completion journal.
- Process-crash verification after remediation:
  `tmp/langgraph-crash-verification/4f68afae-96e5-45a6-9da2-64738422ebc4/report.json`.

Checks ran with installed Node `v24.11.0`; the repository declares `24.22.1`.
No runtime upgrade was performed.

## Verification repairs and local state effects

The build inherited `allowImportingTsExtensions` while emitting JavaScript;
adding `rewriteRelativeImportExtensions` to `tsconfig.build.json` fixed TS5096.
Two existing frontend tests had unnecessary `async` declarations that failed
lint; those declarations were removed without changing test behavior.

The existing general verification script only set `STATE_DIR` for its child
server. A configured `HAZE_TASK_STATE_DIR` took precedence, so one validation run
wrote two fixture tasks and their derived local records into
`.state/general-v2`. That run stopped. The script now pins **both** variables to
its unique verification directory, and the rerun used the isolated database.

The two added fixture task IDs are:

- `374dd136-ce18-4400-b4c7-41d2be8699b3` — paused after the fixture correction.
- `936ef5fd-b2f2-414b-80b2-970cf77cd037` — completed.

They were created around 04:25 on 27 October, Singapore time. Their metadata is
retained in
`.state/routing-validation/general-fixture-side-effects-2026-10-27.json`.
No existing records or verification records were deleted.

## Remaining exit gates

The three original direct-inference contract blockers are resolved for the
supported strict NVIDIA/Nemotron path. Other Nightshift models/providers and
incompatible operator policies remain blocked until their contracts are
implemented and verified.

Capture genuine end-to-end Manager and specialist task traces, compare against
the frozen baseline under matched limits, and complete independent role-specific
quality/latency review before release or role-default promotion. The historical
failed NVIDIA retrieval trace remains a separate quality issue.

Readiness now distinguishes negotiated schema compatibility from live and role
verification. Its role-quality and live-verification flags remain unverified;
these probes do not automatically promote a role or rewrite stored routes. The
plan's role-quality release and default-promotion gates remain open.
The complete backend suite also needs a clean rerun after the integration-test
timing failures are addressed; its current result must not be described as a
repository-wide pass.

Follow-up: [specialist execution and routing remediation](nightshift-01-routing-remediation-report.md)
records the deterministic PM2.5 repair, shared action constraints and subsequent
verification evidence. The historical failures above remain retained; the
role-quality promotion gate remains closed.
