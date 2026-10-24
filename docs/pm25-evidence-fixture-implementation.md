# Implementation: Fictional Hourly PM2.5 Evidence Fixture

This standalone checklist breaks down the Evidence & Inputs task for the root
Haze Agent project. Use Architecture v0.13 §§4-5, 17 and 23 and the existing
shared contracts. All records remain synthetic fixtures; they are not accepted
operational evidence, supported scientific uncertainty, or a basis for an
operational recommendation.

- [x] **Task 1: Define the reusable environmental evidence format.**
  - **Suggested commit message:** `feat(contracts): define environmental evidence fixture format`
  - Inspect the existing contract conventions and Architecture v0.13 §§4.1 and 4.3. The root `app/contracts` currently has no evidence-record contract; use the architecture's `haze.evidence.v2` record requirements rather than inventing an incompatible fixture shape.
  - Added strict `haze.evidence.v2` and `haze.environmental_series.v2` contracts for immutable evidence metadata and resolved location series, including stable identities/revisions, raw-byte references/hashes, source kind, provenance chain, tagged exact locators, time/unit/spatial fields, permitted uses, limitations, review/disposition links, and explicit reasons for nullable fields.
  - Registered both contracts in runtime validation and Draft 2020-12 schema generation. Added UTC/valid-interval checks, interval non-overlap checks and per-interval missing-value reasons.
  - Added focused contract tests. Synthetic source kind requires synthetic input origin; these structural formats do not themselves accept evidence or grant operational use.

- [ ] **Task 2: Encode the nominal hourly yard and office series.**
  - **Suggested commit message:** `feat(fixtures): add nominal hourly PM2.5 series`
  - Add nonoverlapping native hourly intervals covering 08:00–12:00 on 25 October 2026 in `Asia/Kuala_Lumpur`: yard values 100, 80, 50, 30 and office values 20, 20, 20, 20 in canonical `ug/m3`.
  - Store the yard and office as distinct location series with stable evidence identity/revision, exact raw bytes and hash, exact data locator, provenance, source kind and `synthetic_fixture` origin.
  - Preserve the original timezone metadata while representing interval timestamps in the shared UTC timestamp convention. Record the four-hour valid interval and one-hour native temporal resolution explicitly.
  - Describe the office values as independently fictional; do not imply a filtration benefit or indoor/outdoor ratio.

- [ ] **Task 3: Add the paired fictional +20 sensitivity transformation.**
  - **Suggested commit message:** `feat(fixtures): add lineage-bound plus-20 sensitivity series`
  - Add a pinned, versioned transformation that adds exactly 20 `ug/m3` to each nominal yard and office interval. Preserve one-to-one location, interval, and hourly resolution.
  - Record transformation method/version and explicit lineage from every transformed series/interval to its nominal source records. Generate immutable demo-local hashes for the transformed bytes.
  - Verify the transformed yard values are 120, 100, 70, 50 and office values are 40, 40, 40, 40.
  - Label this as an artificial engineering sensitivity only, not a forecast-error distribution, supported scientific uncertainty, or operational uncertainty treatment.

- [ ] **Task 4: Bind and load the evidence records through the fixture tooling.**
  - **Suggested commit message:** `feat(fixtures): bind environmental evidence records`
  - Integrate records and series with the repository's fixture loading and hash-binding conventions; update generation/check tooling only where needed to make the records reproducibly loadable.
  - Connect the planning fixture's evidence references to the exact local records only after their IDs, revisions and hashes validate. Update the existing fixture check that currently requires an empty evidence-reference list so it verifies these precise synthetic records instead.
  - Keep local fixture bindings separate from canonical acceptance. Publication stays disabled and operational recommendation eligibility stays false.

- [ ] **Task 5: Validate coverage, values, lineage and native resolution.**
  - **Suggested commit message:** `test(fixtures): validate hourly PM2.5 evidence integrity`
  - Add focused tests for complete four-hour coverage at each location and scenario; contiguous, nonoverlapping hourly intervals; valid timestamps and timezone metadata; finite, nonnegative concentrations; exact nominal and transformed values; stable identities and hashes; and valid transformation lineage.
  - Assert that environmental source resolution remains hourly. Document and test the declared piecewise-constant convention when activity durations intersect the 15-minute planning grid; do not generate independent quarter-hour readings or interpolate missing data.
  - Verify synthetic records cannot be interpreted as accepted operational evidence or enable publication or recommendation eligibility.

- [ ] **Task 6: Document fixture fields, provenance and consumer handoffs.**
  - **Suggested commit message:** `docs(fixtures): document hourly PM2.5 evidence inputs`
  - Add concise source and field notes describing record/series relationships, raw bytes and locators, timezone handling, native intervals, null reasons, nominal data, transformation lineage, permitted fictional use and limitations.
  - Include handoff examples for App, Planner, Verification and WorkerShield that identify how each consumes the agreed format without implying those components have executed or approved the evidence.
  - State explicitly that the yard and office values are invented, the office values are not a filtration assumption, the +20 case is not supported uncertainty, and the 15-minute planning grid does not increase measurement resolution.
  - Link the guide from the appropriate root documentation if that matches existing documentation patterns.

## Completion checks

Run the commands relevant to the final changes from the repository root and
report exact results:

```text
npm run contracts:fixtures
npm run contracts:check
npm run contracts:validate -- planning input_examples/v2/planning.json
npx vitest run --project unit tests/unit/planning-contract.test.ts
npm run typecheck
```

Add and run a focused test command for the evidence-record and hourly-series
checks when those tests are implemented. If the shared contract or application
code changes, also run the applicable lint/build checks and tests for the
affected behavior. Do not claim that contract validation proves scientific
applicability, operating acceptance, or a real-world recommendation. Report
architecture-source blockers and any unimplemented gates explicitly.

## Implementation prompt

```text
Implement this plan in the repository, following its instructions and existing contracts.

Do not include task numbering from this checklist in implementation code, supporting implementation documentation, test names, or your final report. Preserve the checklist numbering in this implementation document; you may use it internally to organize the work.

Do not create a git commit. I will review and commit the changes myself.

Use the tracked Architecture v0.13 source and the source-to-contract requirements in this plan; recheck §§4-5, 17 and 23 if that tracked source changes. Reuse the existing stack and contracts. If the architecture or required repository inputs are unavailable, identify the missing input rather than inventing it.

Keep every record fictional and operational recommendation disabled unless all real gates pass. Use immutable demo-local records with publication disabled when canonical capability is unproved. Preserve native hourly source resolution and the declared piecewise-constant convention; do not create quarter-hour environmental readings. Do not label the +20 transformation as supported scientific uncertainty or a forecast-error distribution.

Implement and validate the scoped work, then summarize changed files, exact commands and results, and remaining blockers. Do not contact people or self-approve human decisions.
```
