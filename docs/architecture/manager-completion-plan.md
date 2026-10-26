# Complete the v3 Manager

Status: planned; implementation has not started.

Recorded: 25 October 2026.

## Summary

Complete the Manager's responsibility for framing requests, planning work, supervising specialists, handling corrections and failures, coordinating reviews, and delivering supported answers.

The Manager makes task decisions. The runtime validates and executes them, enforcing permissions, budgets, dependencies and revision fences.

Use the Manager responsibilities in [Haze Agent Architecture v0.14](Haze_Agent_Architecture_v0.14.pdf) as the reference. Scope includes the existing registered capabilities, task UI and Manager evaluation. The HazeWorld testing Manager is excluded.

## 1. Implement the Manager decision layer

- Keep `app/agents/manager/` as the entry point, with supporting modules for instructions, context assembly, action validation and decision execution.
- Add a registered `decide(services)` entry point. The runtime calls it through a controlled interface; the Manager receives no database handles or unrestricted adapters.
- Give each decision the original objective, exact corrections, current interpretation, available capabilities, assignment states, evidence references, review objections, remaining resources and triggering events.
- Record the interpreted scope, deliverables, assumptions, intended use and stopping conditions. Ask questions only when missing information materially affects correctness, authority or effort.
- Support strict actions for inspecting artifacts, performing granted read-only lookups, applying a plan, steering assignments, requesting peer coordination, asking a question, waiting and producing the final answer.
- Record each decision's concise explanation and supporting references. Source documents, tool outputs and peer messages remain untrusted evidence.
- Keep context within the admitted input limit using artifact references and bounded excerpts. Expose truncation and missing context; never silently discard constraints.

## 2. Add supervision and bounded replanning

### Decision checkpoints

Invoke the Manager initially and after material work products, known failures, review objections, corrections or specialist escalations. Coalesce pending events into one decision. Routine progress messages and tool activity do not trigger extra Manager calls.

Persist the last handled event cursor. A stable wait produces no repeated model calls; unrelated specialist work can continue while the Manager considers another branch.

### Plans and assignments

- Represent the current plan with its own revision, separate from the user's objective revision.
- Let the Manager create, replace, retire or rebrief registered assignments and allocate their remaining resources. Templates remain optional starting points.
- Validate the complete dependency graph before admission, including dependencies on retained work.
- Preserve previous plans, briefs, outputs and supersession relationships. Material changes fence affected workers and invalidate dependent work and reviews.
- Add specialist escalation for missing dependencies, scope conflicts, unavailable resources and peer-channel requests.

### Recovery

Known failures and rejected reviews return to the Manager with exact errors and retained findings. It can choose an authorized alternative, revise the affected work, ask a question or deliver a supported partial result.

Replacement work requires an explicit recorded Manager decision and consumes the original budget. Repeating unchanged failed work without addressing its cause is rejected as no progress. Unknown remote outcomes retain the existing pause-and-explicit-resume behavior.

### Peer coordination

Remove automatic channel creation from specialist messaging. The Manager grants a channel for named assignment revisions and a concrete purpose. Specialists may then communicate within that grant. Preserve one active channel, cumulative traffic limits and the original expiry when participants are revised.

## 3. Make correction, review and finalization explicit

### Corrections

Persist corrections and fence old execution immediately. The Manager then assesses affected work and proposes a revised plan. Replace automatic "Manager checked applicability" records with actual decisions backed by inspected references.

The runtime independently checks hashes, access and dependency changes. Work remains held when impact is uncertain; an unchanged hash alone does not establish continued relevance.

### Review

- Extend capability registration with deterministic prerequisites, availability information and review requirements.
- Normalize existing capability review outputs into verdicts tied to exact artifacts, producer revisions and independent reviewers.
- Enforce required review during admission and finalization. The Manager cannot waive a numerical check or substitute its agreement.
- Let objections trigger investigation, revision and renewed review. Preserve unresolved disagreement and withhold rejected claims.

### Finalization

The final Manager decision selects supported work products and sources, explains uncertainty and unresolved objections, and identifies unfinished deliverables.

Compute completion and review status from the current plan and selected artifacts. Historical failures must not incorrectly downgrade repaired work; completed assignments must not imply that their claims are supported. Close or cancel remaining active assignments before committing a result.

Reserve capacity for final synthesis and required review before admitting additional work. If the Manager model fails, retain the artifacts and report execution failure without substituting fixture output or claiming synthesis succeeded.

## 4. Extend persistence, interfaces and the task UI

- Add typed `ManagerContext`, `ManagerDecision`, `ManagerServices` and durable coordination state through the orchestration interfaces.
- Use one persistent coordinator assignment per run so every checkpoint does not consume another assignment reservation.
- Persist plan revisions, pending events, decisions, artifact inspections and dispatch receipts. Apply plan changes and dispatch receipts atomically and idempotently.
- Bind decisions to the run, objective revision, plan revision and referenced assignment/artifact versions. Late decisions cannot modify corrected or superseded work.
- Keep the public v3 request, update and control endpoints. Add optional Manager state to task readback, Manager progress events, and per-artifact checks within the result's review envelope. Update shared schemas and frontend consumers together.
- Preserve completed historical tasks. Pause unfinished runs using the old Manager with an upgrade explanation; explicit continuation starts a linked run under the new version. Do not reinterpret old decisions.
- Extend the existing task workspace with the interpreted objective, current work plan, assignment status, replanning reasons, review objections and next requirements. Retain the current visual style and controls; keep detailed execution receipts expandable.

## 5. Verification and completion gates

### Automated behavior tests

Cover direct answers, clarification, single and parallel specialists, and plans differing from templates. Verify that a new capability can use the Manager without core domain changes.

Exercise known-failure recovery, rejected-review repair, conflicting evidence, unavailable capabilities, peer requests and valid partial completion.

### Runtime invariants

Test correction during model/tool execution, transitive invalidation, unaffected-work reuse, duplicate decisions, stale dispatch, revocation, budget exhaustion and restart between decision persistence and dispatch. Confirm that unknown attempts remain charged and require explicit resume.

Reject invented capabilities, unauthorized reads, injected document instructions, self-review and unsupported final references.

### UI verification

Test progress, replanning, questions, objections, partial results, saved-history readback and upgrade continuation. Inspect desktop and mobile layouts using the existing application.

### Manager quality evaluation

Freeze representative cases and expected outcomes before tuning. Run scripted decisions through the same validation and dispatch path for deterministic checks, then evaluate the configured real model separately.

Capture actual decisions, inspected evidence, provider receipts, completion quality, unnecessary delegation, call counts and latency. Compare against the current initial-planning/final-synthesis baseline using matching inputs and budgets. Report every attempted case, including failures.

Manager completion requires passing the invariant suite and captured real-model evidence for the required decision scenarios. Successful live PM2.5 retrieval remains a separately reported integration gate; missing credentials cannot count as a pass.

### Defaults

Retain the existing aggregate resource profiles, two active tasks, two specialist slots and delegation depth one. Preserve unrelated workspace changes. Additional scientific capabilities, World Model acceptance, memory capture, external effects and scheduled monitoring remain outside this milestone.
