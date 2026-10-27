# Specialist execution and routing remediation

Date: 27 October 2026, Asia/Singapore.

Subsequent role-decision corrections and retained comparisons are recorded in
the [role-decision quality follow-up](nightshift-01-role-quality-fix-report.md).
The results below retain the earlier remediation evidence.

The repeated PM2.5 retrieval loop is removed from the registered workflow.
Retrieval, capture persistence, analysis and independent checking now use
capability-owned deterministic executors. The general fixture verification
passes, including restart, accepted/held record checks and a retained capture.
This is execution evidence with synthetic tools, not live source retrieval or
proof of specialist model quality.

The frozen live role-quality gate remains **not passed**. Both retained
comparisons reached all thirty inference calls with genuine provider receipts.
The first comparison passed 14/15 direct-baseline and 13/15 Nightshift scenarios;
the subsequent comparison passed 12/15 and 13/15 respectively. Failed attempts
remain in both reports. No defaults were promoted, criteria relaxed, outputs
repaired or calls retried inside a scenario.

A further role-specific candidate comparison retained a **15/15 direct NVIDIA
baseline**. Its mixed Nightshift candidate passed 6/15: the six Lightning
scenarios passed, while all nine 120B scenarios were rejected because the
provider returned `private/nvidia/nemotron-3.5-super-120b-a12b` instead of the
requested registered `nvidia/nemotron-3.5-super-vl-120b-a12b`. This is a model
identity incompatibility, not nine accepted quality measurements. The identity
check was not relaxed. A separate two-call Ultra transport probe passed exact
identity, structured output and truthful truncation; Ultra role quality was not
tested. No further optional comparisons were run.

## Implementation

- PM2.5 source, coverage and checking results are validated and saved exactly,
  including source provenance and independent-check limitations. Missing scope
  requests clarification. Confirmed source unavailability becomes a gap, with a
  persisted domain error code that survives reconstruction. Unknown outcomes
  remain fenced and are not converted into gaps or automatically replayed.
- The shared `haze.specialist-actions.v1` contract derives legal actions, tool
  argument schemas, recipients, retained-result kinds, exact references and
  acknowledged job handles from admitted context. The runtime and evaluator use
  the same helper for generation and validation. Dispatch still performs its
  current authority checks.
- Peer coordination and peer-wait eligibility refresh between turns. An active
  specialist may wait for Manager coordination before a channel is granted;
  that waiting permission does not grant message access. Explicitly shared
  references remain readable, while assignment finish outputs must belong to
  the current producing assignment revision.
- Role instructions specify action key sets, support enums, honest gaps,
  independent checking and partial unreviewed delivery. Manager recovery guidance
  distinguishes an unresolved remote outcome from admitted continuation.
  Rejected responses use the existing bounded correction allowance; the frozen
  evaluator continues to score the first response only.
- Compound action schemas retain JSON-object transport with strict local
  validation. Native enforcement of those compound schemas is not established
  by the earlier flat-schema transport probes and has not been enabled.

Changed instruction identities are Manager v5, HazeOps v4, WorkerShield v5,
EvidenceCritic v4 and DamageAccountant v2. The changed PM2.5 capability and
assignment definitions use version 5; the source tool uses version 5. Existing
stored identities and route snapshots are not rewritten. Unfinished assignments
pinned to unavailable older definitions require the existing explicit linked
continuation path.

## Verification evidence

- Final complete backend run: **1,165 tests passed across 101 files**, with one
  worker and no overlapping build.
- Final focused regression run: **123 tests passed across ten files**, covering
  exact action constraints, owned/shared references, late peer coordination,
  persistence, explicit waits, Manager decisions and the PM2.5 pipeline.
- `npm run routes:test`: **44 tests passed**, including strict transport,
  authentication, guarded installation and unchanged evaluation scoring.
- `npm run build`, `npm run typecheck` and `npm run lint`: passed.
- Four process-crash barriers passed: before dispatch, during remote work,
  after receipt and after local effect. Their report is
  `../../tmp/langgraph-crash-verification/1204706e-5fc4-46ae-a149-3e3479223765/report.json`.
- General fixture verification:
  `../../.state/general-verification/acb552db-97a6-4fa0-ba63-dd88a01b3615/report.json`.
- First live comparison:
  `../../.state/routing-remediation/role-evaluation/1793066139655-2cdb0ebd-11bd-407c-8e0d-ee6fbd2fb9e9/report.json`.
- Subsequent live comparison:
  `../../.state/routing-remediation/role-evaluation/1793066782164-79054bf3-6f01-492e-844e-047fa5d46262/report.json`.
- Role-specific 120B candidate comparison:
  `../../.state/routing-remediation/role-evaluation-candidates/1793069440481-7b7e3a13-89ca-484c-bb8a-f8f18dfeebb3/report.json`.
- Ultra transport probes (not role-quality evidence):
  `../../.state/routing-validation/nightshift-strict/1793069620531-d26d706c-820b-4c16-9cb7-21fa8c16d6d0/report.json`.
- Backend suite machine-readable output:
  `../../.state/routing-remediation/backend-tests-final.json`.

The earlier broad run is retained as `backend-tests.json` in that directory
(1,159 passed, four failed). Its failures were addressed or passed isolated
rechecks; the final run is recorded separately against
`source-snapshot-before-final.json`. The after-run audit found only an unrelated
concurrent change to `scripts/verify-damage-reduction.mjs`; application and unit
test sources remained unchanged. Final lint was rerun successfully after that
change. Validation used installed Node v24.11.0;
the repository's declared Node version remains v24.22.1.

The frozen scenario file remains SHA-256
`8897cb46b00c4712a95803fd6245aceee8cd096e007da0ae68fcb974fb5fdf9e`.
Both live comparisons used the same requested
`nvidia/nemotron-3.5-lightning-30b-a3b` model with the original one-call,
2,400-output-token and 120-second limits. Route mappings were confined to child
processes; saved environment configuration and provider defaults were unchanged.

The latest retained model failures include malformed Manager/action objects,
an inappropriate recovery finalization, and incorrect independent-check
references. These are rejected rather than stripped, filled in or accepted.
Independent quality review and genuine end-to-end role traces remain required
before role-default promotion. The single-decision probes do not establish
scientific validity, live evidence retrieval or a quality/latency advantage.
