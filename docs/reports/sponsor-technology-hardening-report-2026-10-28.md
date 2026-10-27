# Sponsor technology hardening implementation report

[Reports index](README.md) · [Implementation plan](../plans/sponsor-technology-hardening-plan.md) · [Verification guide](../testing/sponsor-hardening-verification.md)

Date: **28 October 2026, Asia/Singapore**.

Status: implementation continued; production automatic release remains blocked.
The real damage accounting/planning input package is not ready, as confirmed by
the user during this work. No synthetic package was substituted for that live
demonstration and no production release manifest was published.

## Scope and starting point

The starting revision was `3bd6bfe`. The repository already contained the three
deterministic final renderers, registry and finalization wiring, a server-owned
Nightshift release loader/publisher, readiness v2 and the main active-office
H-MEM retirement. This work audited and completed gaps in that implementation.

Pre-existing modifications in `app/tasks/store.ts`,
`tests/unit/external-wait-store.test.ts` and `tests/unit/general-store.test.ts`
were preserved. Their behavior is not attributed to this implementation.

Additional concurrent edits appeared during final validation: Manager graph
timing hooks and related runtime/store tests, plus damage-account history and
execution-receipt UI/service changes. These were preserved and are not changes
authored or qualified by this report. Evidence below refers to the captured
compiled build, not later workspace edits. A rebuild containing those later
changes requires fresh affected verification and release evidence.

## Changes

### Grounded numerical answers

- Replaced the mutable store passed to final renderers with a frozen inspection
  facade exposing only task/artifact reads and World Model lookup/hold reads.
  Renderers receive no database handle or mutation methods. Reduction claim
  checking now accepts the narrower evidence-reading interface.
- Corrected damage comparison units: monetary quantities retain their own
  currency labels and benefit-cost ratios are explicitly dimensionless.
- Added regression coverage for mixed quantitative outputs, missing-output gaps,
  unrelated producers, the renderer inspection boundary and unchanged conceptual
  synthesis. Existing numerical calculations and reviewed values are preserved.
- Fixed a live-discovered Manager checkpoint-ID collision: accepted decisions at
  the same event cursor now receive distinct IDs using the persisted decision
  ordinal, while replay remains stable. Missing peer coordination and citations
  outside the selected sources receive one bounded correction. Existing conflict
  and citation rejection remain enforced. The Manager version is now v16.

### Evidence-backed Nightshift cloud controls

- Tightened release validation around the frozen role suite, retained raw
  attempts, exact candidate model receipts and reconstructed outcomes. Evaluated
  output bytes must match their retained hashes. Independent review remains tied
  to the exact evaluation/output identities.
- Strengthened domain and lifecycle evidence requirements to prevent incomplete
  domain demonstrations or unrelated cloud/wait/chain/restart records from
  satisfying release gates.
- Added retained domain-proof validation for exact current artifacts, registered
  producer/reviewer identities, source originals, deterministic recomputation,
  actual role calls and restart readback. Zero model calls remain valid for
  deterministic numerical specialists. Reports capture the complete build,
  route, instruction, contract and runtime binding before execution.
- Re-rendered each retained domain answer with the registered deterministic
  renderers and compared the entire saved string. A changed numerical answer
  cannot qualify merely by retaining a valid prefix and unchanged artifacts.
- Moved release validation into `app/release/`, preserving the boundary that
  keeps task infrastructure independent of concrete agents and capabilities.
- Added an evidence assembler that validates by default and publishes only when
  explicitly invoked with `--publish`. It was not used to publish a manifest.
- Bound native completion to the named lane/model entries in the reviewed cloud
  roster. Cloud permission by itself no longer proves that the selected job used
  cloud compute.
- Added explicit cloud policy support to the native job verifier, preserving
  read-only inspection by default and recording native lane/model provenance.
- Added an isolated live lifecycle verifier using the trusted policy-injection
  seam. Its scripted orchestration is labeled provisional. It cannot publish
  production release evidence or satisfy strict role-quality evaluation.
- Updated automatic-chain verification documentation for the bounded initial
  cloud scope and remaining release requirements.

The initial automatic scope remains cloud-ok, two total runs, one automatic
follow-up, one concurrent native job, two jobs total, one attempt per job and a
30-minute absolute lifetime. No enforceable dollar ceiling is advertised.

### Live domain verification and data handoff

- Pinned isolated live domain-verifier role routes to the exact NVIDIA Ultra
  identity through Nightshift without changing saved application configuration.
- Added actual charged/accepted model-call counts per role, exact requested and
  returned model checks, retained artifact references and raw attempts. Failed
  accounting attempts now produce a retained report as well.
- Strengthened PM2.5 verification to require a current selected analysis, exact
  independent review, retained Zetaris query/raw rows and a rendered answer.
- Strengthened live accounting qualification to reject synthetic inputs and
  incomplete or empty accounts. Reports name missing physical, financing and
  welfare outputs while retaining account omissions and limitations.
- Added `scripts/verify-damage-planning.mjs` and `npm run planning:verify`.
  Its inspect mode validates a self-contained supplied package without making
  model calls. Live mode imports residuals, constructs exact references after
  import, pins the operator selection, checks compatibility and exact arithmetic,
  runs the conditional planning workflow and verifies current independent
  reviews and restart readback. Missing or incompatible inputs produce named
  gaps. Read-time claim timestamps are excluded from restart equality; saved
  identities, references, accounting and results must still match.
- Added package/receipt validation tests to `npm run routes:test` and documented
  the package envelope around existing target, residual and candidate schemas.
  This isolated package format refuses unresolved external candidate evidence
  references instead of silently treating them as verified support.

### H-MEM product retirement

- Deleted the orphaned Memory page, fixture content, styles and page tests.
- Removed remaining H-MEM startup, console/status/doctor/completion and API
  health integration. Preserved health initialization before parallel readiness
  probes, with an explicit regression assertion.
- Moved the coupled Meterless wrappers intact from `app/adapters/meterless/`
  to `app/compatibility/meterless/`; adjusted imports and repository-root
  resolution. Upstream pins, vendoring, conformance checks and probe behavior
  remain unchanged.
- Updated current product/architecture documentation and sponsor SVG/PNG.
  Historical implementation documents and recorded retired identifiers remain
  available. No historical state or imported data was deleted.
- Regenerated and validated the frontend seed using its original generation
  time. It already reflected retired active identifiers, so regeneration caused
  no unrelated timestamp changes.

Formatting failures found by the required repository check were corrected,
including existing frontend files. These formatting changes add no product
behavior.

## Verification

| Check                                           | Result                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pins, formatting, type checking, lint and build | Passed in the required repository check.                                                                                                                           |
| Backend regressions                             | Full run: 1,500 passed and two stale Nightshift test expectations failed. Both fixtures were corrected; the affected HTTP/service suites then passed all 40 tests. |
| Script and route checks                         | 63 tests passed in the final rerun, including four added lineage-pagination regressions.                                                                           |
| Vendored engine conformance                     | H-MEM 13/13 and World Model 8/8 passed.                                                                                                                            |
| Fixture integration and LangGraph crashes       | All seven workflow verifiers and all three crash boundaries passed.                                                                                                |
| Nightshift crash/restart suites                 | 17 scenarios passed: seven job, four wait/wakeup and six chain scenarios.                                                                                          |
| Relocated compatibility probe                   | Passed cross-process local persistence/readback; provider intentionally skipped in offline mode.                                                                   |
| Retained domain evidence                        | 17 tests passed, including exact saved-answer tampering for all three workflows.                                                                                   |
| Release policy and frozen role evidence         | 27 tests passed.                                                                                                                                                   |
| Frontend build and tests                        | Passed; 334 tests passed, one skipped.                                                                                                                             |
| Planning package inspection                     | An incomplete package was rejected with named missing target, candidate and source fields; no model or server was started.                                         |
| Zetaris preflight                               | Passed authenticated read-only checks; available Klang modeled samples include 27 October 2026.                                                                    |
| Provisional native cloud lifecycle              | Final current-build trace passed; two earlier passes were retained. These are provisional engineering traces.                                                      |

The final current-build provisional trace used native lane `nemotron-3-5-super-vl-12`, model
`nvidia/nemotron-3.5-super-vl-120b-a12b`, and a separate exact-Ultra interactive
probe completed in **8.027 seconds**, with the native job running at the start
of the probe. It retained
one successor, one native submission/attempt, candidate review/consumption and
restart-preserved accounting/results. The selected attempt matched the reviewed
cloud roster. Ordinary production readiness remained blocked, with no manifest.

That trace has **seven scripted Manager decisions and five scripted critic
decisions**; actual model calls were Manager **one** (the latency probe), critic
**zero**. It is engineering evidence only and cannot qualify a production
release. The final trace is under
`.state/sponsor-hardening-nightshift-final/da771f86-8250-4b72-8b58-23814fdc6822/`.
Two earlier provisional passes were also retained. The cleaner earlier trace,
with a 1.223-second latency sample, passed 19 separate lifecycle/roster checks;
its review is under
`.state/sponsor-hardening-nightshift/bde5bc15-9492-4e12-8406-a29ddf9a11ac/`.

The first live general/PM2.5 attempt exposed the Manager citation/decision-ID
failures corrected above. Its failed report and raw attempts remain in
`.state/general-verification/34c2ff13-2fce-47a9-a7b4-2dc45b2268bb/`.

The frozen role comparison completed **30 genuine model calls**: 15 inherited
Lightning baseline calls and 15 exact-Ultra candidate calls. Each side called
Manager three times, HazeOps four, WorkerShield two, EvidenceCritic three and
DamageAccountant three. All frozen contract, outcome, reference, receipt and
latency gates passed; maximum latency was 4.227 seconds for baseline and
9.061 seconds for candidate.

A separate agent reviewed every original output and its context, reconstructed
inputs and checks, verified all input/output hashes and append-only attempt
records, and confirmed unchanged compiled-build/runtime/route bindings. Its
verdict was **supported for controlled role probes**. These genuine calls used
synthetic single-decision contexts; they do not establish domain or scientific
success. The report and hash-bound independent review are under
`.state/sponsor-hardening-role-evaluation/1793124993478-bcceca94-145d-4f0e-a155-b074e07d3f8a/`.

The compatibility report is
`.state/sponsor-hardening-compatibility/compatibility/compat-8c97b47b-dfdd-4d96-8e5a-f861da900202/report.json`.
Crash reports and the post-correction type check are recorded in
`.state/sponsor-hardening-recovery-checks.log`.

The final live PM2.5 attempt **did not pass**. Zetaris returned three modeled
samples for Klang, 27 October 2026, 00:00–03:00 UTC, with range
34.3–51.7 micrograms/m³. Deterministic calculation and independent numerical
review completed. Ultra's final Manager response hit the admitted **1,200-token
limit**, and the runtime correctly rejected the incomplete response. No saved
quantitative answer or completed demonstration is claimed.

Actual model calls were Manager **four** for the completed general workflow and
Manager **five** for PM2.5 (four accepted, one truncated). HazeOps, WorkerShield,
EvidenceCritic and DamageAccountant made **zero** model calls in these workflows.
The final failed report, source capture, artifacts and raw attempts remain under
`.state/general-verification/b8b60adc-a03a-4f1a-a9d2-9c06242113c0/`.
The retained-domain validator rejected that report as incomplete.

This run also exposed a verifier-only pagination bug: World Model lineage may
return an empty first page with more pages available. The acceptance event was
at sequence 1403, beyond the first 1001 events scanned. The verifier now follows
bounded pagination and preserves primary task errors and charged model-call
counts even when a later probe fails. These reporting fixes do not turn the
truncated PM2.5 run into a pass, and its original evidence was not rewritten.
The pagination helper passed nine focused tests, a read-only check against the
retained two-page lineage, and the full general/PM2.5 fixture verifier with
acceptance, hold and restart checks. The final fixture report is
`.state/general-verification/c2465143-3b1e-4564-be4d-994d08a3691e/report.json`.

The two corrected test expectations were readiness v1 versus v2 and a legacy
automatic grant outside the released cloud scope. The fixtures now assert v2 and
the exact initial cloud limits; manual v1 behavior and both release-revocation
checks still pass. This work's application code did not change after the
verification build; verifier-only diagnostics received the targeted checks
described above. Later concurrent workspace edits are outside this verification
claim. The earlier concurrent backend run had timeout failures; they did not
recur in the quiet full run. Logs are retained in
`.state/sponsor-hardening-final-check.log` and
`.state/sponsor-hardening-remaining-checks.log`.
The complete `npm run check` command was not rerun after those test-only fixes;
its remaining steps were run separately and passed, and type checking passed
again after the corrections.

## Remaining release prerequisites

1. Supply and validate the real damage accounting/planning package, then run both
   genuine-model workflows and retain their independently reviewed outputs.
2. Resolve the PM2.5 final-decision quality/token-limit failure and complete the
   whole demonstration with a saved deterministic answer and restart readback.
3. Complete the genuine cloud lifecycle and interactive-latency gates, including
   restart evidence. Provisional scripted orchestration alone cannot release
   production.
4. Rerun the frozen role evaluation against final instructions/routes and obtain
   a separate review tied to the exact retained output hashes if the build,
   instructions or routes change while resolving the remaining gates. The
   current controlled comparison and its separate review passed as described
   above.
5. Assemble and atomically publish release evidence only after every gate passes,
   then verify ordinary production loading without injected policy.

The installed execution host reports Node `v24.11.0` and npm `11.8.0`. The
repository declares Node `>=24.22.1 <25`; test execution on this host does not
establish qualification on that declared Node version.
