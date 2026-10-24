# Crew scheduling inside generic chat

The dashboard remains the generic frontend. Its default examples now include the fictional Klang crew request for 25 October 2026, 08:00–12:00 Asia/Kuala_Lumpur. Choosing it or typing an explicit fictional Klang crew scheduling request returns a structured schedule comparison in the same conversation.

## Implemented route

1. `ChatPanel` sends an `AskRequest` through `SchedulingAgentService`. Other haze questions still use the existing general service.
2. `GET /api/demo/crew-scheduling/sample` issues an exact demo-local planning reference.
3. `POST /api/demo/crew-scheduling/agent-runs` receives the shared `haze.run.v2` request: programme, `plan_outdoor_work`, problem, bundle reference and optional explanatory query. The query does not change accepted facts.
4. The local harness resolves the immutable bundle and runs the existing generator and independent checker from `app/demo/review-trace.ts`.
5. A bounded LangGraph workflow executes Manager intake, HazeOps, World Model, H-Mem, EvidenceCritic, WorkerShield and Manager delivery. Four domain roles make five real model calls. World Model stores and reads the fictional comparison using its pinned engine; H-Mem mines and recalls run-scoped fictional constraints. No historical episodes or external evidence are invented.
6. The server sends newline-delimited JSON (`application/x-ndjson`): actual `AgentEvent`s followed by a validated result frame containing the unchanged `haze.demo_chat.v1` scheduling transport, controlled paragraphs and separate live execution receipts. The office renders these events as they arrive. No scripted delays are used.
7. Each model selects unique IDs from the currently available checked facts. Unknown, duplicate, malformed or premature engine fact selections fail the role. The app supplies all displayed words from those checked facts; raw generated text cannot invent times, calculations, references or approval. The final scheduling values and selection remain the independent checker's output.
8. The browser checks the entire stream lifecycle, exact run/reference identity, completion and all six receipts before rendering a completed answer. Cancelling disconnects the stream and aborts the in-flight model request. Failed or unavailable models produce an error without a simulated answer.

The transport envelope does not replace the shared planning, run or result contracts. Live role receipts are separate from the historical fixture's offline handoffs and integration fields. Vite middleware provides these routes for both `npm run dev` and `npm run preview`. Install root and frontend dependencies and build the pinned engines as described in `frontend/README.md`.

Configure `HAZE_PROVIDER=nvidia` with `NVIDIA_API_KEY` (or the existing OpenAI-compatible settings) in the ignored repository-root `.env`. The local Vite server reads these values server-side; no credential is sent to the browser. `SAMPLE_MODE=true`, offline mode or a missing key explicitly blocks model execution. Restart the server after changing provider settings. There are at most four concurrent live runs, bounded request/response sizes and a sixty-second deadline per model call.

The original `POST /runs` → `GET /runs/{id}` route remains a local arithmetic-only fixture endpoint for offline checks. Chat uses `/agent-runs` and never silently falls back to that endpoint. Agent engine stores are isolated per run and removed after execution; live receipts remain in the browser's historical chat snapshot.

## Display and decision boundaries

- Baseline, selected candidate and comparison-only plans have distinct labels. Both §23 alternatives are available as timeline disclosures; shared work appears once with both worker IDs.
- Times use the bundle's timezone rather than the browser's timezone. Exact times, duration, location and fixed/movable labels accompany the bars. Occupancy gaps and overlaps have text diagnostics.
- Assessment, input origin, validation/evidence issues, revisions and immutable references remain inspectable.
- No selected plan retains the baseline. Invalid inputs/results and missing coverage cannot show numerical recommendations.
- All scheduling outputs remain fictional historical-harness drafts for human review. Publication and operational recommendation are disabled. The office now shows real model-role and memory-service execution, with provider/model and six role receipts inspectable in chat.
- Real crew requests ask for a validated planning bundle. Chat text is not silently accepted as evidence or turned into sample crew facts.

## Local limitations and canonical replacement

This is an explicitly labelled contract fixture adapter, not the canonical Evidence & Inputs import/acceptance boundary. The local HTTP routes accept loopback, same-origin requests only; records are bounded, in-memory and immutable. Restarting the server loses run records. Saved chat answers remain labelled read-only historical snapshots.

Keep the dev or preview process running while using its page. A previously opened page can keep displaying cached dashboard data after the server stops, but it cannot load scheduling code or submit runs. After rebuilding or restarting the preview, reload the page before sending another request. Code-loading failures are reported separately from rejected result contracts.

The future canonical flow is controlled import/validation and acceptance → immutable accepted `bundle_ref` → `POST /run` → `GET /runs/{id}` → `haze.result.v2`. Those services, authentication, capability proof and real evidence are still needed. Demo references must never be sent to the canonical run endpoint. A static-only deployment of `frontend/dist` needs a server adapter before this sample route can run.

The harness supports `GET /api/demo/crew-scheduling/sample?case=missing-evidence` for boundary testing. This case is not another default user example. The no-selected comparison-only UI fixture is hypothetical test data and is never offered as an operational result.

## Focused verification

- `tests/unit/demo-chat.test.ts`: HTTP request/response flow, §23 values and alternative selection, missing coverage, malformed/draft/stale inputs, exact baseline/reference identity, loopback/origin/body protections, immutable bounded records.
- `tests/unit/demo-agent-run.test.ts`: model role order and fact selections, checked-result integrity, actual pinned engine readbacks, missing coverage, failures and cancellation.
- `tests/unit/demo-agent-http.test.ts`: live events before model completion, six role receipts, configuration blocking, failed execution and disconnect cancellation.
- `tests/unit/agent-model.test.ts`: provider configuration, bounded responses, completion validation, timeouts, cancellation and secret-safe errors.
- `frontend/src/services/agents/SchedulingAgentService.test.ts`: generic routing, real-input requirement, exact request/result identity, split UTF-8 streams, lifecycle validation, malformed receipts, abort races, failed and unavailable agents.
- `frontend/src/features/chat/ScheduleResult.test.ts`: timezone/date rollover, shared IDs, duplicate work suppression, occupancy gaps/overlaps, both alternatives, missing coverage, no-selected baseline retention and corrupt persisted results.
- `frontend/src/features/agent-office/officeModel.test.ts`: local input checks leave every named agent idle; live `executionKind: agents` events restore the existing per-role behavior.

Browser verification exercises the default example, its actual local API result, timeline disclosures and responsive layout. Production build splits scheduling schemas and rendering out of the generic initial bundle. CI now builds and tests the frontend alongside the existing root contract and demo checks.

### Arithmetic-only route verification, 24 October 2026

| Command / interaction                               | Result                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                     | Passed: pins, formatting, typecheck, ESLint, root build, contract and demo checks, 171 unit tests, 21 upstream engine checks |
| `npm --prefix frontend run build`                   | Passed; scheduling schema and view are separate lazy chunks                                                                  |
| `npm --prefix frontend test`                        | 53 tests passed, including unavailable scheduling code                                                                       |
| `git diff --check`                                  | Passed                                                                                                                       |
| Impeccable detector on changed chat UI              | No findings                                                                                                                  |
| Edge: default example in Vite dev and built preview | Returned the checked fictional result in chat; 440 baseline, 340 selected candidate; both alternative timelines present      |
| Preview HTTP missing-evidence request               | `insufficient_evidence`, null selected plan, null quantified values, baseline retained, publication disabled                 |
| Responsive DOM check at 360 CSS pixels              | No page or conversation horizontal overflow; chat and office stack                                                           |

Local execution used Node 24.11.0 with npm 11.8.0; CI remains pinned to Node 24.22.1. PostgreSQL integration was not rerun because this change does not touch persistence. No canonical backend, real evidence, model agent execution, approval or publication was exercised.

### Live office integration verification, 24 October 2026

- Root checks passed: source pins, formatting, TypeScript, ESLint, build, unchanged domain contracts/review package, 233 unit tests and 21 upstream engine checks.
- Frontend production build and 75 tests passed, including streamed progress, identity validation, UTF-8 boundaries, cancellation, failed providers and saved execution receipts.
- The existing `localhost:5173` dashboard completed an actual NVIDIA run with `nvidia/nemotron-3.5-lightning-30b-a3b`. Chat displayed the controlled fact-based explanation, provider/model, four model-role receipts and two pinned-engine receipts; the office showed completed handoffs and Manager delivery.
- World Model recorded and read back the fictional comparison with a nonempty audit. H-Mem recorded and recalled run-scoped fictional constraints with a nonempty audit. The isolated per-run stores were removed after completion.
- The displayed independent comparison remained baseline 440, selected candidate 340, reduction 100 (22.73%). Human review remained pending, with publication and operational recommendations disabled.
- This verifies the bounded fictional live workflow. It does not establish canonical admission, real evidence, operational planning or publication capability. General haze chat remains the labelled mock service.
