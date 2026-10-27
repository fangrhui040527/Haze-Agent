# Nightshift local jobs implementation report

Date: 27 October 2026, Asia/Singapore.

The manual job backend, durable grants, supervisor, receipt ingestion,
reconciliation, candidate selection and UI are implemented. **The live release
gate remains unmet:** this installation has no eligible ready local text lane.
One real job was acknowledged but failed with
`privacy_floor_refuses_pinned_model`; no usable generated output was produced.
Cloud spending and automatic follow-ups remain disabled.

## Changes delivered

| Area                     | Resulting behavior                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts and port       | Added browser-safe versioned admission/control/job/event/provenance schemas, bounded inbox summaries and a narrow `NightshiftJobPort`. Concrete transport registration stays in composition.                                                                                                                                                |
| CLI adapter              | Installed executable/`ns.mjs` discovery, invocation without a shell, bounded stdin prompts and stdout, strict envelope parsing, runtime/schema discovery and server-side authentication. Read-only control-plane discovery supplies eligible fleets/local-lane readiness.                                                                   |
| Policy enforcement       | Only local-only text `best_of_n` with $0 cloud spend is admitted. Options are checked against the installed/running contract. Schema availability, reachability, privacy enforcement, local compute and reconciliation capability are distinct states.                                                                                      |
| Durable admission        | Added versioned migrations for chains, immutable grants, enrolled runs, submission attempts, reservations, native observations, deliveries, selections and idempotent mutation receipts. Intent, original authority and capacity/attempt/retention reservations commit before dispatch; acknowledgements commit separately.                 |
| Chain envelope           | Default one run, four jobs, sixteen requested attempts, 24 hours and zero automatic follow-ups. Explicit manual admission can authorize up to four total Haze runs. Existing charges and pinned routes are preserved on enrollment. Continue consumes the same cumulative resources and absolute expiry rather than replenishing authority. |
| Shared task controls     | Pause freezes submissions; cancel/revoke close authority and request cancellation of known jobs; objective correction invalidates the old grant. Resume preserves a separately requested chain pause. Known jobs remain observable after task controls.                                                                                     |
| Admission bounds         | Defaults are two nonterminal external jobs and eight open chains, separately configurable from task/specialist capacity. Submitting, unknown and cancellation-unconfirmed work retains capacity. No unbounded local submission queue was introduced.                                                                                        |
| Supervisor               | Runs under the existing Haze owner, independently of browsers and active graph execution. It resumes acknowledged IDs after restart, persists read backoff/cursors and processes at most two due jobs per tick from a bounded query. Polls never submit replacements.                                                                       |
| Reconciliation           | Uses an immutable server-generated nonce plus exact authenticated native prompt/messages/options and a unique matching native job. Similar text, timestamps, model output, missing metadata or duplicate nonces do not establish ownership. Recorded reconciliation redelivery does not repeat verification or submission.                  |
| Cancellation             | Intent and the single-dispatch fence are durable. The inspected runtime's cancelled label does not prove provider termination, so acknowledgement alone does not release capacity. There is no automatic cancellation retry under this contract. Verified terminal failure/completion can release compute capacity.                         |
| Historical capture       | A narrow ingestion path authenticates the stored remote mapping and atomically retains an immutable derived candidate and deduplicated delivery under original task/run/objective/assignment/input identities. It uses its original retention reservation, including after cancellation, correction, expiry or a newer run.                 |
| Explicit selection       | Current revisions, deadline, permissions, hashes, dependencies, policy, citations and remaining authority are revalidated. Selection remains unreviewed and requires independent review. It creates no applicability, accepted evidence, published task artifact, graph wakeup or successor.                                                |
| Authorized review input  | Selected exact dependencies are available to the current model context. Only EvidenceCritic receives candidate text; other roles receive reference/review metadata. Ordinary task admission/context updates and applicability promotion cannot bypass selection using the candidate artifact directly.                                      |
| Receipts and diagnostics | Execution, judge outcome, receipt availability and cancellation confirmation remain separate. Native `errored`/`sealed` states normalize to failed/completed. Safe native failure diagnostics survive later retrieval errors. Missing actual usage stays null; reported estimated tokens are labelled separately.                           |
| UI and API               | Added manual chain/job controls, bounded forms, persisted inbox/details, deep links, cursor events, provenance, remaining grants and stop reasons. Generated text is escaped. Stopping browser observation, cancelling a job and closing a chain are distinct controls.                                                                     |

Primary new implementation files:

- `app/adapters/nightshift/jobs.ts`.
- `app/contracts/nightshift.ts`, `nightshift-records.ts` and `nightshift-list.ts`.
- `app/tasks/nightshift-store.ts`, `nightshift-service.ts` and `nightshift-http.ts`.
- `frontend/src/features/nightshift/` job forms, details, API client and page.
- `scripts/verify-nightshift-jobs.mjs`, `verify-nightshift-crashes.mjs` and
  `nightshift-crash-worker.mjs`.

Integration changes are in `app/composition.ts`, orchestration ports, task
runtime/store/HTTP, frontend routing/navigation, npm scripts and `.env.example`.
The [operation guide](../Testing/nightshift-local-jobs.md) documents the flow,
endpoints, limits and verification commands.

## Live findings and retained evidence

The daemon is reachable and the reviewed job privacy contract is available.
Authenticated discovery found three ready lanes, all cloud lanes. The selected
`imported-v2` fleet pins cloud models. No eligible local text lane is ready.
Readiness now returns `ready:false` and `local_compute_available:false`, with an
explicit Nightshift cockpit setup reason. Reconciliation capability remains
independent of availability for new generation.

The single real attempted job was:

- Local handle: `80f37e1f-d4dc-4a85-98a1-45bc6aa81e36`.
- Native ID: `job_mvpqr48701`.
- Request: one attempt, accuracy judge, low budget, immediate execution,
  local-only, $0 cloud spend, a synthetic two-sentence brief.
- Native result: `errored`, one failed attempt, no candidate or clusters,
  `privacy_floor_refuses_pinned_model`.

The privacy restriction prevented cloud execution. Recovery from the existing
acknowledged mapping preserved the original fingerprint and made **zero new
submissions**. Current normalized state is failed; compute capacity is released,
while one requested attempt and the original retention reservation remain
recorded. No missing output or usage was represented as a successful candidate.

A final read-only reconciliation-proof check against this actual native record
passed: the stored server nonce, full request and unique native identity matched.
It created no new submission or mapping. This validates the native proof path
independently of the unavailable generation lane; it is not a successful output
or review claim.

Evidence is retained under:

- `.state/nightshift-verification/ffc7c666-a7af-40da-b28c-ef6193b76d37/report.json`
  — request, acknowledgement, observations and failed live verification.
- The same directory's `recovery-report.json` — updated source-backed readiness,
  retained failure code, capacity/accounting state and unchanged fingerprint.
- The same directory's `ownership-proof-readback.json` — successful exact native
  request/nonce proof, with zero new submissions.
- `tmp/nightshift-readonly-source-report.json` — independent read-only adapter
  confirmation of reachability, unavailable local compute and native failure.
- `tmp/nightshift-crash-verification/c009500a-1c78-45b9-957a-d15a667a6792/report.json`
  — seven passing process-crash scenarios against the compiled fixture service.
- `tmp/nightshift-crash-verification/8854f5cf-322a-4a75-a122-d6ec0c57318d/report.json`
  The same seven scenarios passed against the latest source via Vite SSR.
  An earlier source-mode attempt exceeded its startup deadline; that failed
  report is retained. Only source-worker startup allowance changed from 15 to
  45 seconds. Fixtures, grants, budgets and assertions were unchanged.

Early verifier failures before submission are also retained in sibling
verification directories. The verifier was corrected to keep its report outside
the task database directory and use a task-owned observation-only test carrier,
so the general Manager graph cannot race the test's manually pinned revisions.
All plan-2 verification used explicitly isolated state; no fixture tasks were
added to the app's normal state directory during this task.

## Validation

| Check                                   | Recorded result                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final full backend unit suite           | **801 tests passed**, 70 files, using four workers. Repository-wide total, including concurrent non-Nightshift work.                                                                                                               |
| Focused backend and related regressions | **123 tests passed**, eight files: adapter, job store/service/HTTP, existing task store/runtime/HTTP and routing persistence.                                                                                                      |
| New adapter tests                       | **32 passed**, including local readiness, exact reconciliation, normalization, bounds, redaction and estimated usage. Included in the focused count.                                                                               |
| New store/service tests                 | **25 passed**: fifteen store and ten supervisor tests. Included in the focused count.                                                                                                                                              |
| HTTP                                    | Nightshift dispatcher and isolated handler tests passed, including identity, origin, idempotency, schema, query and cursor checks. No real jobs were submitted by HTTP tests.                                                      |
| Final frontend checks                   | Production build passed; **214 tests passed**, with one opt-in local-server readback test skipped by default. Focused Nightshift checks were **16 passed**, plus that skipped manual test.                                         |
| Process-crash fixture                   | All seven SIGKILL/reopen scenarios passed against the latest source. No duplicate submission, artifact, delivery, selection or wakeup occurred.                                                                                    |
| Live generation                         | **Failed**, retained honestly: the acknowledged local-only request was refused by its cloud-pinned fleet. Acknowledgement was not counted as provider inference.                                                                   |
| Final build/typecheck/lint              | Backend build, TypeScript --noEmit and whole-repository lint passed on the verified snapshot. Concurrent unrelated work continued afterward. Frontend retained existing chunk-size/dynamic-import warnings.                        |
| Formatting/diff                         | Changed implementation/report files passed Prettier and git diff --check.                                                                                                                                                          |
| Earlier broad checks                    | Initially failed during concurrent damage-planning edits and a missing-dist subprocess run. Those failures were retained; the final sequential build and full-test rerun above passed. Unrelated domain files were left untouched. |

The passing backend test run started at 05:27 Singapore time. A later whole-repository
format check encountered continuing unrelated programme edits, including a syntax
error in `frontend/src/features/damage-reduction/ProgrammeViews.tsx` and formatting
warnings in other damage-planning/data-discovery files. Those files were left
untouched. The results above describe the checked snapshot, not a claim that later
concurrent edits passed verification.

The browser check found and fixed a real client bug: storing native `fetch`
directly and calling it as a class method supplied the wrong browser receiver.
A receiver-sensitive regression now covers the wrapper. Saved records load
independently of slower CLI readiness, so a readiness failure cannot hide the
historical inbox. Snapshot/deep-link verification is performed against a copy of
the isolated failed-job database. The browser displayed blocked local readiness,
the retained native privacy diagnostic, progress cursors, original provenance
and expired grant accounting without console errors. Stopping browser
observation visibly left server work independent. The isolated development
server was stopped after verification.

ESLint now ignores `frontend/dist/**`, so a production build cannot remove
generated files while source lint traverses them. Source lint remains enabled.
A final projection guard also prevents an unreviewed candidate from entering the
World Model indirectly through a review artifact's dependency list.

No genuine generated output, live result receipt or successful local-job quality
claim is made. Fixtures establish control/recovery behavior, not reasoning or
source quality. The earlier routing plan's direct-inference and role-evaluation
gates remain separate and unchanged.

## Remaining limits and release gates

An eligible local model/lane/fleet must be configured in Nightshift's cockpit,
then the bounded live verifier must capture a real request, acknowledgement,
progress, output, judge outcome, receipt and restart readback. Haze does not
install models, change fleet definitions or enable cloud use to obtain this pass.

After closing an enrolled grant, increased authority currently requires a
separately admitted task rather than silently refreshing the same run. Historical
inbox lists show at most 100 summaries; known job deep links remain inspectable.
Cancellation remains unconfirmed where the installed runtime cannot prove
provider termination. Exact reconciliation fails closed when native proof is
missing, ambiguous, duplicated or outside its bounded inspection.

Successful live local-job evidence remains outstanding. The combined all-in-one
`check` command and legacy live-quality integration gates are not claimed as
passed by the unit/build results above. Agent submission tools, external waits,
capacity parking,
automatic wakeups and automatic successor chains were not enabled.
