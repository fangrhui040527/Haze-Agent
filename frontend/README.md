# Haze frontend

A live haze-information dashboard with an AI-agent team (Manager, HazeOps, World Model, H-Mem,
EvidenceCritic, WorkerShield) shown as a pixel-art office.

> **Status: read-only evidence chat plus a live dashboard with fictional fallback.** General chat uses the
> durable task API and a single configured Zetaris SmokeLedger PM2.5 source. Missing access
> or provider failures are explicit errors; no mock answer is substituted. Operational actions
> and publication remain outside this milestone. See [implementation and verification](../docs/evidence/milestone-v014.md).

Current design and implementation: [`docs/evidence/milestone-v014.md`](../docs/evidence/milestone-v014.md)
and [`docs/orchestration/orchestration-scaffold.md`](../docs/orchestration/orchestration-scaffold.md).

---

## 1. Run it locally (Windows, macOS, or Linux)

Use the repository's pinned **Node.js 24.22.1** and **npm 11.8.0**. Check with `node --version`.

Open a terminal in the cloned repository's root folder (the folder containing `frontend`), then run:

```sh
npm ci               # installs the shared contracts and task backend dependencies
npm run build        # builds the current backend
cd frontend
npm ci               # installs the dependencies from the committed lockfile
npm run dev          # starts the app
```

These commands work in PowerShell and macOS/Linux shells. If your terminal is already in `frontend`, run `npm ci --prefix ..` for the shared dependencies, then `npm ci` and `npm run dev`.

Keep the terminal running and open the **Local** URL printed by Vite, usually **http://localhost:5173**. If that port is occupied, Vite may choose another port. Stop the server with `Ctrl + C`.

Live tasks require a configured model provider. Capabilities that retrieve external evidence also require their server-side source configuration. Vite dev/preview read
the shared root `.env` configuration server-side, with process environment taking
precedence and `app/adapters/zetaris/.env.local` supplying missing legacy settings.
Vite mode files retain their normal override behavior. Keep `VITE_API_BASE_URL` empty for the
same-origin local API; never put credentials in `VITE_*` variables. Restart Vite after changing
configuration. Dev and preview must not simultaneously own the same general state directory (`.state/general-v1` by default).
Static hosting needs an authenticated backend adapter.

Try: “Summarize the PM2.5 evidence available for Kuala Lumpur during 2026-10-23 to 2026-10-24,
distinguish modeled values from observations, and identify coverage gaps.” Edit the location and
dates for your request. Dates are UTC, the end is exclusive, and the maximum interval is 31 days.
The answer links exact captured evidence and shows coverage, gaps, assumptions, review scope
and actual execution provenance. **Stop waiting** detaches the browser; an admitted task remains
readable through **Saved task**. **Open task report** opens that same task at `/task/:id`,
including its actual receipts, source material, questions, controls and current result.
Retrying a submission keeps its idempotency key.

Every task uses the general v3 protocol. Only an objective is required. Attach or paste
UTF-8 text, Markdown, CSV, or JSON source material (up to 1 MiB per source), and provide
optional JSON scope when useful. Questions and exact corrections remain in saved history.
The office shows actual assignment receipts and waiting states. Pause, cancel, resume,
continuation, and permission revocation use current revision expectations; receipts distinguish
requested and confirmed state. Fixture adapters are labeled and do not establish live readiness.

The crew-scheduling demo is retired. Existing browser chat text remains visible as
archived history; new questions always use the evidence task API.

| Command                 | What it does                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`           | Development server with instant reload                                                                               |
| `npm run build`         | Type-checks, then builds the production files into `dist/`                                                           |
| `npm run preview`       | Serves the built `dist/` folder locally                                                                              |
| `npm run typecheck`     | TypeScript check only (no build)                                                                                     |
| `npm test`              | Runs the unit tests once (`npm run test:watch` keeps watching)                                                       |
| `npm run data:generate` | Rebuilds the demo data file (`-- --seed 7 --items 400` to change it; add `--coverage worldwide` for every continent) |

---

## 2. What's on screen

| Page             | URL           | Purpose                                                                                                    |
| ---------------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| Dashboard        | `/`           | Live table (top), chat (bottom left), agent office (bottom right)                                          |
| Detail           | `/item/:id`   | Everything about one item: summary, numbers, why ranked, sources, evidence checks, agent results, timeline |
| Task report      | `/task/:id`   | Saved general task, live receipts, clarification, controls and results                                     |
| Dashboard report | `/report/:id` | Template report from the separate dashboard server                                                         |
| Demo Data        | `/demo-data`  | Developer tool: view, regenerate, import/export data and simulate dashboard updates                        |

Things worth trying on the Demo Data page:

- **"Make the next dashboard load fail"** shows the dashboard's error state.
- The **scenarios** (haze spike, source outage, …) change what simulated events look like.

Agent simulation controls and chat templates are retained for the optional offline mock.
They do not affect the configured HTTP agent service or live task execution.

---

## 3. Folder structure

```
frontend/
├─ public/demo-data/demo-data.seed.json   ← the committed demo dataset (generated, fictional)
├─ scripts/generate-seed.ts               ← `npm run data:generate`
└─ src/
   ├─ main.tsx                 entry point
   ├─ app/                     shell: routes, header/footer, live data provider
   │  ├─ router.tsx            ← all pages are registered here
   │  ├─ AppLayout.tsx
   │  └─ LiveDataProvider.tsx  loads data once, receives live updates, "N new updates" queue
   ├─ features/                one folder per feature (one owner each, see §8)
   │  ├─ live-table/           table, filters, ranking.ts (THE ranking rule) + tests
   │  ├─ chat/                 chat panel + status line
   │  ├─ agent-office/         pixel office: layout, model (events → poses), sprites, canvas renderer
   │  ├─ detail/               "Read more" page
   │  ├─ demo-data/            Demo Data page
   │  └─ dashboard/            main page + useAgentRun (one run shared by chat and office)
   ├─ services/
   │  ├─ data/                 DataService, MockDataService, HttpDataService, CompositeDataService, index.ts ← swap here
   │  └─ agents/               AgentService interface, HttpAgentService, optional offline mock, index.ts
   ├─ mock/                    everything fake: generator, simulator, demo store, mock answers, mock settings
   ├─ shared/
   │  ├─ types/                domain.ts (HazeItem…), agents.ts (AgentEvent), dataset.ts
   │  ├─ ui/                   Button, Badge, BandBadge, StatusBadge, States (loading/empty/error), TimeAgo
   │  ├─ hooks/                useNow, useMediaQuery, useReducedMotion, useLocalStorageState…
   │  └─ lib/                  bands, labels, time formatting, seeded random, tiny store
   └─ styles/
      ├─ tokens.css            ← ALL colours, spacing, fonts, motion (design tokens)
      └─ global.css
```

**Rules of thumb**

- A feature only imports from `shared/`, `services/` (the `index.ts` files) and `app/liveDataContext.ts`.
  It never imports a mock directly. The only exceptions are the Demo Data page and the mock services themselves.
- Styles: one `*.module.css` per component (class names are scoped automatically). Use `var(--token)` from `tokens.css`; no hard-coded colours.
- Never show a missing value as 0. Show "no data".
- Never show colour alone. Always pair it with text (band names, status labels).

---

## 4. How to add a page

1. Create `src/features/my-feature/MyFeaturePage.tsx`:
   ```tsx
   import { Panel } from '../../shared/ui/States.tsx';

   export function MyFeaturePage() {
     return (
       <Panel>
         <h1>My feature</h1>
       </Panel>
     );
   }
   ```
2. Register it in `src/app/router.tsx`: `{ path: 'my-feature', element: <MyFeaturePage /> }`.
3. Optional: add a `NavLink` in `src/app/AppLayout.tsx` so it appears in the header.
4. Need data? Use `useLiveData()` from `src/app/liveDataContext.ts` (already loaded, live) or `dataService` from `src/services/data/index.ts`.
5. Handle the three states: loading (`<Skeleton/>`), empty and error (`<StateMessage/>`).

Imports use explicit `.ts` / `.tsx` extensions (needed so Node can run the data script without a build step).

---

## 5. Real data from the Haze server

The dashboard reads data through `DataService` (`src/services/data/DataService.ts`):
`loadSnapshot()`, `getItem(id)`, `subscribe(onUpdate, onStatus)`.

- `HttpDataService` reads the Haze server (`../server`): `/api/snapshot`, `/api/items/:id` and the
  `/api/stream` SSE feed. In development Vite proxies `/api` to `http://127.0.0.1:8000` (override with
  `HAZE_API`); in a build, set `VITE_API_BASE_URL`.
- `CompositeDataService` (used in `src/services/data/index.ts`) shows **real data when the server has it** and
  falls back to the fictional demo data when the server is unreachable or empty. The Demo Data page has a
  toggle to show demo data next to real data (off by default).
- Real item ids start with `hz-`; demo ids never do.
- Chat always uses the general v3 evidence task API. Dashboard server availability does not select a mock chat backend.

**Important:** the browser must **never** call Zetaris directly or hold Zetaris credentials. Anything in
`VITE_*` variables ships to every visitor. The adapter calls _our_ backend API, and the backend talks to Zetaris.
The dashboard server and the general evidence task runtime remain separate services.
Run `npm ci --prefix server` and `npm start --prefix server` from the repository root for real dashboard data.
Its report pages use `/api/reports/:id/events`; the general evidence protocol owns `/api/tasks`.
Vite dev and preview proxy dashboard routes to `http://127.0.0.1:8000` (override with `HAZE_API`).

---

## 6. Evidence task API and actual execution events

`src/services/agents/index.ts` selects `HttpAgentService` for all questions. The table can show real
dashboard data and explicitly fictional fallback data; table items are never passed as trusted evidence context.

The HTTP adapter posts `haze.task.request.v3` to `/api/tasks`, then polls
`/api/tasks/:id/events?after=CURSOR` and `/api/tasks/:id`. Shared Zod schemas validate admission,
status, result and event pages. Global durable cursors are strictly increasing and can contain
gaps caused by other tasks. Terminal status is drained through the matching final event page.

The office consumes server `TaskEvent` receipts directly through the `task_event` variant.
Only the named participants show activity; no handoffs or unused specialists are invented.
The expandable receipt log preserves timestamps, actors and messages. Network, contract and
provider errors reject explicitly and never trigger `MockAgentService`.

General evidence results use `source: 'evidence_model'` only after completed, validated model
synthesis. Sources link exact immutable artifact versions with hash and selection metadata.
The general result panel shows work products, covered scope, uncertainty, review, currency,
next requirements, and actual execution provenance. PM2.5 coverage is an optional domain renderer. Successful captured-shape unit fixtures verify wiring;
they do not establish live source readiness.

---

## 7. Demo data

- **Source of truth:** `public/demo-data/demo-data.seed.json`.
  - 240 items, 35 Southeast Asian locations, 12 fictional sources, 9 categories, 6 statuses.
  - **Focus:** Malaysia first (15 cities, ~55% of items), then Indonesia (9 cities, where most of the fire smoke starts, ~28%), then neighbours hit by the same smoke (Singapore, Brunei, southern Thailand) and the Mekong dry-season haze countries. Weights live in `COUNTRY_FOCUS` in `locations.ts`.
  - The other continents are still in `locations.ts`; use **Coverage → Worldwide** on the Demo Data page, or `--coverage worldwide`, to include them.
  - It also contains 12 deliberate edge cases (missing values, zero, extreme value, long text, retracted, conflicting, missing source, …). Filter by `edge-case` on the Demo Data page.
- **Generator:** `src/mock/generator/`. Add locations in `locations.ts`, sources in `sources.ts`, wording in `text.ts`, chat answers in `chatScripts.ts`. Then run `npm run data:generate`.
- **Same seed = same data.** On load, times are shifted so the newest item is "just now" (`rebase.ts`).
- **Browser copy:** Regenerate and Import save a copy in your browser only. Simulated live events stay in memory.
  Use **Export JSON** to keep them, and commit an export as the new seed file if the team should get it.
- Every dataset is marked `"fictional": true`. Import rejects files without it.
- Source URLs use `example.org`, so no real organisation is imitated.

---

## 8. Git workflow for 5 people

`frontend` is the base branch for frontend work; `main` belongs to the whole project.

```powershell
git switch frontend
git pull
git switch -c frontend/live-table-filters   # one branch per task: frontend/<feature>-<short-name>
# ...work, commit small steps...
git push -u origin frontend/live-table-filters
# open a Pull Request INTO frontend (not main); one teammate reviews; merge
```

Suggested ownership (one feature folder each, to avoid merge conflicts):

| Person | Folder(s)                                                        |
| ------ | ---------------------------------------------------------------- |
| 1      | `features/live-table`, ranking                                   |
| 2      | `features/chat`, `services/agents`                               |
| 3      | `features/agent-office`                                          |
| 4      | `features/detail`, `shared/ui`                                   |
| 5      | `mock/`, `features/demo-data`, `services/data` (backend liaison) |

- Before every PR, run `npm run build` and `npm test`. Both must pass.
- Merge `frontend` into `main` only when the team agrees, through a reviewed PR.
- Don't commit `node_modules/`, `dist/` or `.env.local` (already in `.gitignore`).

---

## 9. Dependencies (kept minimal)

| Package                        | Why                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `react`, `react-dom`           | UI library                                                                     |
| `react-router`                 | Real URLs (`/item/:id`, `/demo-data`), working back button, scroll restoration |
| `vite`, `@vitejs/plugin-react` | Dev server and production build                                                |
| `typescript`                   | Type checking                                                                  |
| `vitest` (dev)                 | Unit tests for the ranking, generator, mock answers and office logic           |
| `@types/*` (dev)               | Type definitions                                                               |

No UI kit, state library, faker or canvas/game engine. The design tokens, a tiny store, our own seeded
generator and a 320×180 canvas cover what we need.

---

## 10. Accessibility checklist (keep it true)

- Everything works with the keyboard. "Read more" and the score buttons are real buttons and links.
- The agent status line is an `aria-live` region. The office has a text legend saying what each agent is doing.
- `prefers-reduced-motion`: the office starts hidden, characters snap instead of walking, and desks highlight instead of flying papers.
- Colour is never the only signal. Missing data says "no data".

## 11. Credits

The pixel office is **original work** (sprites are drawn in code in `features/agent-office/sprites.ts`).
It is inspired by the style of [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT).
No code or image assets were copied.

## General task interface

Chat uses `haze.task.request.v3` for every task. Only the objective is required. Optional source imports accept UTF-8 text, Markdown, CSV, and JSON, up to 1 MiB per file. Scope is optional JSON interpreted by a registered capability.

The local Vite API plugin serves task admission/readback/events, corrections, controls, authorized capabilities, and exact artifacts. It uses `.state/general-v1` unless `STATE_DIR` is explicitly set. Set server-side `HAZE_EXECUTION_MODE=fixture` for fixture verification; live is the default. There is no automatic fixture fallback.

Questions and correction passages remain attached to the saved task. Pause, cancel, resume, and continuation send the current objective/run/generation/state revisions and display persisted requested/confirmed receipts. Stopping the browser wait does not cancel the saved task. General results show work products, sources, scope, uncertainty, review, currency, and provenance. PM2.5 coverage is an optional `pm25.analysis` artifact renderer.
