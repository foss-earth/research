# Terrain performance experiments — 2026-09-07

These are isolated experiments, not a replacement terrain implementation. No
application source, package manifest, server, or browser session was changed.
The user will handle in-game testing. All times below are CPU measurements on an
Apple M5, Node 26.0.0, macOS arm64. GPU frame time and power consumption were not
measured.

## Findings

Square and hexagon-center sampling have similar CPU costs in these local regular
grid prototypes. Hex sampling sometimes needs fewer samples for the same chosen
vertical-error threshold. The evidence does **not** establish that square grids
are intrinsically faster, or that a complete adaptive spherical hex hierarchy
would outperform square tiles.

The much larger measured costs were in the checkpoint application's dense geometry,
continuous vertex updates/seam processing during refinement, and scene raycasts.
Changing the sample lattice alone would leave these costs in place.

### Checkpoint application code: nine adjacent loaded tiles

The experiment imports the actual terrain mesh builder, refinement functions, and
surface query, using Babylon's NullEngine. Repeated runs gave:

| CPU operation | LAX / LA hills, 128 subdivisions per tile | Rainier, 64 subdivisions per tile |
|---|---:|---:|
| Current scene raycast, per height query | 0.687–0.694 ms | 0.225 ms |
| Prototype directly addressing the same mesh triangles, per query | 0.000227–0.000273 ms | 0.000267 ms |
| Morph positions on nine tiles, one pass | 3.69–3.74 ms | 0.90 ms |
| Stitch nine tiles, one pass | 1.30–1.64 ms | 0.44–0.45 ms |
| Morph + stitch twice, as the active-refinement update path does | 9.77–10.03 ms | 2.73–2.75 ms |
| Construct one current terrain mesh | 1.03–1.06 ms | 0.30 ms |

The two animation passes occurred while refinement was active, not continuously on
fully settled terrain. The checkpoint runtime called `animateTerrain()` before and
after tile selection. Each active pass processed every tile in its displayed coverage,
including tiles outside the camera frustum. This benchmark uses only nine tiles;
it does not extrapolate a full game's frame time from that small scene.

The direct-query prototype first calculates the grid cell, then intersects its
actual ECEF triangles. It checks nearby cells if necessary and calculates height
and normal. Across 219 checked points in three fixtures, including internal grid
boundaries, heights agreed with the original scene query within 0.000024 m. This
comparison was repeated. This is agreement between algorithms, not geographic
accuracy. The prototype assumes a known tile with no transformed world root; a
complete consumer needs tile selection, input checks, floating-origin handling,
and mixed-LOD boundary validation. No general scene raycast was replaced in this
checkpoint measurement.

### Stage A implementation: same nine-tile fixture

Stage A1 removes the duplicate refinement/seam pass without changing density or
the 1.2-second transition. The repeated run recorded 5.08–5.10 ms at LAX/LA hills
and 1.38 ms at Rainier, roughly half of the two-pass checkpoint cost.

Stage A2 replaces routine raster `surface.sample()` with an index of adopted mesh
triangles. It reads the current position buffer and uses a restricted neighboring-
patch check only for exceptional misses. On the same CPU-only setup, its median
cost was 0.88–0.94 µs/query and sampled P95 was 1.08–1.17 µs/query. It agreed
with the prior raycast to within 0.00003 m across the fixture queries; no
restricted fallback was taken. This does not measure browser frame time, GPU work,
texture decode or actual power use. See `results-stage-a2-final.json`.

NullEngine does not perform GPU uploads or rendering. The timings exclude image
decode, texture uploads, shaders, actual frame pacing, and the full game scene.
They identify expensive CPU paths, not the complete cause of observed lag.

### Current tile planner

For an LA view at latitude 34.12, longitude -118.32, heading 45 degrees, USGS
Imagery Topo, and `zoomMeters = 500`, the real planner requests:

- 187 leaf terrain tiles and 57 parent records.
- 4,994,360 triangles / 2,539,491 vertices in those leaves if fully loaded.
- Approximately 0.037–0.039 ms for the pure desired-tile selection function.

`zoomMeters` is the renderer's selection parameter, not aircraft altitude. The
triangle count is demanded geometry **before frustum culling**, not observed
drawn triangles. Parent/fallback meshes and cached former tiles add storage beyond
the leaf count. The benchmark exposes private planner functions only inside its
temporary bundle; production exports and source files are unchanged.

### Local sample layouts

Four layouts were compared: fixed-diagonal square, alternating-diagonal square,
hexagon-center/equilateral-triangle lattice, and that lattice rotated 90 degrees.
All store Float32 heights and interpolate their indexed triangles. All receive
the same real source data and evaluation coordinates. There is no object or H3
index per sample in the hex prototype.

At approximately 4,500 allocated samples per patch, across six datasets and two
sequential benchmark runs:

| Layout | Samples including border padding | Build local arrays/indices | Direct local query |
|---|---:|---:|---:|
| Square, fixed diagonal | 4,489 | 0.047–0.053 ms | 8.8–11.5 ns |
| Square, alternating diagonal | 4,489 | 0.046–0.052 ms | 7.9–8.9 ns |
| Hex centers | 4,536 | 0.046–0.052 ms | 8.0–10.1 ns |
| Hex centers, rotated | 4,536 | 0.046–0.053 ms | 8.0–10.8 ns |

The nanosecond values are amortized over batches of 4,096 local queries. They
exclude latitude/longitude conversion, globe geometry, tile lookup and normal
calculation. These microbenchmarks do not justify a universal speed ranking.
Build measurements include allocation, resampling, and index generation, but no
Babylon mesh, ECEF conversion, normals, or GPU work. They are not directly
equivalent to the current application's mesh-construction measurement.

### Samples needed to meet selected error limits

A finer sweep checked 61 density settings per layout per dataset, so the result
does not depend solely on large jumps between grid sizes. The table gives the
smallest tested allocated sample count meeting each selected P95 absolute-height
error threshold, using the fixed-diagonal square and unrotated hex layouts:

| Fixture | Approximate tile width | P95 error limit | Square samples | Hex samples | Hex sample difference |
|---|---:|---:|---:|---:|---:|
| LAX | 1.01 km | 0.25 m | 1,089 | 1,020 | 6% fewer |
| MSP | 0.87 km | 0.25 m | 1,849 | 1,886 | 2% more |
| LA hills | 2.02 km | 3 m | 8,649 | 7,708 | 11% fewer |
| Rainier | 6.69 km | 25 m | 2,809 | 2,640 | 6% fewer |
| Grand Canyon | 7.90 km | 25 m | 15,625 | 13,392 | 14% fewer |
| Alps | 6.82 km | 25 m | 6,889 | 5,976 | 13% fewer |

These thresholds compare prototypes; they are **not proposed flight-safety or
terrain-quality acceptance limits**. P95 means 5% of evaluated points have greater
error. For example, at the Grand Canyon threshold above, maximum sampled error
was 85.5 m for square and 107.6 m for hex. Peak preservation therefore needs its
own requirement. Orientation also affects results. The raw files include RMSE,
maximum sampled error, other thresholds and both alternate orientations.

## Method and limits

- Six 512×512 Mapterhorn Terrarium tiles: LAX, MSP, LA hills, Rainier, Grand Canyon,
  and the Alps. Source URLs and SHA-256 hashes are stored in the layout results.
  [Mapterhorn attribution](https://mapterhorn.com/attribution/).
- Reference heights are bilinear samples of decoded source pixels, not a survey
  or a finer independent dataset. No vertical-datum conversion is performed.
- Quality uses 16,384 deterministic common points in the interior 84% of each
  tile's width and height. This avoids source-edge clamping bias. Boundary quality
  between source tiles is outside this experiment.
- Sample spacing targets equal interior density. Actual padded sample and
  triangle counts are reported; hex and square counts are not exactly equal.
- Eight initial densities × four layouts × six fixtures = 192 timed cases.
  The finer quality-only sweep has 1,464 cases. It measures source-relative
  vertical error, not screen-space visual quality.
- Timing batches are warmed, calibrated, and repeated seven times. Medians and
  P90 batch averages are recorded. Layout order rotates between fixtures. The
  complete timing comparison was repeated in a separate sequential process.
  These are microbenchmark summaries, not statistical confidence intervals.
- Eight independent checks validate affine surfaces, patch-edge samples, and
  direct lookup against an independently evaluated indexed mesh.
- Uniform local lattices are tested. Recursive 7/19/37-cell hex refinement,
  spherical distortion/pentagons, mixed-LOD seams, streaming/cache behavior,
  imagery refinement, and GPU rendering remain unbenchmarked.

## Implications for the draft spec

1. Make the height query directly address the displayed terrain triangles.
2. Bound terrain geometry independently of imagery resolution. A sharper image
   must not force a denser terrain mesh.
3. Reuse geometry and update only affected patches on a surface change. Exclude
   full-coverage CPU morphing/stitching from the initial design.
4. Retain the safe aircraft correction when committed terrain rises through it.
5. Keep both sample layouts viable for now. Hex shows modest quality benefits;
   square has simpler source integration. A mixed-LOD prototype and a browser GPU
   comparison are needed before calling either the complete runtime winner.

## Reproduce from the repository root

No application server is needed. Existing `node_modules` provides Vite and Babylon.
Pillow is needed only to prepare fixtures; the measured run used Pillow 12.3.0.

```sh
python3 -m venv benchmarks/terrain/.cache/venv
benchmarks/terrain/.cache/venv/bin/pip install Pillow==12.3.0
benchmarks/terrain/.cache/venv/bin/python benchmarks/terrain/download.py
node --test benchmarks/terrain/verify.mjs
node benchmarks/terrain/run.mjs
node benchmarks/terrain/run.mjs benchmarks/terrain/results-layouts-repeat.json
node benchmarks/terrain/quality-sweep.mjs
node benchmarks/terrain/run-current.mjs
node benchmarks/terrain/run-current.mjs benchmarks/terrain/results-current-repeat.json
```

Run measurements sequentially, with other CPU-heavy tasks idle. Fixtures and the
temporary bundle are ignored under `.cache/`. The JSON reports are retained next
to the benchmark scripts. Production source hashes are in the repeated current
path result, identifying the exact implementation measured.
