# Haze Agent ↔ TestRail

Bidirectional sync between Haze Agent's automated verification and TestRail.

This is **not** the stock Playwright integration. Haze Agent has no Playwright —
it runs **vitest** plus a set of Node verification scripts — so the bridge was
rebuilt around what this repo actually has, and it talks to TestRail's **REST API
directly** rather than through an MCP server (works in CI and a bare shell with
nothing but credentials).

## Setup

```powershell
[Environment]::SetEnvironmentVariable('TESTRAIL_URL','https://your-instance.testrail.io','User')
[Environment]::SetEnvironmentVariable('TESTRAIL_USER','you@example.com','User')
[Environment]::SetEnvironmentVariable('TESTRAIL_API_KEY','<key>','User')
```

API key: TestRail → **My Settings → API Keys → Add Key**. An admin must also
enable **Administration → Site Settings → API**. Restart your shell afterwards.

Every command accepts `--dry-run`, which needs **no credentials**, performs no
writes, and prints exactly what would be sent.

## Workflow

```sh
# 0. produce the evidence (writes qa/*.json)
npm run qa:suite                  # 30 harness use cases
node qa/checks/api-e2e.mjs        # HTTP API contract
node qa/checks/state-dir-guard.mjs
node qa/checks/peer-budget-probe.mjs
npm run testrail:report           # vitest JSON -> qa/vitest-results.json

# 1. see where things stand (safe, read-only)
npm run testrail:status -- --dry-run
npm run testrail:status -- --project 1

# 2. create/update the cases in TestRail, writing qa/testrail/case-map.json
npm run testrail:import -- --project 1 --dry-run
npm run testrail:import -- --project 1

# 3. open a run over the mapped cases
npm run testrail:run -- --project 1 --name "Haze nightly"

# 4. upload results
npm run testrail:push -- --run 42
```

`--suite N` is required on suite-mode projects. `--verbose` echoes each
suppressed write during a dry run.

## What gets synced

The catalogue is **derived from the audit artifacts**, so it cannot drift from
what actually runs. 73 cases across 9 sections:

| Source artifact             | Section(s)                                                         | Cases |
| --------------------------- | ------------------------------------------------------------------ | ----- |
| `qa/findings.json`          | Environment, Static/Build, Unit, Offline E2E, Durability, Frontend | 30    |
| `qa/api-e2e.json`           | HTTP API Contract                                                  | 30    |
| `qa/state-dir-guard.json`   | Storage Safety (STATE_DIR guard)                                   | 8     |
| `qa/peer-budget-probe.json` | Peer Channel Budget                                                | 5     |

High-value cases carry hand-written preconditions, steps and expected results
(including the known defects, so a tester is not surprised by a documented
failure); the rest get accurate text generated from their command and name.

Status mapping: `PASS → 1 Passed`, `FAIL → 5 Failed`, `WARN → 2 Blocked`
(a cleanly skipped optional suite is Blocked, not Failed).

Each uploaded result carries real evidence in its comment — the command, exit
code, duration, and the output tail on failure.

## Linking vitest tests to TestRail cases

Playwright's `test.info().annotations` does not exist in vitest. A linked test
declares its case id in the **title** instead:

```ts
it('[C12345] rejects a nonempty unmarked state directory', () => {
  // ...
});
```

`task.meta` is also honoured if you prefer metadata:

```ts
it('rejects a nonempty unmarked state directory', (ctx) => {
  ctx.task.meta.testrail = 'C12345';
  // ...
});
```

Both forms are read from the vitest JSON report. Tests with **no** id are
counted and reported by `status` rather than silently dropped, so the coverage
gap stays visible. Multiple ids in one title are allowed — the result is
recorded against each.

## Files

| File            | Purpose                                                      |
| --------------- | ------------------------------------------------------------ |
| `client.mjs`    | REST client: basic auth, 429 retry, pagination, bulk results |
| `cases.mjs`     | Case catalogue derived from the artifacts, plus curated text |
| `collect.mjs`   | Artifact + vitest results → TestRail result payloads         |
| `cli.mjs`       | `status` / `import` / `run` / `push`                         |
| `case-map.json` | Generated: local catalogue key → TestRail case id            |

`case-map.json` is what makes `import` idempotent — re-running updates existing
cases instead of duplicating them. An un-mapped case is also **adopted** if a
case with an identical title already exists in the project. Commit this file if
you want the mapping shared; delete it to force a fresh import.

## Notes

- `push` refuses to send anything for keys with no mapping, and lists them, so a
  partial import can never be mistaken for a complete run.
- Results are uploaded in bulk (`add_results_for_cases`) in chunks of 200.
- `elapsed` is omitted when a duration rounds to under a second — TestRail
  rejects `"0s"`.
- Generated artifacts (`qa/*.json`, `qa/*.txt`) are excluded from Prettier via
  `.prettierignore`; the `qa/**/*.mjs` sources are still formatted and linted.
