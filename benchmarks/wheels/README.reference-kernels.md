# Proposed wheel-model reference kernels

Run from the FOSS Earth root:

```sh
node benchmarks/wheels/run-reference-kernels.mjs
```

The script writes `results-reference-kernels.json` and measures four small,
deterministic **reference kernels**: coupled rigid wheels, a combined-slip brush
tire, and the brush tire with either 8 or 32 local compliance cells per wheel.

This is deliberately narrower than an aircraft performance benchmark. It has no
JSBSim/WASM call, terrain query, collision narrow phase, renderer, audio graph,
browser scheduler, or device power measurement. The compliance field is bounded
and has no claim to be a deformable tire/soil solver. Its useful purpose is to
show which additions scale with a few scalar states and which scale with contact
cells, before anyone claims a precise whole-game cost.

The production gate remains an integrated benchmark with the same C172 approach,
terrain workload, audio state and render load on each target device. See the
[wheel simulation proposal](../../docs/proposals/wheel-simulation-options.md).
