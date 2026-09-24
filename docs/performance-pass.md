# First performance pass

The September 23 headless flight is not a result. The machine was in use for other work while it ran, so the frame times in `results.json` are discarded as evidence. This note is the first pass at making the globe cheaper, and at making the next measurement something that can be repeated.

## What the competitors actually avoid

CesiumJS does not restitch or reupload a tile unless that tile's data or its skirt source changed. MapLibre keeps one terrain mesh topology and only writes elevation where a DEM tile arrived. WorldWind redraws more of the frame on the CPU, which is why it was the only implementation that looked slow even in the invalid run.

FOSS Earth was already render-on-demand, and it already stopped morphing terrain on every frame. Two costs were still paid on updates that did not need them:

- `stitchTerrainEdges` walked every visible tile whenever any one tile committed new elevation.
- `recomputeVisibility` called `setEnabled` on every cached tile even when that tile's visibility had not changed.

## What changed

- A geometry commit now stitches the committed tile, the visible tiles that sample it, and the coarser or same-zoom neighbors those tiles read. A remote tile is not uploaded again. `patchesForGeometryCommit` in `src/terrain/meshRefinement.ts`.
- Visibility updates skip `setEnabled` when the mesh is already in the right state.
- Terrain meshes use bounding-sphere culling. The sphere contains the tile, so this drops draw work for tiles outside the view and can only draw extra, not hide a tile that should be visible.
- The globe scene skips Babylon's pointer-move raycast. Anchor pans still pick on demand. Material dirty propagation is blocked so per-tile texture updates do not walk the whole material graph.

## What this pass did not do

Normals are still computed on the CPU when a tile mesh is built. Index and UV buffers are still unique per tile even though the grid topology is the same for a given segment count. Auto quality still will not raise detail just because frames are at 16.7 ms, because a capped refresh is not spare GPU time. None of that is measured here.

## How to measure again

Leave the machine idle. Close other GPU apps. The suite opens a visible Chrome window unless `--headless` is passed, so the flight can be watched.

```bash
npm run dev -- --host 127.0.0.1 --port 4174
node benchmarks/globe-compare/run.mjs --runs=3 http://127.0.0.1:4174
```

`--headless` is the unattended option. The default is a GUI window. Each target flies the Grand Canyon at about 1200 m for 8 seconds after 6 seconds of warmup, at 1280×720. The JSON reports the unmasked WebGL renderer. If that string is not the Apple GPU, the run used a software renderer and does not count. One run is not a result. Use at least three idle runs and compare the spread before treating a difference as real.
