# Damage-reduction implementation roadmap

Status: Plans 01–05 have engineering implementations, including Plan 04 recordkeeping and the Plan 05 external-evaluation path. Live delivery adapters, reviewed non-synthetic scientific qualification and configured live-model verification remain outstanding. Updated: 27 October 2026. See the [assessment](damage-reduction-01-implementation-report.md), [preview](damage-reduction-02-implementation-report.md), [programme coordination](damage-reduction-03-implementation-report.md), [pilot/delivery](damage-reduction-04-implementation-report.md) and [external evaluation](damage-reduction-05-implementation-report.md) reports for executed evidence and limits.

Deliver the work in five bounded plans. The **hackathon milestone is the assessment and conditional-planning preview after Plan 02**. Programme coordination, live digital delivery and outcome evaluation may be deferred until after the hackathon.

The [reference specification](damage-reduction-reference.md) retains shared numerical, evidence, scientific and lifecycle requirements. This roadmap and the numbered plans define delivery order and scope. Reference requirements apply when their feature is introduced; later programme/delivery/evaluation features are not prerequisites for the preview.

## Intervention model and hackathon boundary

The intended model is **Automated digital intervention**: software delivers the intervention itself. A service automatically sends exposure alerts or applies work-schedule changes under agreed, versioned rules. People define and approve those rules and review outcomes; they do not have to carry out each digital action manually.

For the hackathon, live notification and scheduling integrations are deferred. An optional dry-run preview may show the alert or schedule change that an agreed rule would produce, with no external delivery or applied schedule mutation. Label it simulated/proposed. Neither a simulation nor an action receipt establishes reduced exposure or damage.

## Implementation sequence

| Plan                                                                         | Working outcome                                                                                                                                       | Dependency and completion boundary                                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [01 — Scenario assessment](damage-reduction-01-scenario-assessment.md)       | Compare supplied baseline/intervention damage quantities for one physical endpoint, with exact source selection, arithmetic and independent checking. | Start here. Save a truthful prediction, incompatibility or evidence gap using existing tasks/artifacts.                        |
| [02 — Conditional planning preview](damage-reduction-02-planning-preview.md) | Add a reviewed conditional plan and a small dedicated page with sources, gaps and saved-result recovery.                                              | Depends on 01. **First useful preview release**; no programme database or delivery/effect claims.                              |
| [03 — Programme coordination](damage-reduction-03-programme-coordination.md) | Coordinate several bounded task runs with durable revisions, phase links, budgets and current results.                                                | Depends on 02. Prove revision, control, cancellation and restart behaviour before adding live digital delivery and evaluation. |
| [04 — Pilot and delivery](damage-reduction-04-pilot-delivery.md)             | Assess pilot feasibility, register agreed rules/protocols and record digital delivery/deviations; live adapters are post-hackathon work.              | Depends on 03. Preserve planned and actual delivery without treating delivery as impact evidence.                              |
| [05 — External evaluation](damage-reduction-05-external-evaluation.md)       | Import reviewed comparative evaluations of this programme and enforce eligible outcome claims.                                                        | Depends on 04. **Complete physical-endpoint lifecycle**, subject to qualified evidence and registered criteria.                |

## First release boundary

Use one intervention plus ordinary management, one physical damage endpoint and supplied residual estimates. Demonstrate a 10% inclusive target; retain an explicit target fraction. Reuse the existing local operator boundary, task runtime, artifact persistence and execution ceilings.

Plan 01 uses a narrow physical-residual contract and independently checked method. A prospective comparator must never be labelled historical to satisfy the existing accounting validator. Broader accounting migration is required only when a later integration uses that path; it is not a blanket prerequisite for this preview.

Keep source provenance, compatibility checks, exact threshold comparison, independent review and prediction/achievement distinctions from the beginning. A missing or unsupported estimate produces a gap. A conditional plan lists prerequisites; it does not establish a delivered or achieved reduction.

Synthetic fixtures permit engineering verification and an explicitly labelled preview. Qualified operational use additionally needs a named non-synthetic reference case, reviewed applicability and independently checked expected outputs. Missing scientific inputs remain visible; fixture success cannot replace them.

## Integration checkpoints

1. **After 02:** submit an assessment, inspect its sources and review, obtain a conditional plan, restart and reopen the saved result. Include supported, incompatible and insufficient-evidence cases. Record actual resource use.
2. **After 03:** exercise concurrent revisions, direct task controls, budget limits, late results and terminal-result reconstruction. Task records remain authoritative for execution.
3. **After 05, outside the hackathon milestone:** follow exact target/protocol/rule/digital-delivery/evaluation lineage and verify that only eligible claims appear. Externally calculated results retain their provenance and reproduction limits.

Each implementation plan names scope, exclusions, ownership, dependencies, checks and a definition of done. Implement them as focused changes; completion of one plan does not imply completion of later plans. Run relevant repository checks and record fresh results in the linked implementation reports. The proposed requirements below do not establish live readiness.

## Later method plans

Monetary targets, internally calculated statistical evaluation and additional intervention methods remain in scope as future work. Give each a separate reviewed method specification, evidence/input requirements, independent validation and implementation plan. Do not bundle them into the first preview or assume one universal causal estimator.
