# Imported scenario assessment

`damage-reduction-planning.v1` implements Plan 01 for one physical endpoint,
ordinary-management comparator and intervention. It compares supplied residual
point estimates with exact decimal arithmetic and independent reconstruction.

Import JSON conforming to `physicalResidualImportSchema` through the existing
artifact API. Preserve decimal strings, source method/version, scenario name,
prospective/retrospective evidence basis, applicability, scope and declared disjoint
support. The request's `scope` is a complete `reductionInputSelectionSchema`;
include the selected originals in `context_refs`. `createReductionSelection`
constructs the scope hash and method pins. Row IDs are local to each original.
Only selected rows supply numbers. Additional task evidence cannot supply an
implicit baseline, intervention or coefficient.

For larger assessment-only selections, import the complete selection JSON as an
original artifact and put this compact wrapper in the task's `scope`:

```json
{
  "schema_version": "haze.reduction.selection-request.v1",
  "selection_ref": {
    "id": "<original UUID>",
    "version": 1,
    "sha256": "<exact hash>"
  }
}
```

Pin both that selection original and every selected numerical original in
`context_refs`. The selector resolves only the exact authorized original, checks
it against the operator's scope, and saves its full contents. Its material
dependencies include the selection original, so a hold or applicability change
to either the declaration or a numerical source invalidates current claims.
This avoids repeating hundreds of row IDs in Manager templates and request
scope; no runtime budget or scientific claim gate is raised. Existing inline
selections remain supported. The new wrapper is for Plan 01 assessments, not a
replacement for the Plan 02 preview-request contract.

The registered sequence is HazeOps `reduction.select`, DamageAccountant
`reduction.assess`, and EvidenceCritic `reduction.check`, coordinated by the
existing Manager. It retains `reduction.input-selection`, `reduction.assessment`
and `reduction.review` using existing task/artifact services. Missing selection
produces `reduction.input-gap` and stops dependent calculation. A well-formed
selection with incompatible evidence produces a saved incompatible assessment
and independently reviewed explanation. Existing grants, limits and controls
continue to apply. Preview requests add WorkerShield `reduction.plan` and a final
EvidenceCritic `reduction.plan-check` after the arithmetic check. They save
`reduction.conditional-plan` and `reduction.plan-review` with exact scenario,
candidate, rule and source lineage. Unknown inputs remain prerequisites;
violated hard constraints block a recommendation.

Canonical decimal inputs allow 18 significant digits and 12 fractional places;
intermediate integers have a 128-digit bound. Threshold comparison uses exact
cross-multiplication, including equality for `at_least`. Results retain signed
differences and exact ratio components. Normalized selected inputs are bounded
by 16 originals, 1000 rows and 512 KiB. These are representation ceilings;
configured live-model performance has not been qualified.

These limits apply together. A 1,000-row selection may exceed the byte ceiling
even with short metadata. Run `npm run reduction:capacity:verify` for the
synthetic kernel matrix and API/restart trace, including a 500-row, 16-original
fixture at exactly 512 KiB, over-limit gaps and two outstanding maximum-byte
tasks. Acceptance limits and measured latency/memory/resource usage are retained
with the report; they describe the tested machine and fixtures, not a production
throughput promise or live-model qualification.

### Supplied-pair sensitivity diagnostic

`npm run reduction:sensitivity -- --demo` creates a fully synthetic example
where the nominal pair meets the target and the lower-effect pair misses it.
For original snapshots, run `npm run reduction:sensitivity -- --input INPUT.json`.
The input envelope contains `request` and `artifacts`, where:

- `request.schema_version` is `haze.reduction.sensitivity-request.v1`.
- `request.target` is the existing point-estimate target.
- `request.assumptions` describes how the paired scenarios were supplied.
- Each of 2-16 `request.pairs` contains a unique `id`, `label` and exact `sources`
  with selected row IDs, using the existing selection-source contract.
- `artifacts` contains at most 16 complete original artifact snapshots. At most
  1,000 selected rows across all pairs and 1 MiB combined normalized selected
  input are accepted, in addition to each selection's existing limits. The CLI
  input file is bounded to 8 MiB and rejects duplicate JSON keys.

Each pair keeps its supplied baseline/intervention relationship and passes
through the existing exact producer and independent reconstruction. Scope,
source method/version, evidence basis and declared strata/support must match
across pairs. The result describes `all_supplied_pairs_meet`,
`some_supplied_pairs_meet`, `no_supplied_pairs_meet` or `incomplete`. An unknown
quantity, incompatible comparison or failed reconstruction prevents a complete
set conclusion. Inputs, exact source references, per-pair products and the
report are retained under `.state/reduction-sensitivity/`.

This offline diagnostic does not establish a probability, confidence interval,
scientific robustness or current application eligibility. Its derived refs and
reconstruction IDs are local to the report. Original snapshots are not rechecked
against live access, applicability or holds. The report keeps
`probability_of_target: null`, `scientific_qualification: unqualified`,
`claim_eligibility: none` and `achieved_reduction: false`. Scientific review must
still establish that the supplied paired set is appropriate and sufficiently
complete. No operational method registration or qualified/achieved claim is
enabled by the diagnostic.

### Runtime verification and later phases

Run `npm run reduction:verify` for the synthetic admitted-task/API/restart trace.
The script retains task, artifact, event and resource evidence beneath
`.state/damage-reduction-verification/`. The fixture is engineering evidence;
scientific qualification remains `unqualified`, and no scenario establishes
achieved reduction or delivered actions. World Model publication and acceptance
remain separate.

Read current eligibility with the Manager's read-only `reduction.read-claim`
tool and exact selection, assessment and review references. Its dependency,
permission and hold checks run on every call. A saved review's eligibility flag
is historical. Reduction artifact dependencies contain only their material
selected evidence; unrelated pinned context cannot supply numbers or stale the
numerical claim.

See the [method specification](../../../docs/architecture/damage-reduction/damage-reduction-01-method-spec.md)
and [implementation report](../../../docs/reports/damage-reduction/damage-reduction-01-implementation-report.md).

The dedicated preview is available at `/damage-reduction`; saved previews reopen
at `/damage-reduction/tasks/:taskId`. Its service reads the governed projection
through `GET /api/tasks/:taskId/views/reduction-preview`, rechecking support on
every reuse. Use `npm run reduction:preview:verify` for the complete synthetic
planning/review/restart trace. See the [Plan 02 report](../../../docs/reports/damage-reduction/damage-reduction-02-implementation-report.md)
for scope, test evidence and the limits of the computational benchmark.

Choose **Demos → Damage reduction** in the frontend to view the bundled
completed example at `/demos/damage-reduction`, including recorded exact sources
and reviews. Run `npm run reduction:demo` to execute a fresh synthetic preview
on an isolated fixture server, normally at port 5175. See the
[browser demo guide](../../../docs/guides/damage-reduction-demo.md) for both paths.

Programmes also support an explicitly started `pilot` phase after the current
reviewed plan. WorkerShield `reduction.pilot-draft` retains supplied feasibility
findings and an exact protocol; EvidenceCritic `reduction.pilot-check` checks
both products against original design evidence, target and rule versions. The
read-only projection is `GET /api/tasks/:taskId/views/reduction-pilot`. Missing
scientific inputs remain conditional/limited; no power or causal estimator is
introduced. See [programme records](../damage-reduction-programmes/README.md)
and the [Plan 04 report](../../../docs/reports/damage-reduction/damage-reduction-04-implementation-report.md).

Plan 05 adds an explicit programme `evaluation` phase. DamageAccountant
`reduction.evaluate` reproduces supplied residual point comparisons with the
shared exact kernel; EvidenceCritic `reduction.evaluation-check` reconstructs
them independently and inspects dossier completeness. The governed task view is
`GET /api/tasks/:taskId/views/reduction-evaluation`. Scientific qualification
requires separate human adoption and current server validation; technical
artifacts remain unqualified. Run `npm run reduction:evaluation:verify` for the
synthetic engineering/restart trace. See the [Plan 05 report](../../../docs/reports/damage-reduction/damage-reduction-05-implementation-report.md).
