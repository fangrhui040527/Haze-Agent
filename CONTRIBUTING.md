# Contributing

Use the Node and npm versions pinned in `.nvmrc` and `package.json`. Start with `npm ci` so local development and CI use the committed dependency graph.

## Commands

| Command                                       | Purpose                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm start -- input_examples/01-minimal.json` | Run a metadata example after building; emit JSON and a local trace.                        |
| `npm run typecheck`                           | Check TypeScript without emitting files.                                                   |
| `npm run lint`                                | Check source and test code with ESLint.                                                    |
| `npm test`                                    | Run the focused local test suite.                                                          |
| `npm run test:watch`                          | Watch the local test suite while developing.                                               |
| `npm run test:postgres`                       | Run PostgreSQL saver integration tests against an explicitly configured test database.     |
| `npm run build`                               | Compile the TypeScript project.                                                            |
| `npm run verify:pins`                         | Verify engine source checksums and workflow package locks.                                 |
| `npm run vendor:engines`                      | Materialize and compile pinned engine source without nested installs.                      |
| `npm run test:engines`                        | Run both pinned upstream conformance runners against the built implementations.            |
| `npm run probe:compatibility`                 | Build and prove engine/SQLite compatibility across processes; probe the selected provider. |
| `npm run check`                               | Run the standard repository checks.                                                        |
| `npm run format:check`                        | Check formatting.                                                                          |
| `npm run format`                              | Apply formatting.                                                                          |

The default tests in `tests/unit/` run without external services or API credentials, using disposable memory and temporary SQLite state. PostgreSQL tests in `tests/postgres/` use a dedicated, disposable database configured through `HAZE_TEST_POSTGRES_URL`; see `.env.example` for a placeholder. Set the variable in your shell before running `npm run test:postgres`; the library does not load environment files. CI provisions its own test database and runs this integration suite.

Run `npm run build` before unit tests to prepare the pinned local engines. Run one test file with `npm test -- tests/unit/sqlite.test.ts`. Before requesting review, run `npm run check`, which verifies pins and builds before the adapter tests and upstream conformance runners. Run `npm run test:postgres` when changing saver configuration, checkpoint behavior, or PostgreSQL dependencies. Record any check you could not run and why in the pull request.

## Repository layout and examples

Keep core TypeScript implementation in `app/`, external service boundaries in `app/adapters/`, helper commands in `scripts/`, and small static fixtures or data-source notes in `data/`. Preserve immutable source under `third_party/`; generated `dist/` and `vendor/` files remain ignored. Node dependencies belong in `package.json` and its lockfile.

Maintain at least three inputs under `input_examples/` and matching, same-named expected outputs under `output_examples/`. After `npm run build`, run an input with `npm start -- input_examples/01-minimal.json`. Examples validate the checkpoint metadata contract and stay offline. They must not imply that the four domain roles or Zetaris integration have been implemented. Keep generated JSONL traces under ignored `logs/`, and use `--logs-dir` when a check needs a temporary trace directory.

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
