# DamageAccountant implementation report

The subsequent [World Model input adapter](world-model-damage-input-adapter-report.md) replaces the required user-upload intake with a request-only page and governed evidence retrieval. The imported-source path below remains available for compatibility and fixture verification; the numerical and scientific limitations still apply.

DamageAccountant is registered as a fifth specialist under Manager, with a versioned imported-input accounting capability. It produces physical outcomes, financial incidence and selected social welfare from exact retained JSON or CSV inputs, then submits the manifest and components to EvidenceCritic for independent reconstruction. Empirical regional estimation remains gated on the scientific inputs and applicability evidence described in the [implementation plan](../architecture/damage-accountant-plan.md).

Implemented on 25 October 2026 against the existing Manager v4 working tree. Existing uncommitted Manager, runtime, contract and workspace work was preserved. The pre-change focused Manager and runtime baseline passed 56 tests, including the corrected scope hold and resume behavior; the correction failure described in the plan did not reproduce on this baseline.

## Registration and execution

`app/agents/damage-accountant/` defines `damage-accountant.v1`, bounded instructions and the existing validated specialist loop. `app/composition.ts` registers the agent, `damage-account.v1`, deterministic assignments and four typed tools. No extra specialist slots, task concurrency or aggregate resource budgets were added. The generic task envelope and persistence format remain v3.

The optional starting plan contains five assignments:

| Assignment        | Role             | Result                                                                                                                                                        |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `damage.collect`  | HazeOps          | Reads exact authorized imports and saves the normalized input manifest. Invalid or missing data produces a focused question.                                  |
| `damage.scope`    | DamageAccountant | Binds event, country, population, period, comparator, price basis and approved methods to those imports. Conflicting corrections require new matching inputs. |
| `damage.compile`  | DamageAccountant | Publishes physical, incidence, welfare, coverage, overlap, methods, scenario and source-fire extension records.                                               |
| `damage.assemble` | DamageAccountant | Publishes an account manifest with exact component references and actual envelope dependencies on completed component outputs.                                |
| `damage.check`    | EvidenceCritic   | Independently reconstructs components and selected totals from original retained imports, then reviews the exact manifest and components.                     |

Routing gives account construction and appraisal precedence over PM2.5 matches. Explanatory questions about accounting reports still use evidence synthesis. Fixture selection remains generic, and the configured Manager receives the same capability cards, definitions and optional templates.

The typed `damage.read-input`, `damage.calculate`, `damage.reconcile` and `damage.check` tools accept exact source references and approved method IDs. They read retained numeric inputs rather than accepting model-generated copies, formulas or executable code. Task permissions, cancellation, deadlines, charged attempts and resource limits continue to use the existing runtime.

## Contracts and calculations

`app/contracts/damage-account.ts` contains browser-safe versioned schemas. Domain implementation is under `app/capabilities/damage-account/`: `inputs.ts` normalizes imports, `scope.ts` checks compatibility, `methods.ts` produces component records, `checker.ts` reconstructs independently, `publication.ts` implements explicit account revision decomposition, and `fixtures.ts` freezes invented reference cases.

Inputs retain event and source boundaries, countries, population support, separate emissions and effect periods, valuation date, endpoint, scenario and baseline IDs, native units, causal methods, applicability limits, uncertainty interpretation, accounting lens, overlap selection and exact source references. Import manifests retain table types and selected row indexes. The importer enforces existing artifact bounds; larger tables require bounded partitions rather than a new unbounded transport.

The producer validates supported method IDs, unique identities, source hashes and versions, scope compatibility, units, currency, price year, horizon, coverage, valuation components and overlap groups. It reconciles financing shares to one resource cost and records both payer and recipient for each transfer. Internal transfers cancel within the declared social boundary; cross-boundary incidence remains explicit. Financing totals are a separate view and are not added again to resource welfare loss.

Physical expectations retain fractional values. Available values, true zero, unavailable values, unestimated categories, inapplicable categories and disclosure suppression have separate statuses. Missing quantities remain null. Sensitivity ranges and statistical intervals retain their declared interpretation. Missing harm is not folded into a quantified parameter interval.

Scenario comparisons distinguish source removal from imported project residual outcomes. Project costs, net social benefit and benefit-cost ratios use declared compatible inputs. Incomplete scenario coverage withholds benefits. Social benefit carries no cash-return claim. Source-fire assets, crops, peat, ecosystems and climate are always represented, with unsupported categories explicitly unestimated.

The optional registered `damage.revision-bridge` and `damage.revision-check` assignments require explicit previous/current account references and their original input references. They decompose changes into quantities, coverage, methods, unit values and boundary/incidence, with independent reconstruction and warnings for price-basis changes. They do not silently reuse stale account evidence. The Manager must explicitly pin and assess prior evidence before selecting this branch.

The checker shares schemas and parsing utilities but imports no producer valuation, compilation, reconciliation or revision arithmetic. Arithmetic support explicitly retains `not_established_by_arithmetic` for scientific applicability. Review artifacts are created after production; producer hashes are not mutated and dependency cycles are not introduced.

## Runtime and presentation

Generic finalization now validates every artifact in the exact transitive dependency closure. Each hop must resolve to the correct version/hash, have current applicability, have a valid current producer revision and satisfy any registered review requirement. A supported manifest cannot conceal an unreviewed, rejected or held component. Review checks remain available in the final result for individual artifacts. Tool contexts expose the exact assignment revision so review content identifies its actual reviewer revision.

Manager context compression keeps advertised workflows within the original model input bound as the registry grows. It preserves the original objective and exact corrections while reducing optional metadata and retaining usable references and review evidence. These are generic engine changes; accounting-specific parsing and arithmetic remain outside task admission and persistence.

The damage interface is isolated on `/damage-account`, with saved-account links at `/damage-account/TASK_ID`. The page imports inputs, starts or restores tasks, exposes controls and corrections, and renders server-produced account views, scope, coverage, origin, uncertainty, exclusions, omissions and exact source/component references. Headline values require supported exact numerical reviews. Stale and rejected products remain auditable. Its separate saved-task key prevents accounting tasks from replacing the dashboard's active task.

Following UI feedback, the damage panels were removed from the shared WorkProducts component and the original six-agent office/display registry was restored exactly. Existing Manager workspace and per-artifact review behavior were preserved. The accounting route loads its rendering code separately; the original dashboard, header and route presentation were not redesigned. The server-side DamageAccountant role and accounting capability remain registered.

## Input and verification commands

JSON uses `haze.damage.import.v1`, with one declared `scope` across the selected files and bounded `effects`, `unit_values`, `incidence`, `coverage`, `scenarios` and `source_fire_categories` tables. Tables can be partitioned across imported JSON files, but each combined normalized input and component must still fit the existing 1 MiB artifact bound. Larger studies require bounded linked runs; arbitrary dataset-size manifests are not implemented. CSV has exactly `schema_version,table_type,record` columns; `record` is a quoted JSON object for its typed table. It is not an arbitrary spreadsheet or formula format. PDFs and spreadsheets are not accounting imports.

The schemas are authoritative for required fields. `createSyntheticDamageImport()` in `fixtures.ts` supplies a complete development example; it is never inserted automatically into a missing-input task.

Use pinned Node 24.22.1 and npm 11.8.0:

```sh
npx vitest run --project unit tests/unit/damage-account-methods.test.ts tests/unit/damage-account-runtime.test.ts
npm run damage:verify -- --fixture
npm run damage:verify -- --live path/to/admitted-input.json
npm run check
```

The process verifier imports through the HTTP API, checks duplicate admission, captures exact artifacts, events and attempt receipts, restarts the server and compares persisted readback. Reports are written under `.state/damage-verification/`. The live command uses the configured Manager and preserves the admitted input's original evidence status; a real model with synthetic inputs does not qualify empirical data or scientific methods.

## Verification results

`npm run check` passed with Node 24.22.1 and npm 11.8.0. It completed source pin verification, repository formatting, both backend TypeScript projects, ESLint, backend build, 306 backend unit tests across 24 suites, 21 upstream engine conformance checks, frontend production build, 119 frontend tests across 18 suites and both fresh-process fixture verifiers. The frontend build retains nonfatal chunk-size and ineffective dynamic-import warnings.

The focused damage suites contribute 40 domain/tool tests and 13 registration/runtime cases. They cover known answers, project costs, missingness, withheld benefits, true zero, overlapping valuation paths, incompatible units and monetary bases, financing and transfers, source/version/hash tampering, typed-tool boundaries, revision decomposition, routing precedence, missing inputs, conflicting corrected geography, cancellation, tool exhaustion, duplicate delivery and restart. Generic runtime regressions reject supported manifests hiding unreviewed or rejected components, wrong dependency versions/hashes and held applicability. Existing general tests exercise permissions/revocation, rejected-review repair, unknown charged outcomes and non-damage extensions.

The first complete check caught a context failure with the process verifier's longer objective after the shorter unit case had passed. The exact longer objective is now a regression case; context compaction was corrected without increasing budgets. Final fixture evidence is retained locally:

| Evidence                                                 | Result                                                                                                                                                                                 | Local report                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| General explanation and PM2.5 HTTP tasks                 | Passed, duplicate delivery and fresh-process readback verified                                                                                                                         | `.state/general-verification/fa17d526-1b5a-4967-8daf-620d09b4ad0a/report.json` |
| Imported synthetic damage account                        | Passed, exact component closure independently reviewed, manifest selected, duplicate delivery and fresh-process readback verified                                                      | `.state/damage-verification/aff79294-8879-4217-a9a1-9dd0674cc677/report.json`  |
| Configured model with admitted synthetic JSON, first run | Real provider receipts captured; Manager selected the complete registered damage workflow, then a later response reached the 1,200-token output limit and failed completion validation | `.state/damage-verification/67e2f62c-110b-4fa9-a563-e3095765df7c/report.json`  |
| Configured model after context correction, separate run  | Real provider receipt captured; invalid coordination participants/revisions failed strict UUID/revision validation before plan admission                                               | `.state/damage-verification/d5417e6d-ee02-4779-987b-cf1c9cb4cde6/report.json`  |

The configured provider was `nvidia/nemotron-3.5-lightning-30b-a3b`. Neither configured-model run passed the complete account flow, and neither used empirical data. Failed outputs and charges remain in the trace; no fixture fallback, budget increase or live-readiness promotion was applied. The imported accounting task path is fixture-verified, while reliable configured-model completion remains a release gate.

Earlier browser DOM checks verified the three account views. Desktop/mobile screenshot and viewport verification could not complete because browser screenshot/device calls and subsequent reconnects timed out. No completed visual-viewport acceptance is claimed. Temporary preview files were removed.

### UI separation correction

The accounting UI was subsequently moved to its own lazy-loaded `/damage-account` page after user feedback. The original six-actor office and shared display registry match their pre-accounting versions exactly; the existing Manager workspace remains intact. Shared work products no longer render accounting tables or component trees inline. The new page provides JSON/CSV import, account creation, saved-task access, exact review objections and correction controls with its own task-selection key.

The local task API had inherited `STATE_DIR=.state`, an incompatible archive directory. Vite now accepts a task-only `HAZE_TASK_STATE_DIR` override, configured locally as `.state/general-v1`; the dashboard's original state setting and archives were preserved. Browser testing confirmed that a labelled synthetic JSON import succeeds, the build action enables, and removing the test attachment returns the page to a clean state without starting a model run.

The frontend production build and all 124 frontend tests across 19 suites pass after separation, including five new page regression tests and task-only storage tests for dev and preview servers. Browser DOM inspection confirms the original six office actors and no accounting panel on `/`, while the new route has its own accounting controls and no document overflow at the observed 1,528-pixel width. Independent review found no blocking code/DOM regression; screenshot-based visual verification remains unavailable because capture requests time out.

The frozen invented example uses 9.7170167 imported expected deaths. It reproduces CU21,534,033.40 historical selected loss, CU4,570,000 avoided damage, CU1,000,000 project cost, CU3,570,000 net benefit and a 4.57 benefit-cost ratio. CU is invented currency; these are software test expectations rather than a regional damage estimate or health-response parameter.

## Remaining release gates

The empirical pilot requires reviewed actual/no-target-fire concentration or validated source-apportionment fields, matched populations, baseline incidence, endpoint-specific response functions, priority sector data and scientific applicability review. The implementation does not supply missing coefficients, external source access, currency conversions, discounting, correlated probabilistic uncertainty propagation or legal findings. Substitution, deferred activity, catch-up and residual equipment values must be reflected in the imported incremental quantities and declared method assumptions; this release does not estimate those adjustments from raw sector observations.

Broader source-fire, ecosystem, climate, chronic-health and accountability modules need their own reviewed methods and release evidence. World Model acceptance, external publication and effects, memory capture and monitoring retain their existing disabled status. The legacy revenue-report route was not redirected to DamageAccountant, so its copy was not changed to imply an accounting integration it does not have.
