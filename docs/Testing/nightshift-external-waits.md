# Nightshift external waits verification

Plan 3 extends the existing job supervisor with durable assignment waits and
task-capacity admission. It does not enable automatic successor runs. A retained
remote result and permission to execute are separate facts.

Task admission can explicitly request the optional `nightshift_tools` array in
`haze.task.request.v3`, containing only `nightshift.submit`, `nightshift.result`
and `nightshift.cancel`. Omitting that field grants none of those tools. The
selected registered assignment must independently declare each tool it needs;
registration alone does not authorize an effect. A separate bounded chain grant
must already exist before the specialist submits work.

The chat intake also offers an unchecked **Allow Nightshift candidate tools for
this task** option. It requests the three tools only for that submission, resets
after sending and preserves the original tool grant on an unchanged retry. It
does not create a chain grant or authorize automatic successors.

## Read-only browser checks

Open `/nightshift/:jobId` for an acknowledged job with an external dependency.
The existing job section retains its original task, chain, remote handle,
provenance, progress, output and cancellation receipts. The external-waits panel
reads `GET /api/nightshift/tasks/:taskId/waits` and shows:

- Whether the task holds a Haze permit, independently of its public task status.
- External compute, Haze capacity, user or stopped wait reasons.
- Queue state and the first eligible sequence.
- Exact run, generation, objective and assignment revisions for each dependency.
- Required job handles, terminal delivery state, event cursors and exact retained
  output references.

The Manager workspace and task report show the same task-level panel. Job deep
links filter dependencies and deliveries to that job. Following another job link
does not attach the previous job to a new assignment.

Stop browser observation and confirm that the panel reports observation stopped.
Resume observation or refresh to reconnect. These requests are GET-only; they do
not cancel jobs, close grants, consume results or start execution. The separate
job and chain controls keep their existing mutation and revision requirements.

Pausing a chain also pauses its current task result consumers. Resume the
original chain grant first, then use ordinary task **Resume** to request Haze
capacity and resume execution. Restoring the chain grant alone leaves the task
paused. Both controls preserve the existing grant, charges and original run
deadline; neither control proves that remote compute stopped.

For a full-capacity scenario, observe a retained delivery alongside `Waiting for
Haze capacity`. Its presence must not imply that the specialist has executed.
For stopped or expired work, check the recorded reasons and use explicit task
controls. An expired run requires explicit Continue within the existing remaining
chain grant; reading this page cannot create a successor.

All output and recorded reasons render as escaped text. A failed required job
must show that an explicit failure, partial-result or replanning decision is
needed. Cancellation acknowledgement remains distinct from confirmed remote
termination.

## Automated browser contract coverage

Run:

```powershell
npm --prefix frontend test -- src/features/nightshift
npm test -- tests/unit/nightshift-http.test.ts
npm test -- tests/unit/nightshift-wait-runtime.test.ts
```

The external-waits browser tests cover validated GET-only reconnects, separate
wait reasons and permit state, FIFO sequence readback, exact revision and artifact
references, job-specific filtering, escaped reasons, failure-decision guidance
and stopped observation. HTTP tests reject mutations and unsupported query keys
on the new read-only route. These fixture checks do not establish live inference
readiness or runtime capacity invariants by themselves.

The isolated runtime tests exercise both completion orders, task and chain
pause with late capture and explicit Resume, correction with assignment
supersession, and run expiry with explicit same-chain Continue. Their providers
are synthetic and do not make external requests.

## Live gate

A genuine specialist submit/wait/result trace and an interactive-inference
latency observation while a local background job runs are required live evidence.
Do not describe a fixture or an acknowledged but refused local-only submission as
successful generation. Preserve the local-only and zero-cloud-spend policy and
record unavailable local compute as an unmet gate. Do not change installed
fleets, download models or relax privacy to manufacture a successful trace.
