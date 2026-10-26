# World Model implementation plan summary

## Phase 1 — Foundation

1.1 Define World Model contracts
---

1.2 Add database schema migration
---

1.3 Store scoped records
---

1.4 Add event replay and projections
---

1.5 Link saved artifacts

## Phase 2 — Capability integration

2.1 Add the adapter interface
---

2.2 Integrate PM2.5
---

2.3 Add damage accounting
---

2.4 Integrate episode investigation
---

2.5 Integrate evidence synthesis
---

2.6 Test all adapters

## Phase 3 — Acceptance and reuse

3.1 Add the optional acceptance policy
---

3.2 Check eligibility
---

3.3 Save acceptance with task results
---

3.4 Hold records affected by changes
---

3.5 Recheck records and handle retries
---

3.6 Add authorized context and lineage

## Phase 4 — API, UI, and documentation

4.1 Define read contracts and access checks
---

4.2 Add read endpoints
---

4.3 Emit lifecycle events
---

4.4 Register World Model tools
---

4.5 Show status and lineage in the UI
---

4.6 Update documentation

## Phase 5 — Verification and release

5.1 Test storage and recovery
---

5.2 Test acceptance across capabilities
---

5.3 Test corrections and access controls
---

5.4 Verify the full fixture flow
---

5.5 Run checks and record live evidence
