# Crawler status, remaining limits, and AI integration

## Summary

The discovery tool helps triage reviewed source pages and demonstrates bounded
data acquisition and calculation prototypes. It is not a complete scientific
pipeline or a DamageAccountant estimate.

The current objective is to achieve both DamageAccountant screenshot
workflows: reviewed fire attribution, exposure, and health estimates, followed
by physical/economic accounting and intervention evaluation. The project
owner reports that PM2.5 is already fetchable through Zetaris. **No new PM2.5
source acquisition or adapter development is part of the current plan.** The
existing Zetaris output is treated as supplied and will only be checked for
fit at final integration.

The pilot scope is not approved. The 15 Oct 2026 Klang news lead is
unverified; event dates, boundary, outcomes, baseline, counterfactual, and
intervention details remain unresolved. Do not start event-specific modeling
or present estimates as approved before those decisions are made.

## Completed discovery and prototype work

- Curated source seeds and the Crawl4AI discovery crawler support source-page
  triage; they do not automatically follow links or download bulk data.
- A separate three-row monthly Data.gov.my PM2.5 smoke test and sample
  artifacts exist as completed historical discovery work. They are not a
  required source for the current plan and do not replace the Zetaris feed.
- `pilot_methods.py` contains isolated arithmetic primitives for paired
  source-removal differences, population-weighted exposure, supplied-baseline
  and risk calculations, and declared-unit valuation. It does not run
  transport, select scientific parameters, or produce decision-grade
  estimates.
- `provenance.py` records pilot artifact metadata and supports deterministic
  one-way sensitivity analysis over caller-supplied ranges. It does not invent
  evidence or uncertainty distributions.
- The [implementation plan](../DAMAGE_ACCOUNTANT_IMPLEMENTATION_PLAN.md)
  records the active scope, PM2.5 exclusion, sequence, and readiness gates.

## Remaining work

- Approve the event and full dates, study boundary, population, health
  endpoints, baseline/counterfactual, intervention, economic perspective,
  coverage criteria, and responsible reviewers.
- Acquire and validate fire detections/emissions and meteorology for the
  approved source-to-receptor domain; select, run, and validate a reviewed
  transport/attribution method.
- Acquire compatible population data and calculate reviewed population-
  weighted exposure using the **existing** Zetaris PM2.5 source. Do not build
  or extend PM2.5 acquisition. Confirm the feed contract only as needed at
  integration; if unsuitable, raise a scope decision.
- Obtain appropriate health baselines and risk functions, estimate supported
  health outcomes, and obtain reviewed work-disruption, treatment-cost, and
  valuation inputs.
- Define and evaluate a specific intervention using effectiveness, adoption,
  lifecycle costs, and a credible comparator.
- Complete provenance, uncertainty, independent checks, and mapping of
  reviewed results into the DamageAccountant accounting contract.

APIMS is not named in the screenshots and is not a required dependency.
Historical APIMS observations may be considered optional validation evidence
if useful and officially accessible. No DOE data request is part of the
current implementation plan.

## Nemotron integration and limitations

`nemotron_crawl.py` is an optional one-page inspection experiment:

1. It selects one reviewed seed.
2. Crawl4AI fetches that page under the configured host/request restrictions.
3. Crawl4AI's `LLMExtractionStrategy` sends bounded page evidence (up to
   16,000 characters) through LiteLLM's OpenAI-compatible provider route to
   NVIDIA Nemotron.
4. The script prints schema-checked candidate fields, units, coverage, access
   methods, limitations, evidence quotes, and verification questions.

The strategy does not independently browse, follow links, acquire event data,
or validate scientific claims. Check model output against official
documentation before using it. A live provider call has not been validated in
this project after the strategy change. Install the optional dependency using
the command in the [README](./README.md) before running the live experiment.

An NVIDIA key was exposed during earlier work. Revoke and rotate that key
before any future live request; do not reuse or disclose an exposed key.
Review provider data-handling terms before sending page content.

## Related documents

- [Implementation plan](../DAMAGE_ACCOUNTANT_IMPLEMENTATION_PLAN.md)
- [Input specification](./DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md)
- [Pilot readiness matrix](./PILOT_READINESS_MATRIX.md)
- [Crawler capability and data-gap notes](./CRAWLER_CAPABILITIES_AND_DATA_GAPS.md)
- [README](./README.md)
