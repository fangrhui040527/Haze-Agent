# Nightshift automatic chains verification

Plan 4 adds explicit, finite automatic authority to the existing chain grants.
Existing v1 grants remain manual-only after upgrade. A chain's authorized mode
and the server's release readiness are separate facts: a saved automatic grant
does not bypass an unmet live or recovery gate.

See the [27 October recheck](../architecture/nightshift-04-automatic-chains-recheck-report.md)
for current fixes and verification. Redundant chain Pause must preserve a
`no_progress` stop; Resume still needs validated refinement. V2 admission checks
release again after native runtime discovery before saving a grant.

## Admission and controls

Open `/nightshift`. The automatic follow-up checkbox starts unchecked and is
disabled until `GET /api/nightshift/automation/readiness` reports both `released`
and `ready` with validated prerequisite evidence. Unavailable readback keeps the
automatic admission path blocked. A fixture evidence label never establishes
production readiness.

Manual admission continues using `haze.nightshift.chain.admission.v1` with zero
automatic follow-ups. Explicit automatic admission uses v2, a total of at most
four runs, one to three automatic follow-ups within that total, an absolute
lifetime of at most twenty-four hours, and a versioned initial progress record.
The form accepts a bounded permitted purpose, an unresolved instruction and exact
input references. Server-owned identity, current task revisions and immutable
route/grant accounting remain authoritative.

An unchanged retry keeps the original body and idempotency key. Changing the
automatic checkbox, limits or progress creates a new user proposal; it does not
edit an existing immutable grant. Resume controls have no field that can enable
automatic mode or enlarge an allowance. User Continue and automatic successors
share the same total-run and cumulative resource envelope.
A larger allowance requires a separately admitted task and new explicit grant.
The optional **Previous closed grant ID** records historical linkage after that
grant is closed, expired or invalidated; it cannot reopen or enlarge the old
grant. The server verifies the same local identity/workspace and preserves the
link in the immutable admission record.

## Lineage, inbox and release evidence

Expand **Inspect lineage, inbox and progress decisions** on a saved chain. Its
GET-only observer reads `/api/nightshift/chains/:id/automation`. Check:

- Original and remaining grant; admitted, used and authorized follow-up counts.
- The original absolute expiry and the bounded next permitted purpose.
- Initial run, successor, predecessor links, admitting actor and admission mode.
- Required/optional inbox handles, original run, exact candidate references and
  the run assigned to inspect each retained delivery.
- Versioned accepted progress and the last consumed result cursor.
- Machine-readable stop codes, triggering cursors, exact references and remaining
  resources. Untrusted text renders as escaped text.
- The existing wait/capacity panel, including queued Haze capacity and stopped
  authority independently of retained result bytes.

The screen shows local-job privacy and $0 cloud spending separately from Haze
agent-provider model calls, input-byte bounds, output-token bounds and reserved
synthesis/review calls. A low job budget or a reachable daemon is not a Haze
resource grant or evidence acceptance.

The explicit **Submit revised progress** form sends the versioned record through
`POST /api/nightshift/chains/:id/progress` with current revisions and an
idempotency key. A valid refinement identifies changed exact inputs, accepted
outputs, review objections or a changed known failure cause. Merely editing prose,
changing an ID or receiving a higher Nightshift judge score is not progress.
Neither a proposal nor browser polling creates additional authority.

Stopping browser observation does not cancel one job, close a chain or stop the
server. Closing the browser does not admit a successor. Chain/task pause and
Resume preserve counters and absolute expiry; known remote jobs remain observed.
Cancellation requested and remote termination confirmed remain separate states.
An explicitly paused chain freezes manual Continue as well as automatic
continuation. Restore the original chain grant first, then use task Resume within
its original deadline or explicit task Continue after expiry. Neither operation
replenishes that grant or renews its absolute lifetime.

## Automated checks

Run the focused browser contracts and HTTP routing checks:

```powershell
npm --prefix frontend test -- src/features/nightshift
npm test -- tests/unit/nightshift-http.test.ts
npm test -- tests/unit/automatic-chain-runtime.test.ts
```

Browser fixtures cover default opt-out, blocked release, forged release rejection,
bounded v2 admission, controls that cannot enlarge authority, exact lineage and
inbox provenance, escaped stop text, GET-only readback, stopped observation and
unchanged explicit progress retries. These UI fixtures do not establish live
inference quality or successor/capacity invariants.

The injected-provider runtime traces exercise a real Manager and specialist
workflow through one submission, parking, expiry, retained candidate capture,
one linked successor, explicit Manager assignment of the inherited local handle,
controlled result consumption and partial finalization with review still needed.
They also verify that an unreleased server refuses v2 admission and leaves a
manual-only chain manual-only after late result capture.

The installed configuration currently lacks an eligible local text lane. Genuine
Manager, specialist and background-job traces, including an interactive latency
observation, remain live gates. Do not enable production automatic mode from
schema inspection or fixture success, change fleets or download models to
manufacture a successful trace, or relax the local-only/$0 policy.
