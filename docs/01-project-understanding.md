# 01 — Project Understanding (Phase 1)

> Read-only study of the proposal. No application code yet.
> Date written: 23 Oct 2026 (same day as the spec).

## 0. Sources used

**Only these two files count as the source of truth** (folder `banning-reference/Latest/`):

| Short name | File                                       | Type            | Size                    | Pages | Readable?                |
| ---------- | ------------------------------------------ | --------------- | ----------------------- | ----- | ------------------------ |
| **Spec**   | `Haze_Agent_Architecture_v0.13.pdf`        | PDF, text-based | 245,383 bytes (~240 KB) | 50    | Yes. Text extracts fully |
| **Guide**  | `Haze_Architecture_v0.13_SImple_Guide.pdf` | PDF, text-based | 104,430 bytes (~102 KB) | 8     | Yes. Text extracts fully |

- Neither file is a scanned image, so nothing is unreadable.
- `docs/Haze_Agent_Architecture_v0.13.pdf` (already tracked in the repo) has the **same SHA-256 hash** as the Spec, so it's the same file.
- The Guide calls itself "a companion… Use the original PDF for implementation contracts" [Guide p.1]. **When the two differ, the Spec wins.**
- **Ignored on purpose (named only):** the other files in `banning-reference/` are `Excel_Haze_MVP_Kanban_Backlog.pdf`, `haze-10-percent-questions.pdf`, `Haze_Architecture_Build_Infographic.pdf`, `ori_haze project.pdf`, `PPT_Haze_in_Malaysia.pdf`, `SmokeLedger_Pitch.pdf`. These are loose files; there are no other folders.
- **Mentioned in the Spec but not supplied:** a "companion report" [Spec p.1, App. C p.50], the v0.12 PDF and earlier versions, the hackathon Participant Setup Guide [Spec §24.1 p.43], the "Haze Damage Account", and a 118-page "Technical Execution Requirements" document [Spec §24.1 p.43].

**Citation format:** `[Spec §9.1 p.17]` means Spec, section 9.1, PDF page 17. Page numbers match PDF page positions [Guide p.1].

**Confidence tags:** **[Confirmed]** = stated in the files · **[Inferred]** = my reasoning from the files · **[Unknown]** = not in the files.

---

## ⚠️ Read this first: the files describe a different product from the corrected framing

You told me to flag contradictions rather than silently follow either side. These are the big ones:

| Your framing                                                                           | What the files say                                                                                                                                                                                                                                                                                        | Tag                  |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| A system of agents that **gathers live haze information** from APIs and online sources | Haze **compares crew work schedules**. Can one crew do the same work at different permitted times and breathe less modeled PM2.5? [Guide §1 p.1; Spec §1.1 p.3]                                                                                                                                           | [Confirmed]          |
| A **live info table**, refreshed in real time                                          | "Initial refresh is a bounded path for the selected problem, **not broad monitoring**" [Spec §12 p.23]. "Broad paper/fire monitoring" is an explicit **cut line** [Spec §19 p.35]. News is only a "research lead", not accepted data [Spec §4.1 p.8].                                                     | [Confirmed]          |
| **Klang** is only an example for judges, not the scope                                 | The initial scope is "one supervisor-confirmed crew **in the Klang slice**". The initial `district_id` is `my-selangor-klang` [Spec §1.1 p.3, §3.1 p.6]. The _data_ in the worked example is fictional [Spec §23 p.41].                                                                                   | [Confirmed] conflict |
| Users could be **anyone, anywhere**                                                    | The primary user is a **supervisor**, and the specified screen is a "supervisor interface" [Spec §16 p.30–31]. Location _is_ already a data field (`district_id`, `timezone`) [Spec §3.1 p.6], which supports making the UI location-agnostic.                                                            | [Confirmed]          |
| A **chatbot** answers anything                                                         | There's one optional free-text `query` per run, e.g. _"Why this plan and why not the lower proxy option?"_ [Spec §15.2 p.28–29]. WorkerShield answers **four fixed question types** [Spec §9.1 p.17]. All visible sentences must come from a **controlled renderer**, not free LLM text [Spec §8.1 p.15]. | [Confirmed]          |
| World Model and H-Mem are **agents**                                                   | World Model is the **system of record (database/authority)**. H-MEM is a **memory store** for reviewed learning. Neither is described as an agent [Spec §2 p.5].                                                                                                                                          | [Confirmed]          |

**My recommendation [Inferred]:** before Phase 2, the team should decide one of these:

- **(a)** build the UI the spec describes (a schedule-comparison workspace), or
- **(b)** build a broader "haze information" UI that goes beyond the spec. The backend team would then need to agree on what data actually exists.

I've written Phase 1 faithfully to the files and noted where your desired UI fits.

### ✅ Decision by the frontend lead (23 Oct 2026, after Phase 1)

- **Direction chosen: a live haze information dashboard**, keeping the layout of live table + chat + pixel agent office.
- **Dropped from the frontend:** Klang, workers, crews and schedule comparison. Location is just a data field; users can be anyone, anywhere.
- **This deliberately goes beyond the spec.** The spec (and the teammates' backend in this repo) is built around schedule comparison. Phase 2 (`docs/02-critique.md`) covers the consequences.
- The rest of this document still describes **what the files say**, because Phase 1 is a faithful reading of them.

**Clarifications from the repo (allowed by the frontend lead):**

- `docs/demo-scope.md` and `input_examples/v2/planning.json` confirm the backend demo targets `my-selangor-klang` with fictional data.
- WorkerShield calls NVIDIA Nemotron (`app/adapters/provider.ts:50`).
- The planner, WorkerShield and EvidenceCritic logic are **not implemented yet** (`docs/demo-scope.md`, "Defined versus implemented").
- `output_examples/v2/result.json` is hand-written sample data, not a real run.

**What each role is [Confirmed in the Spec; repo confirms WorkerShield]:**

- **AI model:** WorkerShield only.
- **Plain code:** Planner and Manager.
- **Mostly code:** EvidenceCritic (an extra AI review is optional).
- **Unclear:** HazeOps.
- **Storage:** World Model and H-MEM.

---

## 1. Problem statement and goals (plain language)

**The problem.** Haze (smoke pollution, measured as PM2.5 = fine dust particles) is worse at some hours than others. A work crew might be able to do the _same_ jobs at _different_ allowed times and breathe less polluted air. [Guide §1 p.1] [Confirmed]

**The narrow first goal.** For one crew within one agreed time window:

- compare the **ordinary schedule** (the "baseline") with **alternative schedules**,
- keep the workers, jobs, durations, places and safety controls exactly the same,
- never make any single worker, or any single activity, worse off. [Spec §1.1 p.3, §5.2 p.10] [Confirmed]

**What Haze outputs.** Information, not orders. "Haze supplies information; it does not edit rosters, direct work or authorize an intervention" [Spec §1.1 p.3]. A human must separately authorize any action [Guide §5 p.5]. [Confirmed]

**The bigger long-term programme.** Evaluate "a selected 10% damage reduction against ordinary management". This is explicitly a _separate_ undertaking whose metric is not yet decided. The crew proxy "cannot establish that programme goal" [Spec §1.1 p.3; Guide §1 p.1]. [Confirmed]

**Delivery reality.**

- The immediate deliverable is "an implementable engineering slice for **four remaining development days**" [Spec p.1, §19 p.35].
- If real evidence (a real employer, real data, expert review) isn't available, the team must "deliver an explicitly **fictional or historical engineering demonstration**" [Spec p.1].

**Context [Confirmed]:**

- The project targets the **Open Agent Hackathon 2026**, which has an NVIDIA award that requires real Nemotron use [Spec §14.1 p.25, §24.1 p.43].
- The official rules and deadline are **unverified** [Spec §19 p.35–36].

---

## 2. How the system works end to end

### 2.1 The pipeline (one "run")

From [Spec §16 p.30–31; Guide §3 p.3] [Confirmed]:

```
Supervisor -> API or CLI -> Manager -> LangGraph -> Haze runtime
                                                       |
                    HazeOps   planner   WorkerShield   EvidenceCritic
                                                       |
                    World Model commands and authoritative reads
                          |                          |
                Zetaris pinned queries       durable events -> H-MEM

WorkerShield -> application adapter -> Nightshift -> concrete Nemotron
```

(copied from [Spec §2 p.6])

1. **Validate and accept the inputs.** The supervisor's schedule and constraints are checked. Bad input gets field-by-field help.
2. **Pin the evidence.** HazeOps fixes the exact data versions that are allowed for this run. ("Pin" = lock to one exact version, identified by a hash.)
3. **Calculate and check.** The deterministic planner builds alternative schedules and scores them. A _separate_ checker redoes the maths.
4. **Investigate.** WorkerShield (the only LLM agent) uses read-only tools to work out _why_ a plan was chosen or rejected.
5. **Render.** A controlled renderer turns checked facts into fixed wording, adding mandatory warnings ("caveats").
6. **Review.** EvidenceCritic independently re-checks the finished result.
7. **Publish (conditionally).** This only happens if the World Model can prove it's safe. Until then, publication is **disabled** and results are labelled historical/demo [Spec §11.3 p.22].

**How long a run takes [Confirmed]:**

- Each run has a hard **300-second (5-minute) deadline** [Spec §13.1 p.23–24].
- The stage budgets are: admission 15s → retrieval 45s → calculation 30s → agent 50s → review 60s → revisions 55s → final 15s → contingency 30s [Spec §13.1 p.24].
- **A chat answer may take minutes, not seconds.**

### 2.2 Each agent or component

"UI" = what it would show on screen. All UI suggestions are **[Inferred]** unless cited.

| Component                                                 | Purpose                                                                                                                                                                                      | Inputs                                                                           | Outputs                                                                                                                   | What it could show in the UI                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manager** (exists, called "Manager and scheduler")      | "Select/coalesce bounded jobs, priorities and admission requests; cannot override runtime permissions or review findings" [Spec §2 p.5]. "The manager schedules bounded jobs" [Guide §2 p.2] | Requests from API/CLI [Spec §2 p.6]                                              | Jobs passed to LangGraph [Spec §2 p.6]                                                                                    | Job queued / admitted / running / finished; the deadline countdown                                                                          |
| **HazeOps**                                               | "Bounded retrieval and preparation of provenance, coverage and applicability questions; no autonomous scientific acceptance" [Spec §2 p.5]                                                   | Accepted input bundle and evidence references [Spec §16 p.30]                    | Pinned evidence records and checks (coverage, source kind, issue time, units) [Guide §3 p.3]                              | Which data sources were used, how fresh they are, and any gaps                                                                              |
| **Planner** (deterministic; not in your list but central) | Builds feasible schedules, calculates exposure, applies protections and policy, ranks [Spec §2 p.5, §7.1 p.12]                                                                               | Bundle, pinned evidence, policy                                                  | Baseline vs candidate plans, scores, rejected plans, search counts [Spec §7.1 p.12]                                       | The schedule comparison table (the core of the spec's UI)                                                                                   |
| **WorkerShield** (the LLM agent, using NVIDIA Nemotron)   | Answers 4 questions: _why this plan; why another option was rejected; what evidence supports it; what missing info could change the answer_ [Spec §9.1 p.17]                                 | Run snapshot, allowed plans, fact IDs, the user's `query` [Spec §9.2 p.18]       | An explanation plan made of **fact IDs only** (no free prose). Values and wording come from the renderer [Spec §9.2 p.18] | The chat answer; tool calls made (e.g. `inspect_comparison`); whether the answer came from Nemotron or a template fallback [Spec §9.3 p.19] |
| **EvidenceCritic**                                        | "Independent per-run checks of evidence, constraints, numbers, claim records and exact material payload" [Spec §2 p.5]                                                                       | The finished candidate and all its hashes [Spec §11.1 p.21]                      | A ReviewRecord: `approve / revise / reject / insufficient_evidence` [Spec §11.1 p.21, §7.2 p.13]                          | A review badge plus the list of checks run and their results                                                                                |
| **World Model**                                           | "Sole canonical evidence, bundles, policies/methods, heads, candidates, reviews, publications and durable domain events" [Spec §2 p.5]. **The single source of truth, not an agent**         | Commands like `accept_input_revision`, `publish_if_current` [Spec §11.2 p.21–22] | Snapshots, current-status reads [Spec §11.2 p.22]                                                                         | Publication status (`published / publication_disabled`) and currency (`current / stale / …`)                                                |
| **H-MEM**                                                 | "Eligible reviewed reusable learning with canonical provenance and validity checks; no competing current facts" [Spec §2 p.5]. **Optional** for the core slice [Spec §19 p.35]               | Durable events after publication [Spec §13.3 p.25]                               | Memory IDs with scope and rationale on recall [Spec §13.3 p.25]                                                           | "Memory recalled / skipped / failed", shown visibly [Spec §14.3 p.27]                                                                       |

**Answer to your question: does the Manager exist?** Yes, but only partly as you imagine it. **[Confirmed]** The architecture has a **Manager/scheduler** that admits and prioritises jobs. **[Unknown]** It doesn't "think", hand out tasks conversationally, or carry results back. The handoffs between agents are coordinated by **LangGraph** (a workflow library) and the **Haze runtime**. The pixel Manager carrying tasks would be a **UI metaphor** for that coordination. Confirm with the team.

---

## 3. Target users

| User type                                | How the files mention them                                                                                                      | Tag                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Supervisor** (primary user)            | Confirms ordinary work and timing rights; the UI is the "supervisor interface" [Spec §2 p.5, §16 p.30–31]                       | [Confirmed]               |
| Programme owner / delivery owner         | Adopts scope and policy; runs the day-one gate [Spec §1.2 p.3, §2 p.5]                                                          | [Confirmed]               |
| Evidence / method stewards               | Accept evidence for stated uses [Spec §2 p.6]                                                                                   | [Confirmed]               |
| Occupational hygienist / domain reviewer | Assesses workplace applicability [Spec §2 p.6, §21.1 p.37]                                                                      | [Confirmed]               |
| Independent reviewers                    | Check runs [Spec §2 p.6, §11.1 p.21]                                                                                            | [Confirmed]               |
| Policy owner                             | Approves benefit floor and caps [Spec §22 p.40]                                                                                 | [Confirmed]               |
| Operator                                 | Only role allowed to use `POST /heartbeat/tick` and historical replay [Spec §15.2 p.28]                                         | [Confirmed]               |
| Workers                                  | **Data subjects, not users.** Pseudonymous IDs; no health data [Spec §3.1 p.7]; worker communication required [Spec §15.2 p.29] | [Confirmed]               |
| Hackathon judges / organizers            | Implied by the award and rules references [Spec §14.1 p.25, §19 p.36]                                                           | [Inferred]                |
| Public / community audiences             | Only through later, **disabled** profiles (HazeInfo, CommunityAlert) [Spec §21.2 p.38]                                          | [Confirmed], out of scope |

**How "Klang" is used in the files [Confirmed]:**

1. It's the **initial scope**: "one supervisor-confirmed crew in the Klang slice" [Spec §1.1 p.3; Guide §1 p.1].
2. It's the **initial district ID**, `my-selangor-klang` [Spec §3.1 p.6].
3. It appears in the **example request**, `klang-synthetic-crew` [Spec §15.2 p.29].

The worked example's data is fictional [Spec §23 p.41]. **This conflicts with your framing** that Klang is only a pitch example. The design is still location-capable, because `district_id` and `timezone` are fields.

**Suggestion [Inferred]:** treat Klang as "the first configured location" in the data. Never hard-code it in the UI.

---

## 4. Feature list

| Feature                                                                                                 | Source                                        | Tag                                           |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| Input import with field-specific validation help                                                        | [Spec §16 p.30, App. B3 p.46]                 | **Core**                                      |
| Baseline vs candidate schedule comparison                                                               | [Spec §16 p.31]                               | **Core**                                      |
| Per-worker and per-activity results, with crew totals alongside                                         | [Spec §16 p.31]                               | **Core**                                      |
| Decision-value / disruption panel (movement M, changed count N, largest move L)                         | [Spec §6.2 p.11, §16 p.31]                    | **Core**                                      |
| Evidence / review drawer that opens exact source revisions and passages                                 | [Spec §9.2 p.18, §16 p.31]                    | **Core**                                      |
| Execution / status trace                                                                                | [Spec §16 p.31]                               | **Core**                                      |
| Showing the ~14 status "axes" separately (evidence, protection, search, review, publication, currency…) | [Spec §7.2 p.13, §16 p.31]                    | **Core**                                      |
| Fixed approved wording, e.g. "Engineering candidate only; workplace usefulness unverified"              | [Spec §16 p.31]                               | **Core**                                      |
| Mandatory caveats that can't be removed                                                                 | [Spec §8.2 p.16–17]                           | **Core**                                      |
| "Why this plan?" question answered by WorkerShield                                                      | [Spec §9 p.17–19, §15.2 p.28]                 | **Core**                                      |
| Template fallback when Nemotron fails, shown visibly                                                    | [Spec §9.3 p.19, §14.3 p.27]                  | **Core**                                      |
| `publication_disabled` / historical / as-of labelling                                                   | [Spec §11.3 p.22, §16 p.31]                   | **Core** (very likely the demo state)         |
| Source freshness panel (issue/valid time, last check, next check, gaps)                                 | [Spec §12 p.23]                               | **Core**                                      |
| Offline sample mode (no network, deterministic)                                                         | [Spec §17.1 p.31]                             | **Core**                                      |
| Health / readiness display (`GET /health`)                                                              | [Spec §15.2 p.28]                             | Nice-to-have                                  |
| Refresh on opening; "historical/as-of" when disconnected                                                | [Spec §11.2 p.22]                             | **Core**                                      |
| H-MEM memory recall                                                                                     | [Spec §19 p.35] "optional for the core slice" | Nice-to-have                                  |
| Notifications on meaningful change                                                                      | [Spec §12 p.23]                               | Unclear                                       |
| Programme / damage-account screens showing `not_enabled`                                                | [Spec §16 p.31]                               | Nice-to-have                                  |
| Authentication (allowlisted tokens; no anonymous writes)                                                | [Spec §15.2 p.29]                             | Core for the backend; **Unclear** for the UI  |
| **Your live info table** (real-time, ranked)                                                            | Not in the files                              | **Unclear**                                   |
| **Your general chatbot**                                                                                | Only the single `query` field exists          | **Unclear**                                   |
| **Your pixel agent office**                                                                             | Not in the files (UI-only idea)               | **Unclear** / Nice-to-have                    |
| Regional damage, broad monitoring, PeatFire Sentinel, HazeShield, HazeInfo, CommunityAlert, dispatch    | [Spec §19 p.35, §21.2 p.38]                   | **Out of scope** (explicitly cut or disabled) |

---

## 5. Data and architecture

### 5.1 Data sources

- **Pollution:** PM2.5 series in µg/m³, with source kinds `observation`, `forecast`, `modeled microenvironment` or `synthetic_fixture` [Spec §4.1 p.8, §4.3 p.9]. [Confirmed]
- **Operating data:** crew, activities, locations, resources, baseline schedule, constraints and costs, supplied by the supervisor [Spec §3 p.6–8]. [Confirmed]
- **Named candidate sources** (only "leads, not accepted parameters"): METMalaysia numerical products, NASA FIRMS, DOSH/Ministry of Health haze guidance, WHO AirQ+ [Spec §24.1 p.43]. [Confirmed]
- **Which of these actually have APIs, and their update frequency:** **[Unknown]**.

### 5.2 What Zetaris does

- Documented role: "Approved pinned evidence queries and versioned projections with verifiable dependency coverage; **no canonical current-status authority**" [Spec §2 p.5]. [Confirmed]
- "Projection" = a derived, read-optimised view of data.
- Queries must return "exact source revisions/hashes and per-dependency projection coverage" [Spec §12 p.23]. [Confirmed]
- EvidenceCritic re-queries Zetaris independently in live modes [Spec §11.1 p.21]. [Confirmed]
- `offline_sample` mode skips Zetaris entirely [Spec §17.1 p.31]. [Confirmed]
- An "Approved Zetaris views" owner is still unassigned [Spec §22 p.40]. [Confirmed]
- **UNKNOWN:** what Zetaris _is_ as a product, its API type (REST/SQL/JDBC), auth, data format, rate limits, whether the frontend ever talks to it, and whether access has been granted. **None of this is in the files.**

### 5.3 Data flow: source to screen

```
External source / supervisor input
   -> (Zetaris pinned query or controlled import)
   -> World Model: EvidenceRevision, InputBundle            [Spec §10 p.19-20]
   -> HazeOps pins evidence -> Planner: CalculationArtifact
   -> independent CheckRecords -> FactRecords
   -> WorkerShield selects fact IDs -> renderer: ClaimRenderRecords
   -> CandidateDecision -> EvidenceCritic: ReviewRecord
   -> PublicationRecord (DISABLED until canonical gate proved)
   -> API: GET /runs/{id}, GET /problems/{id}/current      [Spec §15.2 p.28]
   -> haze.result.v2 JSON envelope                          [Spec §15.3 p.29-30]
   -> FRONTEND renders it
```

API endpoints [Spec §15.2 p.28] [Confirmed]:

| Endpoint                     | What it does                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /health`                | Readiness check                                                                           |
| `POST /run`                  | Starts a run; returns **202 Accepted** plus a status location (so the frontend **polls**) |
| `GET /runs/{id}`             | Run status and details                                                                    |
| `GET /problems/{id}/current` | The current published result                                                              |

- The default port is 8000 [Spec §15.3 p.30].
- A **streaming endpoint is not documented** [Unknown].
- Traces are persisted as JSONL logs [Spec §15.3 p.30], but no API exposes them live [Unknown].

### 5.4 What the frontend is and isn't responsible for

**Frontend IS responsible for [Confirmed unless tagged]:**

- Rendering the reviewed payload **without changing its meaning**: "final display may only render that payload and current audited status, with no new free-form claims" [Spec §11.1 p.21].
- Showing every status axis separately, never merged into one "safe" flag [Spec §15.3 p.30, §16 p.31].
- Never presenting a selected engineering candidate as an instruction [Spec §15.3 p.30].
- Showing "historical/as-of" when disconnected, and refreshing on open [Spec §11.2 p.22].
- Showing unknown costs as unknown, never as zero [Spec §3.3 p.8, §14.3 p.27].
- Showing failed Nemotron runs as failed, even when a template answer succeeded [Spec §16 p.31].
- Rounding only for display [Spec §8.2 p.17].
- Keeping secrets out of browser code [Spec §14.2 p.26].

**Frontend is NOT responsible for:**

- calculating exposure, ranking plans, verifying facts, writing explanation sentences, accepting evidence, or publishing [Spec §2 p.5, §8.1 p.15];
- talking directly to Zetaris, Nightshift or the World Model [Inferred from the §2 p.6 diagram, where the API is the only entry point].

---

## 6. Tools and technologies mentioned

| Tool                               | What it is (1–2 sentences)                                                                                                                                   | Role in Haze                                                          | Must the frontend team learn it?                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Zetaris**                        | **UNKNOWN in the files.** _(Outside knowledge, not from files, verify: a data-virtualisation platform that queries many data sources without copying them.)_ | Pinned evidence queries and projections [Spec §2 p.5]                 | **No** for building UI; **yes** to know what data exists. Ask the backend owner |
| **LangGraph**                      | A library for building multi-step AI workflows with saved checkpoints ("save points")                                                                        | Typed steps, checkpoints, resumption [Spec §2 p.5; T2/T3 p.44]        | Basic concepts only (to understand run states)                                  |
| **World Model** (Meterless)        | The project's authoritative data/event store, from a GitHub spec                                                                                             | Single source of truth [Spec §2 p.5; T4 p.44]                         | No                                                                              |
| **H-MEM** (Meterless)              | A memory store for reviewed past learning                                                                                                                    | Optional memory [Spec §2 p.5; T5 p.44]                                | No                                                                              |
| **Meterless Runtime / Nightshift** | A model-serving gateway with an OpenAI-compatible API                                                                                                        | Routes WorkerShield's calls to Nemotron [Spec §14 p.25–27]            | No                                                                              |
| **NVIDIA Nemotron**                | A family of large language models from NVIDIA                                                                                                                | Powers WorkerShield (needed for the NVIDIA award) [Spec §14.1 p.25]   | No (just show which model answered)                                             |
| **JSON Schema (Draft 2020-12)**    | A standard way to describe the shape of JSON data                                                                                                            | Contracts like `haze.result.v2` [Spec §3.1 p.6]                       | **Yes**: read the result schema to build TypeScript types                       |
| **SHA-256 hashes**                 | A fingerprint that identifies exact file contents                                                                                                            | Pinning and review binding [Spec §10 p.20]                            | Only to display them (shortened)                                                |
| **SQLite**                         | A small file-based database                                                                                                                                  | Mentioned as a reference illustration only [Spec §11.3 p.22; T8 p.44] | No                                                                              |
| **Docker**                         | Packages an app so it runs the same anywhere                                                                                                                 | Build and run the harness [Spec §17.2 p.32]                           | Nice to know                                                                    |
| **Node.js**                        | Runs JavaScript outside the browser                                                                                                                          | CLI `node run.mjs` [Spec §15.2 p.28]                                  | Yes (Vite needs it)                                                             |
| **React / TypeScript / Vite**      | UI library / typed JavaScript / dev server and bundler                                                                                                       | **Not mentioned in the files**. Your choice                           | Yes                                                                             |

---

## 7. Proposed table columns

Your "live info table" has no direct equivalent in the files. Two tables _can_ be built honestly from documented data. **[Inferred]** I'd suggest Table A as the main table.

### Table A: Runs / assessments (one row per run). Recommended.

| Column             | Field source                                                                                   | Why                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Location           | `district_id` + `timezone` [Spec §3.1 p.6]                                                     | Keeps the UI location-agnostic                        |
| Time window        | `assessment` start/end [Spec §3.1 p.6]                                                         | Tells the user what period was compared               |
| Outcome            | `decision_outcome`, e.g. `action_candidate_found`, `insufficient_evidence` [Spec §7.3 p.13–14] | The headline result                                   |
| Modeled reduction  | Crew gain / percentage, nominal and minimum scenario [Spec §5.1 p.10, §6.1 p.11]               | Main number, shown with units                         |
| Disruption         | M / N / L (total minutes moved, activities changed, largest move) [Spec §6.2 p.11]             | The ranking is disruption-first                       |
| Protection         | `protection_status` [Spec §7.2 p.13]                                                           | No worker or activity may get worse                   |
| Evidence           | `evidence_status` + source kind [Spec §7.2 p.13, §4.1 p.8]                                     | Shows whether data is fictional, forecast or observed |
| Review             | `review_status` [Spec §7.2 p.13]                                                               | EvidenceCritic's verdict                              |
| Status / currency  | `publication_status` + `currency` [Spec §7.2 p.13]                                             | Current vs stale vs disabled                          |
| Eligible?          | `recommendation_eligible` + blockers [Spec §7.2 p.13]                                          | Must always be visible. False in the demo             |
| Explanation source | `nemotron_runtime` / `deterministic_template` [Spec §9.3 p.19]                                 | Honest AI provenance                                  |

### Table B: Evidence sources (one row per evidence record). Fits your "info" idea.

| Column                     | Field source                                                 | Why                                                   |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| Source kind                | observation / forecast / modeled / synthetic [Spec §4.1 p.8] | Users must not confuse a forecast with an observation |
| Location / spatial support | `location_id`, `spatial_support` [Spec §4.3 p.9]             | Location-agnostic                                     |
| Pollutant and value        | PM2.5, µg/m³ [Spec §4.3 p.9]                                 | Core data                                             |
| Valid interval / issued at | [Spec §4.1 p.8]                                              | Recency                                               |
| Native resolution          | e.g. hourly [Spec §4.3 p.9]                                  | Prevents false precision                              |
| Last check / next check    | [Spec §12 p.23]                                              | Freshness                                             |
| Review / permitted use     | [Spec §4.1 p.8]                                              | Shows whether this data is allowed for this use       |
| Known gaps                 | [Spec §12 p.23]                                              | Missing is never zero                                 |

**Your ranking rule (recency + severity + confidence):**

- **Severity** and **confidence scores** aren't defined in the files [Unknown].
- The spec forbids free-form health or safety claims [Spec §8.3 p.17].
- A frontend "severity" score could therefore count as an unsupported claim. I'll address this properly in Phase 2.

---

## 8. Scope size estimate (5 part-time students)

| Piece                                                                          | Size                                 | Why                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Full architecture in the Spec                                                  | **Large** (far beyond 5 part-timers) | Even the spec plans it as a 4-day sprint by parallel leads, with many cut lines [Spec §19 p.35] |
| Frontend that renders `haze.result.v2` from mock data, plus the "why" question | **Medium**                           | Many status fields and the evidence drawer, but no maths                                        |
| Your desired UI (live table + chat + animated pixel office + demo-data page)   | **Medium–Large**                     | The pixel office alone is a sizeable sub-project                                                |

**Deadline:**

- The files say "four remaining development days" and explicitly refuse to state an event deadline [Spec §19 p.35–36].
- The spec is dated **today (23 Oct 2026)**, so the deadline may be around **27 Oct 2026**. [Inferred, needs confirmation]
- **Please tell me the real deadline.**

---

## Questions for the team

1. **Product direction:** do we build the spec's **schedule-comparison workspace**, or the **live haze-information dashboard** from your framing? (Section 0 lists the conflicts.)
2. **Klang:** the spec makes Klang the initial scope and district ID. Is the team OK with treating it as "first configured location" in data only?
3. **Manager:** is the Manager a real agent that reasons, or only a scheduler? Is "Manager carries tasks" just a UI metaphor?
4. **HazeOps and EvidenceCritic:** are they LLM agents or deterministic code? (Only WorkerShield is clearly LLM-based.)
5. **Zetaris:** what product/API is it, what auth does it use, what data views exist, and is access granted? Everything here is UNKNOWN.
6. **Live data:** which real sources (METMalaysia, NASA FIRMS, …) actually have working access, and how often do they update?
7. **Agent progress:** will the backend expose per-agent progress (streaming or a polling field), or only final run states?
8. **Chat:** is one `query` per run enough, or does the team want multi-turn chat? Multi-turn isn't in the spec.
9. **Deadline:** what is the real submission date and time?
10. **Repo code:** should the frontend use the existing `schemas/haze.result.v2.schema.json` and `output_examples/v2/result.json` in the repo for its types? They're outside `Latest/`, so I haven't treated them as truth.
11. **Auth:** does the demo UI need login, given that the spec requires allowlisted tokens?
12. **Missing documents:** do the "companion report", the Haze Damage Account and the hackathon guide exist anywhere?
