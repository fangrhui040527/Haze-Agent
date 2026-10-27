# Web search and public-evidence integration for damage accounts

[Implementation plans](README.md) · [Documentation index](../README.md)

Status: proposed implementation plan. Saving this plan does not establish that its implementation, scientific qualification or live verification is complete.

Date: **27 October 2026, Asia/Singapore**.

References:

- [Haze core goals and product specification](../architecture/haze-core-goals.md).
- [Damage-account input-source research](../reports/damage-input-source-research-2026-10-27.md).
- [Research source catalogue](../../data/damage-source-research/2026-10-27/source-catalogue.json).
- [DamageAccountant implementation plan](damage-accountant-plan.md).
- [Damage reduction implementation roadmap](damage-reduction/damage-reduction-planning-plan.md).

## Summary

Implement a source-backed workflow that produces three connected hackathon samples:

1. A historical Malaysian damage account.
2. Intervention A evaluated against that account.
3. Lower-budget Intervention B evaluated against the same baseline.

Use public sources initially. Select the episode and interventions according to the strongest compatible public evidence, rather than fixing the work to Klang or the existing synthetic fixture. Preserve missing information as gaps. Align delivery with the core goals: maintained evidence, reproducible damage accounting and supported reduction planning.

Reuse the existing agents, TypeScript/LangGraph runtime, task APIs, artifact storage, accounting engine and independent checker.

```text
Account scope -> Missing-input checklist -> Search and acquire sources
              -> Validate datasets and methods -> Calculate physical effects
              -> Review -> Historical damage account
                          |-> Intervention A
                          |-> Lower-budget Intervention B
```

The existing accounting engine consumes prepared physical quantities and unit values. It does not establish an exposure-to-health calculation or fire attribution merely because search or numerical-source acquisition succeeds. Discovery, acquisition, scientific applicability and arithmetic review are distinct stages.

## Implementation sequence

### 1. Establish the evidence requirements and select feasible cases

- Build a requirements planner from the requested geography, occurrence period, physical outcome, attribution basis and monetary view.
- Check retained evidence before searching. Track each requirement as missing, discovered, acquired, validated or applicable.
- Convert the research source catalogue into operational source definitions containing supported inputs, endpoints, geography, periods, units, parser version, access requirements and refresh cadence. The research catalogue is a starting point, not an approved input manifest.
- Compare candidate Malaysian episodes using evidence completeness, reproducibility and geographical/temporal compatibility. Prefer published physical-effect estimates or reproducible published methods.
- Consider both source prevention and exposure protection when finding interventions. Select A and B only where public evidence supports their proposed mechanism, cost and effectiveness. Verify that B has a lower compatible cost; A and B need not belong to different intervention categories.
- Save a case-selection manifest explaining selected sources, rejected alternatives and unresolved requirements.

**Exit criterion:** One baseline and two intervention specifications have explicit evidence requirements and feasibility findings. Missing evidence may block quantified outputs; it must not be filled with invented values. Three fully quantified samples are not promised before this feasibility gate passes.

### 2. Connect web search to an executable research workflow

- Register a new `damage-evidence-research` capability coordinated by Manager and executed by HazeOps.
- Give its discovery assignment access to `haze-web-search` through explicit task permissions. Use the model-driven specialist path; the existing deterministic measurement collector remains a separate acquisition path.
- Expose bounded search-result previews containing title, URL, excerpt, date and an immutable reference. Correct the current generic digest behavior that reduces result arrays to item counts.
- Add a tool for reading selected captured document excerpts.
- Extend the Tavily adapter with documented news/general modes, date filters and publication metadata. Keep document dates distinct from dataset observation periods. Verify request and response contracts against the provider documentation, including missing publication dates.
- Use official sources first, supplementing them with relevant research and programme evaluations. Support English and Malay queries.
- Apply existing execution budgets and cancellation controls. Record requests, results, failures and provider usage. Treat retrieved text as evidence rather than executable instructions.

**Exit criterion:** A normal Manager task invokes search, presents usable source previews to HazeOps and retains its evidence through restart.

### 3. Acquire and normalize original evidence

- Implement separate document and numerical-data acquisition tools. Search results provide discovery leads; numerical inputs come from retained source documents or datasets.
- Start with the public routes verified in the research: DOSM population CSV, deaths and wages APIs, and pollution sources compatible with the selected episode.
- Fetch through registered provider adapters with bounded downloads, controlled destinations and provider-specific throttling.
- Retain original bytes, source/version information, retrieval timestamps, hashes and extraction or transformation manifests.
- Store large files behind bounded artifact references. Do not embed complete CSVs or rasters in model messages.
- Validate units, geographical boundaries, population strata, observation periods, missingness and currency/price-year compatibility.
- Preserve failed requests and successful fallbacks separately. Keep the last usable capture with its age and current availability status.

**Exit criterion:** Every normalized value can be traced to an original file, row, table or document passage and its transformation.

### 4. Produce reviewed accounting inputs

- Prioritize importing applicable published physical effects. Where reproduction is needed, implement the selected published method as versioned deterministic code.
- Introduce a method interface that binds input references, parameters, endpoint, exposure duration, comparison scenario, applicability and uncertainty.
- Keep method selection and scientific applicability separate from arithmetic correctness. Implement the missing scientific-review workflow and connect its verdicts to exact input and output versions.
- Permit automatic reuse only within a method's reviewed applicability. Unresolved scientific questions remain visible and prevent scientifically qualified claims. Expert method decisions must be recorded separately from automated checks.
- Translate eligible results into the existing accounting structures: scope, effects, unit values, coverage, incidence and scenarios.
- Reuse DamageAccountant and the independent arithmetic checker. Enforce review requirements when reusing World Model inputs; storage alone does not establish scientific acceptance.
- Version contracts to represent reporting type, attribution basis, structured geographical identifiers and explicit assumptions. Continue reading existing artifacts without inventing metadata for legacy records.

**Exit criterion:** A historical account is independently reproducible, with physical, financial and welfare results separated and each reported quantity supported by exact evidence. Unresolved applicability prevents a scientifically supported physical-effect claim.

### 5. Evaluate A and B against one baseline

- Pin both interventions to the same historical account version, outcome, population, occurrence period, attribution basis and valuation basis.
- Have WorkerShield assemble each intervention's mechanism, implementation scope, adoption, effectiveness, costs and prerequisites.
- Require evidence or clearly labelled assumptions for each material parameter. Do not infer B's effectiveness from its lower budget.
- Calculate residual damage and avoided damage using registered methods. Apply the 10% threshold to the requested damage outcome.
- Report intervention cost and monetary net benefit separately. Preserve below-target and insufficient-evidence outcomes.
- Extend existing task/work-product views with source coverage, review status and a baseline/A/B comparison. Provide original-source links and retained evidence references.

For a positive baseline, calculate:

```text
reduction percentage =
  (baseline damage - estimated damage with intervention) / baseline damage * 100
```

The comparison must preserve the same outcome and units. Deaths, illness cases and lost workdays are separate physical quantities. Financial-loss and social-welfare views remain separately labelled, with overlap rules applied before aggregation.

**Exit criterion:** Both comparisons reproduce independently, use identical baseline references and clearly distinguish hypothetical avoided damage from achieved reductions.

### 6. Add continuous collection and revision handling

- Start collectors with the application server rather than waiting for a dashboard request.
- Reuse the watcher scheduler for ten-minute news checks and numerical refreshes matched to source publication frequency.
- Deduplicate articles and unchanged datasets; persist schedules, attempts and progress across restarts.
- Route news changes to investigation or acquisition requests.
- Route validated numerical changes through a durable dependency worker that creates affected account revisions and reassesses A and B.
- Reuse dependency invalidation and revision-comparison machinery. Preserve previous results and require fresh review for revised calculations.
- Record damage under its occurrence period even when new evidence is published later.

**Exit criterion:** A relevant numerical update produces a traceable account revision and intervention reassessment; a news article alone does not change numerical estimates.

## Verification and release gates

- **Execution:** Manager -> HazeOps -> Tavily -> retained evidence works through the normal task API.
- **Provenance:** Reported values reconstruct from original evidence, transformations and pinned methods.
- **Compatibility:** Wrong periods, incompatible geography, overlapping strata and mismatched units or price years are rejected or recorded as gaps. Include regression cases for population in thousands, PM10 versus PM2.5, pollution index versus concentration, and the synthetic 2015 fixture versus 2026 acquisition samples.
- **Review:** Missing, stale or rejected reviews cannot produce qualified results. Independent arithmetic agreement cannot substitute for scientific applicability.
- **Missingness:** Unavailable evidence never silently becomes zero; fixtures remain visibly synthetic.
- **Comparisons:** A/B share one baseline; costs and effectiveness remain independently supported; below-10% results are retained honestly. Verify that B costs less than A on the same accounting basis.
- **Updates:** Unchanged captures cause no duplicate calculation; relevant numerical revisions reassess both interventions; news triggers investigation only.
- **Recovery:** Cancellation, provider failures, throttling and restart preserve evidence and task history.
- **Regression:** Existing accounting, Manager routing, World Model, scenario assessment and frontend workflows continue to pass.

Complete offline contract and workflow tests first, then capture a real public-source acquisition and a configured live-model task. Report these verification levels separately. Prepared sample success does not establish live-update behavior; retain separate evidence of a genuine source revision causing recalculation and reassessment.

## Assumptions and delivery boundaries

- Public sources are the initial acquisition scope; restricted datasets become documented access gaps.
- The existing invented 2015 accounting fixture remains a test fixture. The research's arbitrary October 2026 API sample is not an established episode.
- Prefer fire-attributed evidence. Where only all-PM2.5 support exists, label that account explicitly and preserve the fire-attribution gap.
- Intervention estimates are hypothetical historical scenarios. Unsupported effectiveness or cost remains unestimated.
- A general atmospheric transport model is outside this implementation. Any new scientific calculation must follow a selected, versioned published method.
- Deliver the historical baseline first, A/B comparisons second, and continuous updates third. Broader national/state aggregation follows successful verification of this shared workflow.
- Keep previous artifacts and results readable. New evidence, methods and account definitions create explicit revisions rather than overwriting prior claims.
