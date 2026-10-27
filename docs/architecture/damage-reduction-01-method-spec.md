# Imported residual comparison v1 method specification

Recorded before implementation, 27 October 2026. Engineering owner: repository implementer. Scientific owner and non-synthetic reference case: not supplied. This specification describes a bounded synthetic engineering implementation; it does not confer scientific or operational qualification.

`reduction.imported-residual-comparison.v1` compares supplied residual physical damage for one ordinary-management comparator and one intervention. It does not estimate effectiveness, perform monetary valuation, infer effects from PM2.5, or deliver an intervention.

Inputs are an immutable `reduction.input-selection` containing an exact target, scope hash, method/version, and up to 16 exact original artifact references with explicit row IDs. Only selected rows enter the calculation. Imports retain baseline/intervention role, the exact scenario name matching the target comparator/intervention, prospective/retrospective evidence basis, source decimal tokens, method/version, applicability, endpoint/unit, population, geography, pollutant, period, coverage, missingness and exclusions. Each row declares a stratum and atomic support IDs. Atomic supports must be disjoint within each role, strata must be unique within each role, and both roles must cover identical strata and support IDs. These are checked supplied declarations, not independently measured population membership.

All selected rows must exactly match the target scope and use the same source method/version and evidence basis. Quantities are canonical signed decimal strings (or explicitly unknown), at most 18 significant digits and 12 fractional places, without exponent notation or redundant zeros. A floating-point accounting total cannot be imported through an existing v1 account; a new physical-decimal import is required. Assignment-produced/derived originals and legacy `damage.*` source methods are rejected by this narrow adapter. Original hashes and duplicate keys are checked before normalization. Normalized selected inputs are limited to 512 KiB and 1,000 rows.

The output retains exact baseline and intervention totals, their signed difference, exact relative-reduction numerator and denominator, the inclusive or explicit strict target decision, input-selection reference, method/version, provenance, gaps and scientific limits. The ratio exists only for a positive baseline. Decisions cross-multiply exact bounded integers; no display rounding, floating-point aggregation or epsilon is used. Intermediate integers have a 128-decimal-digit bound. Unknown quantities stop dependent arithmetic. Nonpositive baseline or negative intervention quantities leave the ratio unavailable with a reason; an available absolute difference remains visible.

## Exact selection references

An assessment request may put `haze.reduction.selection-request.v1` in its scope,
with `selection_ref` identifying an exact original containing the complete
selection. Pin that original and the numerical originals in `context_refs`.
The selector resolves the declared selection, checks its original hash and
provenance, and compares the complete selection against the operator declaration
at tool execution. The saved selection retains every row and source pin. Its
dependencies include the declaration original, which participates in current
access, applicability and hold checks. Assignment-produced/derived declaration
originals and declarations with dependencies are rejected. Inline selections
remain supported; no model-input, source, row or byte ceiling is raised.

The aggregate selected-row count is checked before original numerical rows are
read, independently in producer and checker. The selection resolver can reject
an oversized declaration before its numerical originals are supplied. Such a
request saves an input gap and supplies no numerical assessment or claim.

## Supplied-pair sensitivity diagnostic

The offline identifier `reduction.supplied-pair-sensitivity.v1` describes a
finite supplied scenario set. It is not an operational method registration or
an uncertainty/probability criterion. Every supplied pair uses the registered
point-estimate comparison and independent reconstruction above. All pairs share
the same exact target/scope, source method/version, evidence basis and declared
strata/support. Pair identities and exact selected row/source references remain
explicit; baseline and intervention quantities are never recombined across
pairs.

The request accepts 2-16 uniquely named pairs, at most 16 original snapshots,
1,000 total selected rows across pairs and 1 MiB aggregate normalized selected
input, subject also to each comparison's existing bounds. A complete result
reports only whether all, some or none of the supplied pairs meet the target.
An unknown quantity, invalid original, incompatible pair or failed reconstruction
produces `incomplete`. Expected synthetic examples are 100 to 88 and 100 to 95:
the first meets an inclusive 10% target, the second misses it, and the set is
`some_supplied_pairs_meet`.

Reports retain `probability_of_target: null`, `scientific_qualification:
unqualified`, `claim_eligibility: none` and `achieved_reduction: false`. Derived
refs and reconstruction IDs are local report identifiers. This snapshot
diagnostic does not recheck live permissions, holds or applicability, and does
not attest human or agent reviewer identity. Scientific review must establish
the supplied set's plausibility and completeness. A complete finite-set result
is not a probability or a conclusion across every scientifically plausible case.

## Capacity verification

`npm run reduction:capacity:verify` exercises 2/100/500/1,000/1,002 declared rows,
2/8/16 originals, exactly 512 KiB normalized input and a one-byte excess. The
separate unit boundary covers 17 originals. The row and byte ceilings apply
together: the short-metadata 1,000-row fixture is expected to return a byte gap.
The 1,002-row fixture has matching support and isolates the aggregate row guard.

Local engineering acceptance is fixed before measurement: at most 5 seconds for
each producer-plus-checker kernel iteration, 30 seconds per admitted task,
512 MiB kernel-process peak RSS and 1 GiB API-process peak RSS. These are local
verification thresholds, not scientific or production service objectives. The
trace retains first/warm kernel times, fresh-process startup samples, process
memory, calls, artifacts, persisted sizes and exact restart readback. Maximum-byte
tasks run sequentially and as two outstanding admissions. The registered
runtime's existing resource ceilings remain authoritative. Configured live-model
capacity, monetary costs and cold-cache startup distributions are not inferred
from the synthetic trace.

Task acceptance measures persisted `task.created_at` to the current run's
`task_completed` event. Client polling and subsequent artifact/event inspection
remain separately reported as `latency_ms`; they are not treated as task
execution time. Performance misses remain recorded and make the final report
fail, while numerical checks and restart evidence are still collected.

## Original synthetic arithmetic cases

Independently expected synthetic cases, fixed before implementation:

| Baseline | Intervention       | Target/relation     | Difference        | Exact ratio      | Decision    |
| -------- | ------------------ | ------------------- | ----------------- | ---------------- | ----------- |
| `1000`   | `880`              | `0.1`, at least     | `120`             | `120 / 1000`     | true        |
| `0.3`    | `0.27`             | `0.1`, at least     | `0.03`            | `0.03 / 0.3`     | true        |
| `0.3`    | `0.27`             | `0.1`, greater than | `0.03`            | `0.03 / 0.3`     | false       |
| `1000`   | `900.000000000001` | `0.1`, at least     | `99.999999999999` | retained exactly | false       |
| `1000`   | `1100`             | `0.1`, at least     | `-100`            | `-100 / 1000`    | false       |
| `0`      | `1`                | `0.1`, at least     | `-1`              | unavailable      | unavailable |
| `-1`     | `1`                | `0.1`, at least     | `-2`              | unavailable      | unavailable |
| `null`   | `1`                | `0.1`, at least     | unavailable       | unavailable      | unavailable |

Overlapping support, unmatched strata, incompatible scope, method/basis conflicts or conflicting selections produce incompatibility. Missing inputs, invalid hashes, unsupported imports, precision violations and representation limits produce explicit evidence/representation gaps. Independent review reconstructs selected originals, compatibility, totals and threshold using separate arithmetic; it never calls producer arithmetic. Arithmetic review cannot establish a qualified prediction or achieved reduction. Current accessible dependencies and a successful independent review are required for the server's arithmetic-checked scenario label. A non-synthetic reference case and human applicability review remain outstanding prerequisites for operational qualification.
