# Documentation

Start with the [project README](../README.md) for setup and current behavior.

## Architecture

- [Nightshift integration roadmap](architecture/nightshift-integration-plan.md) - all four stages have implementation reports; live inference gates and production automatic release remain pending.
- [Nightshift external waits implementation report](architecture/nightshift-03-external-waits-implementation-report.md) - explicit specialist grants, targeted delivery, durable capacity and FIFO recovery verification.
- [Nightshift automatic chains implementation report](architecture/nightshift-04-automatic-chains-implementation-report.md) - explicit finite opt-in, shared continuation admission, cumulative grants, delegated inboxes, progress checks and the closed production release gate.
- [Executable LangGraph runtime](architecture/langgraph-runtime.md) — independent Manager and specialist graphs, receipts, waits, recovery and authority fences.
- [v0.14 schema catalog and implementation audit](architecture/schema-catalog-v014.md) - schemas by component, fields, source evidence and implementation gaps.
- [Haze Agent Architecture v0.14](architecture/Haze_Agent_Architecture_v0.14.pdf) — target architecture.
- [General agent refactor plan](architecture/general-agent-refactor-plan.md) — proposed reusable task engine and separate agent modules.
- [DamageAccountant implementation plan](architecture/damage-accountant-plan.md) — specialist, linked accounting capability, integration phases and release checks.
- [Damage-reduction roadmap](architecture/damage-reduction-planning-plan.md) — five bounded plans, beginning with an assessment and conditional-planning preview; shared scientific and lifecycle requirements remain in the linked reference.
- [Hybrid Architecture v0.1](architecture/Haze_Hybird_Architecture_v0.1.pdf) — supplied architecture reference.
- [Architecture v0.8](architecture/haze-architecture-v0.8.html) — historical HTML reference.

## Evidence

- [v0.14 PM2.5 milestone](evidence/milestone-v014.md) — historical v1 task API, implementation and limitations.
- [PM2.5 evidence source](evidence/pm25-evidence-source.md) — source inspection, provenance and coverage limits.
- [Haze Damage Account Report](evidence/Haze_Damage_Account_Report.pdf) — supplied report.

## Orchestration

- [Isolated Manager testing](Testing/manager-testing.md) - interactive live Manager chat, focused unit checks and synthetic specialist scenarios.
- [World Model control plane](Testing/world-model-control-plane.md) - inspect retained records, rebuild SQLite projections, run the original Meterless sandbox and verify the integration.
- [General task engine](orchestration/general-engine.md) - current v3 protocol, ownership, controls and recovery.
- [LangGraph implementation report](orchestration/langgraph-implementation-report.md) — baseline, runtime migration verification and remaining release gates.
- [LangGraph cutover and rollback](orchestration/langgraph-cutover-runbook.md) — explicit state-copy migration and matching executable/snapshot recovery.
- [World Model data model](05-world-model-data-model.md) — legacy HazeOps storage and the active v3 model, acceptance, and access boundaries.
- [General engine verification](orchestration/general-engine-verification.md) - release checks and explicit fixture/live evidence.
- [DamageAccountant implementation report](orchestration/damage-accountant-implementation-report.md) - imported accounting, independent checks, task integration and empirical release gates.
- [Imported scenario assessment implementation report](architecture/damage-reduction-01-implementation-report.md) - Plan 01 changes, exact numerical rules, independent checks, retained restart evidence and remaining qualification gates.
- [Conditional planning preview implementation report](architecture/damage-reduction-02-implementation-report.md) - Plan 02 planning/reviews, dedicated task routes, current support, verification traces and remaining live/scientific gates.
- [Programme coordination implementation report](architecture/damage-reduction-03-implementation-report.md) - Plan 03 programme persistence, explicit phase admission, cumulative budgets, current and historical results, restart and crash verification.
- [Pilot and delivery implementation report](architecture/damage-reduction-04-implementation-report.md) - Plan 04 feasibility/protocol drafts, registration, amendments, exact imported delivery evidence, verification and deferred live-service integration.
- [External evaluation implementation report](architecture/damage-reduction-05-implementation-report.md) - Plan 05 engineering path, independently checked external comparisons, scientific adoption, current claim gates and reviewed learning; non-synthetic operational release remains gated.
- [World Model damage input adapter](orchestration/world-model-damage-input-adapter-report.md) - request-only accounting, exact evidence selection, provenance checks and the Jev assessment.

The v1/v2 guides below are retained historical records.

- [Scaffold guide](orchestration/orchestration-scaffold.md) — historical v2 runtime and API.
- [Component adapters](orchestration/orchestration-adapters.md) — teammate integration contracts.
- [Readiness register](orchestration/orchestration-readiness.json) — component stages, evidence and prerequisites.
- [Verification record](orchestration/orchestration-verification.md) — historical scaffold checks and their scope.

## Infrastructure

- [Engine pins](infrastructure/engine-pins.md) — pinned sources, builds and update checks.
- [Compatibility probe](infrastructure/compatibility-probe.md) — engine, model and checkpoint compatibility checks.

## Zetaris

- [Connections and client setup](Zetaris/connections/README.md).
- [Installation guide](Zetaris/install/updated_zetaris_installation_guide.md).
- [SQL command reference](Zetaris/guides/zetaris-lightning-sql-commands.md).
- [SQL companion](Zetaris/guides/zetaris-lightning-sql-companion.md).

## Frontend

These documents record frontend discovery and design decisions. The first two describe historical proposals; consult the project README for current behavior.

- [01 — Project understanding](frontend/01-project-understanding.md)
- [02 — Critique and reality check](frontend/02-critique.md)
- [03 — UI design](frontend/03-ui-design.md)

## History

- [Legacy retirement](history/legacy-retirement.md) — removal of the v0.13 scheduling workflow and its verification record.
