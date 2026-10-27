# Retired H-MEM Memory Page (historical design)

The fixture page, route and navigation have been removed from the product. This
document records the former design only. Historical data and the isolated pinned
compatibility probe are retained.

Route: `/memory` (header nav: **Memory**)

The Meterless H-MEM engine ships no UI. This page lets users see what the agent
remembers, where each memory came from, and how it affected an answer.

> **Status: frontend only.** All data comes from sample fixtures and every action
> changes local state only (reset on reload). The page shows a
> "Sample data · not connected" badge. API integration is not done.

References:

- https://github.com/Meterless/Meterless/tree/main/engines/hmem
- https://github.com/Meterless/Meterless/blob/main/engines/hmem/HOW_TO_USE_H-MEM.md

## Files

| File                                                 | Purpose                                 |
| ---------------------------------------------------- | --------------------------------------- |
| `frontend/src/features/memory/MemoryPage.tsx`        | Page and the six area components        |
| `frontend/src/features/memory/MemoryPage.module.css` | Styles (uses shared tokens, light/dark) |
| `frontend/src/features/memory/memoryFixtures.ts`     | Types and sample data                   |
| `frontend/src/features/memory/MemoryPage.test.tsx`   | Render test                             |
| `frontend/src/app/router.tsx`, `AppLayout.tsx`       | Route and nav link                      |

## What it can do

The page has six tabs.

### 1. Overview

- Memory counts per tier: short-term, working, long-term
- Pending reviews and unresolved conflicts (click to jump to that tab)
- Last maintenance run, capture/recall on/off, memories expiring within 30 days

### 2. Memory browser

- Free-text search, plus filters for location, topic, tier, source and "since" date
- Selecting a memory opens a detail panel with:
  - content, type, tier, review status and a confidence bar
  - **location and time scope** (where and when the lesson applies)
  - **expiry**, provenance (origin, label, learned at), source, recall count
  - **original evidence links** (observations, documents, task results)
  - linked memories (clickable) and revision history

### 3. Recall explanations

- One card per answer, showing **memory availability**: recalled, skipped, disabled or failed, with a reason
- For each memory used: relevance score, why it was retrieved, and source links
- Feedback buttons: **Helpful / Not helpful / Wrong** (each is written to the audit log)

### 4. Review queue

- Proposed insights, invariants and domains (H-MEM "dreaming" output), each with its rationale and supporting memories
- **Approve** adds the proposal to memory; **Reject** takes an optional reason
- Proposals stay separate from approved memories until approved

### 5. Conflicts

- Contradictory memories side by side: content, learned date, source, confidence, scope, evidence
- Actions: **Keep A, Keep B, Keep both, Merge, Delete both**

### 6. Maintenance & history

- Sleep cycle: **Preview** lists the memories to consolidate, archive or synthesize; **Execute** is enabled only after a preview
- Reports table with backup IDs and a **Restore** button
- Audit timeline, searchable by memory ID/text, action, actor and date

## Integration notes (for later)

Types in `memoryFixtures.ts` use H-MEM field names (`layer`, `provenance`,
`relatedTo`, `toConsolidate` / `toArchive` / `toSynthesize`, `backupId`,
`helpful` / `not_helpful` / `wrong`, `keep_a` / `keep_b` / `keep_both` / `merge` /
`delete_both`). To integrate:

1. Replace the fixture imports with API calls (recall, feedback, dreaming approve/reject,
   conflict resolve, sleep preview/execute/restore, audit query).
2. Replace the local `setState` handlers in `MemoryPage` with those calls.
3. Remove the "Sample data · not connected" badge.

Haze-specific fields (`location`, `timeScope`, `reviewStatus`, `expiresAt`,
`evidence`, and recall `availability`) don't exist in H-MEM. Store them in
tags/provenance, or add them in an adapter layer.
