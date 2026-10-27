# Pre-existing components and prior work

Check this against the Official Rules (R4.2, R5.4) and fix any date that is wrong before you submit.
The build window opened 22 Oct 2026 00:00 UTC (08:00 MYT).

## Created before the build window

| Item | Date | Use in this project |
|---|---|---|
| Haze Agent Harness architecture PDF, v0.4–v0.6 (team member) | 20–21 Oct 2026 | Design only: four roles, critic gate, engines, run contract, scenario families. No code. |
| Idea notes and a small Python Zetaris/Nightshift connection snippet | 21 Oct 2026 | Not included. Replaced by the TypeScript code in this repository. |

## Created during the build window (22 Oct 2026 onward)

All code in `src/`, `test/`, `scripts/`, `sql/`, `input_examples/`, the Dockerfile and the docs were written
during the window with AI assistance (Claude), then reviewed and run by the team.

## Reused open-source components

| Component | Licence | How it is used |
|---|---|---|
| Meterless H-MEM reference engine (`engines/hmem/reference`, pinned in `engine_sources.json`) | Apache-2.0 | Vendored at build time; reviewed memory, recall, trust ledger |
| Meterless World Model reference engine (`engines/world-model/reference`, pinned) | Apache-2.0 | Vendored at build time; entities, evidence and conclusion revisions |
| Meterless conformance suites for both engines | Apache-2.0 | `npm run conformance` |
| LangGraph for TypeScript + SQLite checkpointer | MIT | Workflow graph and checkpoints |
| PGlite (embedded Postgres) | Apache-2.0 / PostgreSQL | Offline judging store |
| pg, better-sqlite3, tsx, TypeScript | MIT / Apache-2.0 | Runtime and tooling |

## Data

- `src/sample.ts` generates a **fictional** sample episode (3–9 Oct 2026). Every value and company name is invented.
- Real data (NASA FIRMS, Open-Meteo, concession and peat maps) is fetched by the team and is not committed.
- The workplace guidance table (`outdoor-work v0.1-placeholder`) is a placeholder, not official DOSH guidance.
