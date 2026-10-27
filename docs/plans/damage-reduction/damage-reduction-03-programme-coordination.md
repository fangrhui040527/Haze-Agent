# Damage-reduction plan 03: programme coordination

Status: engineering coordination implemented on 27 October 2026, with synthetic multi-run, correction, restart and crash-before-dispatch verification. See the [implementation report](../../reports/damage-reduction/damage-reduction-03-implementation-report.md). Scientific qualification and configured live-model readiness remain outstanding.

Depends on [02 — Conditional planning preview](damage-reduction-02-planning-preview.md). Follow the [roadmap](damage-reduction-planning-plan.md) and shared [persistence](../../architecture/damage-reduction/damage-reduction-reference.md#programme-persistence-and-phase-transitions), [admission](../../architecture/damage-reduction/damage-reduction-reference.md#admission-transaction-and-recovery) and [resource](../../architecture/damage-reduction/damage-reduction-reference.md#resource-envelope) rules. Next: [04 — Pilot and delivery](damage-reduction-04-pilot-delivery.md).

## Outcome and scope

Let a local operator save a programme and coordinate multiple bounded assessment/planning runs without losing revisions, provenance or current-result status after restart. Existing tasks remain authoritative for execution. This post-hackathon stage adds coordination, not pilot registration, live digital delivery, evaluation records, new scientific methods or automatic follow-up runs. Explicit starts govern agent phases; they do not require manual approval of each future digital action within an agreed service rule.

The preview from Plan 02 remains usable independently. An operator may explicitly attach an existing preview as historical context after identity, mode and exact-reference checks; that attachment does not recreate its admission reservation or automatically make its result current for a programme.

## Ownership and implementation

The programme capability owns domain contracts, repositories, applicability and projections. `app/tasks/` exposes generic transaction/admission/control boundaries. `app/composition.ts` supplies the domain handlers and guards. Browser contracts stay in `app/contracts/`; the dedicated page consumes server projections.

1. Add versioned programme snapshots, append-only revisions, a current revision pointer, phase-attempt links and operation receipts on the existing SQLite connection. Partition by principal, workspace and execution mode. Use additive migrations; preserve all existing task and preview history.
2. Store each link's programme revision, phase kind, exact task/run IDs, admitted objective revision, selected artifact references and canonical relevant-input fingerprint. Programme revisions provide optimistic concurrency; fingerprints determine applicability. Unrelated notes must not stale an assessment. Material input changes invalidate affected descendants for the changed use while preserving history.
3. Derive phase status/results from linked task/run records, including terminal runs, on reads. Any cache is rebuildable. Never follow `task.current_run_id` implicitly or depend on a second completion queue. Recheck source permissions, holds, reviews and withdrawals even without a programme edit.
4. Atomically persist revision, task admission, phase binding, cumulative reservation and idempotent receipt. Schedule only after the outer commit; discard callbacks on rollback. A dispatch failure after commit leaves the same durable queued task and receipt. Existing dispatcher/startup recovery handles execution; programme reads reconstruct completed results.
5. Guard both programme routes and generic task update/control routes before scheduling a changed objective or successor run. Revalidate inputs, attempt limits and budgets before binding the successor. Resume of an unchanged run retains its original deadline/reservation. Corrections fence affected results immediately; replacements are explicit operator actions. Unknown remote outcomes remain charged under existing controls.
6. Add the programme list/read/history/revisions/phases/records routes through a composition-provided handler. The records route initially accepts bounded notes and exact artifact attachments; Plans 04-05 add their typed families. All mutations require bounded input, an idempotency key and expected revision. Keep local identity server-owned. Add `/damage-reduction/programmes/:programmeId` with programme selection, history, phase/task links, remaining capacity and stale/gap explanations; retain Plan 02's saved-task URLs.

Use the reference's proposed programme ceilings: one active phase, three admitted attempts per phase, twelve admitted runs overall, and 400 charged model/tool calls each. Reserve admitted run maxima, reconcile authoritative usage and release only unused terminal reservations. Validate these defaults with measured traces before advertising readiness; retain existing global runtime limits. No automatic new-run retries.

## Verification and definition of done

Check isolation, additive migration, duplicate requests, concurrent edits, partial rollback, crash before dispatch, committed dispatch failure and task completion before programme read. Verify exact linked-run reconstruction, unchanged-note freshness, dependency invalidation, source holds, cancellation, late output and restart. Exercise direct task-API attempts to bypass successor/budget guards and exhausted reservations.

The stage is complete when two explicitly started bounded runs can contribute to one programme, with correct current/historical status through correction and restart. Capture fresh focused, repository-required and fresh-process checks. Programme/task completion must not create scientific qualification or World Model acceptance.
