# Synthetic scenario inputs

These three scenarios contain hand-authored input data for `SAMPLE_MODE=true`.
They contain no saved answer, tool result, agent decision, execution recording,
review verdict or calculated total. The Manager and specialists must choose and
run their ordinary reasoning, calculation and review steps from these inputs.

| ID                       | Scenario                                                                                        | Input files                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence-investigation` | A policy analyst investigates incomplete modeled PM2.5 coverage.                                | [Manifest](01-evidence/scenario.json), [raw capture](01-evidence/pm25-capture.json), [source notes](01-evidence/source-notes.md)                                                                           |
| `damage-account`         | An analyst accounts for treatment and productivity effects while mortality remains unestimated. | [Manifest](02-damage-account/scenario.json), [quantities, unit values and financing](02-damage-account/damage-input.json)                                                                                  |
| `damage-reduction`       | A planner assesses a proposed alert and schedule service across two workforce strata.           | [Manifest](03-intervention/scenario.json), [residual inputs](03-intervention/residual-input.json), [declared target](03-intervention/target.json), [candidate declaration](03-intervention/candidate.json) |

Every manifest contains its objective, input filenames, synthetic provenance and
known gaps. All people, places, quantities, unit values and scenarios are
invented. CU is an invented currency, not MYR or another real currency.

The evidence capture keeps the existing PM2.5 transport contract so the ordinary
source validation and numerical tools can inspect exact raw rows. Its
`mode: fixture` describes the stored synthetic source format; it does not provide
fixture agent decisions. The local source adapter retains synthetic provenance
when it supplies these rows to a genuinely executed agent run. The source
identifier and column names establish format compatibility, not source-provider
authenticity or a live Zetaris request.

The accounting data supplies attributable physical quantities as assertions; it
does not establish health attribution from concentrations. Financial incidence
and social-welfare valuations remain distinct. Missing mortality and direct
source-fire categories are gaps, not zero losses.

The intervention data supplies prospective residual quantities, not delivered
effects. The target and proposed service are operator inputs. Approval, cost,
delivery capacity, trigger/action rules and income protection remain unresolved.

`app/sample-data/index.ts` loads these files from either source or compiled
execution and validates their native contracts and explicit synthetic origin.
Unknown IDs and source data presented as live or scientifically approved fail
validation. Runtime state belongs under `.state/`. The runnable requests are
`input_examples/example_1.json`, `example_2.json` and `example_3.json`; their actual
generated outputs are retained as `output_examples/example_1_output.json`,
`example_2_output.json` and `example_3_output.json`. These data directories keep
the original inputs separate from execution results.
