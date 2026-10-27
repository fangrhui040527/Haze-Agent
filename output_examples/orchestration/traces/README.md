# Sanitized execution trace examples

Regenerate with `npm run traces:examples`. Each directory contains a self-contained evidence bundle and a readable summary produced by the production export service from persisted execution records.

| Example                                                 | Demonstrates                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [single](single/evidence-bundle.json)                   | Successful registered fixture work with retained evidence.                              |
| [rejected-review](rejected-review/evidence-bundle.json) | An independent rejection, changed producer work, replacement evidence and a new review. |
| [known-failure](known-failure/evidence-bundle.json)     | A preserved failed branch followed by an explicit alternative plan and recovery.        |

All three use frozen synthetic methods and an injected scripted Manager. Their provenance is replay/fixture evidence, not live provider or source verification. Runtime UUIDs and UTC timestamps change when regenerated; decisions and expected outcomes are deterministic.

The generator reopens SQLite and reconciles files after execution. It checks that the paginated trace response, recovered JSONL stream and evidence bundle agree on stable event IDs. Original artifact identities and exported sanitized-byte hashes remain separate.
