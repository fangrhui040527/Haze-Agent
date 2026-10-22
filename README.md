# Haze Agent

Repository and development foundation for Haze Agent, based on the [v0.8 architecture](docs/Haze_Agent_Architecture_v0.8.pdf), especially pages 20, 23, and 25.

The scaffold uses TypeScript `StateGraph` from `@langchain/langgraph` and runs in this process. It does not require a hosted LangGraph service. LangGraph supplies orchestration and checkpoint infrastructure; Haze has four domain roles: **Manager, HazeOps, WorkerShield, and EvidenceCritic**.

The [execution graph](app/graph.ts) validates execution metadata in one infrastructure node. The separate [compatibility spike](app/compatibility/graph.ts) executes the real local engines, resumes a persistent SQLite thread in a fresh process, and probes an explicitly selected provider. [Engine adapters](app/adapters/meterless/index.ts) delegate to the pinned Meterless references.

## Repository structure

```text
Haze-Agent/
├── app/                  # Core TypeScript agent and checkpoint infrastructure
│   ├── adapters/         # Meterless engines and provider integrations
│   ├── checkpoints/      # Persistent saver helpers
│   └── compatibility/    # Engine, provider and restart proof
├── data/                 # Small static data and data-source notes
├── scripts/              # Build, verification and example helpers
├── Dockerfile            # Reproducible Node build and offline example
├── input_examples/       # At least three sample metadata inputs
├── output_examples/      # Matching expected JSON outputs
├── logs/                 # Local JSONL execution traces (ignored)
├── .env.example          # Placeholder configuration; no real keys
├── README.md             # Setup, usage, dependencies, architecture and limitations
├── package.json          # Node runtime dependencies and development commands
├── package-lock.json     # Exact Node dependency graph
├── tests/                # Unit and PostgreSQL integration tests
├── docs/                 # Architecture and implementation documentation
└── third_party/          # Immutable, pinned upstream engine sources
```

## Develop locally

Use the exact Node version in [.nvmrc](.nvmrc) and npm version declared by `packageManager` in [package.json](package.json). Then run:

```sh
npm install --global npm@11.8.0
npm ci
npm run check
```

Commit `package-lock.json` with dependency changes. Use `npm ci` for a reproducible installation; do not replace the lockfile with another package manager's lockfile.

The runtime uses Node, TypeScript, LangGraph, Zod and checkpoint saver packages. Exact versions are declared in [package.json](package.json) and [package-lock.json](package-lock.json).

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands, test setup, and review conventions.

## Run the examples

Install dependencies and build once, then run an input from [input_examples/](input_examples/):

```sh
npm ci
npm run build
npm start -- input_examples/01-minimal.json
```

Each example invokes the checkpoint metadata graph with disposable `MemorySaver` state and prints deterministic JSON containing `runId`, `artifactIds`, `graphVersion` and `schemaVersion`. Compare the result with its same-named file in [output_examples/](output_examples/). These samples require no provider credentials or network access after installation and build.

To save a result and choose the trace directory:

```sh
npm start -- input_examples/01-minimal.json --output result.json --logs-dir logs
```

The runner writes local JSONL execution traces under `logs/` by default. Trace files are ignored by Git. The examples exercise metadata validation and checkpoint wiring; they do not execute the compatibility probe or the Haze domain roles.

## Pinned engines and workflow

[engine_sources.json](engine_sources.json) records immutable revisions, source
selections and SHA-256 checksums for the Agentathon starter, H-MEM and World
Model. `npm run build` verifies and vendors checked-in upstream source, including
the starter's H-MEM services, and packages World Model separately. Runtime needs
no clone, dependency installation or model download. Upstream lockfiles,
Apache-2.0 licenses and copyright notices are preserved; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

[Workflow versions](app/workflow_versions.json) pin LangGraph and saver packages,
graph revision 1 and execution metadata schema 2. Older checkpoints require an
explicit migration. [Engine pin documentation](docs/engine-pins.md) describes
builds, loaded implementations, compatibility and updates.

The [Dockerfile](Dockerfile) uses a digest-pinned Node image and performs engine
vendoring during build. Its default command runs the first metadata example.
For an offline packaging smoke test:

```sh
docker build -t haze-engines .
docker run --rm --network none haze-engines
```

## Persistence boundaries

- `MemorySaver` is for disposable tests.
- SQLite is the persistent option for a single process. The [SQLite helper](app/checkpoints/sqlite.ts) requires an explicit state directory; callers close its database handle after use.
- PostgreSQL is the production persistence path, with a dedicated integration test.

Checkpoints retain graph execution state and domain IDs. H-MEM and World Model remain the memory and evidence services; the spike reads their stores again after restart. A checkpoint ID is not authoritative evidence for a Haze decision.

## Compatibility proof

Set `STATE_DIR` and run `npm run probe:compatibility`. This command builds the pinned engines and starts two sequential Node processes. It records exact installed versions, engine hashes, checkpoint IDs, SQLite durability settings, restart/readback checks and provider status in `STATE_DIR/compatibility/<thread_id>/report.json`.

The probe CLI reads an ignored local `.env` file. Select `HAZE_PROVIDER=nvidia` and configure `NVIDIA_API_KEY` there; optionally set `HAZE_MODEL`. NVIDIA without a key is reported as blocked and exits unsuccessfully. `HAZE_PROVIDER=offline` runs the local proof and explicitly skips inference. `SAMPLE_MODE=true` enforces offline operation. See [probe setup and recorded results](docs/compatibility-probe.md).

Keep credentials in local environment variables or ignored environment files. Commit only placeholder values in `.env.example`.

## Limitations

- Manager, HazeOps, WorkerShield and EvidenceCritic remain architecture roles; their domain workflows are not implemented.
- The integration layer currently contains Meterless engines and an explicitly selected provider probe. Zetaris integration is not implemented.
- The example runner uses disposable memory checkpoints. Persistent restart proof is a separate compatibility command; SQLite supports a single process, while PostgreSQL has a dedicated integration test.
- Passing samples, compatibility checks or upstream conformance tests establishes only the tested infrastructure and engine contracts. It does not validate haze science or establish production readiness.
