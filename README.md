# Haze Agent

Repository and development foundation for Haze Agent. The reference design is the supplied [v0.13 architecture](docs/Haze_Agent_Architecture_v0.13.pdf). The [demo scope and implementation status](docs/demo-scope.md) define the bounded slice and the limits of the code delivered here. The earlier [compatibility spike](docs/compatibility-probe.md) retains its original v0.8 scope; its results do not establish the new domain workflow.

The scaffold uses TypeScript `StateGraph` from `@langchain/langgraph` and runs in this process. It does not require a hosted LangGraph service. LangGraph supplies orchestration and checkpoint infrastructure; Haze has four domain roles: **Manager, HazeOps, WorkerShield, and EvidenceCritic**.

The [execution graph](app/graph.ts) validates execution metadata in one infrastructure node. The separate [compatibility spike](app/compatibility/graph.ts) executes the real local engines, resumes a persistent SQLite thread in a fresh process, and probes an explicitly selected provider. [Engine adapters](app/adapters/meterless/index.ts) delegate to the pinned Meterless references. The [v2 domain contracts](app/contracts/index.ts) add executable planning, run-request and result validation; they are separate from the metadata graph. The [demo review package](docs/demo-contract-review.md) adds a deterministic section 23 historical engineering trace, supplemental handoff schemas and independent calculation checks, with human review pending and publication disabled.

## Repository structure

```text
Haze-Agent/
├── app/                  # Core TypeScript agent and checkpoint infrastructure
│   ├── adapters/         # Meterless engines and provider integrations
│   ├── checkpoints/      # Persistent saver helpers
│   ├── compatibility/    # Engine, provider and restart proof
│   └── contracts/        # Closed v2 domain contracts and semantic validation
├── data/                 # Small static data and data-source notes
├── scripts/              # Build, verification and example helpers
├── Dockerfile            # Reproducible Node build and offline example
├── input_examples/       # Metadata samples and synthetic v2 planning/run fixtures
├── output_examples/      # Metadata outputs and a synthetic v2 result fixture
├── schemas/              # Generated Draft 2020-12 domain schemas
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

The runner writes local JSONL execution traces under `logs/` by default. Trace files are ignored by Git. The examples exercise metadata validation and checkpoint wiring; they do not execute the compatibility probe or the Haze domain roles. Their numeric `schemaVersion: 2` is an execution-metadata version, not `haze.planning.v2`, `haze.run.v2` or `haze.result.v2`.

## Validate the v0.13 contracts

After building, validate the shared synthetic examples and their bindings:

```sh
npm run contracts:check
npm run contracts:validate -- planning input_examples/v2/planning.json
npm run contracts:validate -- run input_examples/v2/run.json --surface historical_harness
npm run contracts:validate -- result output_examples/v2/result.json
```

The closed [JSON Schemas](schemas/) use Draft 2020-12 and are generated from the [Zod contracts](app/contracts/index.ts). Runtime validation also enforces formats and domain relationships that a standalone schema pass cannot establish. Regenerate schemas with `npm run contracts:generate` after a deliberate contract change and rebuild first when TypeScript source has changed.

[Planning input](input_examples/v2/planning.json), [run request](input_examples/v2/run.json) and [result](output_examples/v2/result.json) are matching **synthetic contract fixtures**. Their demo-local references and hashes describe local fixtures, not accepted canonical records. The result illustrates a historical, publication-disabled response with explicit gaps. It was not produced by a planner, agent, independent numerical checker or provider call. `contracts:validate` validates a file; it does not admit or execute a planning job. See [demo-scope.md](docs/demo-scope.md) for the scope, invariants and remaining implementation boundaries.

## Check the demo review package

The separate [review fixture](examples/demo-review/package.json) traces the section 23 baseline and both alternatives, an essential-evidence gap and a search cutoff with a verified incumbent through Evidence & Inputs, Planner, Verification and typed WorkerShield inputs. It uses the existing v2 envelopes and small [handoff contracts](app/contracts/handoffs.ts). Its producer and separate engineering checker recompute fixed-work/full-occupancy constraints, interval values, worker/activity protections, fictional policy qualification and movement ranking.

```sh
npm run build
npm run demo:check
```

Use `npm run demo:generate` to deliberately regenerate the review package after changing its source. Generation captures a timestamp and fresh immutable IDs; `demo:check` replays the saved timestamp and verifies the committed bytes, bindings, calculation and error cases. These commands make no provider calls and do not execute WorkerShield. Every record is fictional and demo-local; exact human review and contract sign-off remain pending. All results keep publication disabled and operational eligibility false. The [review document](docs/demo-contract-review.md) contains the actual entry-point inventory, handoff/owner table, concise review checklist and decisions blocking shared integration or operating use. No agreement is claimed and no members are contacted.

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

- The Klang chat sample has a bounded live LangGraph workflow for Manager, HazeOps, WorkerShield and EvidenceCritic, with actual model calls and pinned World Model/H-Mem operations. These roles review independently checked fictional fixtures; general domain planning, canonical admission and publication remain unimplemented. See [crew scheduling](docs/chat-crew-scheduling.md).
- The new local producer/checker executes only the bounded fictional review case. It does not supply a general scheduler, HTTP admission, exact human review or canonical publication/current-read capability.
- The integration layer currently contains Meterless engines and an explicitly selected provider probe. Zetaris integration is not implemented.
- The example runner uses disposable memory checkpoints. Persistent restart proof is a separate compatibility command; SQLite supports a single process, while PostgreSQL has a dedicated integration test.
- Passing samples, compatibility checks or upstream conformance tests establishes only the tested infrastructure and engine contracts. It does not validate haze science or establish production readiness.
