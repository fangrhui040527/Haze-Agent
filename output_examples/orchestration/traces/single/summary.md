# Execution trace

Task: ff30343e-4b2a-46ba-a5b4-0d1d8ab2fc26
Run: b01b617d-669c-4a82-9694-1c189a8eb282
Captured records: 54; snapshot cursor: 54.
Evidence mode: replay.

## Highlights

- 2026-10-27T20:36:50.700Z [trace:1] Manager: General objective admitted with bounded resources. (admitted)
- 2026-10-27T20:36:51.110Z [trace:3] Manager: Admitted 1 assignments. (created)
- 2026-10-27T20:36:51.225Z [trace:8] Manager: Exact inputs pinned and revised brief acknowledged. (started)
- 2026-10-27T20:36:51.880Z [trace:19] Manager: Admitted 1 assignments. (created); causes: be76a3f3-cbd6-4152-9083-57a9b2158545
- 2026-10-27T20:36:51.921Z [trace:21] Manager: Follow the frozen scripted case and exact retained evidence. (applied); causes: be76a3f3-cbd6-4152-9083-57a9b2158545
- 2026-10-27T20:36:52.212Z [trace:24] HazeOps: Exact inputs pinned and revised brief acknowledged. (started)
- 2026-10-27T20:36:53.031Z [trace:36] HazeOps: Execution state persisted independently of evidence support. (completed)
- 2026-10-27T20:36:53.899Z [trace:52] Manager: General result committed with exact sources/work products. (completed); evidence: not_required; artifacts: bda6078c-9f38-4aa8-a4dc-8cb2dc6f2dea@1 sha256:b6bedb0e250c17cdb2d822a8631f580bd107a8bac3133cae127dc1cc8f59c844; causes: 7fdf443e-ebd5-407f-9ed9-ab104081acb8
- 2026-10-27T20:36:53.926Z [trace:53] Manager: Follow the frozen scripted case and exact retained evidence. (applied); causes: 7fdf443e-ebd5-407f-9ed9-ab104081acb8

## Provenance and limitations

- Only saved facts are shown. Missing causal links, confidence, and provider metadata are not inferred.
- Execution acceptance, evidence verdicts, and task outcomes describe separate facts.
- Exported content is sanitized; original artifact references identify the saved evidence, not redacted bytes.
