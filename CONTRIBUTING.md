# Contributing

Use the Node and npm versions pinned in `.nvmrc` and `package.json`. Start with `npm ci` so local development and CI use the committed dependency graph.

## Commands

| Command                                                                  | Purpose                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `npm start -- input_examples/01-minimal.json`                            | Run a metadata example after building; emit JSON and a local trace.                        |
| `npm run typecheck`                                                      | Check TypeScript without emitting files.                                                   |
| `npm run lint`                                                           | Check source and test code with ESLint.                                                    |
| `npm test`                                                               | Run the focused local test suite.                                                          |
| `npm run test:watch`                                                     | Watch the local test suite while developing.                                               |
| `npm run test:postgres`                                                  | Run PostgreSQL saver integration tests against an explicitly configured test database.     |
| `npm run build`                                                          | Compile the TypeScript project.                                                            |
| `npm run contracts:generate`                                             | Generate the committed v2 JSON Schemas from the built Zod contracts.                       |
| `npm run contracts:check`                                                | Check generated schemas, synthetic fixture validation and matching fixture hashes.         |
| `npm run contracts:fixtures`                                             | Refresh fictional record hashes and planning/request/result fixture bindings.              |
| `npm run demo:generate`                                                  | Generate the immutable section 23 review package from the local producer and checker.      |
| `npm run demo:check`                                                     | Verify review-package drift, bindings, workstream traces and engineering/error checks.     |
| `npm run contracts:validate -- planning input_examples/v2/planning.json` | Validate one v2 contract file without running a planning job.                              |
| `npm run verify:pins`                                                    | Verify engine source checksums and workflow package locks.                                 |
| `npm run vendor:engines`                                                 | Materialize and compile pinned engine source without nested installs.                      |
| `npm run test:engines`                                                   | Run both pinned upstream conformance runners against the built implementations.            |
| `npm run probe:compatibility`                                            | Build and prove engine/SQLite compatibility across processes; probe the selected provider. |
| `npm run check`                                                          | Run the standard repository checks.                                                        |
| `npm run format:check`                                                   | Check formatting.                                                                          |
| `npm run format`                                                         | Apply formatting.                                                                          |

The default tests in `tests/unit/` run without external services or API credentials, using disposable memory and temporary SQLite state. PostgreSQL tests in `tests/postgres/` use a dedicated, disposable database configured through `HAZE_TEST_POSTGRES_URL`; see `.env.example` for a placeholder. Set the variable in your shell before running `npm run test:postgres`; the library does not load environment files. CI provisions its own test database and runs this integration suite.

Run `npm run build` before unit tests to prepare the pinned local engines. Run one test file with `npm test -- tests/unit/sqlite.test.ts`. Before requesting review, run `npm run check`, which verifies pins and builds before the adapter tests and upstream conformance runners. Run `npm run test:postgres` when changing saver configuration, checkpoint behavior, or PostgreSQL dependencies. Record any check you could not run and why in the pull request.

## Repository layout and examples

Keep core TypeScript implementation in `app/`, external service boundaries in `app/adapters/`, helper commands in `scripts/`, and small static fixtures or data-source notes in `data/`. Preserve immutable source under `third_party/`; generated `dist/` and `vendor/` files remain ignored. Node dependencies belong in `package.json` and its lockfile.

Maintain at least three inputs under `input_examples/` and matching, same-named expected outputs under `output_examples/`. After `npm run build`, run an input with `npm start -- input_examples/01-minimal.json`. Examples validate the checkpoint metadata contract and stay offline. They must not imply that the four domain roles or Zetaris integration have been implemented. Keep generated JSONL traces under ignored `logs/`, and use `--logs-dir` when a check needs a temporary trace directory.

The separate v0.13 contract examples live in `input_examples/v2/` and `output_examples/v2/`. Their scope is defined in [docs/demo-scope.md](docs/demo-scope.md), using [architecture v0.13](docs/Haze_Agent_Architecture_v0.13.pdf) as the reference. Preserve their synthetic/historical labels. A checked-in result fixture is an illustration of the contract, not captured execution evidence. The metadata graph's numeric `schemaVersion` must never be treated as a domain-contract version.

The new computed review package lives in `examples/demo-review/package.json`; it is separate from those hand-authored contract specimens. Its sources are `app/demo/`, `scripts/demo-review.mjs` and supplemental `app/contracts/handoffs.ts`. Run `npm run build` before `npm run demo:check`. After an intentional producer/contract change, regenerate with `npm run demo:generate`, inspect the resulting immutable record hashes and run the checks again. Preserve pending human review, `agent_execution_status=not_run`, demo-local provenance, disabled publication and false operational eligibility. Do not populate reviewer approvals or provider/tool receipts to make a fixture appear executed.

Review the interface handoffs, pending human decisions and sign-off template in [docs/demo-contract-review.md](docs/demo-contract-review.md). Scope/contract agreement requires actual authorized human findings bound to exact package/schema revisions and hashes. Preparing the package does not establish agreement, accepted operating evidence or day-one real-use success. No distribution or member contact is part of this work.

Edit v2 contracts in `app/contracts/`; keep JSON Schemas under `schemas/` generated rather than hand-edited. After a contract change run `npm run build`, `npm run contracts:generate` and `npm run contracts:check`, plus the normal repository checks. Keep the matching planning/run/result fixture references and content hashes synchronized. Validate run fixtures with `--surface historical_harness`; public/canonical admission must reject their demo-local references. New v1 planning/run payloads require explicit migration and are rejected rather than silently reinterpreted as v2. Do not infer scientific approval, canonical acceptance or a successful comparison from structural validation.

Supplemental evidence/scenario/policy/snapshot/draft/planner/calculation/check/WorkerShield records are deliberately closed to the fictional engineering slice. Extending them to real operating evidence is a separate reviewed contract change with the full architecture's source, authority, intended-use, constraints and operational gates. Keep independent checking separate from producer arithmetic and from human exact-material approval.

## Change and review conventions

Keep each branch and pull request focused on one coherent change. Explain the behavior that changes and the checks that support it. Add focused tests for meaningful new behavior or a regression; avoid tests that merely restate an implementation.

Review should confirm that:

- The change stays within its stated scope and has suitable verification.
- TypeScript interfaces and dependency changes are necessary and understandable.
- Dependency versions remain exact, with `package-lock.json` updated in the same change.
- Local and CI behavior agree, including persistence and cleanup where relevant.
- Secrets, database files, checkpoint artifacts, logs, and generated output are absent from the diff.

For architecture changes, preserve the four Haze roles: Manager, HazeOps, WorkerShield, and EvidenceCritic. `StateGraph` and savers are infrastructure. Do not introduce a hosted LangGraph dependency or treat checkpoints as authoritative evidence without an explicit architecture decision.

Maintainers should configure branch protection to require the repository's CI checks before merge and a reviewer for changes to the default branch. The workflow and pull request template document review expectations; repository protection settings must be configured in the hosting service.

## Dependencies and secrets

Pin direct dependencies and development tools to exact versions. Update the runtime pins together when changing Node or npm. Regenerate the lockfile with the pinned npm version and verify the result using `npm ci` and the applicable checks.

Use `.env.example` only for documented placeholder configuration. Keep actual credentials in ignored environment files or CI secrets. Never paste credentials into source, tests, pull request descriptions, or logs.
