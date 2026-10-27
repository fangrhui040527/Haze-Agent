# Damage-reduction reference specification

Status: shared specification with engineering implementations for Plans 01–05, including Plan 04 recordkeeping and the Plan 05 external-evaluation path. Live delivery adapters remain deferred. See the numbered implementation reports for verification evidence. Method qualification and a reviewed non-synthetic evaluation trace remain operational release gates.

Recorded and revised: 27 October 2026.

Read this alongside the [implementation roadmap](../../plans/damage-reduction/damage-reduction-planning-plan.md) and its five numbered plans. They define delivery order and bounded scope. This reference defines shared semantics for each feature when introduced: programme coordination starts in Plan 03, protocol/delivery in Plan 04 and external evaluation in Plan 05. The Plan 02 assessment/planning preview uses existing task/artifact persistence and does not require those later features.

## 1. Outcome, first supported pathway and scope

Build a programme lifecycle that turns an owner-defined damage-reduction target into an evidence-backed conditional plan, a pilot protocol, delivery records and comparative outcome evaluation.

A valid result is a supported recommendation, a conditional option, or a precise explanation of missing evidence. Finding an option that meets the target is not a condition for successful execution. Keep three achievements distinct: **a scenario predicts a reduction**, **an intervention was delivered**, and **an evaluation supports an achieved reduction**.

| Decision                   | Implementation scope                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target                     | Configurable fraction, initially demonstrated at 10%; the default relation is **at least**, including equality.                                                              |
| Metrics                    | A single physical damage endpoint first; a selected monetary damage account is a separately qualified extension. Existing monetary accounting remains supported.             |
| First intervention pathway | Compare externally supplied baseline and intervention residual damage quantities. Haze does not infer intervention effectiveness from raw PM2.5 or equipment specifications. |
| First complete release     | One physical endpoint, one automated digital intervention plus ordinary management, reviewed inputs and a complete delivery/evaluation lifecycle.                            |
| Expansion                  | Additional candidates, endpoints, monetary targets and internal evaluation methods pass their own readiness gates.                                                           |
| Application                | Dedicated planning page in the existing single-operator local application.                                                                                                   |
| Delivery                   | Automated digital intervention: a service sends exposure alerts or applies work-schedule changes under agreed rules. Live delivery may be deferred for the hackathon.        |
| Coordination               | Existing Manager and four specialist roles, within existing execution ceilings.                                                                                              |

The 10% ambition is an owner-adopted programme target with an explicit metric, comparator and evaluation criterion. See [Haze Agent Architecture v0.14](../Haze_Agent_Architecture_v0.14.pdf), especially pages 12, 21 and 22.

Software delivers the digital action itself; people own and approve the rules, operating scope and scientific review. The hackathon milestone remains Plan 02. Live notification/scheduling integrations and Plans 03-05 may be deferred. An optional dry-run may show what a rule would do, but cannot be recorded as actual delivery or evidence of exposure/damage reduction.

### First method and reference case

Register `reduction.imported-residual-comparison.v1`. It consumes independently supplied, compatible baseline and intervention residual quantities for one damage endpoint, exact source references, the source method/version, applicability evidence and a declared assessment rule. It aggregates only compatible nonoverlapping records and compares the resulting quantities. It supplies no exposure-response model, causal estimator, efficacy coefficient or uptake multiplier.

Plan 01 uses a narrow physical-residual import contract and independently checked comparison method. Reuse compatible accounting mechanisms behind `damage.imported-quantity.v1` and `damage.project-scenario.v1` where useful, without forcing the preview through historical-only validators or a full monetary-accounting migration. Registration means that the software implements this bounded operation; scientific qualification for a particular use is a separate decision.

The first method and readiness evidence are introduced at these stages:

- **Plan 01:** a reviewed method specification covering inputs, support compatibility, exclusions, numerical rules, outputs and failure cases.
- **Plan 01:** a synthetic engineering fixture: one endpoint, ordinary-management damage of `1000`, intervention damage of `880`, and a predicted reduction of `0.12`. This demonstrates software behaviour only.
- **Qualified operational use:** a named non-synthetic reference case identifying the actual intervention, endpoint, population, period, ordinary-management comparator, data custodian and original evidence. Its scientific owner supplies independently checked expected outputs and an applicability review. The case need not meet 10%.
- **Plan 05:** an explicit external-evaluation import specification and example, including the comparative design and what Haze can reproduce. This is not a Plan 02 preview prerequisite.

The non-synthetic case is an outstanding scientific input, not evidence already held or validated by this specification. A clearly labelled engineering preview may proceed if it is unavailable, but operational qualification and a complete programme release remain blocked. Do not substitute synthetic evidence. Monetary targets require a comparable qualification package covering the selected account and valuation conventions before being enabled.

## 2. Target, numerical rules and public contracts

### Target definition

Every programme records:

- Accountable owner, designated scientific owner, intended decision, target fraction and threshold relation.
- Pollutant/source boundary, geography, population, subgroups and period.
- Damage endpoint, unit, aggregation method, coverage and explicit exclusions.
- Ordinary-management comparator, including protections already in place.
- Budget, feasibility requirements and any subgroup protection constraints.
- Assessment rule and exact supporting evidence and method versions.

The first method supports a point-estimate comparison. A qualified uncertainty-bound or probability criterion is enabled only when a registered method explicitly supports that exact criterion, either by calculating it or by validating a reviewed external result, including its interpretation and required dependence information. A confidence interval is not automatically a probability that the target is exceeded.

A physical target aggregates one compatible endpoint. A monetary target uses one selected social-welfare loss account with compatible valuation conventions. Other metrics need registered methods. PM2.5 concentration and exposure changes remain separate outcomes and cannot automatically satisfy a damage target. Missing or unpriced harm remains visible in the coverage statement. Project cost and net social benefit remain separate from damage reduction.

### Exact threshold comparison

For compatible quantities with a positive baseline:

```text
absolute_reduction = baseline_damage - intervention_damage
relative_reduction = absolute_reduction / baseline_damage
target_met = absolute_reduction >= target_fraction * baseline_damage
```

Use the inclusive comparison above by default; any strict relation must be explicit in the target and protocol. Store source decimal quantities and target fractions as canonical decimal strings, with at most 18 significant digits and 12 fractional places per input. Reject excess precision with a reason rather than silently rounding. Target fractions must be greater than zero and at most one.

The new calculation path performs relevant aggregation and threshold cross-multiplication exactly with bounded integer/decimal arithmetic; a later monetary path also requires exact valuation products. Bound intermediate representations to 128 decimal digits and reject overflow. Comparison never depends on a rounded percentage, binary floating-point division or an epsilon. Display ratios may be rounded with an explicit precision; retain the exact numerator and denominator. Independently reconstruct the comparison from original decimal inputs without calling the producer arithmetic.

For example, `0.3` to `0.27` must meet an inclusive 10% target exactly. A result just below 10% must fail even if the displayed percentage rounds to 10. Zero, negative, unknown or incompatible baselines produce an unavailable percentage with a reason. Preserve meaningful absolute differences and increases in damage without clipping.

Do not stringify a previously aggregated v1 floating-point total and call it exact. Reconstruct the new path from retained source decimal tokens under an explicit normalization policy, or require a new decimal import. Precision describes the supplied data, not its scientific certainty.

### Versioned records and qualification

Add browser-safe contracts in `app/contracts/damage-reduction.ts` as their numbered plans introduce these record families. Plans 01-02 need only assessment, evidence, conditional-plan and review records; later families are not an early schema-completeness gate.

| Record family             | Required content                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Programme and target      | Identity, revisions, ownership, scope, constraints and assessment rule.                                                                            |
| Evidence and candidates   | Exact originals, mechanisms, source methods, applicability, gaps and selected candidates.                                                          |
| Scenario assessment       | Baseline/intervention references, exact quantities, methods, coverage, threshold relation and feasibility.                                         |
| Conditional plan          | Responsibilities, resources, dependencies, milestones, contingencies and unmet prerequisites.                                                      |
| Protocol and registration | Outcomes, comparator, measurements, analysis, stopping rules, immutable registration and amendments.                                               |
| Delivery and deviations   | Agreed rule versions, trigger inputs, action scope, live/dry-run status, service receipts, failures/unknown outcomes, verification and deviations. |
| Evaluation and learning   | Comparative estimates, uncertainty interpretation, protocol alignment, review, limitations and conclusions.                                        |
| Scientific qualification  | Exact method/evidence/review references, intended use, scope, decision, reasons, reviewer attestation and supersession/withdrawal.                 |

Use exact artifact references throughout. Keep execution status, numerical threshold relation, evidence support, feasibility, scientific qualification, delivery verification and evaluated effect as separate fields.

The scientific owner supplies a qualification dossier for the stated use, including method/design assumptions, applicability, reviewer identity/role and declared conflicts. A reviewer must be independent of the product they approve; unresolved conflicts prevent an independent-review label. The local operator explicitly records adoption of the dossier. This is a retained human attestation, not external identity or credential verification. EvidenceCritic checks completeness, consistency, exact dependencies and objections; neither model agreement nor `damage.review.v1` can grant scientific qualification.

Qualification states are `unqualified`, `conditional`, `qualified` and `withdrawn`. Unresolved prerequisites remain visible and cannot support an unconditional conclusion. Method registration, arithmetic review, qualification and World Model acceptance do not substitute for one another.

### Claim eligibility

Compute claim eligibility on the server; the Manager and browser cannot override it with prose or imported status fields.

| Claim                           | Minimum support                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imported estimate               | Retained original, origin and declared scope; label review/reproduction gaps.                                                                                                     |
| Arithmetic-checked scenario     | Compatible exact inputs and current independent accounting/target checks.                                                                                                         |
| Qualified prediction            | Arithmetic checks plus qualified applicability, satisfied hard constraints and no unresolved material objection.                                                                  |
| Recorded digital delivery       | Exact agreed rule/action, live trigger and scope, timestamp and service receipt with its stated confirmation level; simulations remain separate.                                  |
| Independently verified delivery | Delivery evidence and a separate verification record covering the stated actions.                                                                                                 |
| Evaluation supports target      | Qualified comparative design/result, exact protocol/target/delivery linkage, applicable independent reviews, satisfied registered criterion and no unresolved material objection. |

All supporting dependencies must remain current, accessible for the stated use, unheld and unwithdrawn. Retain origin labels for imported and internally calculated results. A point estimate meeting the target is labelled **point estimate meets target**; it is never presented as a robust lower-bound or probability conclusion. A scenario or delivery record cannot satisfy the evaluation gate.

An evaluation of this programme must bind the exact delivered intervention, population, period and delivery/deviation records, and account for material departures from the registered plan. Independent delivery verification is required when the qualified design requires it. External studies of other deliveries can support scenario applicability, but cannot establish this programme's achieved effect.

Distinguish simulated/proposed actions, service submission, confirmed alert transmission or applied schedule change, failure and unknown outcome. Provider acceptance does not prove recipient receipt, attention or adherence. A proposed schedule is not an applied schedule. Record only the confirmation the receipt supports; none of these events alone establishes reduced exposure or damage.

For an externally calculated evaluation of this programme, state **external evaluation supports the registered target**, along with what Haze reproduced and what it did not. Do not claim independent reproduction of the causal estimator when only its supplied results were checked. A bare before/after change or exposure-only pilot cannot establish causal damage reduction.

### Accounting compatibility changes

The existing accounting implementation is `app/capabilities/damage-appraisal/`; its v1 contracts require a historical scenario and use numerical inputs. Plan 01's narrow physical contract distinguishes **baseline/intervention role** from **retrospective/prospective evidence basis** and preserves decimal sources without changing those v1 records.

When a later integration adds prospective or exact-decimal accounts to the existing accounting path, introduce v2 contracts and update normalization, calculations, independent checking, rendering and the World Model input adapter/policy together. Future ordinary management must never be labelled historical to satisfy an old validator. Preserve v1 records and reviews for their compatible historical uses; new reviews, prospective captures and qualification do not inherit v1 acceptance automatically.

Plan 01 introduces an immutable `reduction.input-selection` with exact original references, selected rows, scope hash and method IDs/versions. A later accounting integration supplies the analogous `damage.import-selection` handoff. Downstream numerical tools normalize only their explicit selection; reject conflicting import and World Model selections. Unrelated intervention studies remain planning evidence, not implicit accounting inputs.

## 3. Protocol, workflow and implementation architecture

### Protocol registration and pilot feasibility

Before a pilot is represented as capable of evaluating the damage target, retain a reviewed feasibility assessment of comparator/design identification, baseline availability, measurement quality, outcome latency, sample size/precision or power, attrition/clustering where relevant, budget and timing. Scientific owners supply design-specific assumptions and calculations; the first release does not implement a universal power or causal-estimation tool.

If the endpoint cannot be evaluated within the pilot, label it a delivery, exposure or feasibility pilot and state the additional evidence required for damage evaluation. Such a pilot may still be useful, but cannot unlock a damage-target conclusion.

Register an immutable protocol before outcome collection or analysis. It binds the exact target, primary endpoint, population, comparator, observation windows, analysis/uncertainty method, threshold relation, missingness/deviation handling, delivery checks and stopping criteria. Record `registered_at`, any external registration reference, and the attested stage of outcome collection/access. Recording a protocol in Haze later does not establish that it was prespecified earlier.

Amendments append records with reasons, timestamps, affected fields and whether outcomes were already available. Preserve the original registered analysis and distinguish amended or exploratory conclusions. A post-outcome target/comparator change cannot acquire a prespecified label through fresh arithmetic or review. Retrospective evaluations and unknown registration timing can be retained and assessed with those limitations; they cannot pass a prespecified-target claim gate without supporting registration evidence.

Delivery records may be retained even when the protocol is missing or deviated from. Record the gap and its consequences rather than preventing truthful reporting. These requirements follow [HM Treasury's Magenta Book](https://www.gov.uk/government/publications/the-magenta-book/magenta-book-central-government-guidance-on-evaluation-html), including evaluation planning, preregistration and statistical power.

### Bounded agent workflow

Register capability ID `damage-reduction-planning`, version `damage-reduction-planning.v1`, under `app/capabilities/damage-reduction-planning/`, composed through `app/composition.ts`.

| Role             | Responsibility                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Manager          | Preserve intent, propose bounded phases, allocate resources, resolve corrections and synthesize eligible claims. |
| HazeOps          | Acquire permitted evidence, preserve originals and identify coverage/applicability gaps.                         |
| WorkerShield     | Frame options, assess constraints and draft conditional plans and protocols.                                     |
| DamageAccountant | Produce supported physical and monetary scenario accounts and target arithmetic.                                 |
| EvidenceCritic   | Independently check sources, calculations, assumptions, qualification records and exact final products.          |

Update WorkerShield's versioned instructions to permit supported conditional planning while retaining deterministic arithmetic and evidence limits. Human scientific qualification remains outside the agent role grant.

Plans 01-02 use the existing bounded task runtime, with numerical production, independent review and conditional planning inside the preview's admitted run. From Plan 03 onward, a programme coordinates separate bounded phase runs. A future delivery service executes agreed digital rules and records its actions without keeping an agent run open. Each introduced phase has registered prerequisites, outputs and review coverage. Missing required inputs return gaps instead of dispatching dependent numerical work.

The narrow physical preview has its own registered producer and independent checker. When a later scenario assessment uses `damage-appraisal`, reuse its complete five-stage dependency graph and reviews and explicitly authorize both capabilities. Do not present the narrow comparison as a completed full damage account. Revalidate prior products through existing governed artifact/context APIs; task completion or a previous review alone does not establish current applicability.

Add composition-level routing precedence before broad damage-appraisal matching. Explanatory questions remain eligible for direct answers or synthesis. Do not change unrelated task admission into a mandatory programme workflow.

### Evidence and scenario rules

For each candidate, distinguish published effects from local applicability, equipment specifications from delivered performance, and available facilities from verified usable capacity. Retain uptake, effective use, maintenance, persistence, displacement, costs, adverse effects and their sources. Numerical use of these inputs requires a registered method; there is no universal efficacy-times-uptake multiplier.

Combined interventions require supported joint residual outcomes or a qualified joint method. Do not add standalone benefits across overlapping populations. Apply hard constraints before ranking, including subgroup protections. With no owner-defined ranking criteria, show tradeoffs instead of inventing a weighted score. Incomparable outcomes remain visibly incomparable. Conclusions apply only to the assessed candidate set and evidence cutoff.

### Programme persistence and phase transitions

Use domain-owned programme tables on the existing SQLite connection, append-only revisions and a current revision pointer. Partition records by principal, workspace and execution mode. Every domain mutation increments the programme revision and requires the expected revision. Task execution remains authoritative in task records; World Model policy remains authoritative for accepted domain state.

Persist immutable phase-attempt links with programme revision at admission, phase kind, task/run IDs, admitted objective revision, exact input references and a canonical input fingerprint. The fingerprint includes only relevant target, comparator, candidate, evidence, method, constraints and protocol versions. An unrelated note increments the programme revision without invalidating a phase. A material dependency change invalidates its assessments, reviews and descendants while preserving history.

Derive phase execution/result projections from the exact linked task/run records on programme reads, including terminal runs. Any cache must be rebuildable. Do not introduce a second authoritative completion queue or require a callback to advance a programme after task completion. A crash after task completion must reveal that result on the next read/restart. A task's current run pointer must not silently replace the linked run.

Resume follows existing task rules. Correction or Continue that changes the admitted objective/run requires an explicit successor phase-attempt binding with revalidated inputs. Superseded attempts and late outputs remain historical. Domain revisions fence affected results immediately and steer active runs through existing correction/cancellation controls; they do not silently restart work.

For programme-linked tasks, controls that change the objective or create a run must check attempt/budget limits and persist the new binding inside the programme transaction before scheduling. Enforce this through a composition-provided guard on the ordinary task update/control API as well as the programme API. A control cannot execute first and bind afterward. Resuming an unchanged run retains its existing reservation and deadline under the normal runtime rules.

| Transition/action          | Required rule                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start assessment           | Supported target, exact selected inputs and method; missing evidence produces a framing/acquisition gap.                                                       |
| Start plan/protocol        | Selected current assessment, constraints and objections available; unresolved issues become explicit prerequisites.                                            |
| Register protocol          | Exact draft, reviewed feasibility classification and attested outcome-access stage.                                                                            |
| Attach delivery/evaluation | Preserve exact evidence and timing even when incomplete, unreviewed or retrospective.                                                                          |
| Use a phase result         | Linked task/run has a committed current task result, matching objective/input fingerprint, valid evidence and required reviews. A completed gap remains a gap. |
| Show a target conclusion   | Apply the separate claim-eligibility predicate; execution status cannot grant scientific support.                                                              |

### Admission transaction and recovery

Expose a minimal domain-neutral transaction/admission boundary and after-commit dispatch wrapper around the existing task-store transaction mechanism. Keep domain repositories composition-provided; do not expose arbitrary database writes through HTTP.

- Atomically persist programme revision, phase-attempt link, programme budget reservation, task admission and idempotent operation receipt.
- Dispatch only after the outer transaction commits; discard callbacks on rollback.
- A dispatch callback failure after commit leaves an admitted queued task and a valid receipt. It must not be reported as rolled-back admission or retried as a new task. Retry dispatch for the same task through the existing dispatcher/startup recovery.
- Keep existing recovery for queued/interrupted task execution and its explicit controls for unknown remote outcomes. Programme result reconstruction additionally reads terminal runs; it does not depend on `TaskStore.recover()` replaying them.
- Recheck dependency currency, holds, withdrawal and permission at reads/use, even when no programme revision changed.

### Resource envelope

Retain two specialist slots, depth-one delegation and existing per-run ceilings. Current investigation defaults are 40 model calls, 40 tool calls, 16 assignments, 64 artifacts, five minutes, 24,576 model-input bytes, 1,200 model-output tokens and two reserved Manager calls. Persist the actual admitted limits; these are ceilings, not evidence that the new workflow fits.

The preview supports one intervention plus ordinary management. A provisional later expansion envelope is at most three intervention candidates plus one shared comparator, 16 original input artifacts, 1,000 selected rows and 512 KiB of normalized inputs, subject also to existing artifact, context and exact-support bounds. Enable only the envelope demonstrated by measured traces, reducing advertised limits if necessary. Pin and inspect bounded evidence rather than inserting all originals into model context.

From Plan 03, initially allow one active phase per programme, at most three admitted attempts per phase and twelve admitted runs per programme, including failures/continuations. Programme-wide model/tool allowances default to 400 charged calls each. Atomically reserve a new run's maxima against those allowances; reconcile authoritative charged usage and release only unused reservations after termination. Unknown remote attempts remain charged. Existing global task limits still apply; Plans 01-02 require no programme-wide reservation infrastructure.

Every agent phase start or replacement requires an explicit operator action. No automatic new-run retry loop. This governs agent orchestration, not individual actions of a future service operating within already agreed rules. Envelope or budget changes are explicit programme revisions and cannot raise the runtime's global ceilings. Report remaining capacity before admission.

Measure the reference trace and the maximum supported candidate bundle before expanding readiness. Record calls, tools, artifacts, input/output sizes, support closure, cost and latency. Oversized work returns a boundedness gap or a proposed split into explicit runs sharing exact comparator/method versions. Do not silently omit candidates or claim an exhaustive comparison across an unfinished split.

### Local API and dedicated page

The first release reuses the existing loopback, same-origin HTTP boundary and server-owned `localTaskIdentity`. It is a single local operator application, not multiuser authentication. Accountable-owner and external-reviewer names are recorded attestations. Remote access, authenticated reviewer accounts and multiuser roles require a separate design.

Plans 01-02 use existing task/artifact APIs. Plan 03 introduces programme routes through a composition-provided handler; Plans 04-05 extend the typed records route for their record families:

| Route                                          | Behaviour                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET/POST /api/reduction-programmes`           | List or create programmes.                                                           |
| `GET /api/reduction-programmes/:id`            | Read current inputs, derived phase projections and claim eligibility.                |
| `GET /api/reduction-programmes/:id/history`    | Read bounded, paginated revision/attempt history.                                    |
| `POST /api/reduction-programmes/:id/revisions` | Revise selected inputs, constraints or budget with explicit consequences.            |
| `POST /api/reduction-programmes/:id/phases`    | Admit a bounded phase or explicitly bind a permitted successor run.                  |
| `POST /api/reduction-programmes/:id/records`   | Append typed delivery, qualification, registration, amendment or evaluation records. |

Mutations require bounded input, idempotency and the expected programme revision. Reuse existing artifact import and task-control APIs with the phase-binding checks above. A supplied reviewer name or `qualified` flag cannot bypass dossier adoption and validation. Source documents and imported records are evidence, never instructions or authority.

Plan 02 creates `/damage-reduction` and `/damage-reduction/tasks/:taskId` for saved preview tasks. From Plan 03 add `/damage-reduction/programmes/:programmeId`; retain task links without ambiguous ID routes. Introduce Target, Options, Plan, Pilot, Delivery, Evaluation and History views as their plans land. Show sources, gaps, assumptions, objections, qualification and next requirements beside relevant results; add registration/amendment status with Plan 04. Render server-calculated figures/eligibility labels and distinguish delivery from evaluated effect. Save/restart recovery and accessible desktop/mobile use apply to each released surface.

## 4. Staging, ownership and readiness

The [roadmap](../../plans/damage-reduction/damage-reduction-planning-plan.md) and numbered plans govern implementation order: [scenario assessment](../../plans/damage-reduction/damage-reduction-01-scenario-assessment.md), [conditional planning preview](../../plans/damage-reduction/damage-reduction-02-planning-preview.md), [programme coordination](../../plans/damage-reduction/damage-reduction-03-programme-coordination.md), [pilot/delivery](../../plans/damage-reduction/damage-reduction-04-pilot-delivery.md), then [external evaluation](../../plans/damage-reduction/damage-reduction-05-external-evaluation.md). Assign named engineering and scientific owners to each applicable stage and estimate its bounded work before starting.

Plan 02 is the hackathon assessment/planning preview. Its completion does not require a programme database, registered pilot, live delivery service, delivery records or external evaluation. It must preserve provenance, exact arithmetic, independent checks, conditional prerequisites and honest claim labels. Scientific inputs still gate qualified operational use; labelled engineering fixtures and optional simulated actions may be used earlier.

Plan 05 completes the physical-endpoint lifecycle for automated digital delivery. Its release requires a named non-synthetic reference trace, exact rule/protocol/live-delivery/evaluation lineage, reviewed scientific inputs and measured execution evidence. It is not a hackathon gate. Monetary targets, internal evaluation and additional intervention methods each need a separate extension plan and qualification gate. Existing v1 monetary accounting is unaffected.

For internal evaluation, implementers must not select an undisclosed universal causal estimator. Unsupported designs return a gap. Preserve dependence between baseline and intervention estimates; marginal ranges alone cannot justify a probability of meeting 10%. Qualified uncertainty methods must handle relevant covariance and disclose their assumptions. See [NIST uncertainty guidance](https://www.nist.gov/pml/nist-technical-note-1297/nist-tn-1297-5-combined-standard-uncertainty).

Store reviewed lessons as artifacts. Live alert/scheduling adapters are deferred delivery integrations described in Plan 04; H-MEM capture and accepted-state publication remain separate integrations. Retention and review do not establish World Model acceptance; the UI must preserve that distinction.

## 5. Verification and completion criteria

### Required checks

- **Numerics:** inclusive/strict relation, `0.3` to `0.27`, just-below thresholds, rounded displays, negative changes, invalid denominators, precision/overflow rejection and exact aggregation/products. Checker reconstruction starts from original decimals.
- **Comparability:** mismatched population, period, endpoint, units, coverage, currency or valuation basis. Preserve missingness and exclusions.
- **Evidence:** wrong hashes/rows, conflicting selections, unrelated planning studies, unsupported prospective captures, v1 precision laundering, held/withdrawn evidence and source permission changes.
- **Reasoning:** specifications as delivered effects, overlapping benefits, unsupported joint interventions, subgroup constraint violations, synthetic evidence as empirical and incomplete search as target impossibility.
- **Qualification/claims:** arithmetic review alone, imported status flags, self-review, conditional/withdrawn dossiers, unresolved objections and delivery records cannot unlock scientific conclusions. Simulated actions cannot establish live delivery; receipts cannot establish adherence or damage reduction. Evaluations of another delivery cannot establish this programme's achieved effect. Imported/internal provenance and point/bound/probability labels remain distinct.
- **Protocols/pilots:** missing comparator/baseline, inadequate precision or outcome timing, unknown registration timing, outcome-aware amendments, post-outcome target changes and feasibility-only pilots cannot pass a prespecified damage-target gate.
- **Persistence:** duplicate requests, concurrent revisions, rollback after admission, crash after commit before dispatch, callback failure, task completion before programme read, terminal-run reconstruction, cancellation and unknown remote outcomes.
- **Freshness:** material dependency changes stale affected descendants; unrelated notes do not. Resume/Continue/correction cannot silently rebind a phase. Late results remain historical; holds/revocation are reflected without programme edits.
- **Resources:** minimum reference case, maximum candidate bundle, input/closure limits, per-phase/programme caps, reservation release, charged failures, explicit replacement controls and direct task-API attempts to bypass programme admission/binding limits.
- **Interface:** saved-programme recovery, bounded history, partial/gap results, objections, registration/amendment labels, honest local identity and desktop/mobile accessibility.
- **Regression:** existing accounting, PM2.5, synthesis, general task routing, correction and World Model policy behaviour remain intact.

For implementation, run focused checks in each phase, then the repository's required `npm run check` and applicable fresh-process verification. Capture new results and limitations; do not inherit historical test counts or readiness claims. A fixture trace establishes software behaviour. Operational readiness additionally requires the named non-synthetic reference and reviewed scientific inputs; live model/tool readiness requires an admitted configured trace.

Freeze representative Manager cases before prompt tuning. Compare useful completion, unsupported claims, unnecessary coordination, cost and latency with a single-agent baseline using the same sources and tools. Include supported, insufficient-evidence and no-assessed-option-meets-target cases.

### Definition of done

The hackathon milestone is complete after the Plan 02 preview checks pass, with any action preview visibly simulated and live delivery explicitly deferred. The later complete capability requires a supported target, reviewed plan/protocol, agreed digital rules, actual service-delivery evidence, qualified comparative evaluation and restart/history recovery. All applicable claim, execution and resource gates must pass; a dry-run cannot complete the live-delivery/effect lifecycle.

A programme can validly conclude that evidence is insufficient or that no assessed option meets the target. A target-support conclusion requires the registered criterion and qualified comparative evidence with applicable independent review. Completion of the software workflow does not establish an achieved reduction. Readiness is reported per method, metric and claim type; unavailable scientific inputs remain explicit release dependencies.
