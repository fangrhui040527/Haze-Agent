# Make the Manager conversational, with tasks when needed

Date: 2026-10-27

Status: Proposed; implementation and verification are pending.

[Implementation plans](../README.md)

## Summary

The Manager will decide how to handle a request **before creating a task**. Greetings, explanations, quick haze lookups, and follow-up questions stay in chat. Reports, investigations, delegated work, and ongoing monitoring become tracked tasks.

Chat will show normal Manager replies and a compact card for actual tasks. Detailed controls and permissions move to the Manager workspace.

## Manager routing and retrieval

- Add `POST /api/manager/chat`, using the existing configured Manager model route and a separate conversational decision schema. Support answering, asking a clarification, retrieving data, starting a task, and answering an existing task's question.
- Make routing depend on the requested outcome and tracking needs. Using tools or missing information alone must not create a task.
- Reuse existing World Model readers and live haze source adapters without admitting hidden tasks. Use current stored information when suitable; retrieve fresh information when requested or when stored data is stale.
- Retrieve available information before asking the user to supply sources. Infer location and time from conversation or the selected dashboard item; ask a natural follow-up when they remain ambiguous.
- Validate citations against actual retrieved evidence. Include source and observation time, distinguish modeled values from observations, and describe unavailable or unsupported data plainly.
- Bound each conversational turn to four retrieval operations and one model-output correction attempt, within existing model/source timeouts. Failures stay in chat; they never automatically become tasks.

## Conversation and task behavior

- Introduce a conversation service/controller separate from task execution. Chat requests carry bounded conversation history, selected-item context, and relevant task/question associations. Responses distinguish replies, clarifications, admitted tasks, and task updates.
- Keep existing browser transcript persistence. Add a server-side turn ledger using the existing SQLite owner for idempotent retries; repeated delivery must not create duplicate tasks.
- Finish the conversational turn immediately after task admission. Observe task progress separately, keeping chat available while tasks run, wait, or pause.
- Render each task clarification as one Manager message. Route relevant answers through the existing clarification-update API using the exact task/question identity and current revision checks.
- Allow unrelated messages during a pending clarification. If the intended task is ambiguous, ask which task the user means.
- Deduplicate questions and results across polling and reloads. Clearing chat starts a fresh conversation without cancelling saved tasks.

## Chat and workspace UI

- Remove the permanent status/revision/run block, inline lifecycle buttons, permissions panel, and separate "Clarification needed" section from chat.
- For actual tasks, show only the task title, short progress summary, and **Open Manager workspace** link. Keep the user in chat when a task starts.
- Place pause, resume, cancel, continue, technical execution details, and task permission revocation in the Manager workspace.
- Move the optional Nightshift grant checkbox into a clearly labelled **Next task permissions** setting in the Manager workspace. Keep it disabled by default and apply it only to the next admitted task.
- Preserve historical chat text, task links, and existing task/report APIs. Replace catch-all validation errors with accurate error categories, retaining diagnostic details internally and the last confirmed task state.

## Verification and acceptance

- "Hi" and "What causes haze?" produce replies with zero task admissions.
- "Latest haze information for Singapore" retrieves and cites information with zero task admissions.
- Missing location produces a conversational question; answering it completes the lookup.
- A requested investigation or report creates exactly one task and one compact card, including after retry or reload.
- Task clarifications are answerable in chat; unrelated questions still work while tasks wait.
- Polling, reloads, and revised tasks do not duplicate messages or publish stale results.
- Permission controls appear only in the Manager workspace and retain existing grant/revocation semantics.
- Cover unavailable sources, malformed model output, transport failures, and task-response validation separately. Run focused backend/frontend tests, type checks, builds, and browser verification.

Defaults: reuse existing providers and permission boundaries; introduce no new data subscriptions or task-state migration.
