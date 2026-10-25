# 02 — Critique and Reality Check (Phase 2)

> **Historical record.** This critique concerns the earlier v0.13 backend/frontend split. References to removed scheduling files and former missing capabilities describe that earlier tree. See the [retirement record](legacy-retirement.md), root README and current v0.14/orchestration documentation for present behavior.

> **Direction being critiqued:** a **live haze information dashboard** with three stacked sections: live table, chat, pixel agent office. Agents: Manager, HazeOps, WorkerShield, EvidenceCritic, World Model, H-Mem. Location and audience are agnostic. Klang, crews and schedules are dropped (decision recorded in `01-project-understanding.md`).
>
> **Tags:**
>
> - **[Confirmed]** = stated in `Latest/` files.
> - **[Repo]** = seen in this repo's code or docs.
> - **[Inferred]** = my reasoning.
> - **[Outside — verify]** = my general knowledge, not from the files. Check before relying on it.
> - **[Unknown]** = nobody has told us.
>
> Citations: `Spec` = `Haze_Agent_Architecture_v0.13.pdf`, `Guide` = `Haze_Architecture_v0.13_SImple_Guide.pdf`.

---

## 0. The biggest risk, stated plainly

**The frontend and the backend are now building different products.**

- Your teammates' backend and the spec are a **schedule-comparison** tool [Repo `docs/demo-scope.md`; Spec §1.1 p.3].
- The spec explicitly **cuts** "broad monitoring" [Spec §19 p.35] and says data collection is "not broad monitoring" [Spec §12 p.23].
- **Nobody is currently building the thing that would feed a live haze table.** That means fetching many sources, summarising news, and ranking events [Inferred].

This isn't a reason to stop. It's the first thing to raise with the team:

- **(a)** Does the backend change direction?
- **(b)** Does someone build a small separate "haze feed" service?
- **(c)** Is the dashboard a **demo with mock data only** for the judges?

Until that's decided, the frontend must be built entirely on **mock data behind a swappable interface**. That's already the Phase 3 plan.

---

## 1. Impossible or unrealistic

### 1.1 "Real-time" for each kind of data source

All source details below are **[Outside — verify]**. None of these sources are approved in the files; the Spec only lists some of them as "leads, not accepted parameters" [Spec §24.1 p.43].

| Source type                 | Examples                                                        | How fresh it really is                                    | "Real-time"?                              | Access notes                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Ground air-quality monitors | National networks (e.g. Malaysia DOE/APIMS), OpenAQ, WAQI/aqicn | Usually **hourly** averages, published with some delay    | Near-real-time (about 1 h)                | OpenAQ and WAQI need free API keys and have attribution terms. Some national sites have no documented public API, so scraping would be needed |
| Satellite fire hotspots     | NASA FIRMS                                                      | A few satellite passes per day, **~3 h** processing delay | **No**, hours old                         | Free key; good API                                                                                                                            |
| Forecasts                   | Copernicus CAMS, national met services (e.g. METMalaysia)       | Issued **1–2× per day**                                   | No (but it's the future, which is useful) | Accounts or tokens; licence attribution                                                                                                       |
| Regional haze bulletins     | ASEAN Specialised Meteorological Centre (ASMC)                  | **Daily**                                                 | No                                        | No known public API, so scraping                                                                                                              |
| News and social media       | News sites, X/Twitter                                           | Minutes                                                   | Yes, but **unverified**                   | Copyright and terms-of-service issues; X's API is expensive; needs an LLM to summarise, so hallucination risk                                 |
| Low-cost sensors            | PurpleAir and similar                                           | Minutes                                                   | Yes                                       | Paid or limited API; readings need correction                                                                                                 |

**Verdict [Inferred]:** honest wording is **"updated as often as each source allows (typically hourly)"**, not "real-time". Every row must show _when the data was measured_ and _when we last checked_. The spec makes the same point: store measurement, issue, valid, retrieval and acceptance times separately, and "re-fetching an old record does not renew its age" [Spec §4.1 p.8].

### 1.2 Other unrealistic parts

| Item                                                                          | Why it's unrealistic                                                                                                                                                                                                                                            | Tag                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| "Anyone, anywhere" with **real** data                                         | Monitor coverage is very uneven worldwide. **AQI scales differ by country** (US EPA AQI, Malaysia API, China AQI, India NAQI…), so the same PM2.5 value gets different labels. A location-agnostic _UI_ is easy; location-agnostic _data_ is a research project | [Outside — verify]       |
| Agents that "gather from online sources" and validate them, built by students | Needs scrapers, deduplication, an LLM to summarise, and checks against hallucination. The spec spends a whole architecture on _checking_ claims [Spec §8 p.15–17]                                                                                               | [Inferred]               |
| A "severity" score                                                            | Not defined anywhere in the files. The spec forbids free-form claims about "dose, health, safety…" outside a reviewed path [Spec §8.3 p.17]. An invented severity score shown to the public is effectively health advice                                        | [Confirmed] + [Inferred] |
| A "confidence" percentage                                                     | The spec has **no confidence score**. It uses pass/fail check statuses and review statuses [Spec §7.2 p.13, §8.1 p.15], and warns "memory confidence is not scientific confidence" [Spec §13.3 p.25]. A % implies statistics we don't have                      | [Confirmed]              |
| Chat answers in seconds                                                       | A spec run has a 300-second deadline [Spec §13.1 p.23]. LLM calls with tools take ~5–60 s each [Spec §9.1 p.17, §13.1]. Expect **10 s to minutes**                                                                                                              | [Confirmed]              |

### 1.3 Legal and privacy risks [Outside — verify; we're not lawyers]

- **Health liability:** a public dashboard saying "high severity" may be read as medical advice. Use the official AQI band for the location's own standard, cite it, and add "Not medical advice; follow local authorities".
- **Data licences:** most APIs require attribution. Some forbid redistribution or commercial use. **News scraping** may break terms of service and copyright.
- **Chat logs are personal data.** If the users are in Malaysia, PDPA 2010 applies (Personal Data Protection Act). Don't store chats on a server without a privacy notice. For the demo, keep them in the browser only.
- **LLM output:** may invent facts. Every agent claim must link to its source (the spec's core idea [Spec §8.1 p.15]).

---

## 2. Wrong or inconsistent

### 2.1 Inside the files

| #   | Inconsistency                                                                                                                                                                      | Where                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | The spec says it replaces v0.12 and relies on a "companion report", but neither was supplied                                                                                       | [Spec p.1, App. C p.50] |
| 2   | Hackathon requirements (Nemotron for the NVIDIA award, Nightshift support) are "inherited source claims" from a guide that wasn't supplied. Official rules are unverified          | [Spec §14.1 p.25]       |
| 3   | `offline_sample` mode forces the template path with no Nemotron [Spec §17.1 p.31], but the award needs real Nemotron use [Spec §14.1 p.25]. An offline demo can't show the AI part | [Inferred tension]      |
| 4   | The API operation is named `plan_outdoor_work` [Spec §15.2 p.28], but the only worked example includes office work [Spec §23 p.41]                                                 | Minor naming            |
| 5   | The Guide's Diagram A leaves out the Manager and H-MEM. The Spec diagram includes them [Guide p.2 vs Spec §2 p.6]                                                                  | Minor                   |
| 6   | "Four remaining development days" and no stated deadline [Spec §19 p.35]                                                                                                           | Planning gap            |

### 2.2 Between the files and your chosen direction

| #   | Conflict                                                                                                                       | Effect on the frontend                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | **HazeOps** in the spec "collect[s] only evidence needed for explicit dependencies" [Spec §12 p.23]. It isn't a broad gatherer | The dashboard needs HazeOps to be redefined                                      |
| 2   | **WorkerShield** in the spec explains _schedule_ comparisons only [Spec §9.1 p.17]. With no schedules, it has no defined job   | Needs a new role definition (see §5.3 below)                                     |
| 3   | **World Model and H-Mem aren't agents** [Spec §2 p.5]                                                                          | Fine as office "characters" (e.g. archivist, librarian), but label them honestly |
| 4   | The spec's chat is **one question per run** [Spec §15.2 p.28]. You want a multi-turn chatbot                                   | The backend API must support conversations                                       |
| 5   | Spec ranking = **least disruption** among schedule plans [Spec §6.2 p.11]. Yours = recency + severity + confidence             | Unrelated rules; ours is new and must be designed carefully                      |
| 6   | The repo limits timestamps to **`+08:00`** (Malaysia time) [Repo `docs/demo-scope.md`]                                         | Conflicts with "anywhere". The frontend must store UTC and show local times      |

### 2.3 Spec ideas worth **keeping** in the dashboard [Inferred]

These carry over well and will make the demo look rigorous to judges:

- Missing data is **never shown as zero or "all clear"** [Spec §12 p.23].
- Show **source kind** (observation / forecast / modeled / news) and **issue time and native resolution** [Spec §4.1 p.8, §12 p.23].
- Show **separate statuses** rather than one "safe" flag [Spec §15.3 p.30].
- Mark an answer as **"template" vs "AI"** honestly when the AI fails [Spec §9.3 p.19].
- Show **"as of [time]"** when disconnected, and refresh on open [Spec §11.2 p.22].
- **No health or safety claims** without reviewed sources [Spec §8.3 p.17].

---

## 3. Missing (from both the files and your brief)

| Missing item                          | Why it matters                                                                           | Suggestion                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication                        | The spec requires tokens for the API [Spec §15.2 p.29] but says nothing about a UI login | Demo: no login. Public read-only later                                                                                                         |
| Loading / empty / error states        | Not designed anywhere                                                                    | Design all three for the table, detail page, chat and office                                                                                   |
| Refresh frequency                     | Every watcher must declare its cadence [Spec §12 p.23]; none are declared                | Poll every 60 s; show "last updated"                                                                                                           |
| How evidence and confidence are shown | No confidence model exists                                                               | Show "3 of 4 checks passed" plus the list of checks, not a %                                                                                   |
| AQI standard per location             | Labels differ by country                                                                 | Store the raw PM2.5 value plus the band from the location's standard, and show which standard                                                  |
| Time zones                            | Location-agnostic means many zones                                                       | Store UTC; show the location's local time _and_ the viewer's                                                                                   |
| Accessibility                         | Not mentioned in the files                                                               | Keyboard use, colour-blind-safe bands, text status for the animation, `prefers-reduced-motion` (the browser setting asking for less animation) |
| Multilingual                          | Only a `locale` field on rendered claims [Spec §8.1 p.15]                                | English first; keep all text in one file so it can be translated later                                                                         |
| Privacy notice                        | For chat                                                                                 | Browser-only history in the demo                                                                                                               |
| Source attribution                    | Licence requirement                                                                      | A source line on every row and detail page                                                                                                     |
| Success metrics                       | The spec has metrics for explanations [Spec §18.1 p.33]; none exist for a dashboard      | E.g. time for a judge to find "why is this row ranked first", or the share of chat answers that include a source link                          |
| Demo-data labelling                   | Judges must never mistake fake data for real                                             | A permanent "DEMO DATA — fictional" banner                                                                                                     |
| Mobile layout                         | Not specified                                                                            | See §7                                                                                                                                         |

---

## 4. Risky Zetaris assumptions (confirm with the backend owner)

**All [Unknown].** The files only say Zetaris provides "approved pinned evidence queries and versioned projections… no canonical current-status authority" [Spec §2 p.5] and returns "exact source revisions/hashes and per-dependency projection coverage" [Spec §12 p.23].

| Question                                                          | Why it's risky                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Is Zetaris actually provisioned, with an account and credentials? | Its owner is listed as unresolved [Spec §22 p.40]                                                                |
| What API type: REST, SQL over HTTP, JDBC?                         | Decides whether a browser could even call it. It shouldn't anyway                                                |
| What auth?                                                        | **Secrets must never be in browser code** [Spec §14.2 p.26], so the frontend must go through our own backend API |
| What data format and which views exist?                           | We can't design table columns until we know                                                                      |
| Streaming or polling?                                             | Affects "live" behaviour                                                                                         |
| Rate limits and query latency?                                    | Affects refresh frequency                                                                                        |
| Does it hold _haze_ data at all, or only what we load into it?    | If we load it ourselves, someone has to build the loaders                                                        |
| Can we get sample data?                                           | Needed to make the mock realistic                                                                                |
| CORS (the browser rule blocking calls to other domains)?          | Only matters if the frontend calls it directly, which it should not                                              |

**Frontend rule [Inferred]:** the frontend never talks to Zetaris. It talks to **our API**, and our API talks to Zetaris. That's why Phase 3 has a `DataService` interface: swap the mock for an HTTP client, and Zetaris stays a backend detail.

---

## 5. Agent and chat integration risks

### 5.1 How will the frontend know what each agent is doing?

- **Documented today:** `POST /run` returns `202` and a status location. `GET /runs/{id}` returns execution state: `queued / running / waiting / paused / completed / failed / cancelled / timed_out` [Spec §15.2 p.28, §15.3 p.29]. **That's polling, with run-level state only.** [Confirmed]
- **Not documented:** which agent is active, handoffs between agents, or a stream. Traces exist only as JSONL log files [Spec §15.3 p.30]. [Unknown whether exposed]

### 5.2 Which of your animations depend on backend events that may not exist

| Animation                                         | Needs from the backend                          | Exists?           |
| ------------------------------------------------- | ----------------------------------------------- | ----------------- |
| Manager "thinking" after you send                 | Nothing (the frontend knows you sent a message) | ✅                |
| Manager walks to the office                       | `run admitted / running`                        | ✅ (run state)    |
| A specific agent typing (e.g. EvidenceCritic)     | A per-agent "stage started" event               | ❌ Not documented |
| Task handed from HazeOps to EvidenceCritic        | A per-agent "handoff" event                     | ❌ Not documented |
| Status line "EvidenceCritic is checking sources…" | The current stage                               | ❌ Not documented |
| Result goes back to the Manager; answer appears   | `completed` plus the answer                     | ✅                |
| Error animation                                   | `failed / timed_out`                            | ✅                |

### 5.3 Proposal and fallback

1. **Ask the backend for a tiny event contract** (Phase 3 defines it as `AgentEvent`): `run_started`, `agent_started`, `agent_handoff`, `agent_completed`, `run_completed`, `run_failed`. Each has `agent`, `timestamp` and a short `message`. It can be delivered by:
   - **SSE** (Server-Sent Events: a simple one-way stream from server to browser), or
   - a `current_stage` field we poll every 2 s.
2. **Three fallback levels:**

| Level | What it uses          | What the office shows                                                                                                                                                                                                                                     |
| ----- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Real per-agent events | The full animation, truthful                                                                                                                                                                                                                              |
| **B** | Run state only        | The Manager walks over; **all agents show a generic "working"**; status line says "Agents are working… (step details unavailable)". **Never fake specific handoffs**, because that would be the kind of invented status the spec forbids [Spec §8.1 p.15] |
| **C** | No backend (demo)     | The mock `AgentService` plays the full script, labelled "DEMO simulation"                                                                                                                                                                                 |

3. **Proposed agent roles for the dashboard.** These are new definitions [Inferred]; the team must confirm them:

| Agent          | Role                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Manager        | Receives the question, plans, delegates, returns the answer                                      |
| HazeOps        | Fetches data from sources                                                                        |
| EvidenceCritic | Checks freshness, source agreement and links                                                     |
| WorkerShield   | Turns verified data into "what this means for people outdoors", **using official guidance only** |
| World Model    | The archive of verified records                                                                  |
| H-Mem          | Recalls similar past episodes                                                                    |

---

## 6. Recommended MVP

| Must                                                                    | Should                                     | Later                                  |
| ----------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| Live table on mock data, auto-updating with simulated events            | Filter or search by location               | Real API / Zetaris adapter             |
| One documented ranking function, with "why this rank" shown             | Sort toggle (Rank / Newest)                | Map view                               |
| Detail page: summary, sources, evidence checks, agent results, timeline | Import/export of demo data                 | Real backend agent events (SSE)        |
| Chat with history, sending, loading, error, cancel                      | Keyboard shortcuts                         | Login / roles                          |
| Mock `AgentService` running the full flow as events                     | Dark mode                                  | Multilingual                           |
| Pixel office driven only by events, with a text status line             | Compact office mode on mobile              | Notifications                          |
| Demo Data page: view, regenerate, simulate new events                   | Example chat prompts                       | H-Mem "memory" panel                   |
| "DEMO DATA" banner, sources, "not medical advice"                       | Detail page also openable as a side drawer | Multi-turn context sent to the backend |
| Loading/empty/error states; reduced motion; responsive                  |                                            |                                        |

---

## 7. Honest review of your desired interface

### What works ✅

- **"Read more" leading to a full detail screen** is the right pattern. Give it its own URL (`/item/:id`) so the back button and sharing work.
- **The text status line plus a reduced-motion fallback** is exactly right.
- **The Demo Data page** is a great idea for a team that will iterate on data.
- **The pixel office** is a strong "wow" for judges. It also makes the multi-agent idea visible, which a plain spinner can't.

### Bad ideas or things to change ⚠️

1. **The three sections stacked vertically won't fit on a laptop.**
   - A typical laptop shows ~650–750 px of page height. A 10-row table alone uses most of it, so the chat sits below the fold and the office further down.
   - Worse, the Manager **walking from the chat to the office** only works if both are on screen at the same time. If the user has scrolled, they miss it.
   - **Change (desktop):** table on top in a **height-limited scroll box (~40% of the screen)**. Underneath, **chat on the left and office on the right, side by side**, so the Manager walks _sideways_ and everything stays visible.
   - **On mobile:** stack them, and shrink the office to a short strip (or hide it behind a toggle) while keeping the text status line.
2. **"Newest at the top" and "ranked by importance" are two different sort orders.**
   - Pick one default: **Rank**, where recency is one input.
   - Add a toggle for **Newest**.
3. **Rows jumping around while someone reads is frustrating.** Don't reorder live.
   - Show a "**3 new updates — show**" bar instead.
   - Freeze ordering while the mouse or keyboard focus is inside the table.
4. **"Severity" and "confidence" as invented numbers are risky** (see §1.2).
   - Use the location's **official AQI band** (with its standard named) for severity.
   - Use **"checks passed X/Y"** for evidence.
   - Show the ranking as transparent points ("+30 because updated 5 min ago"), not a magic score.
5. **The Manager standing "next to the chat field"** is hard if the chat and office are separate page areas. Put the Manager at a **reception desk at the edge of the office canvas that touches the chat**. The walk then stays inside one drawing area, which is much simpler and more reliable.

### What's missing from your brief ➕

- What the chat _can_ answer (example prompts) and what it can't.
- A cancel button, because answers can take long.
- A "last updated" time and a connection-status indicator.
- Source attribution and a "not medical advice" notice.
- A location filter.
- A legend for the office (who each character is).
- An office on/off toggle.
- Chat answers that **link to table rows or evidence**, so the chat and the table feel like one system.

---

## Questions for the team (numbered)

1. Given the dashboard direction, **who builds the haze data feed**? The backend team, a new mini-service, or nobody (mock-only demo)?
2. Does the backend team agree to **redefine the agents' roles** for the dashboard (table in §5.3), or keep the spec's schedule roles?
3. Will the backend emit **per-agent events** (SSE or a polled `current_stage`)? If not, we use fallback Level B.
4. Is the chat **multi-turn**, and which backend endpoint answers it?
5. **Zetaris:** all the questions in §4. Most urgent: is it provisioned, and what data is in it?
6. Which **real sources** (if any) do we legally have access to (API keys, licences)?
7. Which **AQI standard(s)** should we show? Per location, or one global standard?
8. Is the audience the **public** or **experts**? This changes the wording and the health-advice risk.
9. Does the demo need to run **offline** (no internet at the venue)?
10. Should `banning-reference/` be committed or git-ignored?
