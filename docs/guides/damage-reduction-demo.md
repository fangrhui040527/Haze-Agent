# Damage reduction browser demo

Open the regular frontend and choose **Demos → Damage reduction**, or go
directly to `/demos/damage-reduction`. The completed preview, target decision,
conditional plan and independent reviews are bundled with the frontend.
Expand a source and choose **Inspect recorded source** to read its exact saved
content. No separate demo command, task server or model provider is needed.

The page is a read-only recording of a synthetic fixture run. Reviews and
eligibility describe the captured run, with no live evidence revalidation.
Use **Create your own planning preview** to open the normal workspace.

## Execute a fresh demo workflow

Run this from the repository root with the pinned Node/npm versions and the
root and frontend dependencies installed:

```sh
npm run reduction:demo
```

Open the completed-preview URL printed by the command. Keep the process running
while browsing; Ctrl+C stops it. Port 5175 is the default, so the account demo
can run alongside it on port 5174. Set `HAZE_REDUCTION_DEMO_PORT` to use another
port. The demo needs no model provider or Docker services.

The launcher imports explicitly synthetic residual estimates through the real
artifact API, submits a preview task, and waits for calculation, conditional
planning and independent arithmetic and plan reviews. It opens the existing
damage reduction interface with the completed result at
`/damage-reduction/tasks/TASK_ID`.

Expected results for the invented alert-service scenario:

| Result                        | Value             |
| ----------------------------- | ----------------- |
| Ordinary-management damage    | 1,000 person-days |
| Intervention damage           | 880 person-days   |
| Absolute reduction            | 120 person-days   |
| Relative reduction            | 12%               |
| Target                        | At least 10%      |
| Target met by supplied values | Yes               |
| Arithmetic and plan reviews   | Supported         |
| Plan                          | Conditional       |

Inspect **Target**, **Assessment** and **Conditional plan**, including exact
source references, reviews and unresolved prerequisites. Service costs,
authorization, trigger/action rules and delivery capacity still require inputs.
The example remains explicitly synthetic and scientifically unqualified, with
no delivered intervention or achieved reduction.

To run the example interactively:

1. Choose **Create another preview**, or open `/damage-reduction` on the demo server.
2. Choose **Load synthetic engineering example** to import and fill the inputs.
3. Choose **Create conditional preview** to run and review another saved task.

Each launch creates a fresh directory under `.state/damage-reduction-demo/`,
containing `synthetic-input.json`, isolated SQLite task state and
`demo-report.json` with the request, completed task, governed preview and exact
artifacts. Fixture mode, state location and the same-origin frontend API override
apply only to this process. The normal live server and damage account demo keep
their own state.
