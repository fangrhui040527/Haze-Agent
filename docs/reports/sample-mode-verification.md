# Sample-mode verification

Verified on 28 October 2026 (Asia/Singapore), using Node 24.22.1 and npm 11.8.0.

## Fresh checkout

A separate local Git clone was created with `--no-hardlinks`. The proposed
uncommitted source changes and bundled synthetic data/cache were applied before
installing dependencies with `npm ci`. No local environment files, runtime state,
build output or generated sample outputs were copied from the working checkout.
The clone's `.env` was zero bytes and its Zetaris `.env.local` was absent.

The full application TypeScript build passed, including normal type checking:

```text
node --max-old-space-size=512 --max-semi-space-size=1 node_modules/typescript/bin/tsc -p tsconfig.build.json
```

The memory flags accommodate this machine's memory pressure. Earlier lower-heap
build attempts failed; the successful final build did not use `--noCheck`.

`SAMPLE_MODE=true npm start` then ran with an environment allowlist that removed
all inherited model/data credentials. A verification-only fetch guard rejected
model endpoints and non-loopback network requests. The three output files and
runtime state were absent before this first run in the final clone.

All three tasks completed and passed artifact-integrity, selected-product,
synthetic-provenance and exact independent-review validation. They used 11
input-matched cached LLM turns, zero fresh model responses and 12 actual tool
calls. Each run created new task/assignment/artifact IDs and current event logs.

| Input            | Actual tool calls | LLM cache hits | Verified result                                                                                                                                                                         |
| ---------------- | ----------------: | -------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `example_1.json` |                 3 |              5 | Four usable modeled samples; range 22–64 µg/m³; partial coverage, null and missing timestamp preserved; independent numerical review supported.                                         |
| `example_2.json` |                 4 |              2 | 150 treatment cases, 400 lost workdays; financing 18,000 CU; selected welfare 50,000 CU; mortality unestimated; registered accounting review supported.                                 |
| `example_3.json` |                 5 |              4 | Residuals 1,000 → 890 person-days; 110 avoided, 11%; conditional planning with unresolved prerequisites, independent arithmetic/plan reviews, no delivered or achieved reduction claim. |

## Changed input

A fourth request kept the first example's objective and scope while replacing
its first normalized PM2.5 value and corresponding raw source value from 22 to 7.
This unseen request ran through the same engine with five fresh configured-model
responses and three actual tool calls. Its independently checked range changed
from **22–64** to **7–64 µg/m³**. The changed raw input has a different retained
source hash. No known-input name or saved output selected the result.

The final example exports retain the admitted requests, current artifacts,
independent reviews, actual events and original cache provenance. Runtime logs
are identified by each export's `execution.logs_directory`.

## Focused checks

Passing checks cover response-cache provenance and tampering, zero-network cache
hits, source-data changes outside prompt excerpts, source timestamps and literal
user text, current reference rebinding, citation selection, peer coordination,
duplicate-plan prevention and all three exported workflow validators. The
final focused run passed **138 unit tests** and **21 script tests**. Targeted
ESLint, formatting and whitespace checks passed. The broad
unit suite was not claimed as passing: an earlier run encountered integration
timeouts under memory pressure. The final application build and scenario checks
above passed.

New inputs without a matching cached turn require a working configured LLM or
the documented local model fallback. Sample mode still supplies evidence locally
and does not require external-data credentials.
