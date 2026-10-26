# Documentation

Start with the [project README](../README.md) for setup and current behavior.

## Architecture

- [Haze Agent Architecture v0.14](architecture/Haze_Agent_Architecture_v0.14.pdf) — target architecture.
- [General agent refactor plan](architecture/general-agent-refactor-plan.md) — proposed reusable task engine and separate agent modules.
- [Hybrid Architecture v0.1](architecture/Haze_Hybird_Architecture_v0.1.pdf) — supplied architecture reference.
- [Architecture v0.8](architecture/haze-architecture-v0.8.html) — historical HTML reference.

## Evidence

- [v0.14 PM2.5 milestone](evidence/milestone-v014.md) — historical v1 task API, implementation and limitations.
- [PM2.5 evidence source](evidence/pm25-evidence-source.md) — source inspection, provenance and coverage limits.
- [Haze Damage Account Report](evidence/Haze_Damage_Account_Report.pdf) — supplied report.

## Orchestration

- [General task engine](orchestration/general-engine.md) - current v3 protocol, ownership, controls and recovery.
- [World Model data model](05-world-model-data-model.md) — legacy HazeOps storage and the active v3 model, acceptance, and access boundaries.
- [General engine verification](orchestration/general-engine-verification.md) - release checks and explicit fixture/live evidence.

The v1/v2 guides below are retained historical records.

- [Scaffold guide](orchestration/orchestration-scaffold.md) — historical v2 runtime and API.
- [Component adapters](orchestration/orchestration-adapters.md) — teammate integration contracts.
- [Readiness register](orchestration/orchestration-readiness.json) — component stages, evidence and prerequisites.
- [Verification record](orchestration/orchestration-verification.md) — historical scaffold checks and their scope.

## Infrastructure

- [Engine pins](infrastructure/engine-pins.md) — pinned sources, builds and update checks.
- [Compatibility probe](infrastructure/compatibility-probe.md) — engine, model and checkpoint compatibility checks.

## Frontend

These documents record frontend discovery and design decisions. The first two describe historical proposals; consult the project README for current behavior.

- [01 — Project understanding](frontend/01-project-understanding.md)
- [02 — Critique and reality check](frontend/02-critique.md)
- [03 — UI design](frontend/03-ui-design.md)

## History

- [Legacy retirement](history/legacy-retirement.md) — removal of the v0.13 scheduling workflow and its verification record.
