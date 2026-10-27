# Damage account intake

This capability organizes an existing damage account from supplied manifests,
component artifacts and evidence references. It checks which required components
are present and preserves their exact revisions for review and World Model
lineage.

The registered capability is `damage-account-intake` (`damage-account-intake.v1`). Its
single executable assignment, `damage-accounting.intake`, runs as `WorkerShield`
without external tools. `EvidenceCritic` is the declared independent reviewer
role; this module does not register executable component-review assignments.

The capability's former ID was `damage-accounting`. Its assignment, review and
artifact identifiers retain the `damage-accounting.*` names for existing records;
the capability is advertised to the Manager as `damage-account-intake`.

For numerical accounting from supplied effects and valuation inputs, use the
separate [damage-appraisal capability](../damage-appraisal/README.md). The
[composition root](../../composition.ts) distinguishes the two starting plans:
a valid component-intake scope selects this workflow when their objective
matches overlap.

## Inputs

Provide a task scope matching `damageAccountScopeSchema` and the relevant JSON
artifacts in the assignment context:

- **Scope:** account ID, account type, episode ID, geography, a positive
  end-exclusive period and counterfactual ID. Supported types are
  `physical_outcomes`, `financial_incidence`, `social_welfare` and
  `source_fire_extension`. Financial and welfare accounts also require currency
  and price year.
- **Manifest:** `haze.damage.account-manifest.v1`, containing that exact scope,
  a revision, required component IDs and immutable component references.
- **Components:** `haze.damage.component.v1`, carrying the account/component IDs,
  revision, scope hash, category, supplied measure, evidence references, overlap
  information and limitations.
- **Reviews and lineage:** separately supplied
  `haze.damage.component-review.v1` and `haze.damage.account-lineage.v1` artifacts
  support the World Model adapter's review and revision checks.

Artifact references use an ID, version and SHA-256 hash. A manifest for another
scope or a component for another account, revision or scope hash cannot fill a
required reference.

## Behavior and outputs

An invalid or incomplete scope produces a question and `waiting_human`. With a
valid scope, intake searches the supplied artifacts for a matching manifest,
resolves its component references and saves a `damage-accounting.intake` artifact
with the scope, manifest reference, resolved and missing component IDs, component
references and limitations.

No matching manifest produces a `partial` artifact with `gap` support. Missing
required components also produce `partial` with `gap` support. When all required
references resolve, the artifact reports `components_present`; assignment
support remains `partial` because presence does not establish independent review.

The World Model adapter extracts account, component, review and revision-lineage
records from hash-verified artifacts. It declares required arithmetic and/or
scientific-applicability review coverage by component category. An acceptance
candidate additionally requires exact component and evidence references,
independent supported `EvidenceCritic` assignment receipts, currency consistency
and, after revision 1, lineage to the previous manifest. These adapter checks do
not themselves grant accepted-state authority.

## Limits

This workflow does not fetch evidence, calculate damage figures, infer missing
values, estimate causal attribution or establish scientific applicability.
Physical outcomes, financial incidence and welfare valuations remain separate
account types; combining them requires explicit overlap reconciliation. Supplied
component reviews remain separate from intake, and schema validation does not
prove the supplied measures are correct.

## Key files

| File                         | Responsibility                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| [index.ts](index.ts)         | Capability card, objective matching and component-intake assignment.                             |
| [contracts.ts](contracts.ts) | Scope, manifest, component, review and lineage schemas.                                          |
| [world.ts](world.ts)         | Exact artifact resolution, World Model records, review coverage and acceptance-candidate checks. |

See the [capability overview](../README.md) and
[orchestration guide](../../orchestration/README.md) for registration and runtime
boundaries.
