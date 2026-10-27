# Damage evidence web search: implementation report

[Reports](README.md) · [Implementation plan](../plans/damage-evidence-web-search-plan.md)

Implementation and verification: **27–28 October 2026, Asia/Singapore**. Artifact directories use the task's 27 October start date.

The implementation adds an executable public-evidence research and acquisition workflow, scientific-review gates, a shared-baseline intervention comparison, and durable collection/revision handling. It does **not** establish a scientifically qualified historical Malaysian damage estimate or two evidence-supported interventions. Those outputs remain subject to the plan's feasibility gate. No missing health effects, intervention costs or effectiveness values were invented.

## Changes

### Requirements, sources and case selection

- Added `app/capabilities/damage-evidence/` with operational definitions for the research catalogue's public numerical sources, document leads and restricted-access gaps. Definitions declare supported inputs, endpoints, units, parser versions, periods, access requirements, byte bounds and refresh intervals.
- Added a requirements planner that checks identity-scoped retained captures first, records missing/discovered/acquired/validated evidence, supplies English and Malay discovery queries, and records the outstanding requirements for one baseline and interventions A and B. Source prevention and exposure protection are both considered.
- Added case-selection manifests comparing candidate historical episodes. Ranking an episode does not approve it or authorize numerical output. The discovery planner deliberately cannot promote normalization into scientific applicability; the separate review workflow checks exact method outputs and expert decisions.
- Preserved the synthetic 2015 fixtures. The 2024 live acquisition selections verify provider contracts; they are not substituted for a historical haze episode.

### Executable research

- Registered the `damage-evidence-research` capability through the existing composition root and task API. Manager coordinates HazeOps discovery; deterministic measurement collection remains separate.
- Research needs an explicit task scope or `evidence_tools` grant, plus an assignment tool grant. Merely registering one of these five research tools no longer grants it to every task. Other tools retain their existing admission rules. `SAMPLE_MODE=true` disables external acquisition and search.
- Split requirements planning, model-driven discovery and acquisition into bounded assignments. Search outputs now provide usable titles, URLs, excerpts, publication metadata and immutable result references instead of array counts.
- Declared capture results must be saved by exact tool-action reference before the specialist continues. Web search has a persisted one-call quota per assignment; Manager can schedule another discovery assignment for another query. This prevents repeated paid searches from replacing evidence retention.
- Added `haze-captured-excerpt` for bounded passages from exact pinned/owned captures and imported text. Retrieved text is treated as untrusted evidence and rendered as text, without executing source markup.
- Extended Tavily support for general/news modes, English/Malay, date filters, optional publication dates and provider usage. Publication dates are separate from dataset observation periods. Request mapping was checked against the [official Tavily search contract](https://docs.tavily.com/documentation/api-reference/endpoint/search).

### Acquisition and provenance

- Added separate numerical and document acquisition tools. Numerical acquisition uses registered provider routes; discovered documents require an exact retained search URL on an allowed original-source host.
- Added an identity-scoped, content-addressed original-byte archive, immutable capture manifests and separate request-attempt histories. Captures retain hashes, retrieval times, source versions, parser versions, selected row/JSON locations, transformations and gaps. Large CSVs stay outside model messages.
- Implemented DOSM population CSV, district deaths and state wages API parsing, Malaysian monthly PM2.5 context, and Open-Meteo modeled PM2.5 acquisition.
- Added bounded downloads, provider throttling, controlled HTTPS redirects and explicit handling of access challenges. An HTTP 200 challenge page does not count as an acquired scientific article.
- Population values in thousands are multiplied by 1,000 with the original value and row retained. PM10, pollution indices, incompatible dates, overlapping selected strata, missing values, geographical mismatches and monetary-basis mismatches remain errors or gaps.
- Failed requests remain separate from successful captures. Availability views retain the last usable capture and its age.

### Methods, review and comparisons

- Added browser-safe versioned contracts for structured geographical identifiers, reporting type, attribution, assumptions, published-effect methods, expert scientific decisions, automated scientific checks and baseline/A/B comparisons.
- Added one deterministic physical-effect method: import an explicitly retained published estimate with its exact source locator, applicability, parameters and uncertainty. This does not implement a new exposure-response or transport model.
- Scientific decisions must be separately imported user-supplied expert records. Automated checks verify exact inputs, outputs, method version, scope, attribution, uncertainty and review validity. Model-authored, expired, rejected or unresolved decisions cannot qualify a result.
- Connected scientific bindings to accounting and World Model reuse. Existing independent arithmetic review remains separate. Optional versioned reporting metadata preserves legacy readability without inventing scientific metadata for old records.
- Added WorkerShield A/B comparison and independent numerical checking. Both interventions must use the same exact historical account, requested outcome, population, period, attribution and valuation basis. Adoption, effectiveness and cost each carry evidence, a labelled assumption, or missingness.
- The 10% threshold applies to avoided requested damage. Below-target and insufficient-evidence outcomes are retained. B's lower budget needs compatible, supported cost evidence; price alone supplies no effectiveness estimate. Costs and monetary net benefit remain separate.

### Collection, revisions and views

- In live mode, collectors start with the application server, without waiting for a dashboard request. Fixture/replay initialization remains lazy to preserve isolated task state. Documents and accounting datasets reuse the HazeOps scheduler without passing through station-measurement ingestion.
- Added ten-minute news discovery, source-cadence numerical subscriptions and a durable revision queue. News creates investigation records; it does not change numerical accounts.
- Numerical revisions create normal task corrections with immutable new evidence, preserving previous artifacts and requiring fresh calculations/reviews. Paused, cancelled or revoked work must not be silently restarted. Subscription and job state survive restart.
- Added `/api/damage-evidence/maintenance` and `/api/tasks/:id/views/damage-evidence` for retained availability, dependencies and revision status.
- Extended generic and accounting work products with readable search sources, evidence coverage, original-byte references, scientific-review status, and a baseline/A/B table. Intervention results are explicitly hypothetical. Currency and price-year labels remain visible.

## Verification

Verification levels are separate. Offline tests demonstrate contracts and execution behavior; public acquisition demonstrates real provider access; configured live inference demonstrates the model/provider/task path. None alone proves scientific qualification or a genuine numerical source revision.

The frontend production build passed. The frontend suite passed **333 tests, with one skipped**, when run with two workers. An initial unrestricted-worker run had a timeout and a consequent reused-response failure; the bounded rerun passed. Backend TypeScript checking, including the separate Zetaris configuration, passed.

Focused checks passed for acquisition/planning (15 tests), scientific review/comparisons (14 tests), durable maintenance (9 tests), and the research/search/action-contract/runtime combination (58 tests). A further pinned-runtime recheck of research, maintenance, action contracts and general runtime passed 54 tests. Frontend checks after the final display changes passed 24 targeted tests. Coverage includes exact versions, whitespace/null missingness, units, boundaries, periods, expired reviews, lower-budget claims, monetary consistency, permission revocation, prose-only corrections, semantic deduplication and restart.

The final full backend run on pinned Node **24.22.1** executed **1,434 tests: 1,428 passed and six compatibility tests failed**. A concurrently started development server rebuilt `dist` during those tests, temporarily removing their worker and adapter modules. All **six compatibility tests passed** when rerun against the completed build, with no source changes. This is a full run plus a successful targeted recheck, not a clean single full-suite pass. Local JSON results are retained at `tmp/damage-evidence-pinned-unit.json` and `tmp/damage-evidence-pinned-compatibility.json`.

Earlier verification found and fixed a fixture-isolation regression: eager dashboard initialization seeded location records into task-only fixture tests. Live initialization remains eager; fixture/replay initialization is lazy again. All six affected World Model/pilot cases passed their isolated recheck. Backend and frontend builds, TypeScript checks, repository lint, changed-file formatting and `git diff --check` passed.

The existing synthetic accounting verifier passed on the repository's pinned Node **24.22.1**, including duplicate delivery, restart, exact component closure and independent review. Its [retained report](../../.state/damage-verification/6c527dc1-8520-4cf5-a6f8-37305c3faa16/report.json) keeps synthetic provenance visible. Its harness now isolates `HAZE_TASK_STATE_DIR` and uses the existing safe HTTP verification reader; this resolved local connection resets without altering accounting behavior. The existing damage-reduction fixture verifier also passed. These checks do not qualify public historical estimates.

### Configured live model and retained evidence

The [live research verification summary](../../data/damage-evidence-verification/2026-10-27/live-research-verification.json) preserves the successive configured-model attempts. None completed the requested live research task. Failures included invalid model-generated references/inputs, exhausted bounded context and an unsupported final reference. These failures are not counted as successful task completion.

One run made real Tavily requests and saved two external-source captures, retaining provider request IDs, usage, original response bytes and hashes. Reopening that run through the normal task API verified both artifacts byte-for-byte and both provider-response hashes. Attempt counts were identical before and after reopening: the retention check dispatched no new model or provider work. The task remained failed. `scripts/verify-damage-evidence-retention.mjs` reproduces this separate persistence check.

The subsequent tool quotas and mandatory capture-saving rules pass offline execution tests. The last bounded configured-model attempt still produced invalid input before acquisition. A successfully completed configured-model task therefore remains an explicit release gate.

### Real public-source acquisition

The retained [acquisition manifest](../../data/damage-evidence-verification/2026-10-27/acquisition-verification.json) records original requests, selected values, hashes, transformations, failures and fallbacks. Original large bytes remain in `.state/damage-evidence-verification/2026-10-27/`.

- Population CSV: original 24,637,855-byte download retained; the 2024 Klang total is reconstructed from its exact CSV record and the thousands-to-persons transformation.
- District deaths, state wages and monthly PM2.5: real API captures obtained after correcting the provider's canonical trailing-slash endpoint.
- Published physical-effect originals encountered availability restrictions and challenge pages. These are retained access gaps, rather than scientific evidence.
- The [case-selection manifest](../../data/damage-evidence-verification/2026-10-27/case-selection.json) preserves the feasibility findings. No public historical baseline or A/B monetary/physical result is qualified by these acquisition samples.

### Remaining release gates

1. Complete a bounded live Manager/HazeOps task with the configured model. Real search and restart retention have separate evidence, but failed or waiting tasks do not establish successful end-to-end task completion.
2. Acquire an applicable original published physical-effect source and record an actual expert decision for its exact scope and versions.
3. Obtain compatible intervention mechanism, adoption, effectiveness and incremental cost support; verify lower-budget B against A. Then produce the three reviewed public-evidence samples through the accounting workflow.
4. Observe a **genuine** relevant upstream numerical revision and retain its resulting account revision, fresh reviews and A/B reassessment. Offline injected updates do not satisfy this live gate.

The implemented physical method imports a reviewed published estimate; it does not estimate exposure response, fire transport or causal intervention effectiveness. Comparisons are deterministic point scenarios. Published uncertainty and assumptions remain traceable to method and source records; the implementation does not introduce a new uncertainty-propagation model. Broader national/state aggregation remains outside this initial shared-workflow delivery, as specified in the plan.

Public source availability and model behavior are reported as observed; an unavailable source does not silently become zero and a failed live task does not count as a successful integration.

## Running the workflow

Start the normal server with `npm run tasks:serve`. Configure the existing model routes and `TAVILY_API_KEY` for live discovery; `HAZEOPS_SCHEDULER=off` disables recurring collection. A task opts into the research capability with this scope:

```json
{
  "schema_version": "haze.task.request.v3",
  "objective": "Research compatible public evidence for a Malaysian historical haze baseline and two interventions. Preserve gaps and compare feasible episodes before selecting a case.",
  "scope": {
    "capability": "damage-evidence-research"
  }
}
```

Submit through the existing `POST /api/tasks` endpoint with its same-origin and idempotency headers. Add a complete `scope.account_scope` using `damageEvidenceScopeSchema` when a geography, occurrence period, outcome, attribution and monetary view have been chosen; this enables deterministic requirements planning before discovery. Manager can schedule further bounded acquisition and review assignments as evidence becomes available.

Use the repository's pinned Node **24.22.1** and npm **11.8.0**, then reproduce the verification levels separately. The host's default Node 24.11.0 was below the supported range; pinned-runtime checks used `npm exec --yes --package=node@24.22.1 -- node ...` without changing the host installation.

```text
npm run build
node scripts/verify-damage-evidence.mjs --live
node --env-file-if-exists=.env scripts/verify-damage-evidence-research.mjs --live
npm test
npm --prefix frontend test -- --maxWorkers=2
```

The two live commands acquire real external evidence or invoke configured providers. Their retained manifests identify what each execution actually verified.
