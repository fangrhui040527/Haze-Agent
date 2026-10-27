# Damage account demo

Open the regular frontend and choose **Demos → Damage account**, or go directly
to `/demos/damage-account`. The completed synthetic account, numerical tables,
component references and independent reviews are bundled with the frontend.
Exact source links open the matching recorded artifact, including its version
and hash. No separate demo command or model provider is needed to view it.

The page is a read-only recording of a completed fixture run. Its reviews
describe that saved example; they do not revalidate current live evidence.
Use **Build your own account** to open the normal account workspace.

## Execute a fresh demo workflow

Run this from the repository root with the pinned Node/npm versions and the
root and frontend dependencies installed:

```sh
npm run damage:demo
```

Open the completed-account URL printed by the command. Keep the process running
while browsing; Ctrl+C stops it. Port 5174 is the default. Set
`HAZE_DAMAGE_DEMO_PORT` to use another port.

The demo uses the existing synthetic example and the real accounting workflow:

1. Import the complete, explicitly synthetic evidence into an isolated fixture
   runtime and retain its accounting capture in World Model.
2. Submit a second account request with no attachments or structured scope.
3. Retrieve the original evidence, validate scope, calculate components, assemble
   the account and independently check its exact numerical components.
4. Display the saved account in the existing damage-account interface.

To build another account yourself, open `/damage-account` on the demo server and
enter:

> Build a damage account for Fixture Region for September to October 2015 using World Model.

Expected results, in invented CU currency at the declared 2015 price basis:

| Result                                  |           Value |
| --------------------------------------- | --------------: |
| Historical selected social welfare loss | CU21,534,033.40 |
| Avoided damage in the project scenario  |     CU4,570,000 |
| Project cost                            |     CU1,000,000 |
| Net social benefit                      |     CU3,570,000 |
| Benefit-cost ratio                      |            4.57 |

Inspect the physical outcomes, financial incidence, welfare and scenario tables,
exact source references, independent review and execution receipts. The Manager
workspace shows the completed assignments. Source-fire categories remain
explicitly unestimated.

Each launch creates a fresh directory under `.state/damage-demo/`, containing the
input JSON, SQLite task state and `demo-report.json` with the exact results.
Fixture mode and the state override apply only to the demo process. The normal
live server remains separate. This is a deterministic software demonstration;
its inputs are invented and its arithmetic review does not establish scientific
attribution or live-model readiness.
