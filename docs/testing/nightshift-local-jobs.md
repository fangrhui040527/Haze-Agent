# Manual Nightshift candidate jobs

Haze now has a manual-only job inbox at `/nightshift/:jobId?`. Direct inference
routing remains separate. A reachable Nightshift daemon is not enough: the
installed job contract and eligible ready compute must be available.
New job admission is blocked whenever the daemon, reviewed contract or eligible
compute is unavailable. New grants default to `cloud-ok` with no monetary cap.
The active Nightshift fleet selects compute; `cloud-ok` permits cloud and local
lanes. Existing local-only grants retain their original policy and $0 cloud spend.
See the latest
[recheck](../reports/nightshift/nightshift-02-local-jobs-recheck-report.md) for current
installation findings rather than treating an earlier lane inventory as live.

## Manual workflow

1. Create a task through the existing task interface/API, then attach a chain to
   its exact current task/run/objective/state revisions. Enrollment preserves
   the run's deadline, pinned routes and prior charges.
2. Choose the chain's cumulative allowance. Defaults are one Haze run, four jobs,
   sixteen requested attempts and 24 hours. Up to four total runs can be admitted
   for explicit user continuations. Automatic follow-ups always remain zero.
3. Submit a text `best_of_n` brief with exact input artifact references. Defaults
   are four attempts, accuracy judge, low budget, immediate execution and runtime
   selection. The reviewed runtime does not implement explicit fleet selection;
   its `fleet_id` is metadata, so the adapter rejects that option for new jobs.
   New grants allow cloud with no monetary cap, while jobs, requested attempts
   and absolute lifetime stay bounded. An explicit local-only grant requires
   zero cloud spend. Jobs must match their chain's saved policy. The installed
   CLI rejects positive cloud ceilings because it cannot enforce them; uncapped
   cloud submissions omit `--max-spend` rather than passing zero.
4. Observe persisted execution, judging outcome and receipt state independently.
   Closing the page or stopping browser observation does not cancel compute.
   The server supervisor reconnects to acknowledged IDs after restart.
5. Select a retained candidate explicitly using current authority and exact
   hashes/dependencies. This records an unreviewed dependency, without a graph
   wakeup, evidence acceptance or automatic successor. Only a current independent
   EvidenceCritic receives candidate text in model context; Manager and other
   roles receive reference/review metadata. Registered domain methods and review
   requirements still apply.

Continue and Resume preserve cumulative usage and absolute expiry. Continue
cannot replenish an enrolled chain's run/resource allowance. Closing a grant
does not make the same admitted run eligible for a larger grant; additional
authority currently requires a separately admitted task. A paused, expired,
revoked, corrected or superseded authority cannot select stale output, while
historical output remains readable to its original local owner.

## Recovery and cancellation

Submission intent and resource reservations commit before the CLI is invoked.
Acknowledgements are persisted separately. Unknown submissions retain their
reservations and are never automatically repeated, including after restart or
unchanged HTTP redelivery. Repeating a mutation uses its original body and
`Idempotency-Key`; changing content under the same key fails.

Explicit reconciliation requires an authenticated native job record with the
exact server-generated ownership nonce, prompt/messages and admitted options.
The adapter verifies a unique matching native job. It does not use model output,
similar prompt text or timestamps as proof. Missing, conflicting or oversized
native metadata leaves the submission unknown. Linking an already accepted job
does not require an available lane for new generation.

Cancellation intent is durable before invoking the adapter. The inspected
runtime marks a record cancelled before provider termination is proven, so a
cancel acknowledgement or cancelled label leaves capacity reserved. There is
no automatic cancellation retry under this unverified retry contract. A verified
terminal observation releases compute capacity; it does not erase charged
attempts, unknown accounting or receipt-retention reservations.

Capture is a separate historical ingestion path. It preserves original task,
run, generation, objective, assignment, route and exact inputs even after task
controls invalidate current authority. Capturing a receipt creates no current
applicability, published task artifact or accepted evidence. Estimated native
token counts are retained separately from actual usage; missing actual usage
stays null.

## API

All routes use the existing local identity/workspace and same-origin boundary.
POST requests require JSON, `Idempotency-Key` and versioned bodies. Controls,
reconciliation and selection require current revisions.

| Route                                     | Methods / purpose                                                |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `/api/nightshift/readiness`               | GET: existing sanitized agent-route readiness                    |
| `/api/nightshift/jobs/readiness`          | GET: CLI, schema, runtime, local compute and policy capabilities |
| `/api/nightshift/chains`                  | GET / POST: bounded grant list and explicit admission            |
| `/api/nightshift/chains/:id`              | GET: grant, usage, remaining allowance and stop reason           |
| `/api/nightshift/chains/:id/control`      | POST: pause, resume, cancel or close                             |
| `/api/nightshift/jobs`                    | GET / POST: latest 100 bounded summaries and manual submission   |
| `/api/nightshift/jobs/:id`                | GET: persisted job, original provenance, output and diagnostics  |
| `/api/nightshift/jobs/:id/events?after=N` | GET: cursor-based events, at most 100 per page                   |
| `/api/nightshift/jobs/:id/cancel`         | POST: request cancellation                                       |
| `/api/nightshift/jobs/:id/reconcile`      | POST: verified linkage of an unknown submission                  |
| `/api/nightshift/jobs/:id/select`         | POST: exact unreviewed dependency selection                      |

The browser polls saved state only. Two due jobs are inspected per supervisor
tick; reads have deadlines and persisted backoff. Failed or missing output stays
visible without creating an unbounded local submission queue. Global admission
defaults are two nonterminal external jobs and eight open chains; these are
separate from Haze's task and specialist limits. Inspect local interactive
provider latency before increasing external concurrency.

## Verification commands

```sh
npm run build
npm run nightshift:verify                 # read-only schema/runtime inspection
npm run nightshift:verify -- --live        # one explicitly requested local attempt
npm run nightshift:test:crashes            # fake external service, real process kills
```

The live verifier uses a unique `.state/nightshift-verification/<id>/state`
directory, pins both state-directory environment settings and submits only a
synthetic brief. A remote acknowledgement is not reported as successful inference.
This live verifier explicitly requests local-only/$0, so an unavailable local
lane blocks its attempt even when cloud candidate jobs are ready. It never
changes fleets or silently converts that verification request to cloud.

For source-mode crash checks while unrelated work prevents a build, set
`HAZE_NIGHTSHIFT_VERIFY_SOURCE=1`. Workers load the current backend via Vite SSR
without application plugins or a listening server. Their external service is a
fixture; passing these checks is recovery/control evidence, not live inference.

See the [implementation report](../reports/nightshift/nightshift-02-local-jobs-implementation-report.md)
for the retained live failure, recovery evidence and remaining release gates.
