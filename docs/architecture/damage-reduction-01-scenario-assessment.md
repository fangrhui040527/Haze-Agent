# Damage reduction plan 01: imported scenario assessment

Status: engineering implementation and synthetic restart verification completed on 27 October 2026. Scientific qualification and configured live-model verification remain outstanding. See the [implementation report](damage-reduction-01-implementation-report.md) and [method specification](damage-reduction-01-method-spec.md).

Prerequisite: none. Start here in the [roadmap](damage-reduction-planning-plan.md). Next: [conditional planning preview](damage-reduction-02-planning-preview.md).

## Outcome and scope

Produce a saved assessment comparing supplied ordinary-management and intervention residual damage quantities for one physical endpoint. The intended intervention is a service sending exposure alerts or changing work schedules under agreed rules; this stage assesses supplied estimates and does not execute those actions. Support one intervention, one comparator and a point-estimate target, demonstrated at an inclusive 10%. Return a supported calculation, an incompatibility or a precise evidence gap.

Use existing task admission, artifact imports, persistence and controls. Programme tables, multi-run coordination, monetary targets, raw-data effectiveness estimation and pilot/evaluation records belong to later plans.

## Ownership and input decision

Browser-safe schemas belong in `app/contracts/damage-reduction.ts`; the physical import adapter, deterministic methods and independent checker belong in `app/capabilities/damage-reduction-planning/`. Register implementations through `app/composition.ts`. Existing task/runtime modules retain identity, grants, charges and persistence.

Use a narrow physical-residual import contract as the default. Distinguish baseline/intervention role from prospective/retrospective evidence basis. The existing historical accounting validator must not force a future comparator to be labelled historical. This slice does not require migration of the complete monetary account. Any later existing-account integration must version normalization, methods, checking and input adapters together, without inheriting old reviews.

Before implementation, record the method's input/output specification and independently expected results. Scientific owners identify a non-synthetic reference case and applicability evidence. Missing scientific inputs permit explicitly synthetic engineering work; they prevent an operational-readiness claim.

## Implementation

1. Add bounded contracts for target/scope, compatible physical records, selected sources, assessment and independent review. Retain endpoint, unit, population, period, coverage, missingness, exclusions, origin and original method/version. Start with supplied residual quantities; do not infer effects from PM2.5, product specifications or adoption assumptions.
2. Persist immutable `reduction.input-selection` containing exact original artifact references, selected rows, scope hash and method/version. Normalize only that selection, reject ambiguity/conflicts and preserve source tokens. Unrelated request evidence cannot become implicit numerical input. Reuse existing access, hash and applicability checks.
3. Register `reduction.imported-residual-comparison.v1`. Aggregate only compatible nonoverlapping records and apply the [exact numerical rules](damage-reduction-reference.md#exact-threshold-comparison). Preserve decimal strings, exact differences and ratio components. Do not stringify aggregated v1 floating-point totals or use rounded displays/epsilon for decisions.
4. Have an independent deterministic checker reconstruct compatibility, aggregation and threshold results from original selected inputs. It must not call producer arithmetic. Persist exact input, output and review references through existing artifact services.
5. Register bounded assessment assignments/tools under the planning capability. Manager coordinates, HazeOps pins supplied evidence, DamageAccountant calculates and EvidenceCritic reviews. Preserve WorkerShield for Plan 02 and retain existing slots, grants and ceilings. Missing required inputs stop dependent calculation and produce a gap.

Keep task execution, arithmetic support and scientific qualification separate. The server exposes eligible prediction labels under the [shared claim rules](damage-reduction-reference.md#claim-eligibility); no assessment can establish an achieved reduction. World Model publication and acceptance remain separate.

## Verification and completion

Check `1000` to `880`, exact `0.3` to `0.27`, just-below thresholds, worsening outcomes, invalid baselines, precision/overflow rejection, incompatible scope and overlapping records. Check source/hash/row conflicts, irrelevant context, synthetic provenance, producer/checker disagreement and attempted v1 precision laundering.

Run focused method, task and regression checks, then applicable repository checks and fresh-process readback. Retain new results. The exit artifact is one admitted task whose saved assessment and independent review reopen after restart, including honest incompatibility/gap cases. Scientific applicability and configured live model/tool behaviour require their own evidence before readiness advances.
