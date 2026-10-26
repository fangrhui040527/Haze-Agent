# Add the DamageAccountant agent

Status: imported-input accounting implementation added. See the [implementation report](../orchestration/damage-accountant-implementation-report.md) for changes, executed verification and remaining empirical release gates. The staged requirements below remain the design reference; they do not establish that the empirical pilot or every broader programme module is qualified.

Reviewed: 25 October 2026. Baseline: commit `ce5bf33` plus the current uncommitted Manager v4, runtime, contract and frontend work.

## Purpose and decision

Add `DamageAccountant` as a dedicated specialist under the existing Manager. Give it a versioned `damage-account` capability containing accounting contracts, deterministic methods, input requirements and independent checks. Keep HazeOps responsible for evidence acquisition and EvidenceCritic responsible for independent review. WorkerShield continues to compare interventions and prepare plans; DamageAccountant accounts for supported harm and values the corresponding scenarios.

Use the existing TypeScript, LangGraph, SQLite, provider adapter and v3 task API. Register the extension through `app/composition.ts`. Keep accounting-specific inputs and outputs out of general task admission and persistence logic.

The first useful release is a reproducible accounting engine for reviewed imported quantities and declared unit values. An empirical regional damage estimate is a subsequent milestone requiring scientific inputs and applicability evidence that the current PM2.5 summary does not provide.

## Current repository findings

| Area                   | Current evidence                                                                                                                                                                                                                                                           | Consequence for this work                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration           | [Composition](../../app/composition.ts) registers Manager, HazeOps, WorkerShield and EvidenceCritic, plus PM2.5, episode investigation and evidence synthesis.                                                                                                             | Add a fifth agent and its capability, assignments and tools at this registration point.                                                                                                                 |
| Manager                | [Manager modules](../../app/agents/manager/index.ts), [coordination contracts](../../app/contracts/manager.ts), runtime/store changes and new Manager tests implement substantial v4 functionality.                                                                        | Integrate with the current decision, plan-revision and review interfaces. The existing Manager plan's "implementation has not started" status is no longer an accurate description of the working tree. |
| Review                 | [Capability interfaces](../../app/orchestration/ports.ts) now expose prerequisites, availability, review requirements and review normalization. [Review assessment](../../app/orchestration/runtime.ts) binds verdicts to exact artifacts and producer/reviewer revisions. | Declare mandatory damage reviews through these interfaces and test their enforcement.                                                                                                                   |
| Current domain methods | [PM2.5 methods](../../app/capabilities/pm25/methods.ts) compute modeled sample coverage, missing timestamps and concentration ranges. Episode investigation explicitly reports unavailable observation and attribution adapters.                                           | These results can provide environmental context; they are insufficient for fire-attributable population exposure, health burden or monetary damage.                                                     |
| Other evidence paths   | `server/` contains separate monitoring adapters and evidence records. Retained SmokeLedger source-attribution tooling is separate from the general task registry.                                                                                                          | A typed, permission-aware bridge and applicability review are needed before those records can become accounting inputs. Trajectory/fire weights are not attributable PM2.5 concentrations.              |
| Shared identities      | [Agent roles](../../app/contracts/capabilities.ts) are a closed four-role enum; capability role arrays have a four-item maximum. Frontend identities and office actor mappings are separately enumerated.                                                                  | Extend the role contract and affected UI mappings together. A fifth role does not require more concurrent execution slots.                                                                              |
| Task workspace         | `ManagerWorkspace`, `TaskResult` and `WorkProducts` already show current plans, exact references, objections and saved artifacts.                                                                                                                                          | Extend these surfaces with a validated accounting renderer; retain the current workspace and correction controls.                                                                                       |
| Import limits          | [Artifact contracts](../../app/contracts/artifacts.ts) support bounded UTF-8 text, Markdown, CSV and JSON, with 1 MiB content and 256 dependency references per artifact.                                                                                                  | Start with typed JSON/CSV inputs. Partition larger datasets behind bounded manifests. The existing importer does not accept PDFs or spreadsheets.                                                       |

Current finalization checks required reviews for directly selected references. Its dependency walk tracks coverage but does not enforce those reviews across the full artifact closure. A manifest can therefore require an additional generic closure-validation gate before the new capability is enabled.

The re-review used current source and tests, including uncommitted files. Knowledge-graph refresh failed, so direct source inspection supplied the code evidence. The working tree was changing during review; rebase implementation decisions on its latest state before editing shared Manager files.

## Responsibilities

| Role                | Owns                                                                                                                     | Boundary                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Manager             | Intended use, scope, work plan, corrections, resource allocation, synthesis and completion                               | Cannot waive a required review or infer scientific acceptance from agent agreement.                                                         |
| HazeOps             | Authorized acquisition, source selection, input manifests, coverage and evidence gaps                                    | Cannot turn a source assertion, hotspot or concentration correlation into established damage.                                               |
| DamageAccountant    | Account structure, deterministic accounting execution, overlap decisions, valuation selection and account reconciliation | Uses registered methods and exact inputs. Cannot invent coefficients, causal effects or unit values; cannot review its own production work. |
| WorkerShield        | Intervention options, feasibility and supported effectiveness/cost scenarios                                             | Supplies scenarios to DamageAccountant when appraisal is requested; it is optional for a historical account.                                |
| EvidenceCritic      | Independent reconstruction, accounting checks, applicability objections and exact review artifacts                       | Checks original inputs independently of producer arithmetic. Numerical agreement alone does not establish scientific applicability.         |
| Named domain owners | Attribution methods, health-response transfer, valuation choices and consequential intended-use acceptance               | Expert decisions and their scope must be recorded separately from automated checks.                                                         |

`CONTRIBUTING.md` currently requires preserving four domain roles. Update that statement explicitly for this user-requested fifth role. Preserve the existing roles and their functionality.

## Capability scope and release stages

### Accounting MVP

Support one declared historical episode, with country/subgroup dimensions, typed imported source-attributable physical outcomes, incremental resource quantities, declared compatible unit values and financing records. Produce all three linked accounting views: physical outcomes, financial incidence and selected social welfare. Include coverage, omissions, overlap decisions, uncertainty and exact provenance.

Imported health or sector effects retain their original causal method, population, scenario, evidence status and applicability limits. A successful import does not validate the original study. Missing evidence produces a coverage/gap result and withheld components, rather than an invented estimate.

Represent the source-fire extension explicitly from the first release. Its unsupported categories remain marked not estimated. The accounting MVP is complete only for its declared imported-input scope; it is not the report's complete empirical pilot.

### Empirical pilot

Add reviewed actual/no-target-fire concentration fields or validated source-apportionment outputs, matched population strata, baseline incidence and endpoint-specific response functions. Compute supported exposure and health outcomes through registered deterministic methods. Add priority Singapore sector inputs alongside clearly scoped regional health coverage.

Record emissions periods, consequence periods and valuation dates separately. Preserve risk-function averaging periods, age ranges, lags, rate conventions, nonlinearities and transfer limits. Choose one consistent primary mortality framework, showing overlapping alternatives separately.

### Broader programme

Extend independently to supported sector causal estimation, direct source-fire assets and crops, peat, ecosystems, climate, chronic-health alternatives, distribution and accountability records, and realistic intervention appraisal. Each module needs its own methods, data, applicability review and release evidence. Keep scientific attribution, management/control facts and legal findings distinct.

## Data and artifact contracts

Define browser-safe domain schemas under `app/contracts/damage-account.ts`; server implementations import them. Keep the generic artifact envelope and v3 task result unchanged apart from the additive agent identity. Use explicit domain schema versions such as `haze.damage.account.v1` inside artifact content.

Minimum analytical grain: event and source scope, geography, period, population stratum, endpoint and scenario.

| Contract        | Required contents                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account scope   | Intended use; smoke/source-fire boundaries; countries and social boundary; population; emissions/effect/valuation periods; endpoints; currency/price year; historical and intervention comparators.                                     |
| Input manifest  | Exact source references/hashes; table type; selected rows or partitions; native units/support; method and model versions; access classification; missingness; imported/measured/modeled/synthetic origin.                               |
| Effect          | Stable effect and endpoint IDs; scenario and baseline IDs; geography/time/subgroup; quantity/unit; causal method; applicable source references; uncertainty basis; accounting lens; overlap group; inclusion flag and exclusion reason. |
| Unit value      | Method/version; compatible quantity unit; currency, price year and valuation date; transfer/discount assumptions; included components; applicability evidence.                                                                          |
| Incidence entry | Linked effect/resource and transaction IDs; payer, recipient, amount, financing/transfer type and social-boundary membership.                                                                                                           |
| Coverage        | Covered endpoints and geographic/population support; measured/modeled/imported status; monetary inclusion; omissions with reasons. Distinguish unavailable, not applicable, not estimated, disclosure-suppressed and true zero.         |
| Review          | Exact producer and source references; reviewer identity/revision; executed checks; arithmetic, reconciliation and applicability scope; verdicts and unresolved limitations.                                                             |

Required artifact kinds: `damage.scope`, `damage.inputs`, `damage.coverage`, `damage.physical`, `damage.incidence`, `damage.welfare`, `damage.overlap`, `damage.source-fire-extension`, `damage.methods`, `damage.review` and `damage.account`. The final account is a manifest of exact component references, coverage and selected totals. Add `damage.scenarios` and `damage.revision-bridge` when appraisal or an account revision requires them.

Make units and accounting lens explicit on every quantity. Preserve fractional expected outcomes internally, with presentation precision recorded separately. Store lower/central/upper values only with a declared interpretation; a sensitivity range must not become a confidence interval.

## Execution and independent review

Start with these registered assignments. They are optional Manager templates, not a new mandatory global workflow:

1. `damage.collect` / HazeOps: read the exact imported JSON/CSV references, normalize supported input tables and produce a source manifest with gaps.
2. `damage.scope` / DamageAccountant: bind scope, endpoints, scenarios and approved method versions to those inputs; ask a focused question when a material boundary is missing.
3. `damage.compile` / DamageAccountant: run the registered accounting methods and publish component artifacts.
4. `damage.assemble` / DamageAccountant: depend on the completed component producer and assemble the proposed account manifest. Its envelope dependencies must include the exact component outputs; content references alone do not establish the runtime's dependency closure.
5. `damage.check` / EvidenceCritic: depend directly on `damage.collect`, `damage.scope`, `damage.compile` and `damage.assemble`. Independently reconstruct quantities, inclusion decisions, transfers and selected totals from their pinned inputs. Review the exact manifest and its component closure. Direct component inputs are required by the current exact-review matching rules.
6. Manager finalization: select only current supported account material, or deliver the supported gap/partial result with precise next requirements. Corrections or objections return affected work through revision and re-review.

WorkerShield scenario assignments can precede a later appraisal branch. The Manager remains the sole assignment creator. Retain depth one, two specialist slots and the existing aggregate budgets. A full regional study may require bounded linked runs with fresh reservations; adding an agent must not silently multiply budgets.

Define routing precedence when registering the capability. The current fixture Manager chooses the first available matching template, evidence synthesis is a catch-all, and PM2.5 matching can also capture an accounting request mentioning PM2.5. Register the damage capability before those broader matches and keep catch-all synthesis last, with damage matching scoped to account construction or appraisal intent. Explanatory questions about a report can still use evidence synthesis. Test damage-account requests both with and without PM2.5 wording, ordinary PM2.5 summaries, source explanations and missing-input requests. Keep fixture selection generic; the configured Manager must independently select from the same advertised capabilities rather than rely on a damage-specific fixture branch.

Register `review_requirements`, `prerequisites`, `availability` and `normalizeReview` for the damage capability. Require review of each publishable numerical component and the account manifest. Implement generic finalization checks across the exact transitive artifact closure, validating version/hash, applicability and required reviews at every hop. Add a regression where a supported manifest references an unreviewed or rejected component and finalization rejects it. This closes the observed direct-reference-only gap without importing accounting logic into the runtime.

Use a completed-producer dependency for the first reviewer implementation; it does not require PM2.5's peer-wait choreography. Add a bounded Manager-granted peer channel only for a concrete clarification.

Implement calculations as registered deterministic functions/assignment executors. Where the bounded agent loop selects tools, expose typed `damage.read-input`, `damage.calculate`, `damage.reconcile` and `damage.check` adapters. Inputs contain exact references, approved method IDs and bounded selections, never model-generated executable code or formula strings. Read saved numeric inputs from authorized artifacts rather than accepting model-supplied copies as authoritative.

The checker may share schemas and parsing utilities, but must not invoke producer valuation/reconciliation arithmetic to establish independent agreement. Link review artifacts after production without mutating producer hashes or creating cyclic dependencies. A passed calculation check retains any unresolved scientific applicability limitation.

## Accounting rules

- Keep physical units visible; physical, financing and welfare headline totals are separate views.
- Count a treatment resource once, even when households, insurers and government split its financing. Link both sides of a transfer; cancellation depends on the declared social boundary.
- Select compatible valuation paths. Exclude overlapping mortality valuations/earnings, alternative acute/chronic estimates, cause-specific components of all-cause totals, and duplicated morbidity or production costs.
- Account for substitution, deferred activity, catch-up, durable equipment residual value and capitalized flows where the selected method requires them.
- Reconcile currency, price year, time horizon, subgroup totals and regional boundaries before aggregation. Preserve excluded alternatives and the reason for exclusion.
- Separate source-removal attribution from achievable with/without-project benefit. Record effectiveness, adoption, maintenance, durability, displacement, costs and adverse effects when appraising an intervention. Social benefit is distinct from cash return.
- Keep missing harm outside quantified parameter intervals. Preserve material correlation in probabilistic propagation and label structural/valuation alternatives separately.
- Publish a revision bridge attributing changes to quantities, coverage, methods and values. A changed method or price basis must not appear as an observed change in haze.

## Implementation sequence

| Phase                           | Concrete work                                                                                                                                                                                                          | Exit evidence                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Stabilize the current base   | Reconcile the ongoing Manager v4 changes and documentation; diagnose the observed correction/scope failure; freeze representative accounting cases and data requirements.                                              | Current Manager, correction, review, extension and UI checks pass on an agreed working-tree revision. Record fixture versus actual-model/source evidence separately.                 |
| 1. Add identity and contracts   | Add `DamageAccountant` role, versioned agent definition, domain schemas and composition registration. Add availability/gap behavior with no invented estimates. Update contributing guidance and shared UI identities. | A registered task reaches the new role; unrelated tasks and saved four-role history still work; unsupported inputs return useful gaps.                                               |
| 2. Build the accounting engine  | Add bounded input normalization, physical/incidence/welfare records, valuation and overlap reconciliation, publication manifests and an independent checker.                                                           | Known-answer, overlap, transfer, units, missingness and tamper cases pass; synthetic examples remain visibly synthetic.                                                              |
| 3. Integrate the full task path | Register producer/reviewer definitions and prerequisites; exercise Manager decisions, objections, revision, final selection, cancellation and restart through the existing API.                                        | A complete imported-input account is reproducible after restart; stale/rejected/unreviewed components cannot become current headline output.                                         |
| 4. Present and verify           | Add a schema-validated damage renderer to WorkProducts, extend agent-office identity/activity, and update active documentation and legacy explanatory copy.                                                            | Existing workspace shows all account views, omissions, review and exact sources on desktop/mobile; office participation follows real receipts.                                       |
| 5. Qualify empirical modules    | Add reviewed attribution, exposure/health and priority sector input/method adapters; then enable each broader extension independently.                                                                                 | An actual scoped historical pilot has reproducible inputs, methods, scientific applicability review and economic reconciliation. A fixture or agent prompt cannot satisfy this gate. |

### Proposed file map

- `app/agents/damage-accountant/index.ts` and `instructions.ts`: bounded specialist behavior, version and permitted actions.
- `app/contracts/damage-account.ts`: browser-safe domain schemas and explicit versions.
- `app/capabilities/damage-account/index.ts`: card, availability, assignments, prerequisites, review rules and optional tools.
- `app/capabilities/damage-account/inputs.ts`, `scope.ts`, `physical.ts`, `valuation.ts`, `incidence.ts`, `reconcile.ts`, `publication.ts`: deterministic domain implementations.
- `app/capabilities/damage-account/checker.ts` and `fixtures.ts`: independent checks and labeled synthetic cases.
- `app/contracts/capabilities.ts` and `app/composition.ts`: role and registration changes. Revisit the role-array bound only when a registered card requires it; execution concurrency remains unchanged.
- `frontend/src/features/chat/DamageAccountResult.tsx` and `WorkProducts.tsx`: validated optional rendering with generic fallback. Render server results without browser accounting arithmetic.
- `frontend/src/shared/types/domain.ts`, `agents.ts`, and `features/agent-office/officeModel.ts`, `sprites.ts`, `officeLayout.ts` plus affected renderer code: identity, actor mapping, appearance and reachable station.
- Focused `tests/unit/damage-account-*.test.ts`, runtime/extension tests and frontend renderer/office tests; extend the existing process verifier with a damage case or add a verifier alongside it using the same API and evidence conventions.

Preserve current ManagerWorkspace and per-artifact review work. Keep current/stale and supported/rejected status visible. Rejected content remains auditable through exact raw artifacts but must not appear as a supported subtotal. Update the older revenue-report copy that attributes accounting to unconnected WorkerShield only after the relevant route actually uses the new capability; a copy change alone does not enable it.

## Verification and acceptance

Freeze cases before tuning. The first accounting fixture uses the detailed report's invented example: approximately 9.717 expected deaths, CU21.53 million selected loss and CU4.57 million avoided damage. In the accounting MVP, health expectations are imported physical quantities; reproducing the exposure-to-health calculation belongs to a separately tested health-method module. These are test expectations, not default health parameters, real currency or regional estimates.

Required behavior cases:

- Independently reproduce component and selected totals from exact inputs; retain unrounded values.
- Reject duplicate effects, overlapping valuation paths, inconsistent financing shares, unbalanced transfers and mixed unit/currency/year/horizon inputs.
- Keep missing categories and disclosure-suppressed values distinct from zero through aggregation and presentation.
- Reject unsupported method IDs, fabricated source references, wrong hashes/versions, stale scope and tampered inclusion flags or totals.
- Verify that account-manifest selection cannot hide a rejected or unreviewed dependency; review exact components and producer revisions.
- Correct geography, population, period, comparator or valuation assumptions during execution; invalidate only affected components and their review. Reuse unaffected evidence only after explicit applicability checks.
- Exercise rejected-review repair, unavailable inputs, cancellation, revocation, restart, duplicate delivery, charged unknown outcomes and budget exhaustion.
- Keep attribution, health applicability, legal responsibility and numerical/accounting checks distinct. Historical fire removal cannot be reported as one project's achieved benefit.
- Render current and historical results, omitted categories, uncertainty basis, evidence origin and per-artifact objections. New office activity follows actual task receipts, including reduced-motion behavior.
- Run a non-damage task and the existing extension/boundary checks to prove that general contracts and core infrastructure remain reusable.

Use pinned Node 24.22.1 and npm 11.8.0. During implementation, run focused domain and Manager/runtime tests first, then the relevant frontend checks, `npm run check` and the fresh-process fixture verification. Capture a separately admitted real-model/imported-data trace for agent behavior; qualify empirical methods and live-source access separately. No live verification is required to create this plan.

### Review baseline

The focused review run used Node 24.22.1 and seven existing suites: Manager decision, Manager store, Manager runtime, general runtime, general extension, general boundaries and PM2.5 methods. It recorded **73 passing tests and one failing correction test**. The failure was `general-runtime.test.ts` / "corrects investigation scope, preserves old products as stale, and reuses unaffected work only after checks": after the location correction, replacement retrieval was waiting with a missing/conflicting scope. An isolated rerun of that case also failed by reaching its 10-second test timeout. These are observations of ongoing work, not DamageAccountant regressions or a settled root-cause diagnosis. Phase 0 requires diagnosis and a clean rerun.

Focused frontend checks also passed: **29 tests across three suites**, covering `GeneralTaskPage`, `EvidenceResult` and `officeModel`. These establish current component behavior; desktop/mobile visual verification of the new agent remains an implementation gate.

## Reference requirements

- [Haze Agent Architecture v0.14](Haze_Agent_Architecture_v0.14.pdf), especially pages 8, 10-13 and 22-24: domain packages, provenance, methods, corrections, accounting distinctions and release readiness.
- [Haze Damage Account Report](../evidence/Haze_Damage_Account_Report.pdf), pages 3-13 and 19-20: boundaries, accounting methods, data grain, reconciliation, uncertainty, required outputs and audit rules. Pages 14-16 supply synthetic fixtures only; page 17 describes a conditional empirical pilot, not this implementation's deadline.
- [General engine guide](../orchestration/general-engine.md), [verification record](../orchestration/general-engine-verification.md) and [Manager completion plan](manager-completion-plan.md): existing execution boundaries and ongoing integration work. Current source and freshly executed checks determine implementation status.

This plan adds a specialist and accounting capability. World Model acceptance, external publication/effects, monitoring and memory capture retain their existing disabled status until separately implemented and verified.
