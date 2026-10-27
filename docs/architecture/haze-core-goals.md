# Haze core goals and product specification

[Documentation index](../README.md) · [Architecture and specifications](README.md)

Agreed scope recorded on **27 October 2026** (Asia/Singapore).

**Status:** target requirements and acceptance criteria. This document defines
intended behavior; implementation status and verification evidence are tracked
separately in the [implementation reports](../reports/README.md).

Haze's overall purpose is to help **government/environmental policy analysts and
journalists understand and reduce haze-related damage in Malaysia**. It should
provide national results and state breakdowns wherever the evidence supports them.

The following defines the target behavior and the criteria for completing each
goal.

## Goal 1: Continuously collect and maintain updated haze-related evidence

Haze should automatically acquire, organise and retain the evidence needed to
understand current conditions, calculate damage and assess mitigation options for
Malaysia.

### Requirements

- **Check news every 10 minutes.** Retain relevant reports with their source,
  publication date, retrieval time and geographical relevance.
- **Refresh numerical datasets according to their publication frequency.** These
  include pollution and fire data, population and health statistics, economic
  values, and intervention effectiveness and costs.
- **Run unattended while the application and local computer remain on.** This
  supports the hackathon. Production operation should run on an always-on server.
- **Preserve evidence provenance and history.** Store source references, versions,
  timestamps, units, geographical coverage and transformations. Distinguish
  observations, modeled estimates, forecasts, assumptions and sample data.
- **Track freshness and coverage.** Show unavailable sources, failed updates,
  missing periods and unsupported locations. Retain the last usable evidence with
  its age clearly stated.
- **Automatically update affected calculations.** New or revised relevant
  numerical evidence should trigger validation and recalculation. News can trigger
  investigation or further acquisition; an article alone should not automatically
  change numerical damage estimates.
- **Preserve previous results.** Updated evidence should create traceable revisions
  rather than silently overwrite the evidence behind an earlier estimate or plan.

### Expected output

A maintained evidence collection showing what is available, where it applies, how
current it is and which calculations depend on it.

### Completion criterion

A live source update can be collected, validated and retained, then correctly
trigger an affected damage estimate and plan reassessment. Restarting the
application preserves retained evidence and collection history.

## Goal 2: Calculate supported physical and monetary damage

Haze should calculate damage for the location, period and outcome requested by the
user, using all relevant, compatible evidence for that scope. Annual accounts must
assign damage to **the year it occurred**, regardless of when supporting evidence
was collected or published.

### Initial quantified scope

| Reporting view        | Included outcomes                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Physical damage       | Illness, premature deaths and lost work/productivity expressed in appropriate physical units    |
| Financial losses      | Healthcare expenditure and supported income or productivity losses                              |
| Social-welfare damage | Supported monetary valuations of health, premature mortality and other included welfare effects |

### Requirements

- **Keep different physical outcomes separate.** Deaths, illness cases and lost
  workdays cannot be added into one physical total. Each result must state its
  outcome definition and units.
- **Keep financial-loss and social-welfare views separately labelled.** Apply
  explicit overlap and double-counting rules; do not automatically add the two
  views together.
- **Distinguish reporting periods.** Clearly identify episode totals, year-to-date
  accounts and complete annual accounts. An episode subtotal must not appear as
  the damage for an entire year.
- **Support national and state reporting.** Aggregate compatible geographical
  results without counting overlapping populations or losses twice. State where
  coverage is incomplete.
- **Use published, applicable calculation methods.** Retain the supporting inputs,
  method versions, assumptions, valuation basis and uncertainty. Monetary amounts
  must use compatible currencies, price years and valuation periods.
- **Distinguish attribution.** Calculate fire-related haze damage where supported.
  Where fire-specific attribution is unavailable, offer a separately labelled
  all-PM2.5 estimate; never describe that fallback as damage proven to come from
  fires.
- **Represent missing evidence honestly.** Unsupported categories or periods remain
  gaps, rather than invented values or zero losses. Education, tourism, agriculture
  and ecosystem damage remain outside the initial quantified scope unless suitable
  support is added.
- **Independently check calculations.** Retain sufficient original evidence for a
  separate numerical review to reproduce the reported results.

### Expected output

A versioned damage account containing physical outcomes, separate financial and
social-welfare views, geographical and temporal coverage, sources, methods,
uncertainty and omissions.

### Completion criterion

A supported historical case produces reproducible results for its declared scope,
with independently checked arithmetic and clearly identified missing coverage.

## Goal 3: Generate evidence-supported plans targeting at least 10% damage reduction

Haze should generate plans aimed at reducing the damage identified in the user's
request by at least 10%. The user's request determines the target outcome:

- A request about illness should target a reduction in the specified illness
  outcome.
- A request about lost workdays should target lost workdays.
- A request about monetary losses should identify whether the target concerns
  financial losses or social-welfare damage.

Haze must interpret the request into a structured scope: **location, period, damage
category, specific outcome, unit, attribution basis and comparison baseline**. It
should ask for clarification when ambiguity materially changes the result. The
choice of classifier or model remains an implementation decision.

For a positive baseline:

```text
reduction percentage =
  (baseline damage - estimated damage with intervention) / baseline damage * 100
```

### Requirements

- **Use the requested damage estimate as the baseline.** Preserve the same outcome,
  geographical scope, time basis and accounting definition when comparing
  intervention scenarios.
- **Consider both intervention categories:** exposure protection, such as warnings,
  cleaner indoor air and workplace adjustments; and fire/source prevention.
- **Require suitable effectiveness evidence for quantified benefits.** Published
  methods and explicit assumptions are acceptable, with applicability and
  uncertainty stated.
- **Produce actionable plans.** Describe proposed actions, responsible actors,
  timing, prerequisites, implementation constraints, costs and the evidence
  supporting expected effects.
- **Report avoided damage, intervention costs and net benefit separately.** Apply
  the 10% threshold to avoided damage. Calculate monetary net benefit only using
  compatible values.
- **Distinguish historical and prospective claims.** Historical recommendations are
  hypothetical avoided-damage scenarios. Future recommendations are projections.
  Neither establishes an achieved reduction.
- **Handle insufficient support explicitly.** If evidence cannot support 10%, report
  the gap or a supported below-target option without inventing effectiveness.
- **Pin each plan to its baseline version.** When relevant evidence changes,
  reassess the plan and preserve its previous calculations and conclusions.

### Expected output

A reviewed plan showing its baseline, proposed actions, estimated avoided damage,
percentage reduction, costs, uncertainty, prerequisites and target status.

### Completion criterion

Haze can reproduce the reduction calculation and explain whether a supported
scenario meets 10%, falls below it or has insufficient evidence.

## Hackathon demonstration and live verification

The **hackathon demonstration will use three prepared historical sample
datasets**. Together, they should demonstrate physical damage, monetary damage and
reduction planning, with traceable sources and expected calculations.

Historical episodes grouped under their occurrence years remain the **proposed
sample format**; the exact cases depend on evidence availability. Episode results
must remain labelled as episode results and must not substitute for complete
annual totals.

Live collection remains a separate required capability. Successful sample
demonstrations establish calculation and workflow behavior; live collection must
be verified through actual source updates.
