# External evaluation engineering implementation report

The original verification results below are historical. The
[engineering follow-up](#engineering-follow-up-27-october-2026) records this
later recheck and fixes.

Implemented the engineering path from [Plan 05](damage-reduction-05-external-evaluation.md) on 27 October 2026. The user confirmed that no real evaluation package is available and requested the engineering path. The implementation retains imported external evaluation evidence, independently checks supported exact point comparisons, and provides programme Evaluation and learning views. Operational release remains gated on a complete reviewed non-synthetic reference trace.

## What changed

Added browser-safe versioned contracts for external evaluation input, original expected outputs, numerical results, reviewed learning, scientific qualification dossiers, local human adoption and material objections. Inputs bind programme, target/scope hashes, original or amended registered protocol, analysis basis, rule versions, action/deviation/verification records, source method/design and uncertainty interpretation. Unsupported or missing scientific quantities remain explicit gaps. Imported approval flags cannot grant scientific authority.

The [import specification](damage-reduction-05-import-spec.md) describes import order, exact field meanings, examples, bounds and current-use rules.

Extracted the existing Plan 01 exact comparison kernel for reuse by the evaluation producer. It preserves canonical decimal strings, signed differences, exact rational reductions and unrounded cross-multiplied threshold tests. EvidenceCritic independently reconstructs the numerical result from original inputs rather than calling the producer's arithmetic. Bound and probability criteria stay unsupported; neither falls back to a point estimate. Haze does not reproduce the external causal estimator, measurement process or uncertainty calculation.

Added explicit programme `evaluation` admission and two assignments: DamageAccountant `reduction.evaluate` and EvidenceCritic `reduction.evaluation-check`. They save `reduction.external-evaluation`, `reduction.evaluation-learning` and `reduction.evaluation-review`. The phase shares existing atomic admission, identity/mode boundaries, idempotency, one-active-phase rule, run ceilings, budget reservations and coordinated task controls. Importing evidence or recording adoption does not start a run. Evaluation scope and selected sources are pinned to the exact admitted task/run/objective.

Programme reads reconstruct current support from retained history. They check exact source hashes, permissions, holds, assignment provenance, independent review, current upstream results, registration timing, delivery events and deviations. Amendments preserve the original registration. Outcome-aware or unknown timing cannot become prespecified through a new target. Simulated events and human delivery reports cannot supply actual service delivery. Where the declared design requires independent delivery verification, it must cover the selected exact actions.

Operational adoption also requires a named programme scientific owner and an elapsed registered observation period. Future forecasts cannot become achieved effects through a qualified flag. Repeated proof checks share validation only within one synchronous read; a new read starts fresh, including hold/permission/review checks. Failed proof validation cannot leave a partially approved cached product behind. Retained pilot facts conservatively fence active evaluation work; some changes on another registration can require a replacement attempt.

Technical review, dossier completeness and local scientific adoption remain separate records. A human operator may retain a qualified, conditional, unqualified or withdrawn decision; the server checks whether current evidence actually supports it. Unresolved material objections, conditional/withdrawn support, synthetic provenance, stale dependencies, unavailable proof and insufficient delivery block an unconditional claim. The qualified wording is **external evaluation supports the registered target**, accompanied by reproduction limits. A numerical threshold comparison alone is labelled **point estimate meets target**. Supported below-target and insufficient-evidence outcomes are valid completion.

Added the Evaluation and learning panel to the programme page. Operators can import/select exact input and dossier artifacts, explicitly choose a retained registration, start the phase, inspect original evidence and reviews, record adoption/withdrawal and objections, and reopen historical results. Reviewed lessons stay ordinary retained artifacts with publication marked `not_published`; World Model acceptance and H-MEM publication are separate integrations.

Generic task extensions now expose registered tools and read-only task views. The runtime configures grants after extension tools are registered; registry reuse replaces tools owned by the same extension and rejects collisions. Domain evaluation policy remains in the damage-reduction modules.

Manager catalogue compaction removes unused assignment/rule metadata when an exact starting template already specifies the selected work. It preserves original requests, corrections, source references, grants and registered identifiers under the existing 24 KiB input limit. No runtime resource limit was increased.

## Verification

The frozen case inventory is [damage-reduction-evaluation-cases.json](../Testing/damage-reduction-evaluation-cases.json). The reproducible engineering command is `npm run reduction:evaluation:verify`; it writes retained trace evidence below `.state/damage-reduction-evaluation-verification/`.

- Evaluation integration: **18 passed**, including governed four-phase execution, exact nested raw-proof pinning, duplicate imports/replays, rollback, registration timing, unbound-copy denial, coordinated Continue, cumulative budgets, withdrawal, source holds, restart and mode isolation.
- Evaluation numerical/checker tests: **18 passed**. Seven additional server predicate cases passed for the hypothetical positive path, below-target completion, missing adoption, held sources, withdrawal, material objections, elapsed observation period and scientific ownership. These use fictional supplied metadata at a mocked upstream task-view boundary; they do not constitute a real reference trace.
- Evidence-read boundary: **3 passed**, covering nested reuse, fresh next-read holds, identity isolation, failed-review rollback and the cached dependency bound. Focused Manager/runtime checks: **21 passed**.
- Frontend production build and rendered/service tests: **283 passed, 1 existing skipped**. The React review covered explicit mutations, revision fences, read-error claim withholding, accessible forms, exact sources and historical/current learning.

The two multi-phase evaluation lifecycle test cases use 180-second aggregate test guards. Diagnostic timing confirmed completed bounded phases and many exact read/replay operations rather than a blocked task; the 24 KiB Manager input limit and 300-second per-run runtime deadline remain unchanged. An initial broad regression run overlapped a build and was cancelled; subsequent regression checks use stable build output.

Final repository checks:

- Stable-output backend regressions: **991 passed across 89 files**, using `npx vitest run --project unit --maxWorkers 2 --exclude tests/unit/damage-reduction-evaluation-integration.test.ts`. Combined with the separately passed 18 evaluation integration cases, this covers **1,009 backend tests across 90 files**. The two suites are disjoint.
- `npm run build`, `npm run typecheck`, `npm run lint` and `npm run verify:pins`: **passed**.
- `npm run routes:test`: **5 passed**. Engine conformance: **13 H-MEM and 8 World Model checks passed**.
- Scoped formatting across the evaluation implementation, shared kernel, runtime changes, tests, verifier and report: **passed**.
- `npm run check` stops at its formatting stage on four existing files under `tools/damage_data_discovery`: `CRAWLER_CAPABILITIES_AND_DATA_GAPS.md`, `DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md`, `PILOT_READINESS_MATRIX.md` and `seed_sources.json`. Those unrelated files were left untouched. The later checks listed above were executed separately.

The final fresh-process verifier **passed** on 27 October 2026 at 00:53:43 UTC. Its retained [report and exact trace](../../.state/damage-reduction-evaluation-verification/6e0875b1-1b88-4c6c-ad4a-cf81d98cd23f/report.json) identifies programme `267d54c9-dda8-46be-959b-c78f40a83862` and preserves:

- Five explicit runs: assessment, planning, pilot, evaluation and a replacement below-target evaluation. No automatic phase was started.
- Exact programme/task/history reconstruction in a second server process, duplicate phase receipts, historical adoption replay and withdrawal history.
- Fourteen original artifacts explicitly reopened and checked for exact versions, content hashes and bodies, including both external input/dossier/report/data/review/expected-output packages and the nested raw receipt.
- Required-method revocation making the evaluation task view **stale**, with the programme claim withheld.

The trace consumed **0 model calls, 14 tool calls, 31 generated artifacts and 19 assignments**. Reservations returned to zero; seven runs, 400 model calls and 386 tool calls remained in the programme allowance. Phase wall times were approximately **4.30, 6.03, 7.06, 17.87 and 17.91 seconds**. These are local fixture measurements; configured live-model behavior was not tested.

Both evaluations retained synthetic origin and honest delivery gaps. The independent reviews supported the bounded checks: `120 / 1000` meets the numerical threshold; the replacement `50 / 1000` is below it. Neither became an achieved-effect conclusion. Reviewed learning remained `insufficient_evidence` and `not_published`; operational release remained `gated_pending_non_synthetic_trace`, with `achieved_reduction: false`.

## Remaining release gate

All evaluation examples used for this change are synthetic engineering fixtures. No real programme effect, independently qualified scientific reference case or live delivery was demonstrated. No live delivery adapter, monetary target, internal causal estimator or automatic publication was added. Operational conclusions require the scientific owner to supply and review a complete non-synthetic package, followed by exact technical review and explicit local adoption under the server predicate. Browser automation was not used; frontend validation uses compiled code and rendered component tests.

The workspace includes earlier Plans 01–04 and unrelated in-progress changes. This work preserves those changes and has not been committed or deployed.

## Engineering follow-up, 27 October 2026

This recheck covers the implemented evaluation engineering path. Scientific
qualification remains outside its scope, and live delivery remains deferred
as the user requested. It does not create a non-synthetic scientific reference
package or publish reviewed learning.

Two functional defects were reproduced and fixed:

- A reference-shaped proof wrapper could hide additional nested evidence
  because traversal stopped after its `{id, version, sha256}` fields. A material
  objection could consequently appear resolved despite concealed synthetic
  proof. Traversal now retains the wrapper's own exact reference and checks
  its additional fields. Regressions cover hidden synthetic evidence, held or
  missing nested originals, and cycles; the corresponding resolution remains
  withheld. The existing reference and traversal bounds are unchanged.
- Independently supplied expected fractions were compared as literal objects.
  A correct `3/25` or `0.12/1` was rejected against the producer's `120/1000`.
  The producer and independent reviewer now perform exact cross-multiplied
  equivalence checks using their own arithmetic. Generated outputs still use
  the canonical difference/baseline representation. Wrong ratios, zero
  denominators and oversized arithmetic remain rejected. No threshold,
  uncertainty method or scientific qualification rule changed.

All **24 numerical/checker tests** and **9 proof-record/evidence-boundary tests**
pass, including the new regressions. The original **18 evaluation API tests**
also pass under pinned Node 24.22.1, using stable isolated build output. The
two lifecycle cases took 112.95 s and 147.69 s, within their unchanged
180-second test guards. The four discovery-file formatting failures cited
above have already been corrected and pass their focused formatting check.

The baseline fresh-process
[evaluation verifier](../../.state/plan05-recheck-dee71dd7533d45e3926bfce8477892bd/fresh-process/damage-reduction-evaluation-verification/df5a4cb2-6079-49a0-bced-1740944dbe5d/report.json)
passes five explicit runs, fourteen exact original readbacks, restart,
idempotency and method revocation. It used zero model calls, fourteen tool
calls, 31 generated artifacts and 19 assignments, with reservations returned
to zero. This is fixture evidence rather than configured live-model evidence.

After both fixes were overlaid, the final isolated build passed with exit code
zero and **40/40 focused tests** passed: 24 numerical/checker, seven server
predicate, six evaluation-record and three evidence-read boundary tests.
The [final fresh-process trace](../../.state/plan05-recheck-dee71dd7533d45e3926bfce8477892bd/final-fresh-process/damage-reduction-evaluation-verification/d7b4751f-2f52-408f-9fc9-f0f991badbb8/report.json)
also passed with exit code zero after clean shutdown. It repeated five explicit
runs, fourteen exact original readbacks, restart and revocation checks with
the same zero-model usage and reconciled reservations. The final phase wall
times were 3.830, 5.727, 8.965, 29.407 and 18.789 seconds. The
[recheck summary](../../.state/plan05-recheck-dee71dd7533d45e3926bfce8477892bd/evaluation-recheck-summary.json)
and [source-hash manifest](../../.state/plan05-recheck-dee71dd7533d45e3926bfce8477892bd/post-audit-overlay.json)
identify the tested sources. The 18-API suite above was the pre-overlay
baseline; final focused checks and fresh-process execution verified the fixes
without repeating that complete long suite.

Scoped ESLint, formatting and `git diff --check` pass. The complete repository
`npm run check` was not rerun in this review, and no aggregate pass is claimed.
The shared configured live-model readiness limitation documented in the
[Report 04 follow-up](damage-reduction-04-implementation-report.md#still-unresolved-configured-live-model-readiness)
remains open; passing evaluation fixtures do not close it. Scientific
qualification and the non-synthetic reference requirement remain unchanged.

The browser verification gap is now closed with the final compiled backend.
The [UI report](../../.state/damage-reduction-evaluation-ui-recheck/report.json)
and [restart comparison](../../.state/damage-reduction-evaluation-ui-recheck/restart-comparison.json)
record exact input/dossier imports, explicit evaluation admission, a supported
below-target comparison, source/review inspection, withdrawal safeguards,
material objections, history and manual reload. Importing or saving records
did not automatically start a run. Fresh-process readback retained revision 18,
six runs, seven records, sixteen charged tool calls, zero model calls and zero
reservations. Only two regenerated `preview.claims.checked_at` timestamps are
excluded from the comparison. Reimported dossier bytes did not evade the prior
withdrawal safeguard. Learning remained `insufficient_evidence` and
`not_published`; no achieved-effect claim was granted.

The frontend production build and **11 focused Evaluation UI/input tests** pass.
Actual desktop and 390 px mobile checks found no substantive UI defect and no
captured console warnings or errors. No frontend source change was necessary
in this recheck, and all owned verification servers were shut down.
