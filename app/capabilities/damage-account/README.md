# Damage account

This capability builds damage accounts from retained, scoped physical quantities
and compatible unit values. It keeps physical outcomes, financial incidence and
selected social welfare in separate views, with exact source references,
explicit omissions and an independent numerical review.

The registered ID is `damage-account`, version `damage-account.v2`. HazeOps
retrieves evidence, DamageAccountant produces the account and EvidenceCritic
checks the completed account and its components.

## Inputs and use

Open `/damage-account` and describe the location, episode and dates, for example:

> Build a damage account for the Klang haze episode during 2026-10-24 to
> 2026-10-25, using retained accounting evidence and identifying missing inputs.

No attachment is required. The server-owned `damage.world-inputs` tool looks for
accounting-ready `haze.damage.inputs.v1` captures in World Model. It resolves the
requested scope, pins the exact capture and original supporting artifacts, and
reconstructs the tables from those originals. It checks access, execution mode,
producer state, applicability, holds and content hashes. Different versions or
ambiguous evidence require an explicit selection; the adapter does not silently
choose the newest capture.

The retrieval and selection bridge lives in
[adapters/damage-input-adapter](../../adapters/damage-input-adapter/README.md).
Composition injects this capability's request/scope matching and accounting
reconstruction policy into the adapter. Permissions, provenance, holds and
durable pin enforcement remain shared task/runtime responsibilities.

If evidence is missing, collection produces `damage.acquisition-gap` with the
backend acquisition requirements and no numerical estimate. Ambiguous scope or
evidence produces a clarification with candidate record references. Raw PM2.5
series alone cannot supply the attributable physical outcomes this account
needs.

An explicit compatibility path accepts authorized JSON or CSV artifacts through
`damage.read-input`. JSON uses `haze.damage.import.v1`, with exactly one declared
scope across the selected imports and typed `effects`, `unit_values`,
`incidence`, `coverage`, `scenarios` and `source_fire_categories` tables. CSV
requires `schema_version,table_type,record` columns; each `record` is a quoted
JSON object. See the schemas in
[damage-account.ts](../../contracts/damage-account.ts) and the complete,
explicitly synthetic example in [fixtures.ts](fixtures.ts).

## Workflow and results

| Assignment        | Role             | Result                                                                                                            |
| ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `damage.collect`  | HazeOps          | Canonical `damage.inputs`, a retained evidence selection link, or an acquisition gap.                             |
| `damage.scope`    | DamageAccountant | Declared event, geographic, population, temporal and social boundaries, with approved method IDs.                 |
| `damage.compile`  | DamageAccountant | Coverage, physical, incidence, welfare, overlap, source-fire extension, method and scenario components.           |
| `damage.assemble` | DamageAccountant | `damage.account`, an immutable manifest referencing the exact completed components.                               |
| `damage.check`    | EvidenceCritic   | `damage.review`, independently reconstructed from original inputs and tied to exact artifact versions and hashes. |

The deterministic tools `damage.calculate`, `damage.reconcile` and `damage.check`
perform calculation, assembly and independent reconstruction. Registered methods
retain supplied physical quantities, multiply compatible quantities and unit
values, select nonoverlapping valuation paths, reconcile financing and cancel
internal transfers across the declared social boundary. Financial transfers are
not added again to welfare loss.

Scenario comparisons use supplied residual outcomes and compatible comparators.
When declared inputs support them, outputs include avoided damage, project
cost, net social benefit and a benefit-cost ratio. Missing coverage remains
visible and can withhold benefits; missing quantities are not replaced with
zero.

The optional `damage.revision-bridge` and `damage.revision-check` assignments
compare explicitly pinned previous/current accounts and their original inputs.
They separate quantity, coverage, method, unit-value and boundary/incidence
changes, with an independent review of the bridge. This branch is not part of
the default five-stage workflow.

## Limits

This capability does not estimate exposure, health responses, causal source
attribution or intervention effectiveness from raw data. It does not supply
missing coefficients, currency conversions or default values. Source-fire
categories remain explicitly unestimated. Arithmetic support does not establish
scientific applicability, source authenticity or legal findings.

Units, currency, price year, valuation date, horizon, scope and overlapping
valuation paths must be compatible. Existing artifact and evidence-closure
bounds apply. Fixture examples are synthetic software checks and are never
substituted for missing live evidence.

The sibling [damage-accounting](../damage-accounting/README.md) capability
organizes supplied manifests and components. This folder owns the calculation,
assembly and independent numerical-check workflow.

## Key files

| File                                                                 | Responsibility                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [index.ts](index.ts)                                                 | Capability card, assignment graph, tool registrations and review requirements.                             |
| [world-input-policy.ts](world-input-policy.ts)                       | Request/correction scope interpretation, country/date matching and original-evidence reconstruction rules. |
| [World Model adapter](../../adapters/damage-input-adapter/README.md) | Governed lookup, evidence selection, receipt persistence and selection reuse.                              |
| [inputs.ts](inputs.ts)                                               | Import parsing, normalization, exact source references and registered method descriptions.                 |
| [scope.ts](scope.ts)                                                 | Scope, unit, valuation-basis, overlap, coverage and financing validation.                                  |
| [methods.ts](methods.ts)                                             | Deterministic component compilation and manifest assembly.                                                 |
| [checker.ts](checker.ts)                                             | Independent account and revision reconstruction without producer arithmetic.                               |
| [publication.ts](publication.ts)                                     | Revision bridge construction from exact previous/current inputs and accounts.                              |
| [fixtures.ts](fixtures.ts)                                           | Explicit synthetic imports and known accounting expectations.                                              |

For setup and execution modes, see the [project README](../../../README.md).
The [adapter report](../../../docs/orchestration/world-model-damage-input-adapter-report.md)
and [accounting implementation report](../../../docs/orchestration/damage-accountant-implementation-report.md)
explain the integration and accounting rules in more detail.
