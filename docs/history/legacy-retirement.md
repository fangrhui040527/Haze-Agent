# v0.13 scheduling retirement — 25 October 2026

The historical crew-scheduling backend and its connected demo UI have been removed from the active repository. General chat now uses the PM2.5 task paths. Crew-scheduling requests no longer select fictional crew data, invoke the old schedule workflow or render schedule comparisons; unsupported requests receive the task capability's scope/error response.

The retirement covers schedule-specific admission/result/handoff contracts, producer and checker code, worker-occupancy evidence linkage, planning-pack import/validation, generated scheduling schemas, fixtures, release checks, scripts and their dedicated tests. The scheduling documentation (`chat-crew-scheduling.md`, `demo-contract-review.md`, `demo-scope.md`, `sample-data-pack.md` and `two-worker-fixture.md`) was removed with that code.

Before cleanup, a verified external source archive was created as `legacy-retirement-20261025T092637Z/source-before-cleanup.zip`, with 519 files. It preserves the removed immutable fixture bytes, hashes and review context for recovery. Git history also preserves previously committed files. Restoring that package would require a deliberate migration; old planning payloads are not converted into current task requests.

The current [v1 PM2.5 task API](../evidence/milestone-v014.md), [v2 orchestration scaffold](orchestration/orchestration-scaffold.md), shared JSON/hash utilities, metadata examples, checkpoint compatibility proof, pinned Meterless engines and Zetaris tooling remain. Supplied architecture/reference PDFs are preserved. Older frontend discovery documents and the v0.8 HTML remain labeled historical; the UI design document is still referenced by the frontend.

Historical verification records retain their original scope and test counts. They do not certify the repository after retirement. Current validation belongs to the retirement change's executed check results; live source readiness still requires a successful configured source-backed run.

## Post-retirement verification

Executed with Node 24.22.1 and npm 11.8.0:

- `npm run check` passed: source pins, formatting, root/SmokeLedger types, lint, clean backend build, 222 backend tests, 21 engine conformance checks, frontend production build and 63 frontend tests, plus the fixture integration verifier.
- The synthetic orchestration HTTP task completed five model turns, five tool operations and nine immutable artifacts. A fresh server process returned identical task and event records.
- Sixteen HTTP checks against actual Vite dev and preview servers passed: retired/unknown API routes return JSON 404 responses; current task validation and same-origin checks remain enforced; application page routes retain their HTML fallback.
- Browser verification submitted a PM2.5 request through the current chat, rendered its explicitly synthetic answer, exact citation and execution receipts, and retained the answer after reload. No browser console errors were observed.
- Independent comparison with the pre-cleanup source archive found all 101 retired backend/frontend paths absent and no remaining source imports of them. The build removed their 63 stale backend outputs. Shared JSON/hash, model and SQLite helpers, source pins, lockfiles and supplied PDFs were preserved.

All verification used isolated temporary state. Existing task stores and user servers were preserved. No configured live source-backed run or PostgreSQL saver test was repeated for this retirement; the saver implementation and dependencies did not change. Fixture success does not resolve the existing live Zetaris readiness gap.
