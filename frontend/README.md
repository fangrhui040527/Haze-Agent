# HazeWatch frontend

A live haze-information dashboard with an AI-agent team (Manager, HazeOps, World Model, H-Mem,
EvidenceCritic, WorkerShield) shown as a pixel-art office.

> **Status: demo with FICTIONAL data only.** The backend team is still building the real services.
> Everything here runs on mock data and mock agents behind interfaces that the real backend
> can replace without touching the UI.

Design and decisions: [`docs/01-project-understanding.md`](../docs/01-project-understanding.md),
[`docs/02-critique.md`](../docs/02-critique.md), [`docs/03-ui-design.md`](../docs/03-ui-design.md).

---

## 1. Run it (Windows PowerShell)

You need **Node.js 22.18 or newer** (tested on 24.22). Check with `node --version`.

```powershell
cd C:\Dev\Website\Haze-Agent\frontend
npm install          # first time only, downloads the packages
npm run dev          # starts the app
```

Open **http://localhost:5173**. Stop it with `Ctrl + C`.

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

| Page      | URL          | Purpose                                                                                                    |
| --------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| Dashboard | `/`          | Live table (top), chat (bottom left), agent office (bottom right)                                          |
| Detail    | `/item/:id`  | Everything about one item: summary, numbers, why ranked, sources, evidence checks, agent results, timeline |
| Demo Data | `/demo-data` | Developer tool: view, regenerate, import/export data; simulate live events; change mock agent behaviour    |

Things worth trying on the Demo Data page:

- **Agent event detail → "Run state only"** shows how the office behaves if the backend only reports run state.
- **"Always fail"** shows the error path.
- **"Make the next dashboard load fail"** shows the dashboard's error state.
- The **scenarios** (haze spike, source outage, …) change what simulated events look like.

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
   │  ├─ data/                 DataService interface, MockDataService, ZetarisDataService (TODO), index.ts ← swap here
   │  └─ agents/               AgentService interface, MockAgentService, HttpAgentService (TODO), index.ts ← swap here
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

## 5. Swapping the mock data for the real backend (Zetaris)

The whole app reads data through one interface, `DataService` (`src/services/data/DataService.ts`):
`loadSnapshot()`, `getItem(id)`, `subscribe(onUpdate, onStatus)`.

1. Implement the TODOs in `src/services/data/ZetarisDataService.ts`, mapping the backend's JSON into
   `HazeItem` / `Location` / `Source` (`src/shared/types/domain.ts`).
2. In **`src/services/data/index.ts`** (the only file to change), replace
   `export const dataService: DataService = mockDataService;` with
   `export const dataService: DataService = new ZetarisDataService(import.meta.env.VITE_API_BASE_URL);`
3. Copy `.env.example` to `.env.local` and set `VITE_API_BASE_URL`.

**Important:** the browser must **never** call Zetaris directly or hold Zetaris credentials. Anything in
`VITE_*` variables ships to every visitor. The adapter calls _our_ backend API, and the backend talks to Zetaris.
Nothing about Zetaris's API is known yet (see `docs/02-critique.md` §4), so don't guess endpoints.

---

## 6. Replacing the mock agent events with the real backend

The chat, the status line and the pixel office render **only** from a list of `AgentEvent`s
(`src/shared/types/agents.ts`). The backend needs to produce the same events:

| Event                                            | Meaning                                           | Office shows                                          |
| ------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------- |
| `run_started`                                    | Question received                                 | Manager at reception                                  |
| `agent_thinking`                                 | An agent is thinking                              | Thought bubble                                        |
| `agent_moving` (`to: office / reception`)        | Manager walks                                     | Walking animation                                     |
| `handoff` (`from`, `to[]`, `payloadLabel`)       | Work passed between agents                        | Paper flies between desks                             |
| `agent_working` / `agent_completed`              | Agent busy / done                                 | Typing / green tick                                   |
| `run_state` (`queued / running`)                 | **Level B**: backend only knows the overall state | Everyone shows a generic "working"; no invented steps |
| `run_completed` / `run_failed` / `run_cancelled` | End of run                                        | Manager returns; a red "!" on failure                 |

Steps:

1. Implement `src/services/agents/HttpAgentService.ts`:
   - Post the question.
   - Then either read an SSE stream (Server-Sent Events, a simple one-way stream from server to browser) or poll the run status.
   - Map each message to an `AgentEvent` and call `onEvent`.
   - When the run finishes, resolve with an `AgentAnswer`.
2. Swap it in **`src/services/agents/index.ts`**.
3. If the backend only has run states (the spec's `POST /run` → `GET /runs/{id}` polling), emit `run_state` events. The UI already handles that honestly.
4. Set `AgentAnswer.source` truthfully: `'model'` only when a model produced the answer, otherwise `'template_fallback'`.

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
No code or image assets were copied; see `docs/03-ui-design.md` §7.1 for the licence review.
