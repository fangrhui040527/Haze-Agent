# Capabilities

This folder contains the domain methods available to the Haze task engine. Each
capability describes its purpose, inputs, work products, agent roles, required
tools and limitations, and supplies registered assignment plans and validation.
The Manager can use those definitions to choose specialist work for a request.

## Available capabilities

| Folder                                                           | Registered ID / version                                      | What it does                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [evidence-synthesis](evidence-synthesis/README.md)               | `evidence-synthesis` / `evidence-synthesis.v3`               | Extract bounded notes from supplied sources and independently check exact citations.                                                                               |
| [episode-investigation](episode-investigation/README.md)         | `episode-investigation` / `episode-investigation.v3`         | Record scoped episode context and unresolved observation/attribution branches, with independent review of the references.                                          |
| [pm25](pm25/README.md)                                           | `pm25-evidence-summary` / `3`                                | Retrieve stored modeled PM2.5 samples, calculate coverage and range, and independently check the numerical result.                                                 |
| [evidence-collection](evidence-collection/README.md)             | `evidence-collection` / `evidence-collection.v1`             | Collect one explicitly selected source's current haze evidence for bounded locations; retain exact raw material and coverage without granting acceptance.          |
| [damage-appraisal](damage-appraisal/README.md)                   | `damage-appraisal` / `damage-appraisal.v2`                   | Build separate physical, financial incidence and selected welfare views from retained accounting inputs, and independently reconstruct the account.                |
| [damage-account-intake](damage-account-intake/README.md)         | `damage-account-intake` / `damage-account-intake.v1`         | Resolve supplied account manifests and component references, report missing components and preserve review/revision lineage.                                       |
| [damage-reduction-planning](damage-reduction-planning/README.md) | `damage-reduction-planning` / `damage-reduction-planning.v1` | Compare supplied residual damage, draft conditional plans/pilots and check external evaluations with exact arithmetic, independent review and current claim gates. |

Each linked README explains the capability's inputs, assignments, outputs, limits
and source files. `damage-appraisal` performs numerical accounting;
`damage-account-intake` handles existing component manifests. Episode investigation
registers context/gap work by default; its factory accepts additional method
plans, while PM2.5 retrieval and analysis are registered separately.

[Damage-reduction programme coordination](damage-reduction-programmes/README.md)
is a composition-registered runtime extension around existing assessment and
planning tasks. It owns programme revisions, exact phase links, cumulative
budgets, historical context, API projections and task mutation guards.

The capability IDs were renamed from `damage-account` to `damage-appraisal` and
from `damage-accounting` to `damage-account-intake`. Existing saved task records
retain their original capability/version pins; start a new task to use the
renamed capabilities. Artifact kinds, schema tags, assignment/tool IDs and the
`/damage-account` interface URLs retain their existing names.

## Registration and execution

[composition.ts](../composition.ts) assembles the executable registry: it registers
the five agent roles, capability definitions, assignment definitions and typed
tools. Capabilities expose a public card and matching/plan functions; assignments
bind concrete work to a role and declare the services they need. Capabilities can
also define prerequisites, independent review requirements, peer channels and
World Model adapters.

The damage-account input bridge lives in
[adapters/damage-input-adapter](../adapters/damage-input-adapter/README.md).
Composition supplies the capability's request/scope and input reconstruction
policy to that adapter; accounting methods and independent checks stay here.

The current roles are Manager, HazeOps, WorkerShield, EvidenceCritic and
DamageAccountant. Their instructions live in `app/agents/`; domain methods and
checks live here. Shared execution interfaces belong to
[orchestration](../orchestration/README.md), public schemas to
[contracts](../contracts/README.md), and lifecycle, permissions, budgets and
durable state to [tasks](../tasks/README.md). Keep domain registration in the
composition root so shared engine code stays independent of individual methods.

## Evidence and limits

Artifacts retain exact IDs, versions and SHA-256 hashes. Independent review names
the specific artifacts it checks. Missing evidence stays visible as a gap or a
request for clarification, and a capability's registered tools bound the sources
it can retrieve.

Execution mode (`live`, `fixture` or `replay`) is separate from evidence origin.
Fixture data must be selected explicitly. Fixture success establishes integration
behavior; live readiness requires captured configured model/tool execution.
Registration, schema validation and numerical review do not establish source
authenticity, scientific applicability or accepted-state authority.

See the [project setup guide](../../README.md) for configuration and verification
commands and the [general engine guide](../../docs/orchestration/general-engine.md)
for the complete task flow.
