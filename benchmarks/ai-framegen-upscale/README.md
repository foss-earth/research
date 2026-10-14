# AI frame generation and upscaling screen

Stage 1 and Stage 2 of the [shared proposal](../../docs/proposals/ai-framegen-upscale.md):
fixed-shape exports, stored PyTorch references, a GPU replay harness and a cost/quality screen
for Practical-RIFE 4.25.lite and RT4KSR x2. The work changes research tools only.

[REPORT.md](REPORT.md) records the recommendations and measurement limits.
[tables.md](tables.md) contains the registered gate values and separate cold starts.
The manifests are [rife-4.25-lite.json](manifests/rife-4.25-lite.json) and
[rt4ksr-x2.json](manifests/rt4ksr-x2.json). Selected numeric evidence is in [results/](results/);
weights, ONNX files, raw tensors and corpus-derived images stay in gitignored `build/`.

## Reproduce

Run from the research repository with the pinned Python environment under
`build/benchmarks/ai-framegen-upscale/work/venv`. The offline environment recipe and package
hashes are in [requirements.in](../../scripts/benchmarks/ai-framegen-upscale/export/requirements.in)
and [requirements.lock](../../scripts/benchmarks/ai-framegen-upscale/export/requirements.lock).
[sources.json](../../scripts/benchmarks/ai-framegen-upscale/export/sources.json) lists the source,
weight and corpus pins, terms and manual retrieval instructions. `fetch.py` imports verified local
copies; it contains no downloader. `fetch-ort-web.mjs` uses the existing npm cache by default.

Set `FOSS_EARTH_RESEARCH_CORPUS` to a read-only folder containing the six
`<panorama-id>/6144.jpg` files. Cache and temporary directories must stay under research `build/`.
Use normal memory pressure, nice 10 and at most four Python threads. These correctness/quality
commands can share the machine within its memory budget; timed blocks require every other
agent and heavy job to pause. The [interference policy](../../docs/validation/benchmark-interference.md)
and [machine timing rules](../../docs/validation/timing.md) define qualification.

```sh
AI_WORK="$PWD/build/benchmarks/ai-framegen-upscale/work"
AI_SCRIPTS="$PWD/scripts/benchmarks/ai-framegen-upscale"
AI_PYTHON="$AI_WORK/venv/bin/python"
AI_PYCACHE="pycache_prefix=$AI_WORK/cache/pycache"

"$AI_PYTHON" -I -B -X "$AI_PYCACHE" "$AI_SCRIPTS/export/fetch.py" \
  --check --corpus-root="$FOSS_EARTH_RESEARCH_CORPUS"
node "$AI_SCRIPTS/fetch-ort-web.mjs"
nice -n 10 "$AI_PYTHON" -I -B -X "$AI_PYCACHE" "$AI_SCRIPTS/export/references.py" \
  --corpus-root="$FOSS_EARTH_RESEARCH_CORPUS" --threads=4
nice -n 10 "$AI_PYTHON" -I -B -X "$AI_PYCACHE" "$AI_SCRIPTS/export/export.py" \
  --profiles=small --precisions=fp32,fp16 --threads=4
nice -n 10 node "$AI_SCRIPTS/run-parity.mjs" --profiles=small --cold-repeats=3
nice -n 10 "$AI_PYTHON" -I -B -X "$AI_PYCACHE" "$AI_SCRIPTS/export/export.py" \
  --profiles=720p,1080p,540p --precisions=fp32,fp16 --threads=4
nice -n 10 node "$AI_SCRIPTS/run-parity.mjs" --profiles=small,720p,1080p,540p --cold-repeats=3
nice -n 10 "$AI_PYTHON" -I -B -X "$AI_PYCACHE" "$AI_SCRIPTS/export/replay.py" \
  --profiles=720p,1080p --corpus-root="$FOSS_EARTH_RESEARCH_CORPUS" --verify
nice -n 10 "$AI_PYTHON" -I -B -X "$AI_PYCACHE" "$AI_SCRIPTS/export/quality.py" \
  --profiles=720p,1080p,540p --precisions=fp32,fp16 --threads=4 --no-sr-diagnostic
```

An export exits nonzero when gate A fails. Valid/static failed graphs have explicit failed-A
receipts and are retained to diagnose B–F; they cannot qualify for timed admission. Every
browser run writes its output folder. Use its final `results/parity.json` for the next command,
and the completed quality run's `results/quality.json` for publication.

```sh
nice -n 10 node "$AI_SCRIPTS/run-timing.mjs" --parity="$AI_PARITY" \
  --corpus-root="$FOSS_EARTH_RESEARCH_CORPUS" --graph-capture=true \
  --capture-parity="$AI_CAPTURE_PARITY"
"$AI_PYTHON" -I -B -X "$AI_PYCACHE" "$AI_SCRIPTS/export/manifest.py" \
  --browser-results="$AI_PARITY"
node "$AI_SCRIPTS/make-tables.mjs" --parity="$AI_PARITY" --quality="$AI_QUALITY" \
  --timing="$AI_TIMING_RESULTS" --capture-parity="$AI_CAPTURE_PARITY" \
  --optimizer-diagnostic="$AI_OPTIMIZER_DIAGNOSTIC" --publish
npm run check:tools
npm run test:source
```

Captured timing requires separate both-case correctness proof on the same graph hashes.
`AI_CAPTURE_PARITY` can point to this benchmark's retained `results/capture-parity.json` for
these exact RT4KSR fp32 exports; `AI_OPTIMIZER_DIAGNOSTIC` points to the retained
`results/optimizer-diagnostic.json`. The recorded cost experiment uses explicit graph capture.
Normal-session functional smoke runs remain diagnostic.

Publication copies selected numeric summaries only. Timing is bounded to 33 seeded rounds or
120 seconds per comparison, with 30 iterations per block, warmup at most 5 seconds, at least
11 accepted pairs and A/A within 5%. The final results retain disturbed blocks and all rejection
reasons. Sustained runs apply only to profiles that pass the complete screen.

## What the harness proves

The browser serves a hash-pinned ONNX Runtime Web 1.30.0 native WebGPU build over an isolated
HTTPS origin through CDP interception. It injects one harness-owned GPU device, reconstructs
and hashes identical float32 inputs, uses GPU input/output buffers, runs WGSL capture/output
conversion, captures ORT's node placement and accounts incremental GPU allocations. No page
request uses a CDN. Both synthetic and natural cases must pass; static operator support alone
does not prove numerical correctness.

The [established model/runtime facts](../../docs/ai-framegen-upscale-models.md) explain input
padding, the RT4KSR reparameterization and the runtime's timing semantics. Gates A–I were
registered before browser results and remain unchanged. The source fixture
[aiFramegenUpscale.test.mjs](../../fixtures/aiFramegenUpscale.test.mjs) exercises pure gate,
statistics, ordering, telemetry-parser, routing and tensor-builder behavior without a browser
or GPU.
