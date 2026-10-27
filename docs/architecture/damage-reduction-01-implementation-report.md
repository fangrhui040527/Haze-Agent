# Plan 01 implementation report: imported scenario assessment

Recorded: 27 October 2026 (Asia/Singapore).

Plan 01 now has a working engineering implementation: an admitted task retains
an explicit original-input selection, compares supplied physical residual damage
using exact decimal arithmetic, saves an independent reconstruction, and reopens
the saved records after a fresh API process restart. Scientific qualification
remains **unqualified**. No non-synthetic reference case, scientific-owner
applicability review or configured damage-reduction live-model trace was supplied
or established. The follow-up below records a general live retry and current
repository checks; it does not change scientific qualification.

## Changes

| Plan requirement                    | Implementation                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser-safe bounded contracts      | `app/contracts/damage-reduction.ts` defines physical imports, target/scope, exact selection, assessment and review. Baseline/intervention role is independent of prospective/retrospective evidence basis.                                                                                                                              |
| Immutable explicit numerical inputs | HazeOps saves `reduction.input-selection` with exact original artifact versions/hashes, selected row IDs, target/scope hash and method/version. The selection tool binds it to the current operator-declared request scope.                                                                                                             |
| Narrow physical import adapter      | `inputs.ts` reads only selected originals and rows. It retains decimal strings, scenario identity, endpoint/unit, population, geography, pollutant, period, coverage, missingness, exclusions, source method/version, applicability and synthetic provenance.                                                                           |
| Exact registered comparison         | `methods.ts` implements `reduction.imported-residual-comparison.v1` using bounded integer arithmetic, exact aggregation and threshold multiplication. It retains signed absolute differences and exact ratio components.                                                                                                                |
| Independent reconstruction          | `checker.ts` independently reads original selected inputs and reconstructs compatibility, totals, reason codes and threshold decisions. It imports neither producer arithmetic nor the producer import adapter. Reviews bind exact selection/output references and a separate reviewer assignment.                                      |
| Existing task/runtime integration   | `index.ts` registers HazeOps `reduction.select`, DamageAccountant `reduction.assess` and EvidenceCritic `reduction.check`. `app/composition.ts` supplies the capability and governed tools. Existing Manager coordination, admission, grants, two specialist slots, resource ceilings, artifact persistence and controls remain in use. |
| Repeatable verification             | Focused method/import, checker and task suites plus `scripts/verify-damage-reduction.mjs`. `npm run reduction:verify` builds and runs the synthetic restart trace; the integration command includes it.                                                                                                                                 |

The [method specification](damage-reduction-01-method-spec.md) records the
input/output rules and independently expected synthetic results before
implementation. The [capability guide](../../app/capabilities/damage-reduction-planning/README.md)
describes request construction and saved work products.

`claims.ts` provides the read-only `reduction.read-claim` tool. A saved review's
eligibility flag records the time of review; current eligibility rechecks exact
dependency access, applicability, grants, active holds, registered producer and
reviewer revisions, and independent reconstruction. Stale, inaccessible or held
support returns `none`. The [current-claim guide](damage-reduction-01-current-claims.md)
documents this distinction. Qualified and achieved claims are never enabled.

The generic assignment artifact service now accepts an optional exact material
dependency list, bounded to pinned inputs or the assignment's own saved outputs.
Existing callers retain their default behavior. Reduction artifacts use the
selected originals and their exact selection/assessment lineage, so unrelated
context does not enter arithmetic or unnecessarily invalidate current numerical
eligibility. The shared runtime still owns access, charges and persistence.

One incidental compile correction adds the missing empty `fleets` option to the
existing unconfigured Nightshift readiness default. Its behavior remains
unconfigured; this satisfies that work's declared response schema.

Compatibility requires an exact shared physical scope, a single comparator and
intervention, compatible original method/version and evidence basis, matching
strata/support across roles, and disjoint declared atomic support within each
role. Source hashes, duplicate/conflicting sources and row IDs, absent selected
rows, synthetic-origin conflicts and unsupported formats produce explicit gaps
or incompatibilities. Unselected evidence never supplies numerical quantities.

Inputs require canonical decimal strings with at most 18 significant digits and
12 fractional places. Intermediate integers are bounded to 128 decimal digits.
The inclusive threshold is `difference >= fraction * baseline`; the explicitly
strict relation uses `>`. No rounded percentage, binary floating-point total or
epsilon decides the result. Previously aggregated v1 numeric accounting totals
cannot be laundered through this physical-decimal path. Existing v1 monetary
accounting records and validators were not migrated.

Unknown quantities stop arithmetic. Zero/negative baselines and invalid residual
quantities leave the percentage and target conclusion unavailable; meaningful
absolute differences remain visible when both quantities are known. A missing
selection saves `reduction.input-gap` and dependent assignments finish with an
honest gap. Incompatible original scope saves an incompatible assessment and an
independently reviewed explanation. Runtime resource failures retain the existing
execution outcome; completing a task does not convert a gap into support.

## Original implementation verification evidence

The final fresh-process fixture passed against a successful normal build and
retained its complete report at:

`.state/damage-reduction-verification/19a2f727-72eb-49fb-9f8f-9f05a208deaf/report.json`

Its supported admitted task was `8a9ab9ec-3c34-4d6e-869f-7d576b6c10e4`.
The saved result was baseline `1000`, intervention `880`, difference `120`, exact
ratio `120 / 1000`, and an inclusive 10% target met. The saved assessment and
independent review were unchanged after stopping and restarting the API process.
The same trace checked duplicate admission, unrelated-context isolation, a
missing-selection gap, an unknown-quantity gap with a saved assessment and
independent review, and incompatible scope, including exact task/artifact/event
restart readback for all four cases. Unselected references are absent from every
reduction artifact's material dependency list.

| Fixture                       | Latency | Model calls | Tool calls | Charged artifacts |
| ----------------------------- | ------: | ----------: | ---------: | ----------------: |
| Supported supplied comparison | 1303 ms |           0 |          3 |                 6 |
| Unknown selected quantity     |  968 ms |           0 |          3 |                 6 |
| Missing selection             |  680 ms |           0 |          0 |                 4 |
| Incompatible scope            | 1054 ms |           0 |          3 |                 6 |

The supported trace used four assignments including Manager, 16,877 bytes of
serialized artifacts and a 1,634-byte serialized request. These are fixture
measurements, not live-model cost or operational capacity evidence. The contract
ceilings of 16 originals, 1,000 selected rows and 512 KiB normalized input are
representation bounds; a maximum live bundle has not been qualified.

Focused verification passed **88 tests** across method/import, checker,
current-claim and admitted-task suites. This covers `0.3 → 0.27`, strict/equal thresholds,
`1000 → 900.000000000001`, worsening damage, invalid baselines, signed quantities,
precision/overflow guards, exact aggregation, overlap/scope/method conflicts,
wrong sources/hashes/rows, unselected malformed rows, v1 precision laundering,
synthetic origin, fabricated gap reasons, producer disagreement, self-review,
operator-selection substitution, claims, tool ceilings and restart readback.
Real-store claim checks cover source holds and release, source applicability,
permission revocation, historical review immutability and unrelated held context.
The generic material-dependency guard rejects unpinned artifact references.
The full unit regression run, `npm test -- --maxWorkers=4`, passed **738 tests
across 67 files**. This includes existing accounting, PM2.5, task/runtime,
correction and World Model checks. ESLint passes for all new source/test files,
composition and the shared runtime/port changes. `git diff --check` passes.
The existing monetary-accounting fresh-process fixture also passed, including
exact selection, independent review and restart readback. Retained report:
`.state/damage-verification/fa4fa882-48e4-46c1-b5dc-d0da58183084/report.json`.

`npm run build` passed. The original `npm run check` stopped at pre-existing
formatting in four files beneath `tools/damage_data_discovery/`: `CRAWLER_CAPABILITIES_AND_DATA_GAPS.md`,
`DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md`, `PILOT_READINESS_MATRIX.md` and
`seed_sources.json`. A follow-up on 27 October 2026 formatted those four files;
`npm run format:check` passed at that point. A separate full typecheck previously
reported Nightshift test errors concerning mock return types
(`truncated: boolean` versus `false`, and an untyped submission promise). Those
files are outside this implementation.

The current follow-up below supersedes those repository-wide check results; the
earlier Nightshift type errors were not reported by its backend typecheck.

The general fixture verification was attempted with the repository's environment
loading command. General task/restart/hold behavior completed, but PM2.5 source
execution failed its readiness gate because the admitted specialist route had
no live inference provider; the report remains unverified. This does not qualify
live model/source behavior for this capability. Retained general report:
`.state/general-verification/23e46dd5-2d42-4c68-ba4e-85149027f3eb/report.json`.

## Follow-up live retry, 27 October 2026

A fresh `npm run build` passed. The configured retry used:

```powershell
node --env-file-if-exists=app/adapters/zetaris/.env.local --env-file-if-exists=.env scripts/verify-general.mjs --live Singapore 2026-10-01T00:00:00Z 2026-10-01T03:00:00Z
```

This invocation exited 1. The previous missing-provider condition did not recur:
two actual NVIDIA responses returned HTTP 200 with `stop`, one per admitted task.
The synthesis task failed `invalid_citation` because its final source references
did not match the exact selected originals. The PM2.5 task failed before
specialist execution because the Manager's `coordinate` action supplied four
participants against a maximum of two, non-UUID assignment IDs and a purpose
longer than 256 characters. Both tasks retained zero tool calls and zero
artifacts. Provider transport worked; source execution and end-to-end live
verification did not pass.

The harness then raised its existing "fixture synthesis did not produce an
acceptance" assertion, including when invoked with `--live`. It did not reach
restart assertions or write its normal `report.json`. A read-only reconstruction
of persisted tasks, errors, usage and provider receipts is retained at:

`.state/general-verification/dbcaa018-9431-4216-b873-e079f4a6c91a/retry-summary.json`

The separate general `--fixture` control exited 2 with `passed: false` and
`readiness: unverified`. Its restart, acceptance and hold checks passed, but its
PM2.5 assignment rejected an unrecognized top-level `save_tool_result` action
field. It made eight configured inference calls and five synthetic retrieval
calls without saving a `pm25.capture`. Its report is:

`.state/general-verification/d5a8e749-1f15-46fb-90e4-458d8c7159bd/report.json`

Next live-verification work is to correct and verify exact-source citations and
the Manager/specialist action shapes, then repeat the admitted source workflow
and restart checks. No source, configuration, credential or claim gate was
changed by this retry. The damage-reduction verifier itself always starts a
fixture process; a separate configured admitted damage-reduction trace is still
needed to establish live behavior for this capability.

## Follow-up repository verification, 27 October 2026

`npm run check` was rerun and exited 1: engine pins passed, then formatting
failed. Its current formatting findings are `scripts/dev-commands.mjs`,
`scripts/dev-config.mjs`, `scripts/dev-console.mjs`, `scripts/dev-process.mjs` and
`scripts/dev.mjs`. The four discovery files from the original report were not
reported again.

Because that command stops at its first failure, remaining stages were executed
separately. The integration subcommands used the fresh successful build and
continued after individual failures to expose the remaining results; this is
not a passing `npm run check` or aggregate integration run.

| Check                                             | Observed result                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend build                                     | Passed.                                                                                                                                                                                                                        |
| Backend typecheck                                 | Failed: `tests/unit/dev-api.test.ts:230`, TS2379, explicitly assigning `RequestInit \| undefined` to an optional `RequestInit` property under exact optional-property rules. The previous Nightshift errors were not reported. |
| Zetaris typecheck, run separately                 | Passed: `tsc -p tsconfig.zetaris.json`.                                                                                                                                                                                        |
| Repository ESLint                                 | Failed: nine errors in `frontend/scripts/dev-display-plugin.test.ts` (one `require-await`, eight `unbound-method`).                                                                                                            |
| Backend unit suite                                | Failed: **1,076 passed, 8 failed**, across **93 passed files and 1 failed file**, in 591.20 seconds. All eight failures were 40-second timeouts in `tests/unit/damage-reduction-pilot-integration.test.ts`.                    |
| Route tests                                       | Passed: **38/38**.                                                                                                                                                                                                             |
| Engine conformance                                | Passed after build: **H-MEM 13/13, World Model 8/8**.                                                                                                                                                                          |
| Frontend production build                         | Failed: `frontend/scripts/dev-display-plugin.test.ts:48`, TS2345, incompatible mock callback signature. The chained frontend tests were therefore run separately.                                                              |
| Frontend unit tests                               | Passed: **288 passed, 1 skipped**, across **40 passed files, 1 skipped file**.                                                                                                                                                 |
| Plan 01 reduction fixture                         | Passed, including exact restart readback.                                                                                                                                                                                      |
| General fixture                                   | Unverified, exit 2; action-shape failure described above.                                                                                                                                                                      |
| Monetary-accounting fixture                       | Failed on the original attempt and one sequential retry: `ECONNRESET` at `scripts/verify-damage-account.mjs:140` during the duplicate admission POST.                                                                          |
| Conditional-preview fixture                       | Failed on the original attempt and one sequential retry: `ECONNRESET` at `scripts/verify-damage-reduction-preview.mjs:313`.                                                                                                    |
| Programme, pilot and external-evaluation fixtures | All passed, including their restart checks. These later-plan fixtures do not replace the failed unit suite or establish scientific qualification.                                                                              |
| Crash verification                                | Passed all four cases on retry. The first attempt failed to import `dist/tasks/runtime.js`; that file was present again before the successful retry. The cause of its temporary absence was not established.                   |

The unit suite completed naturally. Its timeout locations were lines 482, 536,
596, 635, 764, 866, 997 and 1127 of the pilot integration suite. Other checks ran
concurrently, so these observations do not distinguish load sensitivity from a
reproducible isolated failure; an isolated pilot-suite rerun remains a diagnostic
next step. No unit pass count from the original implementation was inherited.

Checks ran with **Node 24.11.0 and npm 11.8.0**. The repository declares Node
**24.22.1** in its package metadata, `.node-version` and `.nvmrc`; these results
do not qualify the declared Node version. No runtime installation was changed.

Command logs, exit metadata, original failures and retry evidence are retained
under `.state/damage-reduction-followup/2026-10-27-recheck/`, especially
`check.log`, `typecheck.log`, `lint.log`, `frontend.log`, `frontend-tests.log`,
`unit-final.log`, `routes.log`, `engines-final.log`, `integration-stages.json`
and the `*-retry` logs. Earlier pre-build unit/engine attempts in that directory
are diagnostic only; the final results above use `unit-final` and
`engines-final` after successful vendor generation.

The new Plan 01 report is:

`.state/damage-reduction-verification/2283bc1a-fd0e-47a1-8ecb-29fdc55d8019/report.json`

Later-plan fixture reports are:

- `.state/damage-reduction-programmes-verification/2ed323ab-f28a-4612-a39f-c3725ba9d2fb/report.json`
- `.state/damage-reduction-pilot-verification/074846e9-0b24-46d7-b5e8-5c1eb71558de/report.json`
- `.state/damage-reduction-evaluation-verification/3ecebc1a-d01a-437a-bf45-47cd3d5269d8/report.json`

The passing crash retry report is:

`tmp/langgraph-crash-verification/1bf14da6-0c89-4349-bca1-306a4c85be66/report.json`

## Remaining qualification and scope

The strongest available result is an **arithmetic-checked scenario** with a
point-estimate target decision. Synthetic origin remains visible. Arithmetic
review cannot establish a qualified prediction, robust uncertainty conclusion,
live delivery, achieved reduction or World Model acceptance. The scientific
owner must supply a named non-synthetic reference case, independently expected
results and an applicability review before operational qualification advances.

Conditional planning, WorkerShield planning work, action previews, programme
coordination, delivery, monetary targets, raw-data effectiveness estimation and
external evaluation are outside Plan 01. Subsequent engineering work is recorded
in the [Plan 02](damage-reduction-02-implementation-report.md),
[Plan 03](damage-reduction-03-implementation-report.md),
[Plan 04](damage-reduction-04-implementation-report.md) and
[Plan 05](damage-reduction-05-implementation-report.md) reports; this report does
not assign them operational qualification.

## Proposed work to close qualification gaps

The scientific reference steps remain proposed. The engineering follow-up below
implements sensitivity diagnostics and capacity checks; scientific and
configured live-model qualification remain separate gates.

### Scientific reference and applicability

1. Name a scientific owner and select one real reference case for one physical
   endpoint, comparator, intervention and bounded population/geography/period.
   A candidate to investigate is the
   [EPA 2024 PM2.5 final regulatory impact analysis](https://www.epa.gov/pm-pollution/final-reconsideration-national-ambient-air-quality-standards-particulate-matter-pm),
   comparing its projected 2032 baseline and revised-standard scenario. Compatible
   residual exports have **not** been acquired or confirmed. This regulatory
   scenario would not establish applicability to local digital alerts or work
   scheduling.
2. Obtain source-owner-approved original exports of both residual physical-damage
   quantities with matching scope, endpoint/unit, evidence basis, source
   method/version and strata/support. Retain native decimal tokens, provenance,
   missingness and exclusions. An avoided-incidence difference or rounded
   percentage alone cannot supply the required pair; obtain compatible residual
   outputs or select another case.
3. Freeze independently calculated expected baseline/intervention totals, signed
   difference, exact ratio and target decision before running this implementation.
   The external calculation/reviewer must be independent of both repository
   arithmetic implementations. The reference need not meet the target.
4. Have the scientific owner review assumptions, source validity, transferability,
   endpoint interpretation, uncertainty and exclusions, and retain the intended
   use, reviewer identity/conflicts, decision and unresolved conditions.
5. Replay admission, exact selection, assessment, independent review, restart and
   current-claim readback against that package. Acceptance requires agreement with
   the frozen results and the applicability review. Exact reconstruction checks
   exported numbers; it does not establish the scientific model's accuracy.

The case and review can close a reference-validation prerequisite. Qualified and
achieved labels remain disabled in the Plan 01 path; enabling any stronger claim
requires its own implemented and verified qualification/claim gates.

### Uncertainty

Obtain paired baseline/intervention scenarios or simulation draws from the
external scientific method, preserving shared assumptions and dependence.
Predeclare whether the decision is a sensitivity exercise across a stated
plausible set, an uncertainty-bound criterion or a probability criterion. Review
exposure, response-function, population/incidence and transferability assumptions
as applicable. Covariance matters when combining uncertain quantities; see
[NIST's combined-uncertainty guidance](https://www.nist.gov/pml/nist-technical-note-1297/nist-tn-1297-5-combined-standard-uncertainty).

Initially retain this as an explicitly external linked analysis. Do not subtract
marginal interval endpoints and label the result a confidence interval, or treat
a sensitivity range as a probability. A robust/probabilistic target conclusion
needs a separately specified, registered and independently reviewed method and
contract; v1 remains a point-estimate comparison.

### Capacity

Predeclare deployment latency, memory and cost acceptance limits, then exercise
valid bundles at 2/8/16 originals and 2/100/500/1,000 total selected rows, plus
near/at 512 KiB of **normalized selected input**. Use 500 matched strata per role
for a compatible 1,000-row case. Isolate each limit in rejection tests at 17
originals, more than 1,000 selected rows and 512 KiB plus one normalized byte.
Measure normalized bytes rather than assuming raw JSON size is equivalent.

Repeat cold/warm runs at the supported concurrency; retain p50/p95 task latency,
peak memory, provider/model revision, input/output tokens, actual or unavailable
cost, model/tool calls, artifacts, persisted bytes and resource-limit outcomes.
Check producer/reviewer agreement, explicit over-limit gaps/rejections and exact
restart/current-claim readback. Advertise only the envelope that meets the
predeclared limits. Synthetic stress tests can qualify engineering bounds;
maximum live-model operation additionally needs measured configured live traces.

## Implemented engineering follow-up, 27 October 2026

The engineering parts of the uncertainty/capacity proposals now have working
implementations and new evidence. Scientific qualification remains unqualified.

### Supplied-pair sensitivity

`npm run reduction:sensitivity -- --demo` builds and runs an offline diagnostic;
`--input INPUT.json` accepts an envelope containing a bounded request and original
artifact snapshots. Each named pair retains its exact selected source hashes and
rows, passes through the existing exact comparison and independent reconstruction,
and must share scope, original method/version, evidence basis and support with
the other pairs. The diagnostic reports whether all, some or none of the
**supplied pairs** meet the target, or `incomplete` when a comparison is unavailable.
It never recombines separate baseline/intervention margins or estimates a
probability. Its report and input snapshots are saved together.

The retained synthetic example compares 100 to 88 and 100 to 95. Only the first
meets the inclusive 10% target, so the result is `some_supplied_pairs_meet`.
`probability_of_target` remains null, scientific qualification unqualified,
application claim eligibility none and achieved reduction false. Derived refs
and reconstruction IDs are local diagnostic identifiers; live permission,
applicability and hold checks are not supplied by this offline tool. A scientific
owner still needs to justify the real paired scenarios and their coverage.

Retained example:

`.state/reduction-sensitivity/2ebe8176-b5fe-4ca5-be86-894450385d30/report.json`

### Capacity fixes and verification

The first maximum-byte task exposed a real Manager-context bottleneck: repeating
a full selection in request scope and starting templates exhausted the existing
input budget before arithmetic began. The new assessment-only
`haze.reduction.selection-request.v1` scope pins the complete selection as an
exact original artifact. The selector resolves and validates that original,
retains the complete selection and numerical inputs, and includes the declaration
original in material dependencies. Current claims recheck it alongside numerical
sources. The declaration dependency comes from the server's current operator
scope, including when a Manager supplies equivalent inline input or another
pinned copy. Source/manifest holds and specialist substitution were tested. Existing
inline requests and all runtime resource ceilings remain supported unchanged.

Aggregate row-count guards now run before original numerical-row processing in
the selector, producer and independent checker. The oversized declaration can
be checked with only its selection original pinned. The final API test exercises
this path without supplying numerical originals; it saves an input gap with
`selected_row_limit_exceeded` and performs no numerical tools. Earlier attempts
that processed an oversized bundle exceeded the local 30-second test threshold;
the final declaration-only preflight completes in 1.415 seconds.

The byte and row ceilings apply together. The short-metadata 1,000-row fixture
uses **613,951 normalized bytes**, so its correct result is a byte-limit gap.
There is no promise that 1,000 arbitrary rows fit 512 KiB. The demonstrated
maximum-byte positive case contains **500 rows from 16 numerical originals**, plus
the pinned selection original, at exactly **524,288 normalized numerical bytes**.
Its independently checked totals are baseline 25,000, intervention 22,000 and
difference 3,000; the point estimate meets the inclusive 10% target.

The local acceptance limits remained fixed at 5 seconds per kernel iteration,
30 seconds per admitted task, 512 MiB kernel-process peak RSS and 1 GiB API-process
peak RSS. The first complete trace under **Node 24.22.1, Windows x64** recorded:

| Measurement                                              | Observed result                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Maximum-byte API tasks, three sequential runs            | 11.213, 11.360 and 11.263 seconds                                                                                                                            |
| Two outstanding maximum-byte tasks                       | Both captured within a common batch elapsed time of 29.140 seconds; this is a conservative upper bound for each task, not individual finish-time measurement |
| One normalized byte over the ceiling                     | Saved and independently reviewed byte gap in 11.466 seconds                                                                                                  |
| Oversized 1,002-row declaration                          | Input gap in 1.415 seconds; zero numerical originals pinned and zero tool calls                                                                              |
| Maximum-byte producer plus checker, five warm iterations | p50 125.22 ms, p95 144.81 ms; descriptive small-sample statistics                                                                                            |
| Kernel-process peak RSS                                  | 218,464,256 bytes, approximately 208 MiB                                                                                                                     |
| API-process peak RSS                                     | 334,622,720 bytes, approximately 319 MiB; restarted process peak 265,940,992 bytes                                                                           |
| Fresh-process startup samples                            | 2.547 and 2.406 seconds                                                                                                                                      |
| Positive maximum-byte task resource usage                | 0 model calls, 3 tool calls, 6 charged artifacts, 4 assignments                                                                                              |
| Persistence                                              | Exact task/artifact/event readback after a fresh API process restart for every saved case                                                                    |

Peak RSS uses Node's KiB high-water mark converted to bytes; see the
[Node resource-usage contract](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage).
The verifier uses fresh local connections and at most one recorded retry for a
transient reset/socket closure or HTTP 408, restricted to reads and the two
idempotent import/admission endpoints with the exact same key/body. Validation
and mathematical failures are not retried. That first complete trace recorded
**zero transport retries**. Earlier failed attempts remain in the follow-up logs.

Retained capacity report:

`.state/damage-reduction-capacity-verification/ff67accf-54a2-4919-9837-d950e9086874/report.json`

The two-outstanding result is close to the local latency threshold and is a
single batch, not a production throughput guarantee. The fixtures are synthetic;
configured live-model capacity/cost, cold-cache distributions and scientific
uncertainty qualification remain unestablished. No scientific or achieved claim
gate was enabled.

A subsequent rerun initially failed a conservative timing gate that included
post-completion artifact inspection in the common batch elapsed time. Its
persisted completion events show task durations of 28.454 and 29.970 seconds.
The verifier now measures `task_duration_ms` from task admission to the current
run's `task_completed` event, retaining client polling and inspection elapsed
time separately as `latency_ms`. The 30-second threshold is unchanged; any true
task-duration miss is retained as a performance failure. Both timing fields
remain visible in the report.

The final rerun after the operator-lineage fix passed, completed fresh-process
readback and reported no task-duration performance failures:

`.state/damage-reduction-capacity-verification/e0998ae0-a810-4221-9d36-12cbcaab6ae2/report.json`

| Final case                         | Persisted task duration |   Client polling/inspection elapsed |
| ---------------------------------- | ----------------------: | ----------------------------------: |
| Maximum-byte sequential run 1      |                11.139 s |                            11.638 s |
| Maximum-byte sequential run 2      |                11.432 s |                            12.290 s |
| Maximum-byte sequential run 3      |                12.238 s |                            12.889 s |
| One byte over the limit            |                11.456 s |                            10.830 s |
| Oversized row declaration          |                 1.264 s |                             1.550 s |
| Two outstanding admissions, task 1 |                10.088 s | 25.647 s common batch/audit elapsed |
| Two outstanding admissions, task 2 |                11.924 s | 25.651 s common batch/audit elapsed |

These are distinct server-event and client measurement bases, not interchangeable
latency estimates. Two outstanding client admissions do not prove parallel
execution. The final trace recorded one HTTP 408 admission replay with the same
idempotency key/body. Kernel peak RSS was 216,457,216 bytes; API peak RSS was
332,926,976 bytes (266,805,248 after restart). Startup samples were 2.304 and
2.399 seconds. The exact-byte kernel's five warm iterations had p50 139.22 ms
and p95 153.73 ms. All declared resource/memory thresholds stayed unchanged.

The sensitivity `--input` path also replayed the saved demo snapshots successfully:

`.state/reduction-sensitivity/9a8b766e-15f7-44de-a229-778afe8c2d39/report.json`

### Validation scope

Under pinned Node 24.22.1, **152 focused tests across nine files** passed,
covering existing arithmetic/import/checker/claim/planning/preview behavior plus
sensitivity, bounds, exact selection references, substitution rejection and
maximum-byte restart/hold checks. **Six HTTP-verifier tests** passed, including
same-key/body replay, bounded retries and non-retryable validation/response errors.
The normal application build, final backend `tsc --noEmit` and scoped source/test
ESLint passed. These focused results do not certify the whole repository.
The public sensitivity demo command and complete synthetic capacity/restart
trace passed. No global Node installation was changed; execution used
`npm exec --yes --package=node@24.22.1 -- ...`.

Focused logs and earlier capacity failures are retained under
`.state/damage-reduction-engineering-followup/`. The broader repository check and
unrelated pilot tests were not rerun in this engineering pass; their earlier
results above remain historical and are not replaced by the focused test count.
