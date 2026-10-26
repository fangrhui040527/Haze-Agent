# Checkpoints

This folder provides the file-backed SQLite saver used to persist LangGraph
execution progress. Callers choose the state directory and checkpoint database;
the helper applies consistent local durability settings and exposes a close
operation.

## Key file

[sqlite.ts](sqlite.ts) exports
`openSqliteCheckpointer(stateDir, filename = 'checkpoint.sqlite')`. It:

- Rejects an empty directory path and creates the selected directory if needed.
- Opens a `SqliteSaver` for the chosen database file.
- Configures WAL mode, `synchronous=FULL` and a 5,000 ms busy timeout.
- Returns the saver, database path, observed durability settings and `close()`.

Callers close the returned handle after graph work finishes. They also select
`durability: 'sync'` when invoking their graph; configuring the saver and choosing
graph write durability are separate steps.

## Which database is used

| Caller                                             | Database under its selected state directory                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Task runtime](../tasks/runtime.ts)                | `execution-checkpoints-v1.sqlite` for independently checkpointed Manager and specialist workflows. |
| [Compatibility worker](../compatibility/worker.ts) | The default `checkpoint.sqlite` for the infrastructure restart probe.                              |

Checkpoint databases contain workflow progress. The task application stores its
authoritative permissions, charged attempts, effect receipts, immutable artifacts
and results in `tasks.sqlite`, managed by [tasks](../tasks/README.md). The runtime
and versioned graph wrappers enforce thread identity, compatibility and authority.
This helper's job is to open and configure the saver.

The [compatibility probe](../compatibility/README.md) also keeps its H-MEM and World
Model records in separate engine stores, referring to them from checkpoint state.

See the [LangGraph runtime architecture](../../docs/architecture/langgraph-runtime.md)
for task recovery and the [compatibility probe guide](../../docs/infrastructure/compatibility-probe.md)
for the separate restart check.
