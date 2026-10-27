# Execution trace

Task: e6197539-e036-47e6-b53d-358efe843341
Run: b769a811-426c-4a16-93e4-ac0e9161ceec
Captured records: 82; snapshot cursor: 82.
Evidence mode: replay.

## Highlights

- 2026-10-27T20:37:16.253Z [trace:1] Manager: General objective admitted with bounded resources. (admitted)
- 2026-10-27T20:37:16.598Z [trace:3] Manager: Admitted 1 assignments. (created)
- 2026-10-27T20:37:16.717Z [trace:8] Manager: Exact inputs pinned and revised brief acknowledged. (started)
- 2026-10-27T20:37:17.176Z [trace:19] Manager: Admitted 1 assignments. (created); causes: 8e76a217-c15d-44b4-9973-eb64bfb02a66
- 2026-10-27T20:37:17.225Z [trace:21] Manager: Follow the frozen scripted case and exact retained evidence. (applied); causes: 8e76a217-c15d-44b4-9973-eb64bfb02a66
- 2026-10-27T20:37:17.414Z [trace:24] HazeOps: Exact inputs pinned and revised brief acknowledged. (started)
- 2026-10-27T20:37:17.788Z [trace:31] HazeOps: Execution state persisted independently of evidence support. (failed)
- 2026-10-27T20:37:18.549Z [trace:47] Manager: Admitted 1 assignments. (created); causes: 323c886e-3b45-430b-ad8b-4a3a2180adf9
- 2026-10-27T20:37:18.559Z [trace:49] Manager: Follow the frozen scripted case and exact retained evidence. (applied); causes: 323c886e-3b45-430b-ad8b-4a3a2180adf9
- 2026-10-27T20:37:18.700Z [trace:52] HazeOps: Exact inputs pinned and revised brief acknowledged. (started)
- 2026-10-27T20:37:19.186Z [trace:64] HazeOps: Execution state persisted independently of evidence support. (completed)
- 2026-10-27T20:37:19.927Z [trace:80] Manager: General result committed with exact sources/work products. (completed); evidence: not_required; artifacts: db9a58ff-4beb-44ff-bf0b-9df44278730a@1 sha256:14b061ac245c82bd7d4edc981619877a5a5cf8f199a3f64722974de394d52931; causes: 65411884-5951-40db-afeb-9ae9ba8c57f0
- 2026-10-27T20:37:19.952Z [trace:81] Manager: Follow the frozen scripted case and exact retained evidence. (applied); causes: 65411884-5951-40db-afeb-9ae9ba8c57f0

## Provenance and limitations

- Only saved facts are shown. Missing causal links, confidence, and provider metadata are not inferred.
- Execution acceptance, evidence verdicts, and task outcomes describe separate facts.
- Exported content is sanitized; original artifact references identify the saved evidence, not redacted bytes.
