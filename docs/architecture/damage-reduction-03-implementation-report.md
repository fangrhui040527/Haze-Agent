# Damage reduction programme coordination implementation report

The original verification results below are historical. See the
[engineering follow-up](#engineering-follow-up-27-october-2026) for the later
recheck and superseding evidence.

Implemented on 27 October 2026 against [Plan 03](damage-reduction-03-programme-coordination.md).
Local operators can save programmes, explicitly start bounded assessment and
planning phases, revise inputs and budgets, and reopen current or historical
results after restart. Existing task records remain authoritative for execution.
Scientific qualification remains unqualified; pilot registration, live delivery
and outcome evaluation remain in Plans 04–05.

## Programme storage and transactions

Added browser-safe versioned programme contracts in
`app/contracts/damage-reduction-programme.ts` and a domain-owned repository,
service and projection in `app/capabilities/damage-reduction-programmes/`.
Additive migrations use the existing task SQLite connection. Scoped current
pointers reference append-only revisions; immutable phase attempts, context
records and operation receipts preserve history. Every lookup partitions by
principal, workspace and execution mode.

A phase attempt records its programme revision, phase, exact task/run/objective,
selected artifact versions/hashes, relevant-input fingerprint, predecessor and
actual admitted model/tool maxima. Revision, task admission, attempt binding,
reservation and receipt commit together. Nested transactions use savepoints and
discard deferred dispatch callbacks on rollback. Dispatch runs only after the
outer commit. A callback failure leaves the committed queued task and receipt
available for retry/startup recovery.

The generic runtime exposes transaction-aware extension/admission/control
boundaries; composition registers the programme handler and mutation guard.
Domain policy stays outside `app/tasks/`. Failed extension construction releases
the store and runtime owner before asynchronous execution resources start.

## Current results and guarded controls

Reads reconstruct status, usage and terminal results from the linked run. The
new `task_run_results` archive keys committed results by run and objective
revision; programme projections never substitute the task's later current run.
Existing unambiguous current results are backfilled additively. Older
superseded result prose cannot be recreated if it was not retained before this
upgrade; existing artifacts remain available as history.

Notes, titles and ownership edits leave relevant-input fingerprints unchanged.
Scenario/target changes stale assessment and planning, while candidate changes
or a newly selected assessment stale planning. Material revisions immediately
fence affected active tasks without starting replacements. Sources are
rechecked for exact hashes, identity, mode, applicability, required permissions
and World Model holds even when no programme edit occurs. Registered required
review coverage and the exact supporting review's currency/holds are also
rechecked for generated inputs. Stale/historical
attempts retain exact artifact references and reasons, with current preview
eligibility withheld.

Planning requires an explicitly selected completed, current assessment with its
independent arithmetic review. The programme retains those exact predecessor
references. The new planning task reconstructs the original evidence through
the existing bounded pipeline; predecessor reviews never become direct factual
sources. Pipeline selectors now distinguish their own task/run/objective
products from retained context. Assessment-only task views expose a current
structured assessment when their committed numerical support is valid.

Bound generic task corrections are rejected with instructions to revise the
programme and explicitly start a replacement. Generic Continue requires the
bound programme ID and current expected programme revision, revalidates inputs
and capacity, and atomically binds/reserves the successor before dispatch.
Resume keeps the unchanged run's original reservation and deadline. Pause,
cancel and permission revocation remain available; pausing retains the active
phase slot. Cancellation fences late outputs. No operation automatically starts
a replacement phase.

## Budgets and API

Defaults enforce one active phase, three admitted attempts per phase, twelve
admitted runs overall and 400 charged model/tool calls each. Every admission
reserves its actual run maxima. Reads reconcile authoritative usage and release
only unused terminal reservation; unknown charged calls remain charged and
unavailable authoritative usage retains its reservation. Budget revisions
cannot fall below admitted counts, charged usage or current reservations, and
cannot exceed programme ceilings or raise per-run runtime limits.

Added the six programme route families under `/api/reduction-programmes` for
list/create, read, history, revisions, phase starts and records. They reuse the
existing loopback/origin checks, server-owned identity and no-store responses.
Mutation bodies are strict/versioned, require an idempotency key and expected
revision, and have a 64 KiB request bound. Snapshot size is also bounded to
64 KiB. List/history pages contain at most ten revisions/programmes with
explicit offsets. Context records retain at most 32 notes/exact attachments;
an attachment remains historical context without adopting its result or
reservation. Oversized input is rejected explicitly.

## Browser changes

Added `/damage-reduction/programmes/new` and
`/damage-reduction/programmes/:programmeId`, plus programme selection on the
existing damage-reduction landing page. Creation saves inputs without starting
a task. Operators explicitly start assessments and select a current reviewed
assessment before starting planning. The page displays remaining capacity,
exact phase/task/run links, current/historical results, stale/gap reasons,
revision history, input/budget edits and notes/attachments.

Mutation retries reuse the same intent key, drafts retain their expected
revision, and failed current reads withhold result eligibility. Existing
standalone preview creation and saved-task URLs remain available. Shared intake
components accept an optional programme submit callback. Controls use labelled
forms and responsive layouts for long identifiers.

## Verification and limits

The fresh-process programme verifier passes. Its retained
[JSON trace](../../.state/damage-reduction-programmes-verification/46305d33-3fbf-4efa-955e-6d176b6cbb04/report.json)
contains four explicitly started runs, duplicate receipt checks, unchanged-note
freshness, a material target correction, a historical attachment and exact
before/after restart projections. The supplied `1000 → 880` scenario meets the
initial 10% target and correctly does not meet the revised 15% target. Old
attempts remain historical after explicit replacements.

| Explicit run           | Target | Model calls | Tool calls | Charged artifacts | Assignments | Latency |
| ---------------------- | ------ | ----------: | ---------: | ----------------: | ----------: | ------: |
| Initial assessment     | 10%    |           0 |          3 |                 6 |           4 | 2158 ms |
| Initial planning       | 10%    |           0 |          5 |                10 |           6 | 4649 ms |
| Replacement assessment | 15%    |           0 |          3 |                 6 |           4 | 1956 ms |
| Replacement planning   | 15%    |           0 |          5 |                10 |           6 | 4703 ms |

Each run reserved its admitted 40 model/40 tool maxima. After terminal
reconciliation, the main programme has 400 model calls, 384 tool calls and eight
runs remaining, one attempt remaining for each phase, and zero outstanding
reservation. These fixture latencies vary with machine load and do not measure
configured model performance.

A separate process exits synchronously after durable phase admission and before
graph dispatch, with zero charged calls at the crash marker. Restart plus the
same idempotency key recovers the exact task/run and receipt, completes one
assessment attempt, and reconciles its reservation without another admission.
This trace also exercises the existing runtime's durable capacity permit after
restart; the concurrent external-wait implementation owns that permit logic.

Focused domain checks pass 12 cases. Programme integration checks cover 16 cases:
transaction/savepoint rollback, source/review holds, identity/mode isolation,
concurrent revisions, idempotency, cumulative reservations, unknown charged
calls, exact archived results, cancellation/late output, attempt ceilings,
generic route bypass attempts, successful coordinated Continue and constructor
cleanup. The generated-source review regression exercises admission/read
guards. Prior preview products are supported as historical attachments;
adopting them as new factual sources can still be rejected by generic task
closure validation. The frontend
production build passes with 249 tests passing and one existing skipped test.
The React/accessibility review covers explicit mutations, stale reads, exact
assessment selection, revision-pinned drafts, long identifiers and approval
reset on rule edits. Browser automation was not attempted in this turn because
the earlier browser session ended under an automation guard.

Reproduce the programme fixture and crash trace with
`npm run reduction:programmes:verify`; it is also included in
`npm run test:integration`.

The normal backend build, full TypeScript checks, repository ESLint, engine-pin
verification, five route-evaluation tests and engine conformance checks pass.
The final backend unit run passes **870 of 871 tests across 76 files**, including
all 28 programme domain/integration checks. One test in the concurrently
changed `tests/unit/external-wait-store.test.ts` fails: its queued-downstream
review fixture calls `createAssignments` while execution is waiting. That
Nightshift/external-wait case was preserved. Scoped formatting and
`git diff --check` pass.

`npm run format:check` reports only four existing files under
`tools/damage_data_discovery/`: `CRAWLER_CAPABILITIES_AND_DATA_GAPS.md`,
`DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md`, `PILOT_READINESS_MATRIX.md` and
`seed_sources.json`. Those files were preserved. This formatting stage prevents
the aggregate `npm run check` command from completing; the applicable checks
above were run separately.

Fresh-process regressions also pass for
[monetary accounting](../../.state/damage-verification/7080dc34-3a80-4b3d-a912-97cc50551219/report.json),
[Plan 01 assessment](../../.state/damage-reduction-verification/de14296d-8363-44f0-9b0b-244277554a4a/report.json),
[Plan 02 preview](../../.state/damage-reduction-preview-verification/43354229-17e6-421b-a08b-2ff1ac336422/report.json)
and the existing [four-point graph crash suite](../../tmp/langgraph-crash-verification/6f259d53-c03d-4cfc-863b-5d6e20a7d4e0/report.json).
Those commands used the completed build without rebuilding during execution.

The documented general verifier was run with the repository's normal
`--env-file-if-exists` flags and returned exit code 2. Its configured PM2.5
investigation charged four model calls and one tool call, then rejected model
action JSON containing the unsupported key `save_tool_result`. It retained an
evidence gap and produced no `pm25.capture`, so the source-execution criterion
failed. General task completion, restart, idempotency and World Model checks
passed. The [failure trace](../../.state/general-verification/8fa94567-c7a3-4107-97e2-65dc540ad1c5/report.json)
records this configured model/tool limitation separately from the passing
deterministic programme trace. No provider configuration was changed.

The fixture demonstrates coordination and recovery with supplied engineering
evidence. A configured live model trace, maximum supported live input bundle
and named non-synthetic scientific-owner review remain required before
advertising operational readiness or interpreting the ceilings as validated
production capacity. Programme/task completion grants no scientific
qualification or World Model acceptance.

## Engineering follow-up, 27 October 2026

The queued-downstream external-wait regression has already been corrected:
its downstream critic is admitted before parking execution. All **20 focused
external-wait-store tests** pass with Node 24.22.1. The four discovery files
listed in the original formatting failure now pass formatting. These
historical failures must not be read as current failures.

Actual browser verification now covers explicit assessment/planning admission,
exact source inspection, revision changes, stale outputs, history, manual
reload and fresh-process restart. Programme list rows now refresh after the
selected programme revision changes, and long result labels wrap within
mobile cards. The frontend build and **22 focused programme/preview UI tests**
pass. The retained [browser report](../../.state/damage-reduction-programmes-ui-recheck/report.json)
and [restart comparison](../../.state/damage-reduction-programmes-ui-recheck/restart-comparison.json)
record the original and resulting bindings, counts and screenshots.

The maximum-bundle handoff now retains the exact selected declaration as an
original artifact and passes its complete reference into assessment and
planning. Planning retains the complete candidate separately in its bounded
scope. Manager context deduplicates only redundant metadata for exact current
import references; canonical refs remain in the request/corrections, and
unique template briefs, source availability, objections and evidence gaps are
preserved. The resolver still requires the admitted original declaration;
an inline copy cannot replace it or bypass its hold. No ceiling was raised.

The retained [maximum fixture trace](../../.state/plan03-recheck-0cc21c8e42244fdb8417794424e3d018/fixture-envelope/damage-reduction-programme-envelope-verification/4aae5dc1-6d8f-47c9-a053-97717b31f8da/report.json)
passes **500 normalized rows, 16 numerical originals and exactly 524,288 bytes
of normalized input**, plus the retained selection declaration. The saved
programme snapshot is 7,749 bytes. Assessment and planning task durations were
11.020 s and 19.162 s; peak API RSS was 331,759,616 bytes. Exact readback passed
after restart. It used zero model calls, so it establishes only this fixture
envelope, not live model performance, every combination of contract maxima,
production throughput or comparative model quality.

The runtime now dispatches queued work after all required exact peer channels
exist rather than repeatedly calling Manager while runnable work waits.
Completed peer channels cover only their original participants; a later
checker still needs a new grant. Manager may request one charged correction
for a received malformed proposal; a corrected complete proposal must pass
the same schema, checkpoint, reference and authority validation. Provider
failures, unknown operations and authority failures remain fail-closed. No
proposal is executed before validation, and no reference or hash is filled in
by the runtime.

A completed coordinated Continue exposed a separate declaration handoff bug:
the successor reselected only the numerical sources and lost the admitted
operator declaration, making its result stale. Continue now re-pins the whole
exact `bound.selected_refs` set. Two focused regressions pass, including exact
successor readback after restart, immutable old-run output, withholding and
blocked continuation while the declaration is held, and recovery after that
same hold is cleared.

The general verifier now retains unsuccessful reports and model attempts and
requires actual charged provider receipts for live claims. A configured PM2.5
source execution produced a retained live Zetaris capture with zero returned
rows for its requested window. This verifies the source-execution path; it
does not supply missing observations or establish scientific accuracy.

See the [Plan 04 engineering follow-up](damage-reduction-04-implementation-report.md#engineering-follow-up-27-october-2026)
for current pilot/browser and repository recheck evidence. Scientific
qualification is unchanged. Unavailable pre-upgrade prose remains a historical
data limitation; it cannot be reconstructed from hashes. Prior previews remain
historical attachments, and their rejection as new factual evidence is an
intentional source boundary.

The final configured maximum-bundle
[live attempt](../../.state/plan04-live-recheck/live-capacity/damage-reduction-programme-envelope-verification/de3ac1a1-54aa-4585-a3cc-9beb030eaef4/report.json)
remains unsuccessful: its first model response exhausted the unchanged
1,200-token output allowance, and no tools ran. The successful maximum fixture
and final maximum-byte unit regression therefore do not close the maximum-live
capacity gate. The four-phase configured pilot and general live verifier also
remain unsuccessful, as detailed in the Plan 04 follow-up. These are operational
model-readiness limitations separate from Scientific qualification.

The earlier fair single-agent comparison gate is also still open. A frozen
three-case [configured comparison](../../.state/plan04-live-recheck/model-benchmark/e6fadec0-3bc2-4b45-af81-c9f05f38c31f/report.json)
used matching model, originals, kernel operations and 24 KiB limits, and all
six arms received real provider responses. However, the below-target baseline
overflowed its combined tool-result context before finalization, so that arm
cannot be graded as a model-quality failure or compared as successful latency.
The other results include a correct supported single-agent answer and
coordinated requests for already-retained data. The retained
[interpretation](../../.state/plan04-live-recheck/model-benchmark/e6fadec0-3bc2-4b45-af81-c9f05f38c31f/interpretation.md)
records the unsupported missing-data assertion and limitations. Provider
receipt coverage is complete; full fair usefulness/cost qualification and
monetary cost remain unestablished. No superiority or saving is claimed.
