# Nightshift integration roadmap

Status: all four plans have implementation reports; live inference gates remain unmet.
Plan 4 automatic chains remain behind a closed production release gate. The specifications and fixture checks
do not establish live readiness. See the reports for
[routing](nightshift-01-routing-implementation-report.md),
[manual jobs](nightshift-02-local-jobs-implementation-report.md) and
[external waits](nightshift-03-external-waits-implementation-report.md) and
[automatic chains](nightshift-04-automatic-chains-implementation-report.md).

## Delivery sequence

Implement and verify each plan before enabling the next phase. Routing, background-job visibility and manual consumption are independently useful before automatic continuation is available.

| Order | Implementation plan                                                                         | Delivered behavior                                                                                                       | Gate before the next phase                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1     | [Routing with role-specific evaluation](nightshift-01-routing-plan.md)                      | Admission-pinned provider/model routes for every Haze task and registered role, sanitized readiness and actual receipts. | Provider contracts, replay identity and captured role-specific decision quality pass.                                          |
| 2     | [Local jobs with basic visibility and manual consumption](nightshift-02-local-jobs-plan.md) | Durable local jobs, manual-only grants, restart monitoring, historical result capture and a usable Nightshift screen.    | Acknowledged jobs recover; unknown submissions are never replayed; manual consumption preserves authority and evidence checks. |
| 3     | [External waits and capacity handling](nightshift-03-external-waits-plan.md)                | Granted agent job tools, targeted waits, required-job dependencies, fair capacity reacquisition and durable delivery.    | Concurrent completions, restart, admission bounds and authority fences pass without automatic successors.                      |
| 4     | [Opt-in automatic chains](nightshift-04-automatic-chains-plan.md)                           | Explicitly authorized, finite linked runs under one cumulative grant, with progress checks and stop reasons.             | Mixed manual/automatic accounting, one-successor guarantees and real end-to-end traces pass.                                   |

Each linked document has its own implementation scope, contracts, verification and exit gate. Earlier phases do not implicitly enable later behavior. The full UI grows with the phases instead of waiting until automatic chains are implemented.

## Intended use and evidence boundary

Use Nightshift background generation initially for:

- Evidence-linked drafts using exact Haze-provided source references.
- Alternative explanations that retain their evidence, assumptions and uncertainty.
- Critique candidates to inform a separately authorized review.

Source retrieval, numerical calculations, deterministic scientific methods and independent checks continue through registered Haze capabilities. Nightshift output is service-produced, derived, untrusted material. Neither best-of-N agreement nor a Nightshift judge substitutes for EvidenceCritic, establishes source authenticity, grants applicability or satisfies Haze evidence acceptance.

Keep Haze responsible for task coordination, admission, permissions, budgets, schema validation, artifact applicability, independent review and finalization. Nightshift supplies inference and external compute.

## Required architectural boundaries

| Requirement                               | Planning commitment                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One authoritative chain grant             | Plan 2 establishes the immutable manual-only envelope; plan 3 preserves it during waits and manual controls; plan 4 enforces cumulative Haze and job allowances across every manual and automatic successor. Continue and Resume never replenish a same-chain grant.                         |
| External waits change admission policy    | Plan 3 distinguishes external-only waits from human/peer/mixed waits, releases permits only when verified, atomically reacquires capacity, bounds outstanding work and uses a durable fair ready queue.                                                                                      |
| Capture is separate from current evidence | Plan 2 adds historical receipt ingestion with original run/objective/assignment/input identities. Plans 3-4 require current authority, applicability and review before consumption; late outputs never bypass current-execution checks.                                                      |
| Routes are pinned for all tasks           | Plan 1 snapshots effective inherited or explicit routes for ordinary tasks as well as future chains, and binds route identity into operation fingerprints before dispatch. Configuration changes cannot silently remap admitted work.                                                        |
| Dependency direction stays explicit       | Adapters implement transport. Tasks own policy, reservations, lifecycle and delivery. Orchestration supplies restricted interfaces and workflows. Contracts hold browser-safe schemas. Composition registers implementations. Existing graph infrastructure remains the execution mechanism. |

Concrete Nightshift transport belongs in `app/adapters/nightshift/`. Task lifecycle and the supervisor belong in `app/tasks/`. Register tools and inject adapters through `app/composition.ts`; domain behavior stays in `app/capabilities/` and `app/agents/`. Do not give agents CLI access, credentials, database handles or arbitrary remote endpoints.

## Shared defaults and policies

These are proposed implementation defaults, not claims about the installed daemon's current settings. Resolve and persist admitted limits; users may lower them.

| Limit or policy                               | Default                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Active Haze tasks / shared specialists        | Preserve two / two; parked external waits use a distinct bounded backlog.                                                                                                                                                      |
| Global nonterminal Haze-owned Nightshift jobs | Two, including queued, unknown-submission and cancellation-unconfirmed jobs until verified terminal or reconciled.                                                                                                             |
| Global open chains, including parked chains   | Eight, sharing one cap; parking does not free an open-chain place.                                                                                                                                                             |
| Total admitted runs / automatic follow-ups    | One run and zero automatic follow-ups by default. Explicit admission may authorize at most four total runs; only plan 4 opt-in permits up to three automatic follow-ups. Manual and automatic successors share the same total. |
| Jobs / total requested attempts per chain     | At most four / sixteen; reserve before submission.                                                                                                                                                                             |
| Absolute chain lifetime                       | At most twenty-four hours from admission; pauses, downtime and successors do not renew it.                                                                                                                                     |
| Default job                                   | Text `best_of_n`, four attempts, accuracy judge, low budget, immediate execution and runtime-selected fleet.                                                                                                                   |
| Job privacy and cloud spend                   | Local-only and $0. Cloud submission stays disabled until enforceable runtime caps are verified.                                                                                                                                |

Keep one open chain per task. A manual-only chain defaults to one run and zero automatic follow-ups; extra user-triggered runs must be explicitly included at admission. Increasing an existing grant requires separate explicit admission after closing it. Reserve cumulative Haze resources from the resolved investigation profile and admitted total run count, with per-call bounds and protected synthesis/review resources. Enrollment preserves the current run's admitted limits and existing charges. Logical budget authority is separate from active execution permits.

Unknown outcomes stay charged or reserved. The CLI's idempotency flag is not remote submission deduplication. Never automatically replay an unacknowledged submission; require explicit reconciliation against a verified remote job.

Cloud additionally requires server permission, explicit opt-in and a user-entered cap with no positive prefill. Haze must keep spent plus outstanding allocated caps within the chain cap, and Nightshift must enforce each allocation. Advertised flag support alone is insufficient. Direct agent-provider inference has separate Haze call/token limits and routing policy; the job cap must not be presented as covering those calls.

Use versioned additive SQLite migrations in the authoritative task database, preserve existing public task protocols and replay guards, and never reinterpret historical results or silently enable new behavior on old tasks. All mutations require stable idempotency keys; controls require current revisions and existing server-owned identity/workspace authorization.

## Readiness and rollout evidence

Distinguish CLI/schema availability, daemon reachability, supported runtime capabilities, provider compatibility and captured live behavior. The prior read-only inspection found the installed CLI schema available and the daemon unreachable. That is a historical observation, not a readiness guarantee; each phase must record fresh verification.

Each phase runs checks appropriate to its changes. Fixtures and isolated crash/restart checks establish control behavior; genuine Manager, specialist and background-job traces establish live integration. Role-specific evaluation must support route choices rather than assuming that more candidates or a different provider improve quality.

Jobs may continue inside Nightshift while Haze is offline. Monitoring, result delivery and eligible Haze execution resume when the server restarts. No phase installs an operating-system service, adds a hosted orchestration dependency or changes the existing local single-owner boundary. Model installation, lane administration and native Nightshift schedules remain in its cockpit.

See the [Nightshift control demo](../Testing/nightshift-controls.md) for existing standalone inspection and synthetic/live control examples. The demo does not establish that these integration plans have been implemented.
