# Test the Manager in isolation

## Talk to the Manager yourself

Configure the live provider in root `.env`, then run:

```sh
npm run manager:chat
```

Type your own requests at `You>`. This is a terminal chat with the actual registered Manager and its configured model. All specialist implementations remain synthetic, and external source tools are disabled. You can submit any wording, but available execution methods are the sandbox's `eval.*` methods and local read-only World Model tools. Requests beyond these capabilities should produce an explanation, question or partial result.

Try these messages:

```text
Explain an evidence gap in one sentence.
Make your previous answer simpler.
Summarize my report.
Run eval.produce once, then explain the synthetic finding.
Run eval.fail, then recover using eval.produce with input alternative:retained-source.
```

Reply normally when the Manager asks a question. Messages sent while a task is working correct the current task. After a completed answer, the next message starts a new task and supplies the previous dialogue in `scope.conversation_context`. This is conversational context, not a source artifact or independently verified evidence, so ordinary follow-ups do not acquire artificial source-citation requirements. Dialogue is limited to 4 KiB to reserve space for the Manager's decision context; use `/new` for a longer or unrelated conversation.

| Command                | Behavior                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| `/correct TEXT`        | Send a correction while work is active, or a follow-up after completion. |
| `/status`              | Show current status, task ID, revision and model-call usage.             |
| `/decisions`           | Inspect actual validated decisions and their explanations.               |
| `/pause`, `/cancel`    | Control the current task.                                                |
| `/resume`, `/continue` | Explicitly resume eligible work or start a linked continuation.          |
| `/new`                 | Cancel unfinished work and clear conversational context.                 |
| `/help`, `/quit`       | Show commands or leave the chat.                                         |

For a single custom request:

```sh
npm run manager:chat -- --prompt "Explain an evidence gap without delegating."
```

Each chat gets separate state under `.state/manager-chat/`. The printed `session.json` records captured tasks, decisions, events, artifacts, provider receipts and isolation checks. Live requests consume provider usage. Invalid decisions and provider failures remain visible; they are never replaced with synthetic Manager answers. A failed or paused task requires an explicit control or `/new`. SQLite retains the authoritative final state if you exit while work is in progress; the JSON file is a captured snapshot.

After a code update, exit the chat with `/quit` and rerun `npm run manager:chat` to load a fresh build. `/new` resets the conversation inside the already loaded build. If a provider exhausts its output allowance, the error identifies that limit and retains the partial response and receipt for inspection; partial JSON is never repaired or executed.

### NVIDIA response compatibility check — 26 October 2026

The hosted Lightning decoder could leave a nested Manager decision unclosed and consume its 1,200-token allowance on whitespace. Complex schemas now use JSON mode with the unchanged output contract in the system instructions; the full local parser, schema, authority and citation checks still apply. Simple schemas retain native schema mode. The provider, model and admitted output limit are unchanged, and failures are not automatically retried.

The model-facing contract excludes runtime-only recovery links. Manager context also supplies a checkpoint-specific decision ID so separate tasks do not collide on a generic model-generated ID. Conversation turns remain context rather than imported evidence documents.

A captured live chat completed `Explain an evidence gap.` and `Make that explanation shorter.` It also asked for a missing report and accepted a clarification reply; that task then waited for the full report text. Its four accepted model calls used 370, 260, 202 and 208 output tokens, with zero specialist model/tool calls. The local trace is `.state/manager-chat/session-4468C7/session.json`. These checks establish chat transport and control behavior; they do not replace the full live decision-quality evaluation.

## Run automated scenarios

Run this from the repository root after `npm ci`:

```sh
npm run manager:test
```

This type-checks the Manager and its contracts, runs only the Manager unit tests, transpiles the current Manager and shared runtime into a fresh build, and runs the 12 frozen scenarios with a scripted model. It needs no API keys, frontend, task server, Docker, Zetaris or running specialist agents. A failed check or scenario returns a nonzero exit code.

The shared runtime build uses TypeScript's `noCheck`: the isolated command checks Manager types independently and exercises runtime behavior in tests, without requiring unrelated adapter code to pass type checking. Run the repository's `npm run typecheck` separately for full backend type coverage.

Each run builds under a unique `.state/manager-isolation/` directory. Scenario databases, checkpoints, decisions, events, artifacts and provider receipts are retained under a separate unique `.state/manager-evaluation/` directory. The final console line gives the report path. The command neither uses the application's task state nor replaces the application's `dist/` build.

## What is isolated

The real `app/agents/manager/` code runs with the real task runtime, validation, persistence and dispatch boundaries. The test registry supplies deterministic `eval.*` implementations for specialist results, errors, independent reviews and peer replies. HazeOps, WorkerShield, EvidenceCritic and DamageAccountant agent implementations are excluded from the Manager build. Specialist role names in the trace identify these stubs.

The runtime also registers `world.lookup`, `world.context` and `world.lineage`; they read this test's local SQLite state. Runtime dependencies can include domain adapter code, but the evaluator removes every tool outside this local allowlist before task admission and records those exclusions. For example, a runtime-added `damage.world-inputs` tool is disabled in these tests. The evaluator checks retained registrations and charged attempts, and reports isolation failures separately from expected-outcome failures. Only the Manager may call the model; synthetic specialist assignments may call neither models nor tools.

## Run a focused check

```sh
npm run manager:test -- --list
npm run manager:test -- --case rejected-review
npm run manager:test:unit
```

`--list` lists the frozen cases without compiling, contacting a provider or creating task state. `--case` filters the scenario run; the Manager unit suite still runs first. Unknown cases and invalid options fail instead of reporting an empty success.

| Check                                     | What to examine                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct answer and clarification           | No unnecessary delegation; the question identifies the missing report.                                                                                             |
| Single and parallel assignments           | A custom plan uses the registered definitions and expected number of stubs.                                                                                        |
| Known failure                             | The Manager records the failure and chooses an authorized replacement.                                                                                             |
| Rejected review                           | The rejected artifact is repaired and independently reviewed.                                                                                                      |
| Conflicting evidence                      | The final answer preserves both reported values and sources.                                                                                                       |
| Unavailable capability and partial result | Missing requirements remain explicit; unsupported observations are withheld.                                                                                       |
| Peer request                              | The Manager grants the channel before synthetic peers exchange messages.                                                                                           |
| Correction                                | The new objective revision takes effect and old-region findings are excluded.                                                                                      |
| Injected document                         | Embedded commands do not acquire authority.                                                                                                                        |
| Unit invariants                           | Stale decisions, duplicate dispatch, exact references, inspection and applicability, authorized lookups, independent review, resource charges, waits and recovery. |

The scenario predicates check selected status, assignment, review and answer properties. They do not fully grade prose quality, every planning requirement or scientific validity. Inspect the retained trace when assessing a decision.

## Test the actual Manager model

Configure the model in root `.env` using the variables in [the project README](../../README.md), then run:

```sh
npm run manager:test:live -- --case direct
npm run manager:test:live
```

Live mode uses the same isolated registry and synthetic specialist results. Only the Manager's configured provider receives real requests; these consume provider usage. Provider failures remain failures, with available receipts retained. The model is not changed automatically and failed answers are not replaced with scripted output.

A successful offline run establishes deterministic control flow and runtime invariants. Assess the configured Manager's reasoning with the live suite and its actual decisions. The [previous evaluation report](../orchestration/manager-completion-report.md) records real-model failures despite a passing scripted suite; this isolation setup does not change those historical results. Domain capabilities such as live PM2.5 acquisition and damage calculations require their own separate integration tests.

The lower-level `npm run manager:evaluate -- --scripted` and `--live` commands still load the existing application `dist/` by default. Use `manager:test` for a fresh isolated build; use the evaluator's `--baseline ROOT` only for an intentional baseline comparison.
