# Sanitized execution trace examples

Regenerate with `npm run traces:examples`. Each directory contains a self-contained evidence bundle, a readable summary produced by the production export service, and `stdout.txt` captured from the running scenario. The same console output appears during generation and is retained beside the run's JSONL and manifest under `logs/<run UUID>/`.

| Example                                                 | Demonstrates                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [single](single/evidence-bundle.json)                   | Successful registered fixture work with retained evidence.                              |
| [rejected-review](rejected-review/evidence-bundle.json) | An independent rejection, changed producer work, replacement evidence and a new review. |
| [known-failure](known-failure/evidence-bundle.json)     | A preserved failed branch followed by an explicit alternative plan and recovery.        |

All three use frozen synthetic methods and an injected scripted Manager. Their provenance is replay/fixture evidence, not live provider or source verification. Runtime UUIDs and UTC timestamps change when regenerated; decisions and expected outcomes are deterministic.

Console captures: [successful work](single/stdout.txt), [rejected review and revision](rejected-review/stdout.txt), [failure and recovery](known-failure/stdout.txt). Trace IDs, timestamps, actors, actions and summaries are checked line for line against the saved records; the trailing evaluator JSON is retained too.

The generator reopens SQLite and reconciles files after execution. It checks that the paginated trace response, recovered JSONL stream and evidence bundle agree on stable event IDs. Original artifact identities and exported sanitized-byte hashes remain separate.
