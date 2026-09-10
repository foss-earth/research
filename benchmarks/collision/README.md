# Finite collision ray benchmark

Run from the foss-earth repository root with installed dependencies:

```sh
node benchmarks/collision/run.mjs
```

No server, browser or downloads are needed. Vite compiles the current production
query alongside its unmodified version from commit
`cd84c60998cb4be4c71cce3f5a60f56292ac20dd` (that Git object must be available).
Temporary compilation output stays in ignored `.cache/`. The command writes
`results.json`; pass an output path to retain another run.

Both implementations receive the same 5 m rays and Babylon NullEngine meshes.
The first two fixtures contain eight visible grids, each with 32,768 triangles,
100–800 m beyond the ray origin. The second adds a real collision 3 m away. The
control contains one dense grid within reach, so the exact triangle scan remains
necessary. Hit and miss results are checked before timing. Each path warms for
100 queries, then 21 rounds alternate path order and average 10 queries per round.

Measured on Apple M5, Node 26.0.0, Babylon 8.56.2, macOS arm64:

| Scenario | Baseline median/query | Current median/query |
|---|---:|---:|
| Dense distant geometry; no reachable hit | 4.122 ms | 0.00229 ms |
| Dense distant geometry plus nearby collision | 3.623 ms | 0.00437 ms |
| Dense nearby geometry control | 0.44705 ms | 0.44776 ms |

The JSON includes environment versions, source hashes, timing method and results.
This synthetic CPU measurement isolates work avoided by finite bounding tests.
It measures no GPU rendering, streaming, browser frame pacing, power or game FPS.
The control illustrates the remaining cost of scanning triangles inside a nearby
mesh; this change preserves Babylon's exact triangle picker.
