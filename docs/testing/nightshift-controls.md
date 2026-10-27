# Nightshift control demo

Run from the repository root with Node 24. No build or additional dependencies
are required. This standalone demo does not connect Nightshift to Haze tasks or
modify the application's SQLite state.

## Offline fixture assertions

```sh
npm run nightshift:demo
```

The default mode uses explicitly synthetic daemon replies and a virtual clock.
Assertions exercise different attempt counts, fleet forwarding, repeat rounds,
file-change deduplication, queued work, unknown submission outcomes, timeout
cancellation, NDJSON parsing and invalid input. Fixture success establishes the
demo's control behavior; it does not establish live Nightshift readiness.

## Inspect the installed runtime

```sh
npm run nightshift:demo -- --inspect
```

This reads `ns schema` and `ns status` without generating anything. Windows uses
`%LOCALAPPDATA%\Nightshift\cli\ns.mjs` with the app's bundled Node when available;
other platforms use `ns` on PATH. Override with `--cli PATH`. Arguments are passed
directly, without a shell. The CLI handles its own runtime token; the demo never
reads or prints it.

An unreachable daemon is reported as `schema-only`, not live success. Start
Nightshift and configure its lanes in the cockpit before running live examples.

## Run small live jobs

```sh
# Two sequential jobs requesting different attempt counts.
npm run nightshift:demo -- --live --n 2,4

# Replace YOUR_FLEET_ID with an existing configured fleet ID.
npm run nightshift:demo -- --live --n 2 --fleet YOUR_FLEET_ID

# Repeat twice, waiting 60 seconds after the preceding round completes.
npm run nightshift:demo -- --live --n 2 --trigger repeat --runs 2 --every-seconds 60

# Establish a baseline, then generate once when this file's bytes change.
# Edit the file from another terminal while the watcher is running.
npm run nightshift:demo -- --live --n 2 --trigger change --watch README.md --runs 1 --every-seconds 5 --watch-seconds 180

# Submit queued jobs for Nightshift's quiet window, then return immediately.
npm run nightshift:demo -- --live --n 2 --window quiet
```

Immediate jobs run sequentially and wait for a recorded terminal state. A
completion timeout or interruption requests cancellation of the known active
demo job; a cancellation acknowledgement does not prove the remote compute has
stopped. Quiet-window submissions intentionally remain queued after the script
exits. Inspect those job IDs in Nightshift to follow or cancel them.

The default prompt is a synthetic report-writing exercise with no measurements
or uploaded evidence. Change watches hash a file of at most 1 MiB; they do not
upload it or imply that generated text analyzed its contents. The watch deadline
bounds the whole change-trigger session, including time spent generating.

The demo defaults to `--privacy local-only --max-spend 0 --budget low`. It does
not start models, switch fleets or add cloud credentials. Cloud use requires
both an explicit privacy selection and positive `--max-spend`. The demo limits
each count to 1–64 attempts, at most four counts, three rounds and twelve jobs.
These are demo limits; the running engine may impose additional constraints.

Each invocation writes a report and append-only submission journal to a unique,
gitignored `tmp/nightshift-controls-*/` directory. Intent is recorded before each
submission. A failed or unacknowledged submission stops the demo without retry;
use `ns job list` and the journal to reconcile it before resubmitting. Nightshift
judging outcomes are recorded separately from execution completion and confer
no Haze evidence acceptance.

## Which component owns each control

| Control                | Demo behavior                                                                |
| ---------------------- | ---------------------------------------------------------------------------- |
| Attempt count          | Native `generate --n N`; total attempts, not concurrent lanes                |
| Fleet selection        | Native `--fleet ID`; select an existing fleet                                |
| Individual lane setup  | Configure in Nightshift's cockpit/admin interface; no invented `--lane` flag |
| Judge and budget       | Native `--judge` and `--budget`, checked against installed schema            |
| Privacy and spending   | Native `--privacy` and `--max-spend`                                         |
| Immediate/quiet window | Native `--window now\|quiet`                                                 |
| Repeat interval        | In-process demo loop; not a native Nightshift schedule                       |
| File change            | In-process hash watcher; not a native Nightshift watcher                     |

Repeat timing starts after a round finishes, so it is a delay between rounds,
not a fixed wall-clock cadence. Demo timers disappear when the script exits.
Persistent schedules, clock-time triggers, durable restart deduplication and
application task integration remain future Haze work. Native Nightshift
schedules/watchers can instead be configured in its cockpit; they are not
created by this script.

References: [Nightshift CLI](https://meterless.ai/cli.html),
[lanes and fleets](https://meterless.ai/help.html#lanes),
[native schedules](https://meterless.ai/help.html#auto). The installed
`ns schema` remains the authority for CLI capabilities in that build.
