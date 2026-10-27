# Three sample-mode scenarios

`SAMPLE_MODE=true` supplies raw synthetic evidence to the ordinary task runtime.
The Manager and specialists use individual LLM responses, which may come from
the recorded-response cache or fresh inference. Registered executors still run
their tools, calculations, independent checks and synthesis against the current
inputs. The cache does not provide completed task results or review artifacts.

The default sample cache is `data/llm-cache/`, containing genuine recorded LLM
responses. A cache hit requires the complete semantic model request to match:
role, instructions, objective, scope, evidence, constraints, execution state and
the response contract remain significant. Typed normalization handles transient
runtime identities and rebinds exact references to the current run; it does not
match by scenario ID alone or weaken runtime validation. All proposed actions
still pass their ordinary schema, authority, prerequisite and review checks.

An allowlist manifest identifies the bundled NVIDIA producer routes permitted
for the automatic local fallback. It does not make recordings from arbitrary
models interchangeable. Hits need no live model credentials or new inference.
Misses in the default `read-only` mode reach the explicitly configured LLM, or
use local Ollama when no provider is configured. New inputs without a matching
recorded response therefore need a working model; the cache does not support
every possible input offline.

The automatic local fallback uses installed `qwen2.5:7b` at
`http://127.0.0.1:11434/v1`. Ollama must be running with the weights already
cached (`ollama pull qwen2.5:7b` is the one-time setup). The runtime verifies a
dedicated `haze-sample-qwen2.5-7b-16k-v1` alias with a 16,384-token context,
creating metadata from the existing weights when needed. It never downloads
weights or alters the original model. Custom local settings use
`HAZE_SAMPLE_MODEL` and `HAZE_SAMPLE_MODEL_BASE_URL`.

External evidence credentials and Docker are not needed. Sample HTTP tasks
allow up to 65,536 input bytes and 6,400 output tokens per model turn; explicit
host limits take precedence. The selected model's own context window also
applies.
Sample HTTP tasks have a 15-minute admission window for local inference. The
automatic local model has a five-minute per-request timeout; explicitly
configured providers retain their normal timeout. Call and token ceilings still
apply, and an unknown outcome is retained rather than automatically retried.

## Files

```text
input_examples/
  example_1.json
  example_2.json
  example_3.json
output_examples/
  example_1_output.json
  example_2_output.json
  example_3_output.json
data/sample-scenarios/
  01-evidence/
  02-damage-account/
  03-intervention/
data/llm-cache/
  ...individual recorded model responses and producer manifest
```

The request files select their scenario and supply an ordinary v3 objective.
The datasets contain only synthetic raw quantities, source notes, unit values,
scope, operator targets and proposal declarations. They contain no model
decisions, completed reviews, calculations or final answers.

| Request          | Scenario                                                                                                                                 | What to inspect in the generated output                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `example_1.json` | Incomplete PM2.5 evidence for Sample Coastal District over six hours. One value is null and one hourly timestamp is absent.              | Whether the agents retrieve the local rows, distinguish missingness from zero, calculate partial coverage, retain sources and obtain independent numerical review.         |
| `example_2.json` | An episode account using treatment cases, lost workdays, financing and compatible invented CU valuations. Mortality evidence is missing. | Separate physical, financial-incidence and social-welfare views; treatment of internal transfers and unestimated mortality; exact-component review.                        |
| `example_3.json` | A proposed exposure-alert and work-schedule service assessed across two workforce strata against a 10% target.                           | Residual comparisons, independent arithmetic and plan reviews, unresolved income protection and a conditional or limited conclusion. No achieved intervention is supplied. |

All locations, quantities, people and CU currency values are invented. Numerical
review demonstrates consistency with supplied inputs, not scientific validation
or real-world effectiveness.

## Run

Install the repository dependencies. To permit inference on cache misses, start
Ollama with the cached model or configure an explicit LLM as for a normal run.
From the repository root:

```sh
npm run samples:run -- --all
```

The command enables sample mode for its child process and uses fresh isolated
state. It imports the local input evidence, submits tasks through the normal
HTTP API and waits for the actual agent loops. It writes each result to its
matching `output_examples/example_N_output.json`. Rerunning creates fresh tasks
and replaces the selected output files with their new results.

For a single request:

```sh
npm run samples:run -- input_examples/example_2.json
```

To test your own input, copy a request file, change its objective or scope, and
optionally add an `inputs` object containing native `pm25_capture` and `notes`,
`damage`, or `residuals`, `target` and `candidate` data. The runner validates the
input format and sends those source values through the same task API and agent
engine. Each LLM turn checks its full semantic request against the cache; changed
inputs are not assigned a saved answer by their scenario ID. For a local PM2.5
source outside the runner, set the server-owned `HAZE_SAMPLE_PM25_FILE` to a
synthetic capture JSON file; the source filters it by the requested interval.

The saved outputs retain the submitted request, task state, generated result,
events and exact artifacts so the execution can be inspected. Fresh model
responses retain their actual provider receipts. Cache hits have
`response_status: cache_hit`, with the original producer route, recording time
and original receipt under `receipt.cache`. Current response IDs and token
counts stay unknown; a cached receipt is not a new HTTP response or new token
usage. Model-turn counts can include cache hits and do not alone establish new
inference. Failed runs and questions remain explicit. These generated examples
are observations of one execution, rather than expected answers that later
runs must copy.
Actual execution logs are retained under the run's `logs/` directory (recorded
in `execution.logs_directory`); the console also prints current decision and
execution events. These logs are generated by the ordinary task engine.

## Cache controls

These are server-side environment settings, separate from synthetic source data.

| `HAZE_MODEL_CACHE_MODE` | Behavior                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `read-only`             | Default in sample mode. Reuse matches; send misses to the configured or local model without writing new cache entries. |
| `read-write`            | Reuse matches; run inference for misses and record successful genuine responses.                                       |
| `record-only`           | Refresh every turn through inference and record its successful response; do not read matching entries.                 |
| `off`                   | Bypass the response cache and use actual inference for every turn.                                                     |
| `cache-only`            | Reuse matches; fail a miss without contacting a model.                                                                 |

`HAZE_MODEL_CACHE_DIR` optionally selects another server-side directory. Treat
recorded prompts and responses as retained source material: use a private cache
directory when working with private inputs.

To require a run to use cached responses only, on PowerShell:

```powershell
$env:HAZE_MODEL_CACHE_MODE='cache-only'
npm run samples:run -- --all
```

On POSIX shells:

```sh
HAZE_MODEL_CACHE_MODE=cache-only npm run samples:run -- --all
```

A miss is an explicit failure in this mode. Availability of cache controls does
not itself establish that a clean checkout can complete every scenario; inspect
the actual generated outputs and validation evidence for the executed run.

## Use the normal app

Set `SAMPLE_MODE=true` in the repository `.env`, then run `npm run dev`.
The launcher skips Docker and retains model readiness checks. The default state
directory is `.state/sample-mode`, separate from live evidence; set
`HAZE_TASK_STATE_DIR` explicitly to choose another directory.

For the PM2.5 question, use the location and UTC period in
`input_examples/example_1.json`, or request another bounded interval. The source
filters the actual cached rows for the requested interval; absent periods stay
missing and unsupported locations remain unavailable. It never queries live
data or invents replacements. The
accounting and intervention examples import their corresponding synthetic JSON
evidence; the sample runner performs these imports automatically.

Live collectors and web search remain disabled. The local PM2.5 source keeps
synthetic evidence provenance even though the model loop executes normally.
The separate `--fixture` mode remains available for deterministic engineering
tests, where model actions are substituted; it is not sample mode.
