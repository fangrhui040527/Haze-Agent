# Evidence synthesis

This capability prepares source-backed notes for explanations and summaries of
supplied material, then independently checks the citations and excerpts. It works
across topics and does not require PM2.5 data or an episode scope.

The registered capability is `evidence-synthesis`, version
`evidence-synthesis.v3`. Its matching predicate accepts any objective, making it
available as a general source-based option for the Manager.

## Inputs and use

Import source material, such as text, Markdown, CSV or JSON, and request an
explanation:

> Explain the supplied report and identify what its evidence does and does not
> establish.

The extraction assignment reads input artifacts whose producer is not another
assignment. If none are available, it asks for source material and returns
`waiting_human`. Neither assignment calls an external retrieval tool.

## Execution and outputs

| Assignment                   | Role           | Behavior and output                                                                                                                         |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence-synthesis.extract` | HazeOps        | Saves `evidence-synthesis.notes` with numbered citations (`S1`, `S2`, etc.), exact artifact ID/version/hash references and source excerpts. |
| `evidence-synthesis.review`  | EvidenceCritic | Independently reads the notes and original sources, checks immutable references and exact excerpts, and saves `evidence-synthesis.review`.  |

The default plan runs extraction before review and connects the assignments through
the purpose-bound `synthesis-review` peer channel. The notes contain the first
2,400 characters of each source, using JSON serialization for structured content.
The notes schema supports up to 64 citations. Full sources remain accessible by
their immutable references.

The World Model adapter projects exact source references, citations, synthesis
bundles and supported review references. It checks content hashes and matching
dependencies before using these artifacts and can build an acceptance candidate
from independently reviewed evidence. A candidate does not itself authorize an
accepted-state decision.

## Limits

- Source attribution is supplied information; this capability does not establish
  authenticity or scientific validity.
- Its built-in extraction produces bounded source prefixes rather than a semantic
  analysis of every passage in a long document.
- Citation review verifies exact references and excerpts. It does not mechanically
  prove that every claim in the final prose follows from the sources.

## Key files

| File                         | Responsibility                                                                |
| ---------------------------- | ----------------------------------------------------------------------------- |
| [index.ts](index.ts)         | Capability card, default plan, extraction and independent review assignments. |
| [contracts.ts](contracts.ts) | Strict notes, citation and review schemas.                                    |
| [world.ts](world.ts)         | World Model projections, review coverage and acceptance-candidate checks.     |

See the [capabilities overview](../README.md) and
[composition root](../../composition.ts) for registration, or
[episode investigation](../episode-investigation/README.md) for scoped evidence
availability checks.
