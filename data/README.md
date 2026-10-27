# Static data

Keep small, public reference datasets or their download instructions here.
The three [synthetic sample scenarios](sample-scenarios/README.md) support the
full configured-model agent loop with `SAMPLE_MODE=true`. They contain source
inputs only. Requests live in `input_examples/example_1.json` through
`example_3.json`; fresh generated results go to matching files in
`output_examples/`.

The current checkpoint examples need no external dataset; their JSON inputs live
in `input_examples/` and matching results live in `output_examples/`.

Store runtime databases and engine state in `STATE_DIR` (normally `.state/`).
Do not put credentials, private datasets, or generated state in this directory.
