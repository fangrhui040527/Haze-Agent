# Sponsor technology hardening verification

[Testing index](README.md) · [Implementation plan](../plans/sponsor-technology-hardening-plan.md)

Run `npm run check` before capturing evidence for a release. A changed build,
instruction, contract, role route, Nightshift installation or candidate roster
requires matching evidence to be regenerated. Successful engineering fixtures do
not release automatic chains.

## Numerical demonstrations

Live domain verifiers use isolated NVIDIA Ultra role routes through Nightshift:
`nvidia/nemotron-3-ultra-550b-a55b`. They do not change `.env`, saved application
routes or existing task grants. Reports retain charged attempts, actual model
calls per role (including zero calls for deterministic specialists), exact
artifact references, independent reviews and restart results. Accepted model
receipts must name the exact requested model and cannot be synthetic.

For PM2.5, supply a location and an end-exclusive UTC period that exists in the
configured Zetaris source:

```powershell
npm run build
node --env-file-if-exists=app/adapters/zetaris/.env.local --env-file-if-exists=.env scripts/verify-general.mjs --live Klang 2026-10-27T00:00:00Z 2026-10-27T03:00:00Z
```

This also exercises source synthesis and World Model acceptance/hold behavior.
The PM2.5 check requires retained Zetaris query/raw rows, a selected analysis,
an independent numerical review and a rendered answer. Availability of the
source and complete coverage remain separate from transport reachability.

For damage accounting, use an existing `haze.damage.import.v1` JSON input:

```powershell
npm run damage:verify -- --live C:/data/damage-inputs.json
```

A live pass requires a complete declared account with physical outcomes,
financial incidence and welfare totals, independent review, genuine model
receipts and restart readback. Partial accounts and omissions remain in the
report; they do not qualify as a complete live demonstration. Synthetic inputs
are refused by the live verifier. Arithmetic does not establish scientific
applicability.

## Supplied planning package

The live planning verifier accepts a small transport envelope around existing
target, residual and candidate contracts. It never creates quantities from raw
PM2.5 or estimates missing costs or intervention effects.

```json
{
  "schema_version": "haze.reduction.live-package.v1",
  "target": "an object matching reductionTargetSchema",
  "candidate": "an object matching reductionCandidateSchema",
  "sources": [
    {
      "name": "residuals",
      "input": "a supplied haze.reduction.physical-import.v1 object",
      "row_ids": ["baseline-row-id", "intervention-row-id"]
    }
  ]
}
```

The quoted descriptions above are schema placeholders, not runnable data.
Contracts live in [damage-reduction.ts](../../app/contracts/damage-reduction.ts)
and [damage-reduction-plan.ts](../../app/contracts/damage-reduction-plan.ts).
Every selected row must exist, match the target scope and declare a quantity.
Both baseline and intervention rows are required. Origins must be `supplied`.
Keep candidate evidence arrays empty in this self-contained envelope: references
from an unrelated state database cannot resolve inside the isolated verifier.
The plan retains declared unknown costs, approvals and other prerequisites.

Validate declarations without starting a server or making model calls:

```powershell
npm run planning:verify -- --inspect C:/data/planning-package.json
```

Run the genuine-model workflow explicitly:

```powershell
npm run planning:verify -- --live C:/data/planning-package.json
```

The verifier imports supplied residuals first, constructs exact artifact
references, imports the operator selection, checks compatibility using the
existing exact-arithmetic method, then admits the conditional planning task.
It verifies the current arithmetic and plan reviews and stable restart readback.
A fully completed conditional preview can pass while scientific and human
prerequisites remain visible; it never proves delivery or achieved reduction.
Blocked/incomplete outputs remain retained and do not pass the demonstration.

Reports are saved under the configured state directory in
`general-verification/`, `damage-verification/` and
`damage-planning-verification/`, each in a fresh run directory. Failed live
attempts are retained. An inspection pass proves package declarations only.

## Release evidence

Follow [Nightshift automatic-chain verification](nightshift-automatic-chains.md)
for the bounded cloud lifecycle verifier and production release evidence.
The isolated provisional verifier cannot publish production evidence. Real
domain demonstrations, frozen role evaluation, separate review of exact output
hashes and all remaining release gates are still required.
