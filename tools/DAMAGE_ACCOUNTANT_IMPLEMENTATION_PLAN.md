# DamageAccountant implementation plan

## Goal

Deliver both screenshot workflows for one reviewed pilot:

1. Estimate fire-attributable pollution, population exposure, and attributable
   health outcomes.
2. Provide DamageAccountant with the estimated harm, compatible monetary
   values, evidence, coverage/exclusions, uncertainty, and intervention
   scenarios required for its accounts.

The current DamageAccountant accounting step consumes reviewed effects and
unit values; it does not replace the upstream scientific estimation.

## Scope boundary

- **PM2.5 acquisition is out of scope for this plan.** The project owner says
  PM2.5 is already fetchable through Zetaris. Do not build, replace, or extend
  PM2.5 source acquisition. Treat the existing Zetaris feed as the supplied
  source. At final integration, confirm only that its output contract provides
  the coverage required by the approved pilot; if it does not, raise that as a
  scope decision rather than starting PM2.5 source work.
- APIMS is **not a required source** in either screenshot. Its historical
  station observations may be considered optional validation evidence only if
  useful and officially accessible. Do not block the plan on an APIMS request.
- The recent Klang episode, all-resident population, and intervention
  evaluation are preliminary directions, not approved scope. No event-specific
  acquisition or damage estimate should be represented as approved until the
  scope gate is passed.
- Keep all work in the appropriate source adapters and analysis layers. Do not
  put raw grids, station data, or model intermediates directly into the
  DamageAccountant accounting import.

## Implementation sequence and gates

| Step | Work | Deliverable / exit gate | Status |
|---|---|---|---|
| 1. Approve pilot scope | Select the event and full dates; Klang boundary/version; resident population and strata; health outcomes; event, baseline and valuation periods; counterfactual; currency/price year; and intervention/comparator. Set coverage, exclusions and decision owners. | Signed scope record in the readiness matrix. If the event cannot be evidenced, choose another documented event rather than infer one from a headline. | **Blocked** — decisions pending |
| 2. Define methods and required inputs | With atmospheric, epidemiological and health-economics reviewers, specify source attribution, transport approach, exposure metric, health baseline and risk functions, economic perspective, valuation and intervention evaluation. Classify conditional inputs as required or out of scope with rationale. | Versioned method/input table mapped to both screenshots; methods and reviewers approved before event-specific processing. | Pending |
| 3. Complete fire/source attribution inputs | Select suitable fire detections, emissions/activity, and meteorology for the approved event and source-to-receptor domain. Acquire through documented routes, validate units, QA, timing, spatial coverage, terms and missingness. Select and run a reviewed transport/dispersion method, including the counterfactual. | Reproducible, reviewed estimate of the target fire contribution, with independent validation and limitations. | Pending |
| 4. Integrate supplied Zetaris exposure with population | Use the existing Zetaris PM2.5 feed without changing its acquisition. Select and acquire a compatible population grid; align time, geography, strata and units; calculate the approved population-weighted exposure. Verify the PM2.5 feed contract and coverage against the pilot requirement only at this integration gate. | Reproducible exposure output, with population reconciliation, coverage/missingness report and reviewer sign-off. No separate PM2.5 source development. | Pending |
| 5. Estimate health outcomes | Acquire compatible outcome-specific baseline rates and denominators. Select and review applicable risk functions for the population and exposure metric. Calculate event-versus-counterfactual attributable outcomes and uncertainty. | Per-outcome estimates with definitions, strata, units, assumptions, uncertainty and applicability review; unsupported outcomes are explicitly not estimated. | Pending |
| 6. Estimate economic and physical accounts | Source compatible treatment/resource costs, work disruption/lost production, mortality valuation where selected, and other requested unit values. Establish currency, price year, perspective, transfers and double-counting rules. Combine reviewed effects with values. | Account-ready quantities and valuations, with source evidence, coverage, exclusions and compatible units. | Pending |
| 7. Evaluate the intervention | Specify an actionable intervention, eligible source area, responsible authority, implementation and lifecycle costs, effectiveness, adoption, maintenance, and a credible no-additional-intervention scenario. Estimate modeled exposure and harm differences. | Reviewed with/without-project scenarios and supported avoided damage, benefit-cost ratio and net social benefit; otherwise label the evaluation unavailable. | Pending |
| 8. Provenance, uncertainty and independent review | Maintain source/version, retrieval, license, checksums, transformations, assumptions, exclusions and input-to-output lineage. Quantify supported uncertainties, run justified sensitivities, and obtain independent numerical and domain reviews. | Evidence package and readiness matrix with no unsupported precision or silently zero-filled gaps. | Pending |
| 9. Map approved results into DamageAccountant | Map only reviewed scope, effects, unit values, coverage, incidence and scenarios into the accounting contract. Validate schema, units, totals, completeness and import behavior. | Reproducible import and reconciliation; approved coverage of both screenshot workflows or a clearly documented partial result. | Pending |

## Immediate next action

Complete **Step 1: approve pilot scope**. Resolve the event/dates and
counterfactual alongside the geography, population, health endpoints, and
intervention choice. The current 15 October 2026 Klang report is an
unverified lead, not an approved event. Do not make external requests or
acquire event-specific data until the owner approves the scope and access
routes.

## Acceptance criteria

The pilot meets its goal only when:

- Every included output in both screenshots has a defined quantity, unit,
  geography, population, period, scenario and evidence source.
- Fire attribution, exposure, health, economics and intervention outputs are
  computed using reviewed methods and compatible inputs.
- PM2.5 is sourced through the existing Zetaris feed; there is no duplicate
  PM2.5 acquisition implementation in this plan.
- Missing coverage, exclusions, unestimated outcomes and uncertainty are
  explicit and never silently treated as zero.
- The DamageAccountant import contains only reviewed estimates and values, and
  reconciles to the upstream calculations.
- Relevant domain reviewers approve the methods and an independent reviewer
  can reproduce the reported accounting results.

## Related records

- [Screenshot module table](./DAMAGE_ACCOUNTANT_SCREENSHOT_DATA_REQUIREMENTS.md)
- [Screenshot accounting table](./DAMAGE_ACCOUNTANT_ACCOUNTING_INPUTS.md)
- [Detailed input specification](./damage_data_discovery/DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md)
- [Pilot readiness matrix](./damage_data_discovery/PILOT_READINESS_MATRIX.md)
- [Crawler capability and data-gap notes](./damage_data_discovery/CRAWLER_CAPABILITIES_AND_DATA_GAPS.md)
