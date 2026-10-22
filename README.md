# Haze Agent

Repository and development foundation for Haze Agent, based on the [v0.8 architecture](docs/Haze_Agent_Architecture_v0.8.pdf), especially pages 20, 23, and 25.

The scaffold uses TypeScript `StateGraph` from `@langchain/langgraph` and runs in this process. It does not require a hosted LangGraph service. LangGraph supplies orchestration and checkpoint infrastructure; Haze has four domain roles: **Manager, HazeOps, WorkerShield, and EvidenceCritic**.

The [execution graph](src/graph.ts) currently validates execution metadata in one infrastructure node. It does not implement the four domain roles or call a model. This repository establishes dependency pins, saver integration, and development checks. Passing those checks verifies the scaffold, not a complete Haze engine or its domain behavior.

## Develop locally

Use the exact Node version in [.nvmrc](.nvmrc) and npm version declared by `packageManager` in [package.json](package.json). Then run:

```sh
npm install --global npm@11.8.0
npm ci
npm run check
```

Commit `package-lock.json` with dependency changes. Use `npm ci` for a reproducible installation; do not replace the lockfile with another package manager's lockfile.

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands, test setup, and review conventions.

## Persistence boundaries

- `MemorySaver` is for disposable tests.
- SQLite is the persistent option for a single process. The [SQLite helper](src/checkpoints/sqlite.ts) requires an explicit state directory; callers close its database handle after use.
- PostgreSQL is the production persistence path, with a dedicated integration test.

Checkpoints retain graph execution state. A checkpoint ID or saved execution state is not authoritative evidence for a Haze decision; the future evidence layer must establish that separately.

Keep credentials in local environment variables or ignored environment files. Commit only placeholder values in `.env.example`.
