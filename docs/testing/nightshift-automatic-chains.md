# Nightshift automatic chains verification

Plan 4 adds explicit, finite automatic authority to the existing chain grants.
Existing v1 grants remain manual-only after upgrade. A chain's authorized mode
and the server's release readiness are separate facts: a saved automatic grant
does not bypass an unmet live or recovery gate.

See the [27 October recheck](../reports/nightshift/nightshift-04-automatic-chains-recheck-report.md)
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
automatic follow-ups. Explicit automatic admission uses v2 and a versioned
initial progress record. Production readiness v2 publishes the supported scope:
`cloud-ok`, two total runs, one automatic follow-up, one concurrent native job,
two jobs total, one attempt per job, and a thirty-minute absolute chain lifetime.
Existing task, token and operation limits still apply. Cloud jobs use the
runtime's uncapped monetary policy; the application does not claim an enforceable
dollar ceiling. Admission and successor dispatch both revalidate release scope.
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

The screen shows each candidate grant's saved privacy and spend policy separately
from Haze agent-provider model calls, input-byte bounds, output-token bounds and reserved
synthesis/review calls. A low job budget or a reachable daemon is not a Haze
resource grant or evidence acceptance. New candidate grants default to cloud-ok
with no monetary cap; existing local-only grants retain $0 cloud spend. This
policy choice does not release automatic follow-ups or satisfy its live gates.

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

## Native cloud verification and production evidence

No local model installation is required for the bounded cloud lane. Inspect the
installed native contract without submitting work, or explicitly request one
genuine native job:

```powershell
node --env-file-if-exists=.env scripts/verify-nightshift-jobs.mjs --privacy cloud-ok
node --env-file-if-exists=.env scripts/verify-nightshift-jobs.mjs --live --privacy cloud-ok
```

Both commands retain a report and preserve the selected privacy/spend policy.
Inspection remains the default. Live completion requires the actual native
lane/model provenance, one remote acknowledgement and restart readback. A native
judge result remains an unreviewed candidate.

The isolated lifecycle verifier exercises a genuine cloud job under a provisional
trusted policy, capacity release while parked, completion/wakeup, one opted-in
successor, explicit candidate consumption and restart preservation. It also makes
one genuine NVIDIA Ultra interactive call while native work is active and applies
the 90-second latency gate:

```powershell
npm run build
node --env-file-if-exists=.env scripts/verify-nightshift-live.mjs
node --env-file-if-exists=.env scripts/verify-nightshift-live.mjs --live --output .state/nightshift-live-verification
node --test scripts/nightshift-verification-support.test.mjs
npm test -- tests/unit/nightshift-release.test.ts
```

The lifecycle Manager and specialist decisions are scripted, and their receipts
are synthetic. Actual provider calls and scripted decisions are counted
separately in the retained report. This verifies lifecycle behavior rather than
strict role quality or a scientific demonstration. The state directory is unique
to each execution. Its provisional policy cannot become production evidence;
the verifier checks that no production manifest was installed and ordinary
production loading remains blocked. No command above publishes a release.

Production reads only `<state directory>/nightshift-release/current.json` and
its bounded, content-addressed evidence files. The trusted publisher validates
every gate before atomically replacing that manifest. Browser and task input
cannot install release evidence. Evidence binds the current build, instructions,
registered contracts, exact strict Ultra routes, reviewed installation and ready
cloud roster. Any changed identity invalidates the corresponding release.

Role evaluation evidence must retain the exact response bytes and matching
hashes, the complete current frozen suite, and both baseline and candidate
attempts for every scenario. The loader reconstructs probe inputs from current
instructions, revalidates production action contracts and frozen outcome/reference
criteria, and enforces actual non-synthetic response receipts, output bounds and
latency. Candidate strict roles use the exact Ultra identity; a comparison
baseline retains its own pinned identity. A separate reviewer must inspect these
exact outputs. Full PM2.5, supplied-data damage accounting and
supplied-data reduction planning demonstrations are required. Partial completion
or missing real data cannot release production. Domain slots must retain their
complete report bytes, tasks, results, exact artifact closure, independent review
artifacts and genuine model attempts. Claimed booleans or nonexistent artifact
hashes cannot replace those records. Cloud generation, wait/wakeup,
latency, automatic-chain and restart evidence must all identify the same task,
chain and native job, including the original remote identity after restart.

The trusted assembler takes a reviewed directory with the fixed evidence slot
filenames and validates it against identities discovered from the current server
configuration. Validation is read-only by default:

```powershell
node --env-file-if-exists=.env scripts/assemble-nightshift-release.mjs --evidence .state/reviewed-release-bundle --state .state/server
```

It reports named missing gates, and writes no release files unless a complete
bundle passes every validation and publication is explicitly requested with
`--publish`. Publication rechecks current identities, atomically replaces the
manifest, then verifies ordinary production loading without policy injection.
Keep publication blocked while the real damage package or independent live
review is missing.

Genuine role evaluation and independent review remain separate gates even when
the provisional lifecycle verifier passes. Do not enable production automatic
mode from schema inspection, fixture success or the provisional report, change
fleets or download models to manufacture a trace, or rewrite historical
local-only/$0 grants.
