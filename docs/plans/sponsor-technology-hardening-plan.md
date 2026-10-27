# Ground numerical answers, enable bounded Nightshift cloud execution, and remove H-MEM from the product

[Implementation plans](README.md) · [Documentation index](../README.md)

Status: proposed implementation plan. Saving this plan does not establish that implementation, scientific qualification or live verification is complete.

Date: **27 October 2026, Asia/Singapore**.

## 1. Summary and agreed defaults

Deliver three coordinated changes within a six-hour implementation target:

- Ground final numerical answers in independently reviewed tool outputs across PM2.5, damage accounting and reduction planning.
- Enable Nightshift cloud automatic follow-ups through verified release evidence.
- Remove H-MEM’s product integration while preserving historical data and isolated compatibility dependencies.

Existing tool permissions, exact artifact references, deterministic calculations and independent checks remain the foundation. Scientific data preparation continues in parallel with your current work.

Success requires both requested demonstration workflows. Missing damage inputs remain an explicit outstanding prerequisite; fixtures must not substitute for a completed real-data demonstration.

## 2. Ground final numerical answers

**Close the final-prose gap without rebuilding the existing agent controls.**

Add an internal `registerFinalRenderer(capabilityId, renderer)` interface to the execution registry. Each renderer receives the current task, selected artifacts, validated dependency closure, reviews and read-only services. It returns deterministic answer sections and limitations without model calls or mutations.

Register three renderers:

| Workflow           | Final answer content                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PM2.5              | Scope, modeled/observed evidence classification, coverage, usable samples, missing intervals, range, units and limitations.                                         |
| Damage appraisal   | Physical outcomes separated by endpoint/unit; financial and welfare totals separately; geography, period, currency, price year, omissions and scenario comparisons. |
| Reduction planning | Baseline and intervention quantities, avoided damage, reduction percentage, threshold conclusion, costs, prerequisites and conditional/gap status.                  |

Apply the following behavior:

- Invoke renderers after existing artifact-closure and independent-review validation, before saving the result.
- Select renderers through registered assignment capabilities and artifact kinds—not model prose.
- For these quantitative workflows, construct the saved factual answer entirely from renderer sections. Preserve the original Manager response in the existing decision audit.
- Render mixed quantitative outputs as separate sections. Missing outputs produce an explicit gap.
- Preserve existing rejection of stale, inaccessible, mismatched or unsupported evidence.
- Reuse current reduction-claim eligibility checks. Classify thresholds using exact arithmetic; display percentages rounded to three decimal places with the rounding identified.
- Keep conceptual and non-quantitative synthesis behavior unchanged.

`TaskResult.answer` remains a string; no task-result database migration is required. Existing result screens continue showing artifacts, reviews and receipts.

Use the exact NVIDIA Ultra model for strict role verification and the demonstration’s model routes. Keep deterministic numerical specialists deterministic. Report actual model calls per role.

## 3. Enable evidence-backed Nightshift cloud follow-ups

**Use the currently available cloud lanes. Local model installation is outside this plan.**

### Production release policy

Implement a server-owned release-policy loader and supply it through the existing `nightshiftAutomaticRelease` dependency.

Store release evidence beneath the state directory, with a fixed current-manifest location and content-addressed evidence files. Validate file bounds, hashes and references. Browser requests, model outputs and task inputs cannot install release evidence.

The manifest binds release to:

- Application build, instructions and registered contract identities.
- Exact strict role routes.
- Reviewed Nightshift installation and candidate-roster fingerprints.
- Current role evaluation and separate independent review.
- Both domain demonstrations.
- Genuine cloud generation, wait/wakeup, interactive-latency and automatic-chain traces.
- Crash/restart verification.

Introduce automatic-readiness schema v2 containing the supported privacy policy and grant ceilings; update in-repo clients together. Preserve v1 manual-grant behavior.

Initial automatic release supports only:

- `cloud-ok`.
- Two total runs and one automatic follow-up.
- One concurrent native job, two jobs total and one attempt per job.
- Thirty-minute absolute chain lifetime.
- Existing task, token and operation budgets.

Cloud execution retains the runtime’s supported monetary policy; do not advertise an enforceable dollar ceiling.

Validate the release scope at admission and before successor dispatch. Preserve pause, cancellation, no-progress stops, unknown-outcome fences and immutable grant accounting. Changed build, routes, runtime or roster invalidate matching release evidence.

### Verification and bootstrap

Extend the job verifier with explicit cloud-policy support. Keep read-only inspection as its default.

Add an isolated live verifier using the existing trusted policy-injection seam. Its provisional policy authorizes only the bounded verification scenario and never becomes production release evidence.

Exercise:

1. Specialist submits a genuine native cloud job.
2. Specialist parks and releases execution capacity.
3. Native completion is captured with provenance.
4. The task wakes and explicitly reviews the candidate.
5. An opted-in chain admits exactly one successor.
6. Restart readback preserves identities, accounting and results.

Measure interactive latency during background execution against the existing 90-second gate.

Rerun the frozen role comparison against the final instructions and routes. A separate reviewer must inspect the exact outputs and record a verdict tied to their hashes. Only then may the evidence assembler atomically publish the production manifest. Finally, verify ordinary production loading without injection.

Strict role decisions retain exact-model checks. Native candidate jobs retain runtime-selected lane/model provenance separately and remain unreviewed until checked.

## 4. Remove H-MEM product integration

Remove:

- Memory navigation, route, page, fixtures and page tests.
- Active H-MEM office character, generated activity and agent membership.
- H-MEM startup rows, console commands/completions and health fields.
- Current product and sponsor claims describing H-MEM as active.

Preserve the initial health bootstrap currently embedded in the H-MEM readiness step; other readiness probes still require it.

Move the coupled Meterless wrappers intact into `app/compatibility/meterless/`, updating imports and documentation links. Retain upstream sources, pins, vendoring, conformance checks and compatibility-probe semantics. No compatibility-version bump is needed for this relocation.

Keep historical state and imported datasets intact. Separate active agent identifiers from historical recorded identifiers, allowing old records to display “Retired H-MEM” without creating an active office actor or crashing.

Update current architecture diagrams and regenerate frontend seed data. Preserve historical implementation reports.

## 5. Verification, handoff and six-hour sequence

### Required tests

- Scripted Manager invents a number while citing valid evidence: the invented number never enters the saved quantitative answer.
- All three renderers reproduce reviewed values, units, scope and limitations.
- Accounting preserves endpoint separation, currency/price-year labels and financial/welfare separation.
- Reduction covers met/below threshold, zero baseline, incompatible scope and changed support.
- Unauthorized tools, arbitrary SQL/code, forged references and producer self-review remain rejected.
- Release rejects fixture evidence, missing independent review, altered hashes, stale routes, local-only grants and excessive limits.
- Existing job/wait/chain crash suites preserve exactly-once admission and grant bounds.
- Startup, navigation and office work without H-MEM; historical imports and the unchanged compatibility probe still open successfully.

Run focused checks during implementation, then the repository’s required `npm run check` before freezing the verification build.

### Live demonstrations and data handoff

- **PM2.5:** genuine NVIDIA/Nightshift orchestration, Zetaris retrieval, retained query/rows, deterministic calculation and separate numerical check.
- **Damage accounting/planning:** import your supplied package using existing accounting, residual, target and candidate schemas; construct exact references after import; calculate, independently check and render the results.
- Extend the existing live accounting verifier and add a genuine-model planning verifier. Preserve raw attempts, role-level receipts, artifacts and restart readback.
- Reject incomplete or incompatible packages with named gaps. Do not infer missing health effects, costs or intervention effectiveness from raw PM2.5 samples.

### Delivery order

| Window    | Work                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hours 0–2 | Parallel implementation of renderers, Nightshift release/verifier changes and H-MEM product removal. Validate the incoming data package as it becomes available. |
| Hours 2–4 | Integrate, run focused regressions and required checks, then freeze the build and route snapshot.                                                                |
| Hours 4–5 | Run current role evaluation, both live workflows and the bounded job/wait/successor scenario; independently review retained evidence.                            |
| Hours 5–6 | Publish release evidence only if every gate passes, verify production loading, and prepare the demonstration and sponsor explanation.                            |

Any relevant source or route change after freezing requires affected evidence to be regenerated. If a live gate or data prerequisite remains unmet, automatic release stays blocked and the final report identifies the exact remaining item.
