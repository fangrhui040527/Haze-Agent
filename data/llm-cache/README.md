# Recorded LLM turns

These are genuine individual model responses from the configured NVIDIA API,
with their original request, response ID, model, token usage and timestamp.
`manifest.json` names the permitted historical producer. No credentials or
completed task-result objects are stored here.

The cache key covers the model/transport contract, instructions, output schema,
limits, complete semantic evidence and current execution state. Runtime IDs,
host read times and review-event deduplication keys are rebound to the current
run. Complete artifact digests protect data hidden by a truncated prompt excerpt.
Source values, scope, observation/issuance/ingestion times and user text remain
significant. A changed input needs another matching recording or real inference.

Every hit returns a labeled `cache_hit` receipt with the original provenance and
null current token usage. The ordinary task engine still creates assignments,
executes tools, calculates products, reconstructs independent reviews, validates
references and renders a new result. It never reads `output_examples/` to answer.
Invalid model proposals remain subject to the normal bounded correction loop.

The bundled entries cover the three documented examples and the changed-value
self-test. Index version `haze.manager-semantic-bindings.v2` was recalculated
from the original recorded inputs; model replies and provider receipts were
preserved unchanged. See [verification](../../docs/reports/sample-mode-verification.md).
