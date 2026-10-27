# LangGraph, engine and checkpoint compatibility spike

This bounded infrastructure graph implements the compatibility proof for architecture
v0.8 pp.20, 23 and 25. It does not implement the Haze domain roles or validate haze
science. The synthetic correction and observation are labeled infrastructure fixtures.

## Run

Use the pinned Node 24.22.1 and npm 11.8.0. Create an ignored `.env` file:

```dotenv
STATE_DIR=.state
HAZE_PROVIDER=nvidia
NVIDIA_API_KEY=your-local-key
# Optional model override:
# HAZE_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
```

```sh
npm run probe:compatibility
```

Only this probe CLI loads `.env`; the library continues to read runtime environment
variables supplied by its caller. Existing shell variables take precedence. No key,
provider response text, or authenticated URL is written to checkpoints or reports.
For local-only operation select `HAZE_PROVIDER=offline`. `SAMPLE_MODE=true` disables
network requests regardless of provider selection and reports the skipped inference.
No provider is inferred from the presence of a key.

NVIDIA uses `https://integrate.api.nvidia.com/v1/chat/completions` and defaults to
`nvidia/nemotron-3.5-lightning-30b-a3b`. The probe sends one synthetic request, allows
32 output tokens, disables thinking for this default model, and requires a nonempty
assistant message. It has a 60-second timeout and no retries. A provider failure stays
failed; there is no automatic offline fallback. This proves only basic generation and
graph integration, not tool calling, structured output, model quality or scientific
validity. NVIDIA's model name is a hosted alias, not an immutable weight revision.

Custom endpoints use explicit `HAZE_PROVIDER=openai-compatible`, `HAZE_MODEL`,
`HAZE_PROVIDER_BASE_URL` (API base including `/v1`) and optional
`HAZE_PROVIDER_API_KEY`. NVIDIA also accepts `HAZE_PROVIDER_API_KEY`.

## What executes

1. The runner verifies source checksums and workflow dependency pins, allocates a
   unique thread, then launches a Node child process.
2. `StateGraph` mines a scoped H-MEM correction through the starter's real vendored
   engine. World Model ingests an observation twice and verifies deduplication.
3. The graph pauses before `recall_after_restart`. The first process awaits all
   synchronous checkpoint writes, closes SQLite and exits.
4. A fresh Node process opens the same database and engine stores. It loads the same
   checkpoint and resumes with `invoke(null, { configurable: { thread_id } })`.
5. The resumed node reads memory and entity IDs from graph state and reads the actual
   engine records. It verifies stable memory fields, one creation audit entry and
   identical World Model event IDs. World Model's upstream load replays canonical
   events; `ingest([])` rebuilds derived aggregates from its persisted observations
   without appending events. The rebuilt projection must match its original hash.
6. The provider node runs after readback, and the thread finishes. The runner checks
   distinct process IDs, exact checkpoint continuity, a newer final checkpoint,
   unchanged domain IDs and the expected node sequence.

Storage stays under `STATE_DIR`:

| Path                                     | Purpose                                         |
| ---------------------------------------- | ----------------------------------------------- |
| `checkpoint.sqlite`                      | File-backed `SqliteSaver` execution checkpoints |
| `compatibility/<thread_id>/hmem/`        | Canonical scoped memory and audit               |
| `compatibility/<thread_id>/world-model/` | World Model events and observations             |
| `compatibility/<thread_id>/report.json`  | Derived probe result and provenance             |

SQLite explicitly uses WAL, `synchronous=FULL` (reported as `2`) and a 5000 ms busy
timeout. LangGraph uses `durability: 'sync'`. Checkpoints contain execution metadata,
domain IDs, verification hashes and probe status, not memory text or observation
payloads. Within this isolated probe, H-MEM and the reference World Model provide
memory/evidence services through `app/compatibility/meterless/`. The product runtime
uses its authoritative SQLite store and does not open H-MEM. SQLite is for
single-process judging; the two workers run sequentially. Production uses
`PostgresSaver`; `MemorySaver` remains limited to disposable tests.

Graph ID `haze.compatibility`, graph revision 1 and probe schema revision 1 are pinned
in `app/workflow_versions.json`, independently of the original checkpoint metadata
graph. Incompatible persisted revisions are rejected before resumption. The runner
performs a controlled process exit/restart; it does not establish power-loss recovery,
distributed fencing or exactly-once effects across arbitrary crashes.

## Recorded result

Observed on 2026-10-22 at 15:31:37 UTC (23:31:37 Singapore):

| Probe                                         | Result                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Real H-MEM capture and restart recall         | Passed; saved `mem-1`, one create operation                                                                         |
| Real World Model ingest/deduplication/rebuild | Passed; same entity and events `evt_1`, `evt_2`, `evt_3`                                                            |
| Persistent SQLite process restart             | Passed; writer PID 55364, resumer PID 71896                                                                         |
| Saved thread                                  | `compat-b069c481-16ad-4f1c-8457-c4a449babbcd`                                                                       |
| Checkpoint before restart and before resume   | `1f1ce2da-c0f2-6580-8002-019426e5822b`                                                                              |
| Completed checkpoint                          | `1f1ce2da-d04a-6910-8004-98849c35d9ec`                                                                              |
| Checkpoint rows for this thread               | 4 before restart, 6 after completion                                                                                |
| NVIDIA generation                             | **Passed**: actual configured chat completion, model `nvidia/nemotron-3.5-lightning-30b-a3b`, 7 response characters |

The machine-readable report is retained locally at
`.state/compatibility/compat-b069c481-16ad-4f1c-8457-c4a449babbcd/report.json`.
Runtime state remains ignored by Git. The overall recorded status is `passed`,
and `npm run probe:compatibility` exited with code 0. The actual NVIDIA request
executed once in the resumed process after engine readback. Credentials and raw
response text are excluded from the report and checkpoints. This meets the bounded
compatibility acceptance criterion described above.

| Installed/pinned dependency                | Version          |
| ------------------------------------------ | ---------------- |
| Node / npm                                 | 24.22.1 / 11.8.0 |
| `@langchain/core`                          | 1.2.20           |
| `@langchain/langgraph`                     | 1.5.2            |
| `@langchain/langgraph-checkpoint`          | 1.2.1            |
| `@langchain/langgraph-checkpoint-sqlite`   | 1.1.0            |
| `@langchain/langgraph-checkpoint-postgres` | 1.1.2            |
| `better-sqlite3` (lockfile)                | 12.11.1          |
| `zod`                                      | 4.6.7            |

Starter, H-MEM and World Model are pinned to Meterless revision
`1742dec56a66e58eef9dda2d2b865823758ca8cd`. Source SHA-256 values are respectively
`e9f72e58a3329c687691229189545ba057f4872d042f0b1c0e23a3c3b8654c49`,
`1c5573475ac1490d3cd92282a5dd76286c256af9e96433d83c207df471ae510b` and
`8c4f87c6469eedb810c22b9ae1a7e917b605e29000be746dccc57c3752d5f96c`.
The report also records the verified compiled entrypoint hashes and installed package
versions; `engine_sources.json` and `package-lock.json` retain reproducible pins.

## Verification and references

`npm run check` passed with Node 24.22.1/npm 11.8.0: pin verification,
formatting, typecheck, lint, build, 53 unit/integration tests and upstream
conformance (H-MEM 13/13, World Model 8/8). `npm run test:postgres` also passed
its saver reconnect/resume test against a disposable local PostgreSQL 18.1 database;
the CI database image remains pinned separately in `.github/workflows/ci.yml`.

The automated suite covers restart/readback, missing and tampered memory stores,
incompatible graph/schema versions, checkpoint/domain-payload separation and a local
HTTP fixture invoked once after restart. Fixture responses establish wiring only;
they are not a NVIDIA readiness claim. Provider tests validate NVIDIA configuration,
missing-key behavior, offline enforcement, bounded responses and redacted failures.

Primary references: [LangGraph static breakpoints and resumption](https://docs.langchain.com/oss/javascript/langgraph/interrupts#debugging-with-interrupts),
[SQLite saver API](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint-sqlite),
[NVIDIA hosted endpoint and model example](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b),
[NVIDIA thinking controls](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html).
