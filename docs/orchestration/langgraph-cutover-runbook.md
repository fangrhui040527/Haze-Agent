# LangGraph cutover and rollback runbook

Use a named source directory and a separate target directory. Do not recursively migrate `.state`, migrate in place, or overwrite an existing target. Keep the old executable, its exact dependency pins and an untouched SQLite-safe snapshot together until rollback is no longer required.

No operational state directory was selected by the implementation request. Repository verification uses disposable fixtures; it does not authorize guessing which saved production directory to migrate.

## 1. Record the rollback pair

Record the full source path, application revision or executable snapshot, dependency lockfiles, storage marker and relevant configuration names. Do not copy credentials into a report. Preserve tracked and untracked implementation work without resetting the checkout.

Use pinned Node **24.22.1** and npm **11.8.0** for baseline and final verification. Record `node --version`, `npm --version` and the complete check log. The implementation environment originally reported Node 24.11.0, so the shell default is not sufficient evidence of the pinned runtime.

## 2. Quiesce the old runtime

1. Stop new admissions at the serving boundary.
2. Read every unfinished task and submit pause/cancel using the existing v3 control expectations and a stable idempotency key. Persist the returned receipts.
3. Allow bounded local shutdown and close the old runtime owner. Do not equate local abort with confirmed remote termination.
4. Confirm there are no running assignment leases and no dispatched attempts still represented as executable work. Unresolved dispatched remote attempts must be charged unknown outcomes.
5. Retain all completed results, immutable artifact bytes, history, grants and mutation receipts. Do not delete checkpoints or manually edit task status to make migration pass.

If the old runtime cannot reach the required state, stop here and resolve the outstanding owner or lease. A filesystem copy of a live WAL database is not a verified snapshot.

## 3. Back up and migrate a separate copy

Run the explicit migration command only after quiescence:

```sh
node scripts/migrate-general-state.mjs --source /absolute/old-state --target /absolute/new-state
```

Use the actual platform paths in place of these examples. The source and target must be distinct, non-nested directories; the target must not exist. The migrator validates the old marker and SQLite integrity, takes a SQLite-safe backup and changes only the target. Retain its manifest and hashes.

Require a successful `migration-report.json` before activating the target. A rejected migration may leave a partial target for inspection; its existence or marker does not establish success. The `migration-in-progress.json` sentinel prevents startup of an incomplete target and is removed only after verification. Retry a failed migration into another nonexistent target; do not delete its sentinel to bypass the guard. Verify that the target marker is `haze.general.sqlite.v2`, imported run IDs are unchanged and tagged `legacy`, completed results and mutation receipts remain readable, and every artifact retains its byte content and hashes. Old reference checkpoints are archival input, never executable LangGraph checkpoints. Confirm the source hashes and old marker remain unchanged after migration.

## 4. Verify the migrated copy

Run repository checks and the process-crash verifier with the pinned toolchain:

```sh
npm run check
node scripts/verify-langgraph-crashes.mjs
```

For the migrated copy, verify completed-task and artifact readback first. Confirm startup does not run any imported assignment. Attempt legacy Resume and objective update and confirm their upgrade-required rejection. Cancellation and revocation must remain available.

Select an unfinished legacy task for an explicitly authorized Continue. Record the predecessor and successor IDs. Re-send the same request and idempotency key; it must return the same successor. Check that old reviews do not confer support and source reuse requires current grants, exact hashes and applicability. Do not submit Continue merely to make every legacy task active.

## 5. Switch the serving process

Stop the verification owner before starting the serving owner. Start the new executable against the verified target only. Confirm a second owner is rejected. Keep admission closed until readback, permissions and a bounded explicitly admitted smoke task are checked; then route normal admission to the new runtime.

Retain the old executable and untouched old-format snapshot. Retain verification reports with the application revision and state path so evidence is not accidentally attributed to another copy. There is one execution runtime after cutover; do not use a permanent old/new execution flag.

## 6. Roll back without losing new history

1. Stop new admission to the new runtime.
2. Pause/fence unfinished new runs through controls, finish bounded local shutdown and close the owner.
3. Archive the entire new-format directory intact with its matching new executable/reader and verification metadata. Retain post-cutover artifacts and history there.
4. Restore a separate serving copy of the untouched old-format snapshot and run it only with the matching old executable and dependencies.
5. Verify historical readback before reopening admission. Any replacement execution requires an explicit new admission or control supported by that executable.

Never run the old executable against a v2 database. Never downgrade the new database or merge post-cutover histories backward. Rollback restores the old snapshot's point in time; the archived new-format pair preserves everything created after that point.

Rehearse these steps with disposable state before the operational switch. Record the archive paths, artifact/result comparisons and owner rejection. A documented procedure by itself is not evidence that a rollback was rehearsed.

The repository rehearsal accepts the retained old executable directory explicitly:

```sh
node scripts/verify-langgraph-rollback.mjs --legacy-executable /absolute/retained-old-dist
```

It creates disposable old-format state with that executable, migrates a copy, retains a new-format result, archives the new state and a matching built reader, restores the untouched old snapshot into a separate directory and compares readback through both matching runtimes. It never operates on a selected deployment directory.
