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
- The globe scene skips Babylon's pointer-move raycast. Anchor pans still pick on demand.

Bounding-sphere culling and blocked material dirty propagation were tried and reverted before `afb020e`. Neither flag is present in that commit.

## Raster tiles disappearing at close zoom

The bounds failure reproduces with both `afb020e` and its parent: reverting the selective seam pass does not repair it. Source comparison and an isolated execution trace it to `860d217` (September 7), which combined tile-local vertices, a translated frozen world matrix, and in-place terrain updates. Before that change, vertices were absolute ECEF coordinates and the mesh transform was the identity.

Babylon 8.56.2's `updateVerticesData(PositionKind, positions, true)` rebuilds bounds in local coordinates. A frozen mesh does not recompute its world matrix during rendering, so those bounds stay near Earth's center instead of the tile. Fine tiles then fail the camera's frustum test, while coarse tiles have bounds large enough to remain visible. The previous tests placed seam meshes at the origin and checked tile activation without checking render culling, so they missed this failure.

`updateTerrainPositions` now reapplies the mesh's world matrix to the rebuilt mesh and submesh bounds after each position upload. Terrain commits, refinement, edge stitching, and corner stitching use it. This adds no vertex rescan or extra upload and retains selective stitching, frozen tile transforms, and normal frustum culling. It changes no public contract and requires no downstream 0sfs update.

Regression coverage lives in `src/engine/babylon/createRasterTilesRuntime.test.ts` (zoom from global coverage to 1,200 m, then commit detail elevation) and `src/terrain/meshRefinement.test.ts` (frozen and parented bounds, edge and corner writes). The five new cases fail before the fix; all 257 tests pass afterward. Repository lint and build remain blocked by unrelated errors in `createTilesRuntime.ts`, `WindowOverlay.tsx`, and `createGameLog.ts`.

An isolated headless Chrome/WebGL2 check on the Apple M5 through Metal also reproduced the failure. It used the real raster runtime and geospatial camera at 40° N, 100° W, pitch 75°, with deterministic checkerboard imagery and zero elevation, so provider availability could not affect the result. On an 800 × 600 canvas, both `afb020e` and its parent drew 99,095 nonblack pixels at 20,000 km, then zero at each of 2,000 km, 200 km, 20 km, and 2 km. The fixed code retained the same enabled tile counts and drew all 480,000 pixels at each close zoom, with no load errors. A WebGPU check on the same hardware produced identical fixed pixel and active-mesh counts. All headless browsers were closed after the checks.

A separate review finding remains: `patchesForGeometryCommit` selects edge dependencies but does not include diagonal corner owners read by `stitchTerrainEdges`. That can leave a seam corner stale; it does not explain the whole-tile disappearance and is not changed by the bounds fix.

Frame time has not been remeasured. These are correctness checks, not performance results.

## What this pass did not do

Normals are still computed on the CPU when a tile mesh is built. Index and UV buffers are still unique per tile even though the grid topology is the same for a given segment count. Auto quality still will not raise detail just because frames are at 16.7 ms, because a capped refresh is not spare GPU time. None of that is measured here.

## How to measure again

Leave the machine idle. Close other GPU apps. The suite opens a visible Chrome window unless `--headless` is passed, so the flight can be watched.

```bash
npm run dev -- --host 127.0.0.1 --port 4174
node benchmarks/globe-compare/run.mjs --runs=3 http://127.0.0.1:4174
```

`--headless` is the unattended option. The default is a GUI window. Each target flies the Grand Canyon at about 1200 m for 8 seconds after 6 seconds of warmup, at 1280×720. The JSON reports the unmasked WebGL renderer. If that string is not the Apple GPU, the run used a software renderer and does not count. One run is not a result. Use at least three idle runs and compare the spread before treating a difference as real.
