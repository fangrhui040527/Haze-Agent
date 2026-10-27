# Execution trace

Task: 28f5d54e-8981-473b-befa-883903db2cc7
Run: 56c8e4cc-a830-427d-a890-7791e45412f0
Captured records: 82; snapshot cursor: 82.
Evidence mode: replay.

## Highlights

- 2026-10-27T19:37:00.673Z [trace:1] Manager: General objective admitted with bounded resources. (admitted)
- 2026-10-27T19:37:00.790Z [trace:3] Manager: Admitted 1 assignments. (created)
- 2026-10-27T19:37:00.836Z [trace:8] Manager: Exact inputs pinned and revised brief acknowledged. (started)
- 2026-10-27T19:37:00.968Z [trace:19] Manager: Admitted 1 assignments. (created); causes: 09063002-34fe-4b8b-92b2-d8ed7736f4dd
- 2026-10-27T19:37:00.976Z [trace:21] Manager: Follow the frozen scripted case and exact retained evidence. (applied); causes: 09063002-34fe-4b8b-92b2-d8ed7736f4dd
- 2026-10-27T19:37:01.026Z [trace:24] HazeOps: Exact inputs pinned and revised brief acknowledged. (started)
- 2026-10-27T19:37:01.168Z [trace:31] HazeOps: Execution state persisted independently of evidence support. (failed)
- 2026-10-27T19:37:01.468Z [trace:47] Manager: Admitted 1 assignments. (created); causes: edd7e36e-961e-4542-81f3-a2afb09863f0
- 2026-10-27T19:37:01.474Z [trace:49] Manager: Follow the frozen scripted case and exact retained evidence. (applied); causes: edd7e36e-961e-4542-81f3-a2afb09863f0
- 2026-10-27T19:37:01.537Z [trace:52] HazeOps: Exact inputs pinned and revised brief acknowledged. (started)
- 2026-10-27T19:37:01.870Z [trace:64] HazeOps: Execution state persisted independently of evidence support. (completed)
- 2026-10-27T19:37:02.171Z [trace:80] Manager: General result committed with exact sources/work products. (completed); evidence: not_required; artifacts: 2c63a222-7add-43b9-90a7-e89c3db8deaa@1 sha256:14b061ac245c82bd7d4edc981619877a5a5cf8f199a3f64722974de394d52931; causes: f8f23e7c-90a5-4d52-8151-0d149f501412
- 2026-10-27T19:37:02.184Z [trace:81] Manager: Follow the frozen scripted case and exact retained evidence. (applied); causes: f8f23e7c-90a5-4d52-8151-0d149f501412

## Provenance and limitations

- Only saved facts are shown. Missing causal links, confidence, and provider metadata are not inferred.
- Execution acceptance, evidence verdicts, and task outcomes describe separate facts.
- Exported content is sanitized; original artifact references identify the saved evidence, not redacted bytes.
