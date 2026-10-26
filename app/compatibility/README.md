# Compatibility

This folder contains the infrastructure compatibility probe for LangGraph, the
pinned Meterless H-MEM and World Model engines, SQLite checkpoints and an
explicitly selected model provider. It verifies that a small workflow can save
real engine records, exit and resume them in a fresh process.

## What the probe does

1. Captures a labeled synthetic correction through H-MEM.
2. Ingests a synthetic World Model observation twice and checks deduplication.
3. Saves IDs, verification hashes and execution metadata in a graph checkpoint,
   then pauses before `recall_after_restart`.
4. Opens the same stores in a fresh process, resumes the same thread, recalls the
   saved memory and verifies event IDs and the rebuilt World Model projection.
5. Runs the selected provider probe after readback and records its outcome.

## Key files

| File                                                                           | Job                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [graph.ts](graph.ts)                                                           | Defines the synthetic workflow, versioned checkpoint metadata, engine assertions and restart breakpoint.         |
| [worker.ts](worker.ts)                                                         | Runs the `start` or `resume` phase, opens engines and SQLite, checks dependency pins and returns phase metadata. |
| [../../scripts/probe-compatibility.mjs](../../scripts/probe-compatibility.mjs) | Coordinates separate worker processes, verifies continuity and writes the combined report.                       |
| [../workflow_versions.json](../workflow_versions.json)                         | Pins the probe's graph/schema revisions and workflow dependency versions.                                        |

## Run and inspect

From the repository root:

```sh
npm run probe:compatibility
```

The command builds the project and loads root `.env` configuration. Select the
provider explicitly with `HAZE_PROVIDER`; `offline` allows a local engine/restart
check with inference skipped. `SAMPLE_MODE=true` also disables network requests.
A selected live provider requires its documented configuration, and a failed
provider call remains a failure.

Under the selected `STATE_DIR`, the probe uses `checkpoint.sqlite` and stores each
thread's H-MEM data, World Model data and derived `report.json` in
`compatibility/<thread_id>/`. Checkpoints retain record references and verification
metadata; the engine stores retain the underlying domain payloads.

## Scope

This is a bounded infrastructure check using synthetic inputs. A passing result
establishes the tested engine, provider and controlled process-restart behavior.
Scientific validity, agent reasoning quality and arbitrary-crash recovery require
their own evidence.

The application task lifecycle lives in [tasks](../tasks/README.md), its execution
machinery in [orchestration](../orchestration/README.md), and its graph checkpoint
database is separate. [checkpoints](../checkpoints/README.md) supplies the SQLite
saver used by both callers. The offline metadata example in
[app/graph.ts](../graph.ts) is another separate workflow.

See the [compatibility probe guide](../../docs/infrastructure/compatibility-probe.md)
for provider configuration, storage details and recorded verification scope.
