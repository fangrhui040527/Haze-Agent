#!/usr/bin/env bash
# The whole product on the FICTIONAL sample episode, offline (embedded DB, no Docker needed).
set -euo pipefail
export SAMPLE_MODE=true STATE_DIR=${STATE_DIR:-.state-demo} LOG_DIR=${LOG_DIR:-.state-demo/logs}
sl() { npm run -s sl -- "$@"; }
sl db:init
echo; echo "=== 1. Outdoor crew plan (four roles, critic gate) ==="
node run.mjs --input input_examples/example_1.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.status, r.conclusion_status);console.log(r.output.summary)})'
echo; echo "=== 2. School outlook for parents ==="
sl forecast --town "Batu Pahat" --now 2026-10-05T12:00:00Z --hindsight
echo; echo "=== 3. Backtest ==="
sl replay --town "Batu Pahat" --from 2026-10-04T00:00:00Z --to 2026-10-06T12:00:00Z --every 6 --hindsight
echo; echo "=== 4. Where did the smoke come from? ==="
sl trace --town "Batu Pahat" --at 2026-10-06T18:00:00Z
echo; echo "=== 5. Warn -> record -> re-check -> escalate ==="
sl scan --now 2026-10-05T12:00:00Z
CASE=$(sl cases | awk '$2=="DETECTED"{print $1; exit}')
sl draft "$CASE" --now 2026-10-05T13:00:00Z
sl approve "$CASE" --yes --now 2026-10-05T14:00:00Z
sl recheck --now 2026-10-06T15:00:00Z
sl cases
