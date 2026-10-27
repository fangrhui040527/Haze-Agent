# Documentation

Start with the [project README](../README.md) for setup and current behavior.

## Start here

- [General task engine](orchestration/general-engine.md): execution, ownership, controls and recovery.
- [Architecture and specifications](architecture/README.md): runtime, World Model, schemas and supplied references.
- [Test the Manager in isolation](testing/manager-testing.md) and [inspect the World Model control plane](testing/world-model-control-plane.md).
- [View the damage account demo](guides/damage-account-demo.md).
- [View the damage reduction demo](guides/damage-reduction-demo.md).
- [Zetaris installation and connection guides](zetaris/README.md).

## Directory map

| Directory                               | Purpose                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| [architecture/](architecture/README.md) | Architecture references, data models, schemas and method specifications.              |
| [plans/](plans/README.md)               | Roadmaps, proposed changes, implementation stages and acceptance criteria.            |
| [reports/](reports/README.md)           | Implementation findings, verification evidence, follow-up checks and remaining gates. |
| [testing/](testing/README.md)           | Manual verification guides, reusable case fixtures and captured evaluation results.   |
| [orchestration/](orchestration/)        | Active task-engine guide and cutover runbook.                                         |
| [guides/](guides/)                      | Runnable demonstrations and operator walkthroughs.                                    |
| [infrastructure/](infrastructure/)      | Pinned engines and compatibility checks.                                              |
| [evidence/](evidence/)                  | Source provenance, milestone evidence and supplied scientific reports.                |
| [frontend/](frontend/)                  | Frontend discovery, design decisions and feature notes.                               |
| [zetaris/](zetaris/README.md)           | Zetaris installation, connections, SQL guides and its own recipe roadmap.             |
| [history/](history/README.md)           | Retired runtime records and dated session handoffs.                                   |

## Other guides and references

- **Orchestration:** [General task engine](orchestration/general-engine.md), [LangGraph cutover and rollback](orchestration/langgraph-cutover-runbook.md).
- **Guides:** [Damage account demo](guides/damage-account-demo.md), [damage reduction browser demo](guides/damage-reduction-demo.md).
- **Infrastructure:** [Engine pins](infrastructure/engine-pins.md), [compatibility probe](infrastructure/compatibility-probe.md).
- **Evidence:** [PM2.5 evidence source](evidence/pm25-evidence-source.md), [v0.14 PM2.5 milestone](evidence/milestone-v014.md), [Haze Damage Account Report](evidence/Haze_Damage_Account_Report.pdf).
- **Frontend:** [01 - Project understanding](frontend/01-project-understanding.md), [02 - Critique and reality check](frontend/02-critique.md), [03 - UI design](frontend/03-ui-design.md), [HMem memory page](frontend/hmem-memory-page.md).

## Organization conventions

Put specifications in `architecture/`, delivery plans in `plans/`, and executed findings in `reports/`. Keep related stages together by topic. Use lowercase kebab-case for new filenames and directories; retain stage numbers when they define a reading or implementation sequence. Supplied reference artifacts retain their original names.

Historical proposals, retired guides and session records describe their recorded context. Consult the project README and each document's status and date for current behavior. Plans and engineering reports retain their original scientific qualification, live verification and release gates; their location does not imply that those gates have passed.
