# Shared application backend

The dashboard backend and HazeOps watchers have moved into `app/`. Dashboard UI
remains in `frontend/`. Tasks, collection, dashboard APIs and the World Model now
use one runtime and one scoped SQLite store.

From the repository root:

```sh
npm run build
npm --prefix frontend run dev
```

Vite dev and preview handle every application API route locally. A separate
port-8000 process and `HAZE_API` proxy are unnecessary. For a standalone backend,
run `npm run tasks:serve` (default `127.0.0.1:8787`). This directory retains only
a compatibility launcher: `npm start --prefix server` starts that same backend.

See [the dashboard and state migration guide](../app/dashboard/README.md) for
configuration, module locations and importing a legacy `.state/haze` archive.
The old World Model JSON, raw evidence and H-MEM files remain untouched until
explicitly handled. H-MEM chat memory is archival and is not part of the active
shared World Model.

The duplicate template chat/report protocol is retired. `/api/runs` and
`/api/reports` return explicit guidance to the durable v3 `/api/tasks` API.
Old report event streams emit a readable failure message; old reports themselves
were process-memory records and were never durable saved tasks.
