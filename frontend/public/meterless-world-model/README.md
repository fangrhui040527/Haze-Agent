# Meterless World Model reference demo

`live.html` is the unmodified, self-contained upstream World Model control-plane demo. Vite serves it at `/meterless-world-model/live.html` and copies it into the production build.

The demo runs Meterless's reference engine with seeded data in browser memory. Reloading resets its data. It does not read or modify Haze's SQLite World Model. Use Haze's World Model page for the active store.

## Provenance

- Project: [Meterless/Meterless](https://github.com/Meterless/Meterless).
- Commit: `1742dec56a66e58eef9dda2d2b865823758ca8cd`.
- Original HTML: [`engines/world-model/control-plane/live.html`](https://github.com/Meterless/Meterless/blob/1742dec56a66e58eef9dda2d2b865823758ca8cd/engines/world-model/control-plane/live.html).
- App source bundled into the HTML: [`engines/world-model/reference/scripts/live-app.js`](https://github.com/Meterless/Meterless/blob/1742dec56a66e58eef9dda2d2b865823758ca8cd/engines/world-model/reference/scripts/live-app.js).
- `UPSTREAM-README.md` is the unmodified [`control-plane/README.md`](https://github.com/Meterless/Meterless/blob/1742dec56a66e58eef9dda2d2b865823758ca8cd/engines/world-model/control-plane/README.md). Its relative links refer to the original repository.
- Copyright 2026 Meterless. Apache License 2.0; the unmodified upstream license is included as `LICENSE`.
- `live.html` SHA-256: `1e6868d56244a7c7af2b6166fa6f8e19d270361c8a24802dadd069775ac0ca00`.
- `UPSTREAM-README.md` SHA-256: `e390f59ff506624f0bdb966d9ec91e679c8ec8358419c8ed17ed380df577cd20`.
- `LICENSE` SHA-256: `63e29fc8231b53757a77fbc371071c91d768621efa1e68b1d9ff8d1bb7c4a0ef`.

## Reference behavior

| Panel     | Behavior in this upstream demo                                                       |
| --------- | ------------------------------------------------------------------------------------ |
| Inspect   | Lists seeded entities, their attributes, state, and source provenance.               |
| Merge     | Approves or rejects the seeded resolver queue; approvals append alias events.        |
| Edit      | Asserts a string-valued fact with manual operator provenance.                        |
| Rebuild   | Queries the graph, facts, or timeline projection and reports timing and event count. |
| Repair    | Replays two fixed observations and reports ingestion/idempotency results.            |
| Audit log | Lists reference-engine mutations in reverse sequence order.                          |

The upstream operator specification describes a broader production contract than this demo implements. Its `Role: Admin` pill is a fixed label rather than a Haze authorization control.

All CSS, JavaScript, and the reference engine are inline. The page makes no network requests and needs no additional dependencies. If embedded, use a script-enabled sandbox without same-origin access. Deployments with a restrictive Content Security Policy must explicitly permit its inline content, or serve this demo separately.
