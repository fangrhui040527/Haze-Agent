# Damage reduction plan 02: conditional planning preview

Status: engineering preview implemented on 27 October 2026, with synthetic task/API/restart and frontend verification. Scientific qualification and configured live-model comparison remain outstanding. See the [implementation report](../../reports/damage-reduction/damage-reduction-02-implementation-report.md). This is the first useful planning preview, not the complete programme lifecycle.

Prerequisite: [scenario assessment](damage-reduction-01-scenario-assessment.md). See the [roadmap](damage-reduction-planning-plan.md) and [shared reference](../../architecture/damage-reduction/damage-reduction-reference.md). Next: [programme coordination](damage-reduction-03-programme-coordination.md).

## Outcome and scope

A local operator supplies a physical target, one automated digital intervention and compatible scenario evidence, receives a reviewed conditional plan, inspects its sources and reopens the saved result. The intended action is a service sending exposure alerts or applying work-schedule changes under agreed rules. Build a small dedicated page over existing tasks/artifacts. A valid result includes a useful plan with prerequisites, an incompatible comparison or an evidence gap; meeting 10% is not mandatory.

This is the hackathon milestone. Live alert/scheduling adapters, programme coordination, pilot registration, delivery tracking and achieved-effect evaluation may be deferred. An optional dry-run can show a proposed alert or schedule change without contacting recipients or modifying a work system. It is not a release requirement and must remain visibly simulated. Scientific evidence still gates operational qualification; fixture-only demonstrations remain visibly synthetic.

## Ownership and workflow

Keep contracts browser-safe in `app/contracts/`, planning assignments/methods in `app/capabilities/damage-reduction-planning/`, versioned instructions in the existing agent modules and registration/routing in `app/composition.ts`. The frontend consumes existing task/artifact APIs through its service layer. Tasks remain authoritative for saved work, corrections, controls and permissions.

Extend the bounded task from Plan 01 with conditional planning and independent review. Manager preserves the target and coordinates; HazeOps retains exact sources; DamageAccountant supplies checked figures; WorkerShield drafts the plan; EvidenceCritic reviews the exact final products. Do not add roles, specialist slots or resource ceilings, or require delegation for explanatory questions.

## Implementation

1. Add typed conditional-plan and review artifacts binding the exact target, assessment, candidate and source versions. Record the intended digital action, agreed trigger/action rules, rule owner, affected scope, constraints, dependencies and unresolved prerequisites. Each material recommendation needs exact evidence or a stated prerequisite; missing information cannot become an assumed delivered effect or available capacity. Humans approve the rules; the eventual service executes within them.
2. Update WorkerShield's versioned instructions for supported conditional planning. It uses registered numerical outputs and retains objections, applicability limits, costs and subgroup constraints. Treat imported documents as evidence. A reviewer checks source/claim alignment, exact assessment/review references and feasibility objections independently of the producer.
3. Apply the [shared qualification and claim rules](../../architecture/damage-reduction/damage-reduction-reference.md#versioned-records-and-qualification). An unresolved applicability dossier leaves a plan conditional/unqualified. Model agreement and arithmetic review cannot grant scientific approval. A numerically successful scenario that violates a hard constraint cannot become a supported recommendation.
4. Route planning requests to the planning capability before broad damage-appraisal matches; preserve direct answers and unrelated task flows. Save assessment, plan, objections, review and sources as immutable work products. Existing correction controls stale affected results without erasing their history.
5. Add `/damage-reduction` and `/damage-reduction/tasks/:taskId`. Show three sections: Target, Assessment and Conditional plan. Reuse artifact import, task status/control and exact-source inspection. Display server-calculated figures, review state, gaps and required next inputs. Persist the task identifier in the route so reopening does not depend on browser memory. Programme-ID routes arrive in Plan 03.

Use explicit labels such as **conditional planning preview**, **point estimate meets target**, **simulated action** and **evidence unavailable**. Never present predictions or dry-runs as actual delivery or achieved reduction. Recheck applicable source currency/permissions through existing governed APIs when reusing a saved product. Live execution under agreed rules is a deferred delivery capability.

## Verification and completion

Freeze representative supported, insufficient-evidence and below-target tasks before prompt tuning. Verify unsupported recommendation rejection, specifications mistaken for effects, unresolved objections, subgroup constraint violations, stale reviews and honest scientific-origin labels. Compare coordination, usefulness, cost and latency against a single-agent baseline using the same evidence/tools.

Verify submit, source inspection, review objections, partial/gap results, corrections, task controls, direct URL reopening, restart readback and accessible desktop/mobile rendering. Measure a complete task against existing budgets. Run applicable backend/frontend and fresh-process checks; distinguish fixtures from configured live traces.

Release when the full preview works through the existing task API with retained assessment/plan reviews and truthful limitations. Plans 03–05 are separate implementation decisions after this integration checkpoint; their absence must not be represented as a complete programme lifecycle.
