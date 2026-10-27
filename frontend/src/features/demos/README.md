# Bundled workflow demos

`/demos` links to read-only completed examples at `/demos/damage-account` and
`/demos/damage-reduction`. The pages reuse the production result renderers,
without mounting task controls or task-observation hooks. They also work in a
static frontend build without a task API.

The JSON recordings under `data/` came from successful synthetic fixture runs
of `scripts/demo-damage-account.mjs` and `scripts/demo-damage-reduction.mjs`.
They retain domain products, exact original artifacts and review records. No
live task selection, provider configuration or local state directory is used.

Account source links include exact versions and hashes and resolve within
`/demos/damage-account/artifacts/:artifactId`. Reduction source inspectors use
the recording's local reader. Missing or mismatched artifacts remain unavailable
and never fall back to live evidence. Review eligibility is explicitly labeled
as recorded, while the original numerical review gates still apply.

The recordings are loaded with their respective lazy routes. Focused tests
check all content hashes and reference closure, recorded result rendering,
altered source rejection and local source lookup. To refresh a recording,
capture a new completed synthetic workflow and retain the same envelope and
complete exact artifact set; the tests must still pass.
