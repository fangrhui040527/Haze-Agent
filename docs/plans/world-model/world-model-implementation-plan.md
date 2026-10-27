# Implement World Model in Haze v0.14

## Summary

Build a transactional World Model in the existing v3 application, covering **PM2.5, damage accounting, episode investigation and evidence synthesis**.

Zetaris remains the governed query layer. Immutable artifacts retain evidence, calculations and reviews. World Model connects these records and owns accepted domain state, support revisions, holds and history.

Use **preauthorized automatic acceptance of exact reviewed work products**. Final narrative answers remain task outputs. Add status, lineage and history to existing task views.

## 1. Domain model and persistence

- Introduce browser-safe World Model contracts and a server-side domain service. Keep capability-specific payloads and validation in registered capability adapters.
- Store canonical events, entities, relationships, assessment versions, dependency links, holds and operation receipts in the **existing SQLite database**. Share its transaction boundary with task corrections and finalization.
- Reuse the pinned Meterless identity and canonicalization utilities. Implement Haze's transactional store and projections outside the unchanged vendored source; retain upstream provenance and conformance checks.
- Represent locations, sources, stations, episode contexts, evidence references and assessments. Store immutable artifact references rather than duplicating raw evidence or calculation payloads.
- Scope every record by principal, workspace and execution mode. Keep fixture/replay data separate from live records.
- Use explicit external identifiers and deterministic record keys. Support multiple evidence relationships simultaneously; avoid fuzzy automatic merges and implicit "latest timestamp wins" acceptance.
- Preserve observation, retrieval, recording and acceptance times separately. Supersession requires an explicit version relationship.
- Add a versioned, transactional World Model schema initialization. Preserve existing task data and storage-marker checks. Historical dashboard JSON remains archival; do not import or accept it automatically.

## 2. Integrate all four capabilities

Extend `CapabilityDefinition` with an optional World Model adapter that deterministically extracts records, builds acceptance candidates and declares required review coverage. Register implementations through the existing composition root.

| Capability            | World Model integration                                                            | Acceptance boundary                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| PM2.5                 | Locations, modeled evidence captures, selection provenance and analysis references | Exact independently checked analysis; retain modeled-data and coverage limitations                               |
| Damage accounting     | Account scope, component manifest, component references and revision lineage       | Exact account and required component closure; arithmetic review does not establish scientific applicability      |
| Episode investigation | Episode context, linked analyses and scoped evidence gaps                          | Add independent review of gap scope and configured-source availability; gaps describe the investigation's limits |
| Evidence synthesis    | Source references, extracted quotations and citation relationships                 | Exact independently checked excerpts; source authenticity and final prose entailment remain unverified           |

- Project artifacts when they are durably saved, using the same transaction. Projection records do not imply acceptance.
- Generate acceptance candidates only from registered artifact kinds and completed producer/reviewer revisions.
- Introduce strict schemas for synthesis and episode payloads where current implementation relies on casts.
- Preserve partial results: eligible work products may be accepted while unsupported branches remain pending, rejected or explicitly unresolved.

## 3. Automatic acceptance, corrections and reuse

- Add a server-owned, versioned `research-v1` acceptance policy, enabled explicitly through configuration. It authorizes the four registered integrations for research and accounting uses. Models and request payloads cannot modify it.
- At task finalization, evaluate the selected work products and their exact dependency closure. Require matching hashes, completed independent reviews, current applicability, authorized access, matching execution mode, and no relevant holds or expired support.
- Persist acceptance, policy identity/hash, support revisions, operation receipt and durable events **in the same transaction as result finalization**.
- Separate ordinary ineligibility from infrastructure failure. Ineligible material receives a visible reason while the informational answer can complete; transactional failures roll back without claiming acceptance.
- Keep task objective revisions separate from domain support revisions. Within the existing correction transaction, place holds on affected accepted records and invalidate dependent context across tasks. Unknown impact conservatively holds the affected task-derived branch.
- Apply the same dependency handling to grant revocation, explicit source supersession and registered method/policy changes. Unrelated records remain usable.
- Recheck support, permissions, holds and explicit expiry on every current-state read. Cached projections cannot authorize acceptance or establish currency.
- Use deterministic operation keys: identical retries return the existing receipt; conflicting content under the same key fails. Restart recovery resumes from committed events.
- Add bounded `world.lookup`, `world.context` and `world.lineage` tools. Revalidate source access and requesting-task grants before returning metadata or excerpts.
- Persist retrieved context as an immutable artifact containing exact domain references and support revisions. Recheck those dependencies before downstream acceptance. Accepted history is evidence for reuse, not permission to bypass applicability checks.

## 4. API and existing task workspace

- Add versioned World Model record, reference, status, history and lineage contracts.
- Add authenticated read endpoints:
  - `GET /api/tasks/:id/world`: related records, acceptance outcomes and current status.
  - `GET /api/world/records/:id`: authorized record details and paginated history/lineage.
- Keep existing v3 request/result formats intact. Fetch current World Model status separately so historical task results do not acquire misleading cached acceptance labels.
- Emit World Model lifecycle events through the existing task event stream. Cross-task consumers receive invalidation events when their pinned domain support changes.
- Extend existing work-product and report views with **Pending review**, **Accepted for stated use**, **Held**, **Superseded** and **Not eligible** states.
- Show acceptance policy, exact producer/reviewer versions, evidence links, scope, limitations and hold reasons. Clearly distinguish task completion, independent review and domain acceptance.
- Include expandable lineage and history. Use existing task correction controls for reconsideration.

## 5. Delivery and verification

Implement in dependency order:

1. **Foundation:** contracts, SQLite storage, deterministic identities, event replay and transactional initialization.
2. **Capability integration:** all four adapters, exact review requirements and missing episode/synthesis validation.
3. **Authority:** automatic acceptance, correction/revocation holds, current reads and cross-task dependency checks.
4. **Application integration:** agent tools, read APIs, task status/history views and documentation.
5. **Release verification:** fixture coverage followed by configured live integration checks.

Required tests:

- Duplicate ingestion and acceptance, conflicting operation keys, transaction rollback, restart recovery and projection rebuild.
- Multiple supporting sources remain linked; explicit supersession preserves historical versions.
- Positive and negative acceptance cases for all four capabilities, including partial damage accounts and unresolved episode branches.
- Changed artifact hashes, missing component reviews, self-review and unsupported material prevent acceptance.
- A correction between review and commit rejects stale acceptance; post-acceptance corrections immediately hold affected records.
- Cross-task reuse becomes invalid when its exact support changes; unrelated branches remain usable.
- Access filtering applies before metadata disclosure; revoked grants and fixture/live boundaries are enforced.
- UI status/history remains accurate after correction, restart and failed reads.
- Run repository checks and add a process-level World Model verification command covering all four integrations.

Release acceptance requires an end-to-end trace demonstrating automatic acceptance, cross-task retrieval, correction-driven holds and restart recovery. Live Zetaris readiness is claimed only after a genuine configured run.

**Defaults:** retain SQLite and the existing application; preserve the working tree and source pins; keep automatic acceptance disabled when no policy is configured. External effects, H-MEM capture, new scientific methods, a dedicated explorer and acceptance of final narrative conclusions remain outside this implementation.
