# World Model damage-input adapter

This module connects governed World Model accounting captures to the
`damage-account` capability. It retrieves exact evidence, selects a compatible
capture, persists its snapshot and selection receipt, and rechecks that selection
when later accounting stages reuse it.

Import the public API from [index.ts](index.ts):
`WorldModelDamageInputAdapter`, `createWorldModelDamageInputTool` and
`readDamageWorldSelection`. The registered tool remains `damage.world-inputs`;
artifact contracts and receipt versions are unchanged.

## Ownership

| File                         | Responsibility                                                          |
| ---------------------------- | ----------------------------------------------------------------------- |
| [index.ts](index.ts)         | Public exports and typed tool registration.                             |
| [adapter.ts](adapter.ts)     | Bounded discovery, evidence selection and selection reuse.              |
| [selection.ts](selection.ts) | Snapshot/selection receipt persistence and receipt authenticity checks. |
| [ports.ts](ports.ts)         | Domain policy interface supplied by composition.                        |

[Composition](../../composition.ts) registers the store-backed tool and injects
[damage-account's input policy](../../capabilities/damage-account/world-input-policy.ts).
That policy owns request/correction scope interpretation, country/date matching
and reconstruction through the existing accounting normalization and validation
functions. The adapter imports shared contracts and execution ports; it does not
import capability implementations.

Generic access, producer provenance, holds, corrections and durable pin enforcement
remain in [tasks](../../tasks/README.md) and
[orchestration](../../orchestration/README.md). Accounting calculations and the
independent checker stay in
[damage-account](../../capabilities/damage-account/README.md).

## Evidence behavior

The adapter reads accounting-ready `haze.damage.inputs.v1` captures and exact
original supporting artifacts. It does not acquire external datasets or estimate
health effects from raw PM2.5. Missing evidence produces an acquisition gap;
ambiguous evidence requires clarification. Fixture evidence remains synthetic.

See the [implementation report](../../../docs/orchestration/world-model-damage-input-adapter-report.md)
for bounds, provenance rules and historical validation results.
