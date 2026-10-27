# Model routing verification and evaluation

Role routes are configured with the versioned `HAZE_MODEL_ROUTES_JSON` and
`HAZE_AGENT_ROUTES_JSON` objects illustrated in [the environment template](../../.env.example).
Unmapped roles inherit the existing shared settings. Every new task pins all
five routes in the authoritative task database. Read-only `GET
/api/nightshift/readiness` and the **Agent Routes** page distinguish configuration,
transport/schema compatibility, reachability, live verification and role quality.

Changing configuration admits a different route only for new authority. Resume,
replacement assignments and correction recovery use the admitted routes. A
pre-snapshot unfinished run requires an explicit linked Continue; Resume cannot
silently attach today's provider. Keep credential environment names stable when
rotating their values. Server snapshots store references, never secret values;
browser responses omit both credential references and endpoint details.

## Controlled role probes

Build once, then inspect without inference:

```sh
npm run build
npm run routes:test
npm run routes:evaluate -- --inspect
```

For explicitly requested live inference with synthetic evidence/tool contexts:

```sh
npm run routes:evaluate -- --live
npm run routes:evaluate -- --live --role HazeOps
```

The harness freezes [the scenarios and acceptance criteria](cases/route-evaluation-cases.json)
before resolving providers. It compares each configured candidate against that
role's inherited shared route using identical instructions, scenarios, output
caps and deadlines. Each scenario allows one call per route; no repair, retry or
fallback occurs. Fifteen scenarios cover the five roles. `--output PATH` changes
the parent directory for a unique report folder.

Specialist probes use the same versioned action contract as the production
runtime. Legal tools, peer recipients, retained tool results, artifact kinds,
exact references and acknowledged job handles come from the supplied context,
never from the scenario's acceptance criteria. The inference schema and local
validator share these constraints. Reports retain the action-contract version,
versioned role instructions, exact inputs and input hashes so revised runs remain
distinguishable from historical evidence. Scoring still assesses the original
first response: runtime self-correction does not add calls to these probes.

Hosted Lightning uses JSON-object mode for compound action schemas because its
native compound decoder previously produced incomplete output. JSON-object mode
does not enforce the action schema; the strict local parser, schema and reference
checks remain authoritative. Native enforcement is claimed only for separately
verified supported schema shapes, not for these compound contracts. See the
[compatibility observation](manager-testing.md#nvidia-response-compatibility-check--26-october-2026).

Each report retains the scenario hash, sanitized requested route and capability
identities, exact inputs and agent versions, input hashes, original output, actual response model/ID/status/usage,
latency, strict schema results, exact reference checks and classifications for
blocked routes, rejected actions, rejected/truncated responses and unknown
outcomes. An append-only `attempts.ndjson` records intent before each attempted
scenario, so interruption leaves an explicit unfinished attempt. Missing usage
stays null. Reports live under the gitignored `.state/route-evaluation/` directory.

These probes propose actions against synthetic test doubles; they execute no
tools. They establish a narrow inference/action contract only. They do not
establish live retrieval, full task outcomes, scientific correctness or accepted
role quality. `quality_gate` therefore remains `pending-independent-review`, even
if every automated contract/latency check passes. No script promotes a default.

## Promotion evidence

Keep all attempted candidate and baseline traces, including failed and missing
receipts. Before changing a role's default, retain genuine end-to-end task traces
and independently evaluate the focus specified in [routing plan 1](../plans/nightshift/nightshift-01-routing-plan.md).
The frozen contract gates require every strict action, expected outcome and
exact-reference check to pass, complete actual provider receipts and latency at
or below 90 seconds per call. Passing them is necessary but insufficient:
independent quality review and genuine end-to-end role traces are separate gates.

For Manager supervision, review requirements, corrections, stopping and recovery,
also run the existing frozen Manager suite:

```sh
npm run manager:evaluate -- --scripted
npm run manager:evaluate -- --live
```

Its synthetic specialists isolate Manager behavior; their success is not
specialist reasoning or live retrieval evidence. Specialist evaluations must
exercise actual registered retrieval, accounting and checking capabilities with
authorized sources, exact artifact revisions and producer/reviewer separation.

The PM2.5 retrieval, analysis and numerical-check assignments now follow
capability-owned deterministic execution. Their task completion, exact capture
retention and restart checks establish workflow behavior separately from these
single-decision model-quality probes. Fixture completion does not establish live
source retrieval, and neither workflow success nor a partial role-probe improvement
opens the full release or role-default promotion gate.

## Nightshift direct inference

Haze uses the separate authenticated strict endpoint, capability contract
`nightshift-haze-strict-v1`, for supported NVIDIA-hosted Nemotron chat models.
The general compatible endpoint retains Nightshift's normal app routing and is
not used for these admitted Haze calls.

Install the overlay on the inspected supported runtime build:

```sh
npm run nightshift:contract:install -- --check
npm run nightshift:contract:install
```

The installer verifies source hashes, preserves original files and refuses
unknown builds or operator modifications. It does not restart the runtime.
Reload the idle Nightshift engine through its supervisor before verification.
`npm run nightshift:contract:install -- --restore` restores original host/server
files; a subsequent engine reload removes the endpoint. Backups and overlay
files remain available. Runtime upgrades need a fresh source review and
conformance run before adding their hashes; there is no bypass flag.

Inspect without generation, then explicitly request two bounded live transport
probes:

```sh
npm run nightshift:contract:verify -- --model nvidia/nemotron-3.5-lightning-30b-a3b
npm run nightshift:contract:verify -- --model nvidia/nemotron-3.5-lightning-30b-a3b --live
```

The live probes check structured JSON and deliberately truncated output. Their
reports retain actual model/ID/status/usage under
`.state/routing-validation/nightshift-strict/`; they do not run domain tools or
establish accepted role quality.

Before each runtime model dispatch, bounded authenticated
`GET /v1/haze/contract?model=<exact-id>` checks exact model availability and
operator-policy eligibility. Haze charges no model call for failed preflight.
`POST /v1/haze/chat/completions` makes one provider request with the admitted cap,
reasoning and supported structured-output parameters. It performs no retry,
fallback, race, judge call or server tool execution. Provider finish reasons
and absent usage remain truthful; Haze rejects truncated/invalid decisions and
marks ambiguous dispatched outcomes unknown without replay.

The fixed `haze-agent` application policy still applies. Unsupported bindings,
privacy/lane restrictions, explicit app budgets, mandatory quality stages and
requests requiring withholding or redaction fail closed. The strict route does
not claim local-only compute or background-job monetary-cap coverage. Other
models/providers remain unavailable until separately implemented and verified.

The new capability identity does not rewrite existing run snapshots. Resume
keeps admitted authority; an old unverified contract requires an explicit linked
Continue with a new snapshot. Negotiated compatibility, genuine transport
probes and independent role quality remain separate gates. No background job
submission or automatic continuation is added by this routing feature.
