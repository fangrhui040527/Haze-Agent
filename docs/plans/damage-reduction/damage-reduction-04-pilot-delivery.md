# Damage reduction plan 04: pilot and automated digital delivery

Status: engineering recordkeeping milestone implemented on 27 October 2026, with supplied feasibility/protocol drafting, registration/amendment history and imported/simulated delivery verification. See the [implementation report](../../reports/damage-reduction/damage-reduction-04-implementation-report.md). Live service adapters and operational/scientific qualification remain deferred release gates.

Prerequisite: [programme coordination](damage-reduction-03-programme-coordination.md), with a current reviewed assessment and conditional plan from [plan 02](damage-reduction-02-planning-preview.md). This stage follows the [roadmap](damage-reduction-planning-plan.md); [external evaluation](damage-reduction-05-external-evaluation.md) follows it.

## Outcome and scope

Use **Automated digital intervention**: a service sends exposure alerts or applies work-schedule changes under agreed, versioned rules. People approve the rules and operating scope; software executes the digital action. Assess pilot feasibility, register the protocol and preserve rule/action history, service receipts and deviations.

Live alert/scheduling adapters are not a hackathon requirement. Plan 02 may show an optional labelled dry-run without this stage. Delivery verification and impact evaluation remain distinct; this stage cannot establish achieved damage reduction or supply a universal causal/sample-size tool. Apply the shared [protocol and feasibility rules](../../architecture/damage-reduction/damage-reduction-reference.md#protocol-registration-and-pilot-feasibility) and [claim boundaries](../../architecture/damage-reduction/damage-reduction-reference.md#claim-eligibility).

## Ownership and inputs

The scientific owner supplies design-specific feasibility and independent review. The programme lead owns records/registration; the rule owner agrees triggers, recipients or affected schedules, allowed changes and operating constraints. WorkerShield drafts; EvidenceCritic checks exact dependencies and objections. Composition registers handlers and eventual service adapters; the frontend renders server-owned status.

Required inputs are the selected target, intervention, ordinary-management comparator, assessment, conditional plan and their exact versions. Missing scientific inputs permit labelled draft/fixture work; they cannot qualify a pilot for damage-target evaluation.

## Implementation

1. Add versioned pilot-feasibility, protocol, registration, amendment, delivery, deviation and verification records through `app/contracts/damage-reduction.ts`. Extend the programme repository and existing records route from plan 03; preserve its revision, idempotency and source-access checks.
2. Retain reviewed feasibility findings about comparator/design identification, baseline availability, measurement quality, outcome latency, expected precision or power, relevant attrition/clustering, budget and timing. Record the supplied calculations and assumptions. Classify a pilot as capable of damage evaluation, conditional, or limited to delivery/exposure/feasibility. State missing prerequisites.
3. Register an immutable protocol binding target, population, endpoint, comparator, observation windows, analysis/uncertainty method, threshold relation, missingness/deviation rules and stopping criteria. Pin the agreed digital-rule version, trigger inputs, permitted actions and operating scope. Record registration time, external evidence and attested outcome-access stage. A later import cannot create earlier prespecification.
4. Append amendments with reasons, timestamps, affected fields and whether outcomes were available. Preserve the original registered analysis and distinguish amended/exploratory conclusions. Changes invalidate affected current uses through plan 03's dependency rules.
5. Append digital-action events with rule/action versions, trigger references, timestamps, affected scope, service receipts and deviations. Distinguish simulated/proposed, submitted, confirmed, failed and unknown actions. State whether confirmation means provider acceptance, alert transmission/receipt or an applied schedule change. Human reports may supplement evidence; they do not replace service confirmation. Independent verification follows the qualified design.
6. Add Pilot and Delivery views for feasibility, registration, amendments, rule versions, action status, missing receipts, verification and deviations. Draft/review in bounded runs; the future delivery service does not keep an agent run open. Retain incomplete or failed delivery truthfully.

## Deferred live integration

When implemented, the service executes enabled agreed rules automatically within their scope. Its adapter must enforce allowed actions, idempotent action IDs, accurate receipts and pause/disable controls. Unknown outcomes require reconciliation before replay. These service actions do not authorize automatic new agent runs. Until this integration is verified, use dry-run output or imported records with honest origin labels and show live execution as deferred.

## Verification and completion

Check missing or unusable comparator/baseline data, inadequate precision or outcome timing, conflicting scope, late/unknown registration, outcome-aware amendments and post-outcome target changes. None may silently gain a prespecified damage-target label.

Check incomplete/duplicate receipts, rule-version mismatch, out-of-scope actions, failures/unknown outcomes, partial verification, material deviations, stale evidence and restart recovery. Simulations cannot become live delivery. An alert receipt or applied schedule change cannot by itself establish reduced exposure or damage.

The recordkeeping milestone requires reviewed feasibility, registration, amendments and exact delivery/deviation lineage after restart. Live-delivery readiness additionally requires a verified adapter trace within agreed rules; dry-runs do not satisfy it. Run applicable checks and fresh-process readback, keeping fixture, imported and live evidence distinct. Plan 05 consumes actual delivery evidence; neither milestone gates the hackathon preview.
