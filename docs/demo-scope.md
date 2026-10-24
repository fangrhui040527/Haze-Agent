# Bounded demo scope and shared contracts

The reference is [Haze Agent Architecture v0.13](Haze_Agent_Architecture_v0.13.pdf), especially sections 1-3, 15, 19 and 23. The [review package](demo-contract-review.md) inventories the real code, interface handoffs, pending decisions and review checklist. The supplied [v0.8 HTML](haze-architecture-v0.8.html) and [compatibility spike](compatibility-probe.md) are historical context; their dates, scope and engine checks do not replace v0.13.

## Small demo boundary

Compare activity start times for one crew in `my-selangor-klang` over one common assessment horizon. Keep worker identities and assignments, activity identities, durations, locations, required services/quality, existing controls and resources fixed. Include every worker's complete occupancy, including real breaks, travel, setup and waiting. Only permitted start times move. No reassignment, overtime, new controls or displacement of required work outside the horizon is allowed.

The engineering case follows section 23: two fictional workers, 08:00-12:00 on 25 October 2026 in `Asia/Kuala_Lumpur`, inspection/maintenance/administration, and a 15-minute grid over native hourly information. Fictional constraints specify no required travel/setup for this case. They establish no real operating practice. The baseline and both alternatives use identical required work, with nominal and fictional `+20 ug/m3` sensitivity series. The office series is independently invented. The perturbation is not a forecast-error distribution or approved uncertainty treatment.

All records in the new [executable review fixture](../examples/demo-review/package.json) are immutable demo-local records bound to their actual canonical JSON hashes. The local harness is separate from canonical admission. It keeps `execution_surface=historical_harness`, `publication_status=publication_disabled`, null canonical head/epoch/publication references with reasons, and `recommendation_eligible=false`. Regeneration after changed fixture content produces a new digest; no demo-local record becomes accepted canonical authority. No workplace instructions or roster changes are produced.

## Reviewable interface package

The existing [planning](../app/contracts/planning.ts), [run request](../app/contracts/index.ts) and [result](../app/contracts/result.ts) remain the shared v2 envelope contracts. Supplemental [handoff contracts](../app/contracts/handoffs.ts) describe fictional evidence, scenarios, policy, local snapshots, drafts, planner inputs, calculation/check and WorkerShield inputs. The gate and operating attestations remain explicit local supporting records and human-review requirements, not executable acceptance services. Generated [JSON Schemas](../schemas/) are Draft 2020-12; Zod and application semantic checks remain authoritative for validation. A schema pass does not establish source suitability, human authority, scientific validity or canonical currency.

From the repository root after `npm ci`:

```sh
npm run build
npm run contracts:check
npm run demo:check
npm run inputs:check
npm run contracts:validate -- planning input_examples/v2/planning.json
npm run contracts:validate -- run input_examples/v2/run.json --surface historical_harness
npm run contracts:validate -- result output_examples/v2/result.json
```

`npm run demo:generate` deliberately regenerates the review package with a fresh timestamp and immutable ID namespace. `demo:check` replays the saved generation metadata, rebuilds its expected local trace in memory, resolves hashes, validates handoffs/results and runs a separate engineering checker. It traces the section 23 baseline, both alternatives, missing evidence and incomplete search. It does not execute WorkerShield, obtain human sign-off or publish anything. See the [review package](demo-contract-review.md) for exact interpretation.

The earlier [planning](../input_examples/v2/planning.json), [run](../input_examples/v2/run.json), [result](../output_examples/v2/result.json) and [demo record manifest](../input_examples/v2/demo-records.json) remain contract specimens. Their result was hand-authored, and their nonbaseline records include explicit placeholders. They are distinct from the new computed review package. `contracts:fixtures` refreshes only those older specimen bindings; it never accepts evidence or computes their result. `contracts:validate` validates a file without admitting a job; its `--surface` option is not a historical execution engine.

Three further modules make the fictional pack usable through one shared input boundary. [Input and evidence validation](../app/validation/index.ts) returns coded findings with JSON Pointers, affected record IDs and correction messages, and keeps malformed input, invalid operating semantics and a completed environmental insufficiency distinct. [The importer](../app/import/loader.ts) reads exact bytes, recomputes every hash, rejects stale references and hands Planner and independent Verification the identical pinned artifacts. [Evidence linkage](../app/evidence/linkage.ts) resolves each occupied worker/activity interval to the native hourly records behind it, with half-open boundaries, overlap durations, exact locators and transformation lineage. None of them accepts evidence, scores a schedule or grants operational eligibility.

```sh
npm run inputs:validate                                   # coded input diagnostics
npm run inputs:import                                     # deterministic import and pinned handoff
npm run inputs:links -- --case valid --scenario nominal   # native-interval evidence traces
npm run inputs:ledger                                     # every fixture case against its declared expectation
npm run inputs:negative                                   # re-derive the negative cases from the valid pack
```

Four negative cases are derived from the valid pack by documented transformation — missing baseline coverage, missing candidate coverage, flat pollution and an invalid baseline — each with new evidence revisions and hashes and a hand-declared expected outcome in [`input_examples/v2/negative/`](../input_examples/v2/negative/). The [sample data pack release note](sample-data-pack.md) carries the file manifest and hashes, the source notes for every invented value, the case matrix, the unavailable acceptance capabilities, the unresolved interface decisions and the permitted presentation wording.

`haze.canonical-json.v1` hashes UTF-8 JSON with object keys sorted by UTF-16 code units, array order preserved, and ECMAScript finite-number/string encoding. JSON input has a 1 MiB/64-level limit; duplicate keys, nonfinite numbers, coercion and unknown properties are rejected. Planning allows at most seven days, 64 workers, 64 resources, 128 locations and 256 activities with whole-minute `+08:00` timestamps. These are engineering limits, not operating thresholds.

## Implemented and pending

| Area                        | Delivered                                                                                                                            | Remaining boundary                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Scope and v2 envelopes      | Fixed-work scope, closed schemas, semantic validation and hash-bound specimens                                                       | Human scope/contract sign-off and authorized controlled import                                             |
| Engineering trace           | Section 23 local producer, separate numerical checker, workstream handoffs, valid and error examples                                 | General planner/search, production job admission and authoritative artifact services                       |
| Evidence and day-one gate   | Fictional records, exact local locators, explicit provisional findings                                                               | Ordinary operating case, timing rights, suitable decision-time evidence and qualified intended-use review  |
| Input and evidence checks   | Coded findings with pointers and affected IDs, occupied-coverage diagnostics, scoped candidate exclusions and derived negative cases | Authorized evidence acceptance, qualified applicability review and policy-driven required scenarios        |
| Controlled import boundary  | Deterministic byte-level import, recomputed hashes, stale-reference rejection and one pinned Planner/Verification handoff            | An HTTP admission surface, canonical epoch/head/publication and consumer adapters                          |
| Evidence linkage            | Native-interval traces with exact locators, overlap durations, transformation lineage and reported gaps                              | Planner and independent-checker consumption of those traces, and the evidence drawer that renders them     |
| WorkerShield                | Typed read-only investigation inputs against immutable local records                                                                 | Actual bounded tools/provider investigation, checked facts, controlled rendering and exact material review |
| Engines/persistence         | Existing pinned-engine and checkpoint compatibility spike                                                                            | v0.13 canonical accept/hold/publish/current-read/event and race/recovery proof                             |
| Human review and operations | Review checklist, provisional handoff roles and decision queue                                                                       | Named authorized reviewers, independent exact review, policy adoption and real operational gates           |

The existing `npm start` command still runs only the checkpoint metadata graph. Its numeric `schemaVersion: 2` is not a domain v2 workflow. The review fixture's producer/checker evidence is local engineering execution, not an agent run, canonical acceptance or occupational-hygiene review. An incomplete search retains a verified improving candidate without proving global optimality. Missing essential baseline evidence yields explicit insufficiency with null quantified results.

## Exclusions and sequence

Exclude regional damage modeling, health/monetary conversions, field-effect evaluation, broad monitoring, prevention/communication dispatch, new controls, reassignment, overtime, general peer protocols, extra providers and automatic memory synthesis. No member is contacted and no agreement is claimed.

Follow section 19's dependency order: reviewed contract freeze, independent calculation/fact checks, investigated/rendered material, exact independent review, then publication only after actual canonical proof. Day-one real-use evidence and canonical capability are separate findings. If real evidence is absent, record workplace usefulness as unverified and retain the historical delivery. The human decisions and remaining implementation gates are explicit in the [review package](demo-contract-review.md).
