# Dedicated SQLite storage module for Haze

## Summary

Create **`app/storage/`** for SQLite lifecycle management, artifact persistence and World Model storage. Build on the existing integration and add **exact-byte retention for new uploads**.

Decisions confirmed:

- Keep SQLite and the existing state directory.
- Preserve current artifact IDs, version/hash references and supported file types.
- Audit and prepare H-MEM; keep live memory capture disabled.
- Preserve the current working-tree changes.

Baseline verification: Meterless source pins verified, and **43 focused storage and engine tests passed**.

## 1. Audit the existing integration

Before changing code:

- Trace artifact import, retrieval, assignment outputs, World Model projection, corrections and restart recovery.
- Document the distinction between the live Haze SQLite World Model and the pinned Meterless reference engines exercised by compatibility checks.
- Confirm that artifact writes, World Model projections, applicability records, usage charges and operation receipts share the same transaction.
- Record the current storage format, schema versions, source pins, checkpoint locations and compatibility results in the new folder's README.

Keep the existing Meterless loader and upstream sources unchanged. Engine conformance establishes integration behavior; it does not enable live memory capture or domain acceptance.

## 2. Implement the storage folder

Organize `app/storage/` into SQLite, artifact, World Model and Meterless reference modules, with a server-only entry point.

- **SQLite module:** extract directory validation, storage-marker checks, database opening, durability settings, schema initialization and nested transaction handling. Export `openSqliteStorage(...)`, returning the shared database handle, synchronous `atomic(...)` operation and `close()`.
- **Artifact repository:** centralize artifact inserts, identity-scoped reads, exact-reference validation and original-byte retrieval. Use the existing canonical serializer and hashing functions.
- **World Model module:** relocate the existing storage implementation and schema migrations without changing record revisions, projections, lineage or acceptance behavior.
- **Meterless reference module:** delegate explicitly requested compatibility checks to the existing pinned adapter. Expose its existing memory ports for future integration without opening H-MEM during normal task execution.

Keep **`app/tasks/store.ts`** as the task-policy facade. It retains authorization, budgets, leases, applicability and lifecycle decisions while delegating persistence to the new module.

All repositories use the same SQLite connection and transaction function. Preserve existing import locations through thin re-exports where needed. LangGraph checkpoint storage remains separate.

## 3. Retain and retrieve exact upload bytes

Add an independently versioned, additive SQLite migration creating:

`artifact_originals(artifact_id PRIMARY KEY, byte_sha256 TEXT NOT NULL, bytes BLOB NOT NULL)`

For new uploads:

- Capture the decoded upload bytes before UTF-8 decoding or JSON parsing.
- Persist the original bytes, parsed artifact and idempotency receipt in one transaction.
- Preserve the existing distinction between canonical content hash and original-byte hash.
- Use insert-only storage. Replayed imports return the original receipt without overwriting bytes.
- Retain current UTF-8 validation, supported media types and 1 MiB decoded limit.

Add a server-only `artifactOriginal(id, identity, ref?)` method and:

**`GET /api/artifacts/:id/original`**

The endpoint returns the original bytes with the stored media type, safely encoded attachment filename, content length, `no-store` and `nosniff` headers.

Apply existing artifact authorization before disclosure. Verify the stored bytes against the original-byte hash on retrieval; mismatches use the existing integrity-error behavior.

Existing JSON artifact responses and v3 contracts remain unchanged. Raw bytes are not added to model context or checkpoint payloads.

## 4. Preserve existing data and behavior

- Keep the current state directory, database filenames and storage-format marker.
- Apply the additive migration transactionally after existing marker validation.
- Preserve existing artifact bodies, hashes, World Model history and operation receipts.
- For historical imports without retained bytes, return `404 artifact_original_unavailable` from the new endpoint. Continue serving their existing parsed content.
- Do not reconstruct originals from parsed JSON or silently backfill historical imports.
- Keep current artifact version semantics; same-ID revision chains remain outside this implementation.
- Update storage documentation and API documentation. No frontend redesign is included.

## 5. Verification and acceptance

Add focused tests covering:

- Exact round trips for formatted JSON, Unicode, CSV line endings and UTF-8 BOMs.
- Equal canonical hashes but different original bytes for differently formatted JSON.
- Idempotent imports and rollback when original-byte persistence fails.
- Identity isolation, revoked grants and corrupted-byte detection.
- Opening existing databases, unavailable historical originals and repeatable migrations.
- Restart readback of artifact references, original bytes and World Model history.

Re-run Meterless pin, engine and compatibility tests using isolated temporary directories and deterministic provider fixtures.

Complete one flow: **upload -> parsed retrieval -> original-byte download -> task use -> process restart -> identical readback**. Then run the repository's full check once, recording unrelated baseline failures separately.

Acceptance requires working storage implementations inside the new folder, unchanged existing task behavior, durable exact originals for new uploads, and H-MEM remaining disabled in live execution.
