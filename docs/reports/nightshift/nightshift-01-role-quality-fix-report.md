# Nightshift role-decision quality follow-up

Date: 27 October 2026, Asia/Singapore.

This follow-up records fixes and rechecks of failures in the
[routing implementation report](nightshift-01-routing-implementation-report.md)
and [specialist remediation report](nightshift-01-routing-remediation-report.md).
Historical failed attempts remain retained. Frozen scenarios, criteria,
one-call limits and strict model identity checks have not been relaxed.
Independent quality review and genuine end-to-end role traces remain required
before role-default promotion.

The final Ultra comparison passed **15/15 scenarios on each route**, with
thirty genuine provider receipts. This passes the frozen automated contract
comparison; it does not complete the independent role-quality release gate.

## Changes

- Manager v12 specifies the decision grammar, keeps finalization fields inside
  `finalize`, and uses legal `question` or `wait` actions for unresolved remote
  outcomes. Uncertainty does not authorize replay or establish recovery.
  Admitted `operation_unknown` events survive context compaction. Serialized
  instructions are 4,738 bytes, below the original 4,746-byte budget.
- Manager contract `haze.manager-references.v1` requires empty decision
  `references`, finalization `sources` and `work_products` when context
  explicitly admits no artifact references. Generation and local validation use
  the same boundary. Fabricated references are rejected without rewriting the
  response. Incomplete, compacted or reference-bearing contexts preserve their
  base contract. Custom schemas retain their narrower constraints and local
  definition scope.
- EvidenceCritic v7 preserves method argument nesting and complete artifact
  references. Tool actions contain only `id`, `type`, `tool` and `input`; even an
  empty `outputs` array is invalid there. Finishing without a review artifact is
  conditional on checking being unavailable. Instructions require brief,
  distinct statements of actual uncertainty.
- DamageAccountant v3 copies complete quantities and unit-value references into
  declared argument fields, retaining `id`, `version` and the full SHA-256.
- Shared contract `haze.specialist-actions.v2` constrains canonical artifact
  reference positions to exact admitted references. Registered argument names
  and narrower constraints remain intact. Admitted choices occur once in a
  shared definition rather than at every argument. A size regression covers
  eight tools, three reference positions and twelve references within the
  unchanged 24,576-byte input limit. Registered business fields retain their
  meaning; malformed-reference fallback applies only to schemaless tools.
- A recheck found a further schema-composition bug: custom base definitions
  nested below `allOf` broke root-local references. Definitions now remain
  accessible, with collision-safe policy names. Regressions cover recursive
  custom bases and recursive registered inputs, while checking that invalid
  tools, inputs and unadmitted references remain rejected.
- The Manager context budget now reserves its complete reference-policy schema
  before context assembly. The previous reservation could exceed the admitted
  input cap near the boundary. The shared schema builder is used for both
  reservation and generation; 41 focused Manager runtime/reference tests passed,
  including a near-limit one-call check under the unchanged 24,576-byte cap.

Instruction identities distinguish new admissions from historical attempts.
Stored identities and route snapshots are not rewritten. Evaluation mappings
are confined to child processes; installed configuration and role defaults are
unchanged. Host dispatch authorization remains authoritative.

## Retained live evidence

Full comparisons use the original fifteen scenarios with matched direct NVIDIA
and strict Nightshift routes. Both routes request the same model within each
comparison. Lightning is `nvidia/nemotron-3.5-lightning-30b-a3b`; Ultra is
`nvidia/nemotron-3-ultra-550b-a55b`. Every scenario permits one call, 2,400 output
tokens and a 120-second deadline, with a 90-second latency gate. No response is
stripped, filled in or retried inside a scenario.

| Model / instruction revision                 | Direct    | Nightshift | Retained report directory                            |
| -------------------------------------------- | --------- | ---------- | ---------------------------------------------------- |
| Lightning; Manager 6, critic 5, accountant 2 | 13/15     | 13/15      | `1793071357197-88a68e2c-6e0a-470f-a459-b85f518ec165` |
| Lightning; Manager 7, critic 5, accountant 3 | 14/15     | 15/15      | `1793071684414-dd5ae530-06a9-407c-a466-1d35eeea3e26` |
| Lightning; Manager 9, critic 6, accountant 3 | 12/15     | 12/15      | `1793073910354-1de6069c-3220-4f02-8b86-ecba112e52b3` |
| Lightning; Manager 10 only                   | 3/3       | 3/3        | `1793074448209-c1d59dd4-e44f-4da5-8048-06e3dcd7a568` |
| Lightning; critic 7 only                     | 2/3       | 2/3        | `1793074448210-961ac20c-d2ad-4004-965a-7a56d548547f` |
| Ultra; critic 7 only                         | 3/3       | 3/3        | `1793074667201-a162b3be-ac05-4080-bce3-67d8fefb9ae4` |
| Ultra; Manager 10, critic 7, accountant 3    | 14/15     | 14/15      | `1793074781644-f400bccb-1498-40d1-a4c6-86d988b179c6` |
| Ultra; Manager 11 only                       | 2/3       | 2/3        | `1793076058723-3d3a561b-bb98-4159-8ab8-becf2df6ad42` |
| Ultra; Manager 12 only                       | 3/3       | 3/3        | `1793076281329-3b397393-6581-41cc-b742-607125cfe315` |
| Ultra; Manager 12, critic 7, accountant 3    | **15/15** | **15/15**  | `1793076327381-55507abf-8ad2-4711-bf6e-2fd5758ed4ec` |

Each directory above is under
`../../.state/route-quality-fix/role-evaluation/` and contains `report.json` and
retained attempts. Full comparisons made thirty calls; role-only comparisons
made six. The earlier `1793071161833-f852b5a5-4f86-40d3-a974-2c4b77992dbf`
setup report contains zero calls and is not quality evidence. The local runner
is `../../.state/route-quality-fix/run-evaluation.mjs`.

The first comparison rejected misplaced Manager fields and flattened accountant
references. Later Lightning responses still sometimes selected the wrong
Manager outcome or emitted invalid critic fields; one critic response was
truncated after repetitive uncertainty. Ultra passed all specialist cases but
invented a source for the conceptual Manager answer on both routes. That
failure prompted the explicit no-reference contract. The earlier 15/15
candidate result is not used to hide later failures.

Manager 11 correctly rejected the same invented source under the new local
contract, but its single-source finalization example still conflicted with the
no-source rule. Manager 12 replaces that example with source-free finalization
and makes citation guidance conditional on selected admitted sources. Its
role-only probe and the subsequent complete comparison passed on both routes.

In the final comparison, all thirty responses reported HTTP 200, `stop` and the
exact requested Ultra identity, with no synthetic receipts. All latency and
output-cap gates passed. Direct usage was 29,051 input / 1,477 output tokens;
Nightshift usage was 29,051 input / 1,444 output tokens. Latency ranged from
921 to 41,631 ms direct and 912 to 11,969 ms through Nightshift. This single
comparison is not evidence of a statistically meaningful advantage.

A separate read-only audit verified all thirty unique receipt IDs, paired
input hashes, unchanged frozen contexts and role boundaries. It is retained at
`../../.state/route-quality-fix/final-live-audit.md`; this audit covers the
single-decision probes and does not substitute for end-to-end release review.

The frozen scenario SHA-256 remains
`8897cb46b00c4712a95803fd6245aceee8cd096e007da0ae68fcb974fb5fdf9e`.
These comparisons measure single-decision contract and scenario behavior. They
do not establish live source retrieval, scientific validity, a quality or
latency advantage, or independent role approval.

## Backend validation

The latest complete-suite recheck was **interrupted**, not passed. Six files
reported 76 passing and two failing tests before termination; no final Vitest
JSON report was produced. A pilot case exceeded its original 40-second deadline,
and a programme continuation case failed in the broad run but passed its
isolated recheck with the original assertions and budgets. Source snapshots
record fourteen files changing during execution, including concurrent Manager,
programme and test edits, so this is not validation of a stable final snapshot.
The interruption audit is
`../../.state/route-quality-fix/backend-tests-recheck-interrupted.json`.
The pilot timeout reproduced in isolation and remains unresolved.

The retained full live comparison pins Manager v12. Concurrent workspace edits
subsequently advanced the Manager definition; those later versions are not
automatically covered by that live result.

The final production build, repository TypeScript checks, global ESLint and
**45 routing/strict-transport checks** passed. Routing tests include the new
Manager boundary and retain the original evaluator's rejection behavior.

The earlier affected run passed **136 tests across eight files**, covering
strict action contracts, agent instructions, Manager decisions/storage/runtime,
Nightshift waits and automatic chains, and LangGraph recovery. Its report is
`../../.state/route-quality-fix/affected-tests-final.json`.
Two additional previously failing workflow cases passed with their original
budgets in `../../.state/route-quality-fix/workflow-regressions-final.json`.
The schema recheck added coverage: **26 specialist-contract tests** and **56
Manager contract/decision tests** passed.

The broad run retained as
`../../.state/route-quality-fix/backend-tests.json` is **not a clean full-suite
pass**: 1,160 tests passed, eight failed and seven assertion records remained
unfinished after a worker allocation crash. Vitest warned that some tests were
still running while generating its summary. Concurrent edits also caused a
Manager version mismatch. Context-size regressions and timed-out workflows
subsequently passed focused reruns. No timeout, task budget or acceptance
assertion was increased to make these checks pass.

A backend unit suite exercises orchestration, permissions, reference integrity,
storage, restart/recovery and capability flows with controlled fixtures. Its
result is separate from genuine provider inference and live evidence retrieval.

## Model identity and remaining gates

The 120B route remains incompatible: the provider returns
`private/nvidia/nemotron-3.5-super-120b-a12b` instead of the registered requested
`nvidia/nemotron-3.5-super-vl-120b-a12b`. The adapter continues to reject it and
retain the actual receipt. Resolving the route requires a provider/registry
identity contract that genuinely matches; relabelling the response is not a fix.
Ultra evaluations use its exact returned identity.

A read-only installed endpoint check passed missing-authentication rejection,
unknown-model rejection and exact Lightning contract negotiation with zero
inference calls. Its report is
`../../.state/routing-validation/nightshift-strict/1793070831519-2847b851-0e02-408b-8b77-47d27ad664b1/report.json`.

Independent quality review and genuine end-to-end role traces remain open. The
historical general verification uses synthetic tools, so its success does not
satisfy live evidence retrieval. No model has been promoted to a role default.
