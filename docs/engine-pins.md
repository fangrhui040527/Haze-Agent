# Engine and workflow pins

`engine_sources.json` is the source provenance contract. The starter, H-MEM, and
World Model are pinned to Meterless commit
`1742dec56a66e58eef9dda2d2b865823758ca8cd`. Checked-in source under
`third_party/meterless/` permits a build without cloning upstream. Each selected
file has a SHA-256 checksum; the tree checksum is SHA-256 of sorted UTF-8 lines
`<file-sha256>  <relative-path>\n`. Git tree IDs also identify the original full
upstream subtrees. The H-MEM and World Model selections include their reference
implementations, upstream tests, conformance runners, specifications and licenses.
The starter selection excludes its tracked node_modules directory. This is a
source pin, not a claim that the reference engines are production services.

## Build and load

Run `npm ci`, then `npm run build`. The build verifies the source checksums and
workflow dependency locks before materializing ignored `vendor/` output. It
adapts the starter setup to copy the pinned H-MEM reference locally, preserves
upstream source and lockfiles, and transpiles with the pinned root TypeScript.
It never executes the starter's floating setup command or installs nested
dependencies. World Model is packaged independently, including its stable IDs,
resolution, event store, ingestion and projections. The engine references have
no runtime npm dependencies.

`vendor/engine_sources.json` records generated entrypoint SHA-256 checksums and
the compiler version. `openHazeEngines` loads the compiled starter loader and
requires its `vendor/hmem` implementation, and loads the separate World Model
facade. Haze delegates to their services and reports actual source revisions and
loaded paths. Mining, ranking, storage, feedback, auditing, IDs, entity
resolution, events and projections are upstream implementations. The starter's
optional provider-specific LLM adapter is not invoked by these adapters.

Runtime does not clone, install dependencies, or download models. Callers supply
explicit engine state directories; keep engine state separate from checkpoints.
This change supplies engine packaging and integration boundaries, not the domain
roles, scheduler, full Haze evidence contracts or scientific validation.

## Workflow compatibility

`app/workflow_versions.json` pins LangGraph, LangChain Core, both persistent
savers, the checkpoint base package and Zod. `package.json` and the committed
root `package-lock.json` must match. Existing pins and resolved dependencies are
preserved; use the pinned npm and `npm ci`.

Checkpoints use graph revision 1 and execution metadata schema revision 2.
Schema 2 adds the graph version to recorded execution metadata. Older schema-1
checkpoints and incompatible graph/schema revisions require an explicit
migration before resuming; Haze does not silently relabel them. SQLite remains
the single-process persistent saver, PostgreSQL the production saver, and
MemorySaver is for disposable tests.

## Verify and update

`npm run check` verifies source and package pins, builds the vendored references,
runs adapter/persistence tests and both pinned upstream conformance runners.
`npm run test:postgres` separately tests PostgreSQL against a disposable database.
Upstream conformance checks only the tested reference contracts, not Haze science.

To update a source, review a full immutable commit, copy its selected files and
applicable licenses/notices without changing their bytes, then regenerate the
per-file and sorted-inventory hashes in `engine_sources.json`. Preserve upstream
lockfiles even when they contain broad manifest ranges; Haze does not run those
package managers. Review generated-loader changes and rerun all checks. For
workflow changes, update `app/workflow_versions.json`, package pins, the root
lockfile and graph/schema compatibility versions together as appropriate.

See `THIRD_PARTY_NOTICES.md` for retained licensing and documented build changes.
