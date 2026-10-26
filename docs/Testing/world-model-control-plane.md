# World Model control plane

Open **World Model** in the main navigation, or visit `/world-model`, to inspect Haze's active SQLite World Model. Dashboard views, HazeOps collection and general tasks now share this store and the same application API. The page has **Inspect**, **Rebuild**, and **Reference sandbox** panels. See the [dashboard migration guide](../../app/dashboard/README.md) for importing an old dashboard JSON archive.

## Run locally

From the repository root, after installing the root and frontend dependencies:

```powershell
npm run build
npm --prefix frontend run dev
```

Open `/world-model` on the local Vite address printed in the terminal. Vite's development server and `npm --prefix frontend run preview` both handle `/api/world` through the local task runtime automatically. A separately started task server is unnecessary for these modes.

The runtime uses server configuration:

- The application chooses `HAZE_TASK_STATE_DIR`, then `STATE_DIR`, then `.state/general-v2` for shared storage. Dashboard, task and control-plane APIs read the same database served by that runtime.
- `HAZE_EXECUTION_MODE=fixture` explicitly selects fixture records in Vite; otherwise Vite selects live mode. Records remain scoped to the server's local identity, workspace, and execution mode. The browser cannot choose another identity or mode.
- The plugin passes `HAZE_WORLD_ACCEPTANCE_POLICY` to the runtime. An unset policy keeps acceptance disabled; `research-v1` is the supported explicit policy. Opening the page does not enable acceptance or change policy.

An empty store displays **No records yet**. Run an evidence task to retain Haze records, or open the reference sandbox to explore disposable examples. If another server owns the configured task directory, use that server or select a separate directory before starting another runtime.

The built frontend served as standalone static files needs a backend and a same-origin proxy for all `/api` routes. A static file host alone cannot inspect SQLite or rebuild projections. The standalone application server is started with `npm run tasks:serve` and uses the same storage selection as Vite; its fixture mode is selected explicitly with `node scripts/serve-tasks.mjs --fixture` after building.

## Inspect retained records

The totals show scoped record, relationship, and event counts, plus the workspace. **Inspect** lists the latest revision of each record, with a kind filter and case-insensitive search by record ID or external/source ID. Search matches literal substrings, including `%` and `_`. **Load more records** follows bounded cursor pages; **Refresh** reloads current data.

Select a record to open its inspector:

| View          | What it shows                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Overview      | Record revision, producer, timestamps, content hash, payload, supporting artifact references, and current acceptance outcomes. |
| Relationships | Incoming and outgoing relationship kinds and connected record revisions. Selecting a connected ID opens that record.           |
| History       | Paginated saved events associated with the record.                                                                             |
| Lineage       | Paginated lineage entries and provenance for the record.                                                                       |

Current acceptance is qualified by its stated use and policy. The UI distinguishes **Accepted for stated use**, **Pending review**, **Not eligible**, **Held**, and **Superseded**. A record with no current decision says so. Retention, an acceptance label, or a passing UI test does not establish scientific or operational readiness.

This is a local operator inspection surface. Task reuse still goes through the existing governed evidence and pinning checks. To correct evidence or request another review, return to the originating task and provide a correction through its normal workflow. The live Haze inspector does not offer arbitrary record editing or Meterless's fuzzy entity-merge controls.

## Rebuild derived views

Open **Rebuild**, or `/world-model?panel=rebuild`, and select **Rebuild projections**. The server rebuilds the current identity, workspace, and mode's record and relationship projections from saved World Model events. The result reports the projection cursor.

The request is a same-origin `POST` to `/api/world/projections/rebuild`, with an empty JSON object and an `Idempotency-Key`. Retries reuse the operation key and receive the persisted receipt when the operation already completed. Immutable records, original events, history, reviews, and acceptance decisions remain retained. A projection rebuild does not correct source evidence or change an acceptance decision.

## Original Meterless sandbox

Open **Reference sandbox**, or `/world-model?panel=reference`, to run the exact upstream [`live.html`](https://github.com/Meterless/Meterless/blob/1742dec56a66e58eef9dda2d2b865823758ca8cd/engines/world-model/control-plane/live.html) from Meterless commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`.

The original control plane includes **Inspect**, **Merge**, **Edit**, **Rebuild**, **Repair**, and **Audit log**. It runs its bundled reference engine with seeded data in browser memory. Changes are disposable and reset when the sandbox is reopened. They never become Haze's SQLite records.

The iframe mounts only while the reference panel is selected and uses `sandbox="allow-scripts"`, without same-origin access. The unchanged upstream HTML, license, and provenance are retained under [`frontend/public/meterless-world-model/`](../../frontend/public/meterless-world-model/README.md). Its fixed **Role: Admin** label belongs to the demo and does not grant Haze permissions.

## Focused verification

Run the control-plane API checks from the repository root:

```powershell
npm test -- tests/unit/world-control-plane.test.ts
```

These checks use temporary fixture state and cover scoped browsing, filters, pagination, response bounds, rebuild replay, idempotency, and request validation. They need no running application, model provider, or Zetaris instance.

Run the frontend suite, including the World Model client, page, and local API routing checks:

```powershell
npm --prefix frontend test
npm --prefix frontend run build
```

For the underlying World Model's isolated contracts, policy, services, and store checks:

```powershell
npm test -- tests/unit/world-contracts.test.ts tests/unit/world-schema.test.ts tests/unit/world-policy.test.ts tests/unit/world-store.test.ts tests/unit/world-services.test.ts
```

`npm run test:engines` additionally runs the pinned Meterless H-MEM and World Model conformance suites. Engine conformance exercises the reference implementations; the control-plane API checks exercise Haze's SQLite integration.

For manual verification, select a retained record, follow a relationship, load history and lineage, refresh the page, rebuild projections, and confirm the record's revision/hash and saved history remain intact. Then open the reference sandbox, try a seed merge or fact assertion, leave the panel, and reopen it to confirm the sample state resets.
