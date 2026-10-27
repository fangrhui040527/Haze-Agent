# QA harness and audit records

Test tooling added during an end-to-end system audit, plus the records it
produced. Nothing here is imported by the application; it only drives it.

## Running it

```sh
npm run qa:suite                       # all use cases
node qa/run-usecases.mjs --only=UC-07 --merge   # one case, keeping prior results
node qa/run-usecases.mjs --skip-slow   # quick pass
```

`--merge` preserves recorded results for cases not selected, so a single case can
be re-run without discarding the rest of the report.

Use cases are grouped by layer: environment, static analysis, build, unit,
offline E2E, durability, frontend, storage safety, contract/accounting probes,
agent supervision, live data retrieval, and live Zetaris. Cases that need
something unavailable in a given environment are marked optional and record
WARN rather than a false FAIL.

## Tooling (durable)

| File                               | Purpose                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `run-usecases.mjs`                 | The harness. Runs each use case, writes `findings.json` / `.txt`.                                                                      |
| `checks/engine-preflight.mjs`      | Fails only if a toolchain mismatch would actually block install.                                                                       |
| `checks/api-e2e.mjs`               | HTTP contract: origin/localhost guards, idempotency, v3-only, bounds, query strictness.                                                |
| `checks/state-dir-guard.mjs`       | STATE_DIR marker guard, six hostile shapes plus two positive controls.                                                                 |
| `checks/peer-budget-probe.mjs`     | Peer channel message/byte/expiry bounds.                                                                                               |
| `checks/review-reserve-probe.mjs`  | Reserved review capacity is released when review cannot run.                                                                           |
| `checks/damage-demo-probe.mjs`     | Waits for the damage demo's reviewed state, then stops it. The demo is a long-running server, so asserting `exit 0` on it never works. |
| `checks/data-sources-probe.mjs`    | Hits each upstream directly with the same endpoint construction the Zetaris source scripts use.                                        |
| `checks/agent-retrieval-probe.mjs` | The agent's own evidence adapters against the live network.                                                                            |
| `checks/agent-health-probe.mjs`    | Per-agent registration, routing and capability backing, from the runtime's own endpoints.                                              |
| `checks/zetaris-usecases.mjs`      | Real-world haze scenarios against a live Zetaris stack.                                                                                |
| `testrail/`                        | Bidirectional TestRail sync. See `testrail/README.md`.                                                                                 |

## Records (point-in-time, regenerable)

`findings-report.json` / `.txt` is the audit write-up: every defect with its root
cause, the change, and how it was verified, plus retracted false positives.
`zetaris-launch-record.txt` covers the Zetaris launch and the ten live use cases.
The remaining `*.json` files are raw probe output.

These are snapshots of one run on one machine. Re-running the harness overwrites
them. They are excluded from Prettier (`qa/*.json`, `qa/*.txt` in
`.prettierignore`); the `.mjs` sources are formatted and linted like any other
source.

## Environment notes

Several cases need configuration that is deliberately not committed:

- `tests/postgres` needs `HAZE_TEST_POSTGRES_URL`.
- `test:rollback` needs a retained pre-LangGraph dist via `--legacy-executable`.
- The Zetaris cases need the stack up (`docker compose up --detach`) with the
  image references and credentials from the Zetaris bundle in root `.env`.
- Live data retrieval reaches the public internet; the FIRMS scenarios skip
  themselves without `FIRMS_MAP_KEY`.
- Agent inference needs a reachable model provider. Without one the agents are
  still registered, routed and capability-backed, and the health probe records
  `inference_available: false` rather than failing.
