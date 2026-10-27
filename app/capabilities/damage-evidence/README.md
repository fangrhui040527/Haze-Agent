# Public damage evidence

This module prepares and retains evidence for the existing damage-account workflow.
`validated` means that a registered parser produced structurally valid, traceable
records. It does not mean that the source supports a health-effect estimate or
that scientific applicability has been approved.

`createDamageEvidenceTools` exposes separate requirements, numerical acquisition
and document acquisition tools. The planner reads retained captures before
suggesting official English/Malay searches. It produces explicit baseline and
A/B requirements with missing quantities left unestimated. The discovery planner
does not automatically promote requirements to `applicable`; the separate
scientific-review workflow governs qualified calculation and reuse.

The source registry specifies endpoints, supported inputs, geography, temporal
resolution, native units, parser versions, access requirements, refresh cadence,
download bounds and provider throttles. Restricted or unimplemented routes stay
visible as access gaps. The initial numerical routes cover DOSM district
population CSV, district deaths and state wages APIs, Malaysia monthly pollution
and Open-Meteo modeled PM2.5.

Each capture retains exact original bytes in a content-addressed archive,
source/version metadata, retrieval time, observation period, row/JSON-pointer
locators and transformation instructions. Population normalization explicitly
multiplies the source's thousands of persons by 1000. Missing values remain gaps;
PM10 and pollution indices cannot be substituted for PM2.5 concentration.
Downloads are streamed within provider bounds. Redirects are limited to three
on the same HTTPS host. HTTP200 browser challenges remain retained access gaps.

`DamageEvidenceArchive` keeps immutable capture manifests, separate request
attempts and failures, latest usable captures, current availability and capture
age. Unchanged bytes and parser/request versions reuse a capture ID. Task tools
isolate archives by workspace and principal while sharing the host's provider
throttle. Model messages receive bounded previews and references, rather than
complete CSVs. Document text is untrusted source material.

Document acquisition accepts registered official sources or an exact retained
search-result URL on a registered public host. For the latter, supply
`source_id: "discovered-document"` and `discovered_url`. The host's
`resolveArtifact` callback permits reading only the assignment's retained output
references, so a saved search capture can authorize a subsequent acquisition in
the same assignment. Cross-host document redirects remain access gaps.

Run offline checks with:

```powershell
npx vitest run --project unit tests/unit/damage-evidence.test.ts
```

Run original public-source acquisition separately with:

```powershell
npm run build
node scripts/verify-damage-evidence.mjs --live
```

The live verifier saves bounded reports in
`data/damage-evidence-verification/2026-10-27/` and original bytes and append-only
attempt history in `.state/damage-evidence-verification/2026-10-27/`. It compares
2015, 2006 and 2019 Malaysian episode candidates without importing unreviewed
published estimates. Its 2024 numerical samples are provider-contract checks and
cannot replace evidence from those historical occurrence periods. Successful
acquisition does not establish live-model routing, a genuine source revision,
scientific qualification or intervention effectiveness.

Provider contracts checked against the [Data.gov.my request-query documentation](https://developer.data.gov.my/request-query),
[rate-limit documentation](https://developer.data.gov.my/rate-limit) and
[Open-Meteo air-quality documentation](https://open-meteo.com/en/docs/air-quality-api).
