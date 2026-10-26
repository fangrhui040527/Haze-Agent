# DamageAccountant input specification

## Purpose and status

This specification translates the two DamageAccountant workflow screenshots
into data requirements that can be used to assess candidate sources and plan a
pilot. It distinguishes:

- **Required model inputs**: needed to calculate the named physical, health,
  economic, or intervention outputs.
- **Conditional inputs**: required only when the selected method or requested
  output needs them.
- **Supporting context**: useful for interpretation or validation, but not a
  substitute for a required input.

The minimum-coverage criteria below are proposed screening criteria for a
bounded pilot, not universal scientific standards. The event, geography,
outcomes, temporal resolution, methods, and any relaxation of these criteria
must be approved for the intended analysis. The current DamageAccountant
contracts account for supplied quantities and compatible unit values; they do
not estimate fire attribution, exposure, health effects, or intervention
effectiveness from raw source data.

## Shared scope required for every pilot

| Field | Required specification |
|---|---|
| Event and source | Stable event ID; haze episode definition; fire/source boundary; included smoke or pollution sources; event start/end and rationale. |
| Geography | Named country and analysis boundary; boundary version; spatial reference system; target grid or administrative units. State whether results cover all of Malaysia or a subset. |
| Population | Target resident or exposed population, age bands, sex strata where applicable, and any exclusions. Keep population definitions consistent between exposure and baseline health data. |
| Time | Event period, exposure averaging period, health-outcome period/lag, baseline period, and valuation horizon. State the time zone and date convention. |
| Counterfactual | Explicit comparator, such as event conditions without the target fire contribution or a specified no-intervention scenario. Describe how the counterfactual is estimated; do not treat an observed historical average as causal without justification. |
| Units and prices | SI-compatible physical units; currency; price year; valuation date; exchange-rate source and date if converting currency; discounting convention and horizon where applicable. |
| Evidence | Source owner, product/dataset and version, retrieval date, URL or archive ID, license/terms, transformations, quality checks, limitations, and retained artifact reference/checksum. |
| Uncertainty | For each measured or modeled input, record whether uncertainty is quantified, its interpretation and basis, and any interval/distribution or sensitivity range. Do not invent precision where none is available. |

For an initial pilot, select **one documented haze event, one explicitly
bounded Malaysian study area, and one fully covered event period**. Use the
finest defensible common spatial and temporal resolution across products.
Include only the declared target population and outcomes. The pilot must state
coverage and exclusions explicitly; uncovered people, dates, or areas must not
silently be treated as zero harm.

## Required inputs by workflow stage

### 1. Fire attribution and exposure

| Input | Requirement classification | Definition and unit | Geography and population | Time resolution and baseline | Acceptable source types | Proposed minimum coverage for pilot |
|---|---|---|---|---|---|---|
| Fire detections | Required if attributing smoke to fires | Geolocated fire/hotspot detections with acquisition time, confidence/quality flags, and sensor/product metadata. Counts are not emissions. | Study area plus an upwind/source buffer sufficient for the selected transport method; no person stratum. | Native observation time; cover event period and transport-relevant lead/lag. Baseline is the explicit no-target-fire scenario, not simply no detections in a short window. | Official satellite fire products or validated national monitoring products with documented sensor, QA, latency, and licensing. | All event days and full source buffer, with quality flags retained. Document satellite overpass gaps and cloud/observation limitations. |
| Fire radiative power / fire activity | Required by methods that use it | Per-detection or gridded fire radiative power, typically MW, plus observation time and QA; use only if the emissions method requires it. | Same source buffer as fire detections. | Native observation interval through event and relevant lead/lag. | Official satellite products with documented calibration, units, and uncertainty. | Coverage adequate to characterize target fires for every event day; missing observations explicitly quantified. |
| Fire emissions | Required for emissions-based attribution; otherwise use an explicitly approved alternative | Emitted mass by species (for example, PM2.5 or precursor species), with mass unit, time interval, injection-height treatment, and uncertainty. | Target fires/source region and any relevant surrounding sources. | Hourly/daily as demanded by transport model; event period plus spin-up/decay period. Counterfactual removes or changes only the declared source contribution. | Official emissions inventories or peer-reviewed/validated emissions models with versioned factors, species, temporal profiles, and uncertainty. | Complete model period for all target fires/source cells; disclose incomplete or extrapolated emissions. |
| Meteorology | Required for transport-based attribution; conditional for simpler approved methods | Time-varying wind direction/speed and any other fields required by the selected transport model (e.g. boundary-layer height, precipitation, temperature); retain native units and conversion records. | Full transport domain, not only the impact region. | At model-required interval, covering event, spin-up, and decay. Baseline uses the same meteorology unless the scenario explicitly changes it. | Official reanalysis or operational meteorological data with version, resolution, assimilation/provenance, and uncertainty documented. | No missing time steps or domain cells required by the chosen model, or a documented and reviewed gap-handling method. |
| Transport/dispersion model | Required method, not a source dataset | Versioned model and configuration that maps emissions and meteorology to transported smoke/concentration; record grid, chemistry/deposition treatment, boundary conditions, and validation. | Entire source-to-receptor domain and study area. | Model timestep and simulation period must cover emissions and impact windows. Counterfactual run uses the same configuration with target source removed/changed. | Peer-reviewed or operationally validated transport model with reproducible configuration and appropriate regional evaluation. | Reproducible historical and counterfactual runs over the full pilot period; independent observational comparison and documented model limitations. |
| Ambient PM2.5 field | Required exposure input; source attribution is conditional on the target output | PM2.5 concentration, normally µg/m³, with measurement/model flag, averaging interval, and QA. Keep measured observations distinct from modeled/reanalysis grids. | Every target grid cell or monitoring site relevant to exposed population; define land/ocean and population mask. | Daily/hourly or other outcome-relevant interval over the event and baseline. Include event-free/reference period if the chosen method requires it. | Validated gridded satellite/reanalysis/chemical-transport product, or appropriately quality-controlled monitor data for validation; specify product and version. | Complete declared population-area/time domain, with missing cells/time quantified. A few API rows or monthly regional averages do not meet gridded event-exposure coverage. |
| Population grid | Required for population-weighted exposure and population health burden | Population count per grid cell, with reference year, resolution, age/sex groups where available, and allocation method. | Same analysis boundary and compatible grid as exposure; target population strata. | Reference year(s) matched to event period or explicitly interpolated/held constant with justification. | Official census-based grids or well-documented population products with methods, uncertainty, and licensing. Administrative totals may support validation but are not a grid. | Full study area for selected strata and period; reconcile grid totals with an authoritative population total within a declared tolerance. |
| Exposure aggregation | Required derived quantity | Population-weighted concentration/exposure metric, including formula, spatial mask, averaging period, population denominator, and any exposure-response threshold. Unit generally µg/m³ for a declared averaging period. | Study-area total and required subregions/population strata. | Event-specific exposure window plus any method-defined baseline/counterfactual. | Reproducible calculation from compatible PM2.5 and population products; retain inputs and code/version. | Every included cell has compatible PM2.5 and population for every required time; report missingness and sensitivity to exclusions. |

**Important distinction:** Data.gov.my's tested three-row PM2.5 sample is
monthly monitoring-station aggregate data. It may support contextual
comparison, but does not alone provide the gridded, event-period exposure
required for population-weighted exposure or source attribution.

### 2. Health impact

| Input | Requirement classification | Definition and unit | Geography and population | Time resolution and baseline | Acceptable source types | Proposed minimum coverage for pilot |
|---|---|---|---|---|---|---|
| Baseline outcome rate | Required for attributable health outcomes | Outcome-specific rate/count and denominator (e.g. deaths per person-year, admissions per person-year, or cases per person-year), disaggregated at least to the strata required by the risk function. Specify case definition and coding. | Same or defensibly mappable geography as exposure; age/sex groups compatible with the risk function and target population. | Baseline years representative of the event period; state rate period and any trend adjustment. Exclude event effects if the chosen method requires an unaffected baseline. | Authoritative Malaysian health/vital-statistics or registry data; peer-reviewed local epidemiology with transparent denominator and definitions. Country estimates may be context only if not geographically/stratally compatible. | Every modeled outcome and stratum has a baseline covering the pilot geography and a defensible period. Suppressed or missing data remain explicit, not zero. |
| Risk function / concentration-response relationship | Required to convert exposure change to health outcome | Versioned coefficient/function connecting a specified PM2.5 exposure metric and health outcome to relative risk or another effect measure; record unit increment, lag, shape, reference concentration, confidence interval, and covariates. | Population applicability must be assessed for Malaysia and each included age/sex stratum. | Exposure averaging period and lag must match the exposure and outcome data. Baseline is the selected counterfactual/reference exposure. | Peer-reviewed systematic review or high-quality epidemiological estimate; local estimate preferred. Transferred functions require explicit transfer rationale and uncertainty. | A reviewed function for each reported outcome, including applicability review and uncertainty. If unavailable, mark that outcome not estimated rather than fabricate it. |
| Attributable outcomes | Required output/derived input to economic account | Estimated excess deaths, cases, admissions, or other defined outcomes versus counterfactual; report expected counts and uncertainty interval/distribution. | Study geography and target population strata. | Event/outcome period and lag structure; compare event scenario to declared baseline/counterfactual. | Reproducible burden calculation using validated exposure, baseline rates, and risk function. | Report only for strata with complete compatible inputs; provide method, assumptions, uncertainty, and independently checked totals. |

Health outcomes must not be inferred from all-cause deaths, health staff, or
hospital-bed counts alone. Those can be supporting context; they are not
substitutes for outcome-specific baseline rates or risk functions.

### 3. Economic account

| Input | Requirement classification | Definition and unit | Geography and population | Time resolution and baseline | Acceptable source types | Proposed minimum coverage for pilot |
|---|---|---|---|---|---|---|
| Treatment/resource use | Required only for treatment-cost valuation | Outcome-linked healthcare resource quantity (visits, admissions, treatment days, medication or other resource units), with explicit unit and case definition. | Facilities/populations representing the pilot geography and relevant strata. | Event period and follow-up/horizon matching health outcomes; compare to counterfactual. | Malaysian health costing, provider/claims data with authorization, or peer-reviewed local cost studies. | Costs or resource quantities for each monetized outcome or explicit omission. Ensure no unsupported extrapolation across populations/facilities. |
| Unit treatment cost | Required to value treatment/resource quantities | Currency per compatible resource/outcome unit, including cost components, currency, price year, valuation date, perspective, and included/excluded costs. | Malaysia or explicitly justified transferred jurisdiction; identify payer/provider perspective. | Price year aligned or converted using documented deflator/exchange rate; specify valuation horizon. | Official costing schedules, local micro-costing, claims/provider studies, or peer-reviewed local health-economic estimates. | A traceable value for every included quantity; retain component and transfer assumptions. |
| Work disruption quantity | Required if reporting lost work/productivity | Haze-attributable lost workdays, hours, or output units, with definition (absence, reduced productivity, closure) and causal attribution method. | Worker groups and economic sectors in the study area; account for informal work if included. | Event-specific daily/hourly/shift period; compare with an explicit no-haze counterfactual. | Direct event studies, employer/survey/administrative data with suitable methods, or transparent validated models. General labour-force counts are contextual only. | Coverage by declared major worker strata and event days, or explicit coverage bounds and exclusions; no conversion from unemployment/wages alone to lost work. |
| Work valuation | Required if monetizing work disruption | Currency per lost day/hour/output unit, or another stated productivity valuation; specify whether using wage, output, replacement cost, or welfare measure. | Same worker groups/geography as disruption quantities. | Price year and event horizon aligned to the quantity. | Official wage/earnings data may support wage valuation when matched to workers; national accounts or sector data for output valuation. Document method and limitations. | Compatible unit value for each monetized quantity, with assumptions about benefits, informal work, transfers, and double counting. |
| Mortality valuation | Conditional on monetizing mortality | Declared value per statistical death/life-year or other chosen measure; specify method, population applicability, income transfer, currency, price year, and uncertainty. | Population and jurisdiction to which valuation applies; transfer to Malaysia requires justification. | Valuation date, price year, and relevant lifetime/time horizon. | Local stated/revealed preference or policy guidance; peer-reviewed valuation studies with transfer methodology if local evidence is absent. | Valuation method reviewed and transparently reported; if unsupported, report physical outcomes without monetary mortality value. |
| Coverage, incidence, and transfers | Required to describe account completeness; incidence conditional on payer analysis | Included/excluded harm categories and shares; for incidence, payer, recipient, amount, currency/year, and whether transfer or real resource cost. | Declared social boundary (e.g. households, government, firms, insurers, providers) and each included group. | Same account period/horizon; state treatment of future costs. | Administrative/financial data or explicit, sourced assumptions. | Every target endpoint has an availability status and reason. No double-counting of a transfer as a social resource loss; reconcile financing within the declared boundary. |

### 4. Prevention evaluation

| Input | Requirement classification | Definition and unit | Geography and population | Time resolution and baseline | Acceptable source types | Proposed minimum coverage for pilot |
|---|---|---|---|---|---|---|
| Intervention definition | Required when evaluating a project | Specific action, implementing body, target source/population, implementation schedule, and causal pathway to exposure/harm reduction. | Jurisdiction, target communities, and affected source areas. | Implementation date, project horizon, and lifecycle. | Approved project design, operational records, or an explicitly scoped appraisal. | One implementable, costed intervention and a credible no-project comparator. |
| Effectiveness / exposure reduction | Required when claiming avoided harm | Measured or modeled change in emissions, exposure, or physical outcomes attributable to intervention; unit and method depend on intervention. | Same domain and population as the account; identify spillovers/displacement. | Before/after or intervention/no-intervention period; include ramp-up and duration. | Controlled/quasi-experimental studies, validated engineering models, or reviewed local evidence. | Evidence and uncertainty appropriate to the intervention; quantify adoption, durability, and displacement or state why omitted. |
| Implementation and lifecycle cost | Required for benefit-cost or net-benefit outputs | Capital, operation, maintenance, enforcement, and other real resource costs; currency and price year. Separate transfers/financing. | Implementing entity and affected social boundary. | Full project life and timing of costs; discount rate/horizon declared if future values are compared. | Approved budgets, procurement, audited project accounts, or defensible engineering estimates. | Costs cover the declared project horizon and principal lifecycle components; missing cost categories explicit. |
| Scenario assumptions | Required for scenario comparison | Adoption, maintenance, durability, compliance, adverse effects, displacement, and comparator descriptions. | Same target region/population and social boundary as project. | Scenario horizon and timing aligned to benefits and costs. | Empirical implementation evidence, programme records, or explicit reviewed assumptions. | Historical/baseline and project scenarios have comparable coverage; unmodeled components identified. |

### 5. Evidence, provenance, and uncertainty

| Item | Classification | Minimum record |
|---|---|---|
| Provenance | Required for every input | Provider, dataset/product name and version, URL or archive identifier, retrieval date, license/terms, raw-file checksum, and retained evidence reference. |
| Data transformations | Required for every derived input | Code/version, input references, units before/after, coordinate/time conversions, filters, imputation, aggregation, and reproducible output checksum. |
| Uncertainty and limitations | Required for modeled/estimated quantities; coverage limitations required for all | Interval or distribution if supported; otherwise state `not quantified`; include sampling/model uncertainty, transfer assumptions, missingness, and applicability limits. |
| Sensitivity analysis | Required before decision-grade conclusions | Sensitivity to material inputs (emissions, exposure, population, baseline rates, risk functions, valuation, adoption/effectiveness, and costs); show which assumptions drive results. |
| Independent review | Required before decision use | Domain review for atmospheric attribution, epidemiology, and economic valuation as applicable; separate numerical reconstruction/check of the account. |

## Supporting context — do not substitute for required inputs

The following can inform quality checks or interpretation, but are not by
themselves the required model quantities:

| Context data | Useful for | Not equivalent to |
|---|---|---|
| Monthly monitoring-station PM2.5 values | Trend/context checks and comparison with modeled exposure | Event-hour/day gridded, population-weighted PM2.5 exposure or fire-attributable concentration |
| Annual all-cause district death counts/rates | Broad population-health context or denominator checks | Cause-, age-, and time-specific baseline health rate or haze-attributable death |
| WHO country-level mortality estimates | Broad international context when clearly labeled | Local district/stratum baseline or proof that a risk function applies to Malaysia |
| Hospital beds and healthcare staffing | Service capacity context | Health outcomes, healthcare utilization caused by haze, or cost per treatment |
| Labour-force aggregates and wages | Worker population and possible wage valuation context | Haze-caused absence, lost workdays, or lost productivity |
| Producer-price indices | Price-level adjustment/context | Health treatment costs or a welfare valuation |
| Fire detections alone | Fire occurrence/location context | Emitted PM2.5 mass, smoke transport, or receptor-level attributable exposure |
| Product/method documentation pages | Candidate discovery and method review | Retrieved complete data, validated calculations, or scientific approval |

## Mapping to the current DamageAccountant import

The current `haze.damage.import.v1` contract is an accounting import, not a raw
data-ingestion schema. Once scientific processing is complete, map its outputs
as follows:

| Specification output | DamageAccountant input table/field |
|---|---|
| Event, source boundary, geography, population, periods, counterfactual, currency, price year, approved methods | `scope` |
| Measured or modeled physical outcomes and exposure quantities, by endpoint, scenario, geography, period, population stratum, and unit; include method, applicability, uncertainty, source references, and missingness | `effects` |
| Compatible, sourced monetary value per physical unit, with currency/year, valuation horizon, transfer/discount assumptions, and applicability | `unit_values` |
| Endpoint coverage and reason for available/unavailable/not estimated/not applicable | `coverage` |
| Payer/recipient and transfer/resource financing entries where financial incidence is required | `incidence` |
| Historical, baseline, and (if applicable) project comparator descriptions, costs, effectiveness, adoption, maintenance, durability, and displacement | `scenarios` |
| Fire/source categories not estimated, unavailable, or not applicable | `source_fire_categories` |

Raw rasters, station series, fire detections, meteorological fields, risk
functions, and source-specific metadata need upstream storage and processing;
do not force them into an accounting `effects` row without a documented,
reproducible transformation.

## Seed triage input labels

The reviewed seed inventory uses the following short labels in
`potential_inputs`. A label means the source may help locate or inform that
input; it is not a claim that the source provides a complete or acceptable
dataset.

| Label | Meaning |
|---|---|
| `fire_emissions` | Fire emissions by species and time for an approved attribution method. |
| `fire_radiative_power` | Satellite/product fire activity or radiative-power input used by some emissions methods. |
| `meteorology` | Weather fields needed by a reviewed transport/dispersion method. |
| `ambient_pm25_field` | Candidate gridded or modeled PM2.5 concentration field. |
| `population_grid` | Candidate spatial population counts for exposure/health weighting. |
| `baseline_health_context` | Context or discovery for baseline health rates; individual sources may not satisfy outcome-specific requirements. |
| `health_baseline_context` | Country-level or aggregate health baseline context, not necessarily compatible with event-specific outcomes or strata. |
| `health_baseline_discovery` | Documentation or metadata discovery for potential health baseline datasets. |
| `health_service_capacity` | Health-service capacity context, not outcome incidence or unit treatment cost. |
| `ambient_pm25_validation` | Monitor/air-quality data potentially useful for context or model validation, not automatically population exposure. |
| `labour_context` | General labour-market context, not event-caused work disruption. |
| `work_valuation_context` | Possible wage/earnings valuation context, not a measured work-loss quantity. |
| `price_context` | General price-index or price-basis context, not a health cost or welfare value by itself. |
| `air_quality_context` | General air-quality dataset discovery/context. |
| `population_context` | Administrative population context, not necessarily a compatible gridded population product. |
| `malaysia_official_statistics_discovery` | Catalogue/API discovery for Malaysian official statistics. |
| `risk_function_method_reference` | Health-risk guidance/method literature; not automatically a quantitative or locally applicable function. |
| `health_impact_method_reference` | General health-impact method/software documentation. |

## Sign-off checklist

Before promoting any pilot input to an account, confirm:

- [ ] The definition and unit match the target quantity, not merely related context.
- [ ] Geography, population strata, time resolution, and baseline/counterfactual match across sources.
- [ ] Coverage meets the declared pilot threshold; gaps and exclusions are visible.
- [ ] The source is accessible under its terms and its version/provenance are retained.
- [ ] Transformations and derived values are reproducible and independently checked.
- [ ] Scientific applicability is reviewed by the appropriate domain expert.
- [ ] Uncertainty, sensitivity, overlap, and double-counting are handled explicitly.
- [ ] Unsupported outcomes are marked unavailable/not estimated, not silently set to zero.
