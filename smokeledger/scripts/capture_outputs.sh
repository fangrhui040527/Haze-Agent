#!/usr/bin/env bash
# Re-captures output_examples/ from real offline executions (fresh state each family).
# Outputs are evidence of what ran; the app never reads them at runtime.
set -euo pipefail
mkdir -p output_examples
for f in input_examples/*.json; do
  name=$(basename "$f" .json)
  tmp=$(mktemp -d)
  SAMPLE_MODE=true STATE_DIR="$tmp" LOG_DIR="$tmp/logs" node run.mjs --input "$f" --out "output_examples/$name.output.json" > /dev/null || true
  cp "$tmp"/logs/trace-*.jsonl output_examples/ 2>/dev/null || true
  rm -rf "$tmp"
  echo "captured $name"
done
