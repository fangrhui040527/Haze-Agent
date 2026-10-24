# 03 — UI Design (Phase 3, step 1)

> **Direction:** live haze information dashboard. Location- and audience-agnostic (public **and** experts). Mock data only for now; the backend team is still working.
> **Builds on:** decisions in `01-project-understanding.md`, recommendations in `02-critique.md`.
> **No application code in this step.**

---

## 1. Sitemap

```
/                     Dashboard (main page)
├── Live table        (section 1)
├── Chat              (section 2)
└── Agent office      (section 3)

/item/:id             Detail page ("Read more")
/demo-data            Demo Data page (developer tool)
*                     Not found page
```

- **3 pages + 1 not-found page.**
- Every page has a fixed header containing:
  - the logo
  - a **DEMO DATA** badge
  - the connection status
  - "last updated"
  - links to Dashboard and Demo Data

---

## 2. User flows

### 2.1 Browse the live table → read more

```
Open "/" → table loads (skeleton rows) → rows ranked by score
   → "3 new updates — show" bar appears (rows never jump on their own)
   → click "Read more" on a row → /item/:id (full details)
   → "Back" returns to "/" with the same scroll position and filters
```

### 2.2 Ask the agents

```
Type a question → Send
 → Manager (at the office reception desk, next to the chat) shows a thought bubble
 → Manager walks into the office and hands the task to HazeOps
 → HazeOps gathers → World Model / H-Mem read context → EvidenceCritic checks
   → WorkerShield assesses impact → result goes back to the Manager
 → Manager walks back to reception → answer appears in the chat, with source links
 Status line (always visible as text): "EvidenceCritic is checking 4 sources…"
 Cancel button is available the whole time.
```

### 2.3 Developer: improve the demo data

```
/demo-data → view counts and raw JSON → Regenerate (with a seed) or Import JSON
  → "Simulate new events" (1 / 5 / burst / auto every N seconds)
  → go back to "/" and watch the table update → Export JSON to save
```

---

## 3. Layout decision (the three sections)

**Problem:** stacking table → chat → office vertically doesn't fit a laptop screen. The Manager's walk from the chat to the office must be visible all at once (see `02-critique.md` §7).

**Decision:**

| Screen width           | Layout                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Desktop ≥ 1024 px**  | Table on top in a **height-limited scroll box (~42% of the viewport)**. Below it, **chat (left, ~40%) and office (right, ~60%) side by side**. The office's reception desk touches the chat. |
| **Tablet 768–1023 px** | Table (~40%), then chat, then office (shorter, ~260 px).                                                                                                                                     |
| **Mobile < 768 px**    | Table becomes a **card list**, then chat, then the office as a **compact strip** (toggle to expand). The text status line stays visible.                                                     |

- The **status line** sits directly under the chat input, so it's always next to where the user is looking.
- The office has an **on/off toggle** ("Show office"). It defaults to **off** when `prefers-reduced-motion` is set. (That's the operating-system setting that asks apps for less animation.)

---

## 4. Wireframes

### 4.1 Main page: desktop

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◼ HazeWatch  [DEMO DATA – fictional]   ● Live (mock)  Updated 12s ago        │
│                                               [Dashboard] [Demo Data]        │
├──────────────────────────────────────────────────────────────────────────────┤
│ Live haze information           [Search…] [Location ▾] [Category ▾] [Sort: Rank ▾] │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ ▲ 3 new updates — show                                                    │ │
│ │ # │Score│Updated │Location        │Category    │Summary        │Air quality│Evidence│Status  │    │
│ │ 1 │ 87 ⓘ│ 5m ago │Pekanbaru, ID   │Fire hotspot│212 hotspots…  │PM2.5 168 ■ │ 4/4 ✓ │Verified│Read more│
│ │ 2 │ 81 ⓘ│ 12m ago│Kuching, MY     │Reading     │PM2.5 rising…  │PM2.5 142 ■ │ 3/4   │Verified│Read more│
│ │ 3 │ 74 ⓘ│ 1h ago │Delhi, IN       │Advisory    │Schools shut…  │PM2.5 301 ■ │ 2/3   │Partial │Read more│
│ │ … (scrolls inside this box; header row sticks)                           │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────┬────────────────────────────────────────────┤
│ Ask the agents                  │ Agent office                  [Show ☑] [?] │
│ ┌─────────────────────────────┐ │ ┌────────────────────────────────────────┐ │
│ │ You: Is it safe to run in   │ │ │ ▓▓ reception ▓▓│ HazeOps  │ EvidenceCr.│ │
│ │      Jakarta tomorrow?      │ │ │  (Manager 💭)  │ [desk]⌨  │ [desk]     │ │
│ │ Agents: Forecast shows …    │ │ │                │ WorkerSh.│ WorldModel │ │
│ │   Sources: [1] [2] [row #4] │ │ │                │ [desk]   │ [shelves]  │ │
│ │                             │ │ │                │ H-Mem [archive]       │ │
│ └─────────────────────────────┘ │ └────────────────────────────────────────┘ │
│ [Type a question…      ] [Send] │ Legend: who's who                          │
│ ⟳ EvidenceCritic is checking 4 sources… (00:07)  [Cancel]                    │
│ Try: "What's driving haze in Kuching?" "Compare Delhi and Lahore today"      │
└─────────────────────────────────┴────────────────────────────────────────────┘
│ Not medical advice. Follow your local authorities. Sources listed per item.  │
```

- `ⓘ` next to the score opens a "why this rank" popover (see §6).
- The coloured square ■ is the air-quality band. The band name is always written too, never shown by colour alone.

### 4.2 Main page: mobile

```
┌──────────────────────────┐
│ HazeWatch [DEMO] ● 12s   │
│ [Search…] [Filters ▾]    │
├──────────────────────────┤
│ ▲ 3 new — show           │
│ ┌──────────────────────┐ │
│ │#1 Score 87  5m ago   │ │
│ │Pekanbaru, ID         │ │
│ │Fire hotspot · 4/4 ✓  │ │
│ │212 hotspots detected…│ │
│ │PM2.5 168 Unhealthy   │ │
│ │          [Read more] │ │
│ └──────────────────────┘ │
│ (more cards, scrolls)    │
├──────────────────────────┤
│ Ask the agents           │
│ … messages …             │
│ [Type…        ] [Send]   │
│ ⟳ HazeOps gathering…     │
├──────────────────────────┤
│ Office ▸ (tap to expand) │
│ 🧍💭 → 🧍⌨ 🧍 🧍 🧍     │
└──────────────────────────┘
```

### 4.3 Detail page: `/item/:id`

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← Back to dashboard                                    [DEMO DATA – fictional]│
├──────────────────────────────────────────────────────────────────────────────┤
│ Fire hotspot cluster near Pekanbaru                                           │
│ Pekanbaru, Riau, Indonesia · local 14:05 (UTC+7) · your time 15:05            │
│ [Fire hotspot] [Verified] [Rank #1 · score 87]   [Ask the agents about this]  │
├───────────────────────────────────────┬──────────────────────────────────────┤
│ Summary                                │ Why ranked #1                         │
│ Full text summary (3–6 sentences)…     │ Recency    +38 / 40 (5 min old)       │
│                                        │ Severity   +32 / 40 (Unhealthy)       │
│ Key numbers                            │ Evidence   +20 / 20 (4 of 4 checks)   │
│ PM2.5 168 µg/m³ · PM10 210 · AQI 218   │ Penalties   −3 (1 conflicting source) │
│ Wind SW 12 km/h · Visibility 1.8 km    │ Total       87                        │
│ Band: Very unhealthy (US EPA, demo)    │                                       │
├───────────────────────────────────────┴──────────────────────────────────────┤
│ Sources (4)                                                                   │
│ [1] Satellite hotspots · observation · measured 13:40 · retrieved 13:52 · ↗  │
│ [2] Ground monitor PKU-03 · observation · hourly · retrieved 14:00 · ↗       │
│ [3] Regional forecast · forecast · issued 06:00 · valid to 18:00 · ↗         │
│ [4] News report · news · published 12:15 · unverified lead · ↗              │
├──────────────────────────────────────────────────────────────────────────────┤
│ Evidence checks (by EvidenceCritic)                                           │
│ ✓ Freshness: newest source < 1 h      ✓ Two independent sources agree        │
│ ✓ Units consistent (µg/m³)            ⚠ News figure differs from monitor     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Agent results                                                                 │
│ HazeOps        gathered 4 sources (2.1 s)                                     │
│ World Model    stored record rev 3; previous rev 2 superseded                 │
│ H-Mem          similar episode: Sep 2019 Riau haze (link)                     │
│ EvidenceCritic 3 passed, 1 warning                                            │
│ WorkerShield   outdoor-exposure note: follow official advice (link)           │
├──────────────────────────────────────────────────────────────────────────────┤
│ Timeline                                                                      │
│ 12:15 news report published → 13:40 satellite pass → 13:52 HazeOps retrieved │
│ → 13:58 checks done → 14:05 record updated (rev 3)                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ Related items: Kuching PM2.5 rising · Singapore forecast                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**States:**

- Loading → skeleton blocks.
- Unknown id → "Item not found" with a link back.
- Load error → message plus a Retry button.

### 4.4 Demo Data page: `/demo-data`

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Demo Data  ⚠ Everything here is FICTIONAL test data, not real measurements.  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Dataset: seed 2026 · 240 items · 42 locations · 9 categories · 31 sources     │
│ Saved in: this browser (localStorage) · base file: src/mock/seed/*.json       │
├──────────────────────────────────────────────────────────────────────────────┤
│ Generate         Seed [2026   ] Items [240 ] [Regenerate]  [Reset to seed]    │
│ Live simulation  [+1 event] [+5 events] [Burst 20]  Auto ☐ every [10]s        │
│ Scenarios        [Haze spike] [Source outage] [Conflicting reports] [Calm day]│
│ Agent runs       Speed [1× ▾]   Failure rate [0% ▾]   Mode [Full events ▾]    │
│ Import / Export  [Import JSON…] [Export JSON] [Copy to clipboard]             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Browse  [Items] [Locations] [Sources] [Chat scripts] [Event log]              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ table of the selected collection │ JSON viewer of the selected row       │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ Import errors are listed here (field, problem) and nothing is replaced.      │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **"Mode"** switches the mock agent between three behaviours, so you can demo all of them:
  - **Full events:** fallback level A from `02-critique.md` §5.3.
  - **Run state only:** level B.
  - **Failure.**

---

## 5. Live table columns

| Column         | Shows                                                                                                                                                                                | Why                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Rank / Score ⓘ | Position and a 0–100 score, with a "why" popover                                                                                                                                     | Explains the ordering                             |
| Updated        | "5m ago"; hover shows the exact measured and retrieved times                                                                                                                         | Measured time and check time are different things |
| Location       | City, region, country; local time on hover                                                                                                                                           | Location is just a data field                     |
| Category       | One of: Air-quality reading · Fire hotspot · Forecast · Official advisory · Health guidance · Disruption (schools/flights/transport) · News report · Community report · Sensor issue | "Many aspects" of haze                            |
| Summary        | One line, cut to ~80 characters                                                                                                                                                      | Minimal cell                                      |
| Air quality    | Main pollutant value plus the band name and colour, with the standard named in the detail view                                                                                       | No invented "severity"                            |
| Trend          | ↑ ↓ → against the previous reading                                                                                                                                                   | Quick signal                                      |
| Evidence       | "3/4 ✓" checks passed; source count                                                                                                                                                  | Not a fake % confidence                           |
| Status         | Verified · Partially verified · Unverified · Conflicting · Stale · Retracted                                                                                                         | Honest state                                      |
| Read more      | Button → `/item/:id`                                                                                                                                                                 | Full detail                                       |

Missing values show **"— no data"**, never 0.

---

## 6. Ranking rule (one documented function)

`rankItem(item, now)` returns `{ score, parts[] }`. Score = sum of the parts, clamped to 0–100.

| Part      | Points      | Rule                                                                                                                                                                                                       |
| --------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recency   | 0–40        | `40 × 0.5^(ageHours / 6)`: halves every 6 hours                                                                                                                                                            |
| Severity  | 0–40        | Band index: Good 0 · Moderate 8 · Sensitive 16 · Unhealthy 24 · Very unhealthy 32 · Hazardous 40. Non-reading categories (e.g. an advisory) use the band of their linked reading, or 10 if there isn't one |
| Evidence  | 0–20        | `20 × checksPassed / checksTotal` (0 if no checks)                                                                                                                                                         |
| Penalties | down to −20 | Stale −10 · Conflicting −5 · Unverified-only source −5 · Retracted → score 0                                                                                                                               |

- **Ties:** newer first, then location name A→Z.
- **Default sort is Rank.** The user can switch to **Newest**.
- The popover shows every part, so nobody has to trust a magic number.

**Band thresholds:** the mock data uses US EPA PM2.5 breakpoints (2024 revision), labelled "demo bands". Real per-country standards (Malaysia API, Singapore PSI, EU EAQI…) are a TODO for when real data arrives; each location already stores its `aqiStandard` name.

---

## 7. Agent office

### 7.1 Is pixel-agents reusable? (checked 23 Oct 2026)

| Part                                  | Licence                                                                                       | Verdict                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Code (`pixel-agents-hq/pixel-agents`) | **MIT**, © 2026 Pablo De Lucca                                                                | **Legally** reusable if we keep the copyright notice |
| Character sprites                     | Based on **JIK-A-4 "Metro City" pack, CC0** (public domain; credit appreciated, not required) | Legally reusable                                     |
| Bundled furniture, floors and walls   | **No separate attribution or licence stated** in the README                                   | **Unclear: don't copy**                              |

**Technically**, its renderer is tied to a VS Code webview, a Fastify server and Claude Code hook events. Pulling it out would take longer than writing a small renderer.

**Decision:** build an **original lightweight canvas office** inspired by its style:

- Top-down view, desks, walking characters with typing and reading states.
- **Original sprites drawn in code** (tiny pixel grids defined in TypeScript), so there are no licence questions.
- The CC0 Metro City characters can be dropped in later. We'd credit JIK-A-4 even though it isn't required.

**Something worth copying (as an idea, not code):** pixel-agents drives every animation from an **event model** (`SessionStart`, `PreToolUse`, `Stop`…). We do the same with `AgentEvent`.

### 7.2 Office layout

20 × 12 tiles of 16 px (320 × 192 logical pixels), drawn at a whole-number scale so every art pixel is the same size.

```
┌───────────────┬──────────────────────────────────────────────────────┐
│ HAZEWATCH sign│ window   AQI whiteboard  clock  coffee   window  shelves│
│ Manager behind│ HazeOps desk   EvidenceCritic desk   World Model desk   │
│ the counter   │                                                         │
│ water cooler  door ──►        [ meeting table on a rug ]               │
│               │                                                         │
│ sofa · cat    │ WorkerShield desk                     H-Mem desk  files │
└───────────────┴──────────────────────────────────────────────────────┘
```

Ideas taken from pixel-agents (as ideas, not code or art):

- **Tile grid + breadth-first path finding** around furniture; the Manager walks through the door.
- **Depth sorting by each object's bottom edge**, so people sit _behind_ their desks.
- **Typing vs reading**: HazeOps, WorkerShield and the Manager type; EvidenceCritic, World Model and H-Mem read papers.
- **Pixel speech bubbles** (thinking …, done ✓, failed !) instead of emoji.
- **Idle wandering** between runs (coffee machine, whiteboard, window, shelves, water cooler) and an office cat. Off when reduced motion is on; any event sends the agent straight back to its desk.
- **Click a character** (or its legend entry) to select it and see its role and status.
- Sprites are cached per frame; walking has a 4-frame cycle in 4 directions; characters blink.

### 7.3 Event script (mock `AgentService`, "Full events" mode)

| #   | Event                                | Office shows                       | Status line                                      |
| --- | ------------------------------------ | ---------------------------------- | ------------------------------------------------ |
| 1   | `run_started`                        | Manager 💭 at reception            | "Manager is reading your question…"              |
| 2   | `agent_moving` (Manager → office)    | Manager walks to the meeting table | "Manager is briefing the team…"                  |
| 3   | `handoff` Manager→HazeOps            | Paper icon moves between them      | "HazeOps is gathering data for Jakarta…"         |
| 4   | `agent_working` HazeOps              | Typing ⌨ animation                 | (same)                                           |
| 5   | `handoff` HazeOps→World Model, H-Mem | Two papers move                    | "World Model and H-Mem are looking up records…"  |
| 6   | `handoff` →EvidenceCritic            | Magnifier animation                | "EvidenceCritic is checking 4 sources…"          |
| 7   | `handoff` →WorkerShield              | Shield icon                        | "WorkerShield is assessing outdoor exposure…"    |
| 8   | `handoff` →Manager                   | Paper back to the Manager          | "Manager is preparing the answer…"               |
| 9   | `agent_moving` (Manager → reception) | Walks back                         | (same)                                           |
| 10  | `run_completed`                      | Manager 💬                         | Answer appears in the chat                       |
| ✕   | `run_failed`                         | Red ! over the agent that failed   | "EvidenceCritic failed: source timeout. [Retry]" |

**Reduced motion:** no walking or bouncing. Characters swap pose instantly, the active desk gets a highlight border, and the status line is unchanged.

---

## 8. States everywhere

| Area      | Loading                         | Empty                                          | Error                                                                      |
| --------- | ------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Table     | 8 skeleton rows                 | "No items match your filters. [Clear filters]" | "Couldn't load data. [Retry]" plus the last good data marked "as of hh:mm" |
| Detail    | Skeleton blocks                 | —                                              | Not found / Retry                                                          |
| Chat      | Typing dots and the status line | Example prompts                                | Message bubble in red with [Retry]; Cancel while running                   |
| Office    | Characters idle                 | —                                              | Red ! plus status text                                                     |
| Demo Data | —                               | "No data — Regenerate"                         | Import errors listed by field                                              |

---

## 9. Design tokens (one file: `src/styles/tokens.css`)

"Design tokens" are named values (colours, spacing, fonts) defined once and reused everywhere.

| Group                     | Contents                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Colours                   | Background, surface, text, muted, border, accent; status colours (verified, warning, error, stale) |
| Air-quality bands         | 6 colours chosen to stay distinguishable for colour-blind users, **always paired with text**       |
| Spacing                   | 4-px scale (4, 8, 12, 16, 24, 32)                                                                  |
| Type                      | System UI font for the app; monospace for numbers and pixel labels                                 |
| Radius / shadow / z-index | Small fixed sets                                                                                   |
| Motion                    | Durations, plus a `--motion-scale` that is 0 when reduced motion is on                             |
| Themes                    | Light and dark through `prefers-color-scheme`                                                      |

---

## 10. Accessibility checklist

- Everything is usable by keyboard. The table rows' "Read more" buttons are real `<button>`s and links.
- The status line is an `aria-live="polite"` region, so screen readers announce agent progress.
- The office canvas has a text alternative: a hidden list of "who is doing what" kept in sync.
- Colour is never the only signal (bands, statuses).
- Focus is visible, the chat input has a label, and contrast is at least 4.5:1.
- `prefers-reduced-motion` is respected, and the office toggle is remembered per browser.

---

## 11. Mock data plan ("as wide as possible")

Seed JSON files plus a generator. Everything is labelled `"fictional": true`.

| Collection                  | Contents                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Locations (~40)**         | Cities on every continent in haze- and smoke-prone regions: Southeast Asia, South Asia, East Asia, North and South America, Europe, Africa, Oceania. Fields: name, region, country, lat/lon, IANA time zone, `aqiStandard`, population band |
| **Categories (9)**          | The list in §5                                                                                                                                                                                                                              |
| **Pollutants & weather**    | PM2.5, PM10, O₃, NO₂, CO, SO₂, AOD; wind, humidity, rain, visibility, temperature                                                                                                                                                           |
| **Fire data**               | Hotspot counts, fire radiative power, land type (peat / forest / agriculture), detection confidence                                                                                                                                         |
| **Impacts**                 | School closures, flight delays, hospital visits, outdoor-event cancellations, outdoor-work advisories                                                                                                                                       |
| **Sources (~30 fictional)** | Kinds: ground monitor, satellite, forecast model, government agency, news outlet, community report, low-cost sensor. Each has a licence note, update cadence and reliability notes                                                          |
| **Items (~240)**            | Each item has: summary, details, readings, sources, evidence checks, agent results, timeline, status, related items                                                                                                                         |
| **Edge cases (deliberate)** | Missing values, a stale source, conflicting sources, a retracted item, an unverified news-only item, a sensor fault, a zero reading, an extreme reading, very long text, non-ASCII place names                                              |
| **Chat scripts**            | Example question → answer templates per intent (compare locations, forecast, cause, health guidance, sources, "what changed") with citations to item IDs; plus failure scripts                                                              |

**Simulation:**

- The live simulator creates new items or revisions every N seconds.
- Scenarios (spike / outage / conflict / calm) change what gets generated.
- All randomness uses a **seeded** generator, so the same seed always gives the same data.

---

## 12. Planned tech and dependencies (to be confirmed in Phase 3)

| Package                                      | Why                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react`, `react-dom`                         | UI library (requested)                                                                                                                                                                                           |
| `typescript`, `vite`, `@vitejs/plugin-react` | Typed code plus a fast dev server (requested)                                                                                                                                                                    |
| `react-router`                               | Real URLs for `/item/:id` and `/demo-data`, and a working back button. Writing our own router would be more code and more bugs. (Since v7 the package is `react-router`; `react-router-dom` is only a re-export) |
| `vitest` (dev only)                          | Unit tests for the ranking function and the data generator, which are the two places where silent bugs would mislead users                                                                                       |

**Not adding:**

- a UI kit (tokens + CSS are enough),
- a state library (React context is enough),
- faker (our generator is location-aware and seeded),
- a canvas/game library (the office is small).

**Location:** the app goes in a new `frontend/` folder, separate from the backend's root `package.json`.
