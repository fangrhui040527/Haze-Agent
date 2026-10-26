# DamageAccountant pilot readiness matrix

## Purpose and status

Use this matrix to decide whether a bounded pilot is ready to proceed through
each workflow stage. It translates the input requirements in
[DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md](./DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md)
into evidence, coverage, blocker, and review fields. Update it from verified
source documentation, retained data, reproducible checks, and named reviewer
decisions—not from crawler or model-generated claims alone.

This initial snapshot is deliberately conservative. It does not select an
event, geography, outcome, source, scientific method, or intervention on the
project's behalf. Those choices remain unapproved until entered and reviewed
in the scope record below. `Not assessed` means no evidence was evaluated; it
does not mean the input is available or acceptable.

## Status definitions

| Status | Meaning |
|---|---|
| `NOT ASSESSED` | No adequate evidence has been examined against the stated acceptance criterion. |
| `PARTIAL` | Some evidence exists, but coverage, metadata, validation, or review is incomplete. |
| `BLOCKED` | A required decision, input, or dependency is missing, so the downstream stage cannot proceed. |
| `READY` | Acceptance criterion is met with retained evidence and the required review recorded. |
| `NOT IN SCOPE` | The approved analysis does not require this conditional input; record the rationale and approver. |

Do not mark an item `READY` based only on a crawler result, a small sample,
an undocumented API response, or a passing software test. A test establishes
software behavior, not scientific suitability of real-world inputs.

## Pilot scope and approval record

Complete and approve this record before treating the matrix as a project
readiness assessment. Until then, the overall status is **BLOCKED: pilot scope
not approved**.

| Scope decision | Current value | Evidence / rationale | Decision owner | Approval status |
|---|---|---|---|---|
| Stable event ID and haze episode definition | Not selected | Identify event dates and the evidence used to define the episode. | Project lead + atmospheric-science reviewer | Pending |
| Source boundary and included pollution sources | Not selected | State whether the claim concerns fires specifically or all-source haze; document source buffer. | Atmospheric-science reviewer | Pending |
| Malaysian study boundary and boundary version | Not selected | Name the target area, boundary dataset/version, and spatial reference system. | Project lead + geospatial reviewer | Pending |
| Population and strata | Not selected | Define resident/exposed population, age/sex groups, exclusions, and denominator. | Epidemiology reviewer | Pending |
| Event, exposure, health, baseline, and valuation periods | Not selected | Specify time zone, averaging window, lags, baseline years, and valuation horizon. | Project lead + domain reviewers | Pending |
| Counterfactual | Not selected | Define the comparison and how it will be estimated; do not assume a historical average is causal. | Atmospheric-science + epidemiology reviewers | Pending |
| Health outcomes and endpoints | Not selected | List outcomes and case definitions; designate unestimated endpoints explicitly. | Epidemiology reviewer | Pending |
| Economic perspective and included costs | Not selected | Define payer/recipient boundary, transfers, currency, price year, and double-counting policy. | Health-economics reviewer | Pending |
| Intervention evaluation | Not selected | State whether prevention is in scope; if so, name intervention and no-project comparator. | Project lead + evaluation reviewer | Pending |
| Pilot minimum coverage and acceptable exclusions | Proposed criteria in input specification; not approved | Confirm or revise proposed minimums before acquisition and analysis. | Project lead + relevant domain reviewers | Pending |

## Input readiness

The acceptance criteria refer to the corresponding input row and proposed
minimum coverage in the input specification. Add links to exact source
versions, retained artifact paths/checksums, quality reports, and review
records as evidence becomes available. `Not assessed` is the starting status
for inputs where the current pilot has no adequate evidence.

| Workflow input | Requirement | Acceptance criterion | Evidence currently available | Coverage / known gap | Blocker or next action | Status |
|---|---|---|---|---|---|---|
| Fire detections | Conditional on fire attribution | Official/validated detections cover the event and transport source buffer; retain observation time, QA, and sensor metadata. | Reviewed discovery seeds only; no event data acquired. | Event and source buffer are not selected. | Approve scope, select source, acquire and validate event data. | BLOCKED |
| Fire radiative power / activity | Conditional on emissions method | Required temporal and spatial fire activity is covered with product QA, units, and uncertainty. | No pilot data acquired. | Method dependency not chosen. | Select emissions method; mark `NOT IN SCOPE` only if approved method does not require it. | NOT ASSESSED |
| Fire emissions | Required for emissions-based attribution | Emissions by species, time, source, and model domain are complete or gaps are reviewed; version/factors and uncertainty retained. | No pilot data acquired. | No attribution method or event scope. | Choose reviewed attribution path and acquire complete emissions or approved alternative. | BLOCKED |
| Meteorology | Required for transport-based attribution | Model-required fields cover the complete source-to-receptor domain and simulation period, with no unreviewed gaps. | Documentation discovery only; no pilot fields acquired. | Domain and model requirements unknown. | Select transport model and acquire its required meteorological inputs. | BLOCKED |
| Transport / dispersion model | Required method when attributing transport | Reproducible version/configuration; matched historical and counterfactual runs; appropriate independent validation and expert review. | Arithmetic source-removal prototype only; no transport model execution. | Prototype is not a transport or attribution model. | Select, configure, run, validate, and review an appropriate model. | BLOCKED |
| Ambient PM2.5 field | Required exposure input | Verified concentration unit; declared event-relevant temporal and spatial coverage; QA and measurement/model distinction; gaps quantified. | Three-row monthly Data.gov.my API smoke sample, retained with raw/normalized hashes. | Sample has no verified unit or row-level geography; it is not an event-period grid or complete exposure field. | Acquire a suitable event-period grid and monitor observations for validation. | PARTIAL (not acceptable as required exposure input) |
| Population grid | Required for population weighting / burden | Compatible grid and strata cover the study area; reference year/method documented; totals reconciled to authoritative totals within a declared tolerance. | No pilot data acquired. | Study boundary and population strata are not selected. | Approve scope and acquire/reconcile appropriate population data. | BLOCKED |
| Exposure aggregation | Required derived quantity | Reproducible aggregation from compatible PM2.5/population inputs; exact mask, denominator, period, missingness, and sensitivity documented. | Population-weighted arithmetic prototype and unit tests only. | No compatible real-world inputs or grid processing/validation. | Obtain approved source inputs; implement alignment and coverage checks; independently verify calculation. | BLOCKED |
| Baseline outcome rates | Required for attributable health outcomes | Outcome-specific rates/denominators match geography, period, case definition, population strata, and chosen method. | Context-source discovery only; no compatible pilot rates acquired. | Outcomes, geography, and strata are not selected. | Select outcomes and obtain authoritative, compatible baseline data. | BLOCKED |
| Risk function | Required for health-effect calculation | Versioned function matches exposure metric, outcome, lag, and strata; transfer/applicability and uncertainty reviewed. | Arithmetic prototype accepts a supplied relative risk; no function selected or approved. | No applicability assessment or scientific review. | Obtain epidemiological review and document function or do not estimate that outcome. | BLOCKED |
| Attributable health outcomes | Required output if health effects are reported | Reproducible estimates from accepted exposure, baseline, and risk inputs; uncertainty and independent numerical check included. | Formula prototype tests only; no empirical calculation. | Required upstream inputs are blocked. | Complete upstream evidence and method review; otherwise mark outcome not estimated. | BLOCKED |
| Treatment/resource use and unit costs | Conditional on treatment-cost valuation | Compatible outcome-linked quantities and local/justified unit costs; perspective, price year, components, and exclusions documented. | No pilot data acquired. | No monetization scope or outcome data. | Decide if included; acquire and review sources or record approved exclusion. | NOT ASSESSED |
| Work disruption and valuation | Conditional on productivity valuation | Event-attributable lost time/output and compatible valuation for declared worker strata; method accounts for causal attribution and exclusions. | Labour-market/wage context seeds only. | No haze-attributable disruption data; wages alone are not lost work. | Decide if included; obtain event-linked evidence and justify valuation or exclude. | NOT ASSESSED |
| Mortality valuation | Conditional on monetizing mortality | Explicit valuation method, population applicability, transfer assumptions, currency/year, and uncertainty reviewed. | No value selected or acquired. | No mortality valuation decision or applicability review. | Decide whether mortality will be monetized; otherwise report physical outcomes only. | NOT ASSESSED |
| Coverage, incidence, and transfers | Required for account completeness; incidence conditional on payer analysis | Every target endpoint has availability status/reason; account boundary and payer/recipient entries reconcile without double counting. | Accounting contract mapping documented; no empirical account assembled. | Scope, endpoints, and financing evidence not selected. | Approve account boundary and document included/excluded categories and rationale. | BLOCKED |
| Intervention definition | Conditional on prevention evaluation | One feasible intervention, implementing body, schedule, target, causal path, and no-project comparator are documented. | No intervention selected. | Prevention scope unknown. | Decide whether evaluation is included; if yes, specify and approve intervention/comparator. | NOT ASSESSED |
| Effectiveness / exposure reduction | Conditional on avoided-harm claims | Measured or modeled intervention effect covers domain/population/horizon, with spillovers, adoption, durability, and uncertainty reviewed. | No intervention effect acquired or estimated. | Depends on intervention selection. | Obtain applicable empirical/model evidence and reviewer approval. | NOT ASSESSED |
| Provenance and transformations | Required for every input | Source/product/version, retrieval, license/terms, checksums, transformations, validation, exclusions, and retained artifacts recorded. | Task-five manifest covers the bounded PM2.5 sample; dataset version is not provided and license is not individually verified. | Provenance exists for one small sample only; not for the required full input set. | Generate and verify a manifest for every acquired source and derived artifact; verify terms. | PARTIAL |
| Uncertainty and sensitivity | Required before decision-grade conclusions | Evidence-supported uncertainty is characterized for material inputs/methods; sensitivity covers material assumptions; outputs are not misrepresented as confidence limits. | One-way sensitivity helper tested; no empirical pilot ranges justified or evaluated. | No parameter ranges/distributions reviewed. | Obtain evidence-backed ranges and domain review; document unquantified uncertainty where evidence is absent. | PARTIAL |
| Independent review | Required before decision use | Atmospheric, epidemiological, economic, and numerical reviews are recorded for applicable stages. | No pilot result or expert review record. | No reviewers or results designated. | Assign reviewers and require documented review before decision use. | BLOCKED |

## Stage gates

| Gate | Pass condition | Current result |
|---|---|---|
| G0 — Scope approved | All required scope decisions above have values, evidence/rationale, and named approvals. | BLOCKED |
| G1 — Source access verified | Each required input has an acceptable source, documented access path/terms, and acquisition test. | BLOCKED |
| G2 — Data coverage accepted | Required space/time/population coverage, units, quality, gaps, and exclusions are reviewed against approved criteria. | BLOCKED |
| G3 — Processing reproducible | Versioned transforms and calculations reproduce from retained inputs and pass quality checks. | BLOCKED |
| G4 — Methods reviewed | Applicable scientific and valuation methods, assumptions, counterfactuals, and limitations are approved. | BLOCKED |
| G5 — Uncertainty and independent check | Material uncertainties are treated appropriately and a separate reviewer reconstructs/checks results. | BLOCKED |
| G6 — Accounting import accepted | Only reviewed quantities/values are mapped to the accounting contract with coverage, incidence, and provenance. | BLOCKED |

Passing a gate applies only to the declared event, geography, population,
period, endpoints, and method. It does not establish readiness for other
events or broader coverage.

## Update protocol

For each matrix update, record the date, editor, evidence references, changed
status, and rationale in the project’s normal review record. Keep source
artifacts and detailed quality outputs outside this summary matrix, and link
them rather than copying large datasets or sensitive data into this document.
