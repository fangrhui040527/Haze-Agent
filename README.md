# Haze Agent

Repository and development foundation for Haze Agent, based on the [v0.8 architecture](docs/Haze_Agent_Architecture_v0.8.pdf), especially pages 20, 23, and 25.

The scaffold uses TypeScript `StateGraph` from `@langchain/langgraph` and runs in this process. It does not require a hosted LangGraph service. LangGraph supplies orchestration and checkpoint infrastructure; Haze has four domain roles: **Manager, HazeOps, WorkerShield, and EvidenceCritic**.

The [execution graph](src/graph.ts) currently validates execution metadata in one infrastructure node. It does not implement the four domain roles or call a model. This repository establishes dependency pins, saver integration, and development checks. [Engine adapters](src/engines/index.ts) delegate to the pinned Meterless references. Passing these checks verifies the tested infrastructure and engine contracts, not the full Haze domain workflow or its scientific validity.

## Develop locally

Use the exact Node version in [.nvmrc](.nvmrc) and npm version declared by `packageManager` in [package.json](package.json). Then run:

```sh
npm install --global npm@11.8.0
npm ci
npm run check
```

Commit `package-lock.json` with dependency changes. Use `npm ci` for a reproducible installation; do not replace the lockfile with another package manager's lockfile.

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands, test setup, and review conventions.

## Pinned engines and workflow

[engine_sources.json](engine_sources.json) records immutable revisions, source
selections and SHA-256 checksums for the Agentathon starter, H-MEM and World
Model. `npm run build` verifies and vendors checked-in upstream source, including
the starter's H-MEM services, and packages World Model separately. Runtime needs
no clone, dependency installation or model download. Upstream lockfiles,
Apache-2.0 licenses and copyright notices are preserved; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

[Workflow versions](src/workflow_versions.json) pin LangGraph and saver packages,
graph revision 1 and execution metadata schema 2. Older checkpoints require an
explicit migration. [Engine pin documentation](docs/engine-pins.md) describes
builds, loaded implementations, compatibility and updates.

The [Dockerfile](Dockerfile) uses a digest-pinned Node image and performs engine
vendoring during build. Its default command loads the real local engines and
prints provenance. For an offline packaging smoke test:

```sh
docker build -t haze-engines .
docker run --rm --network none haze-engines
```

## Persistence boundaries

- `MemorySaver` is for disposable tests.
- SQLite is the persistent option for a single process. The [SQLite helper](src/checkpoints/sqlite.ts) requires an explicit state directory; callers close its database handle after use.
- PostgreSQL is the production persistence path, with a dedicated integration test.

Checkpoints retain graph execution state. A checkpoint ID or saved execution state is not authoritative evidence for a Haze decision; the future evidence layer must establish that separately.

Keep credentials in local environment variables or ignored environment files. Commit only placeholder values in `.env.example`.
