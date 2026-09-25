# Map detail validation

Runnable checks for the projected raster imagery described in
[Map detail control](../../docs/proposals/map-detail-control.md). Both runners use
isolated headless Chromium with the real GPU: they reject a software renderer,
never open a window, use no user profile and start no server. Runs write to a
dated folder under `build/benchmarks/map-detail/`; selected runs are copied to
`validation/evidence/map-detail/` with a report of what they show.

Playwright is not a dependency:

```sh
npm install --prefix build/tools/playwright --no-audit --no-fund playwright
```

## Binding fixtures (correctness)

```sh
node benchmarks/map-detail/run-binding.mjs [output-dir] [--backend=webgpu,webgl2,webgl] [--scenario=name,...]
```

`binding-fixture.ts` drives the real raster runtime in atlas mode over flat
terrain, with synthetic imagery that encodes its own identity, on WebGPU, WebGL 2
and a WebGL 1 engine built the way the application builds its WebGL engine.

- Solid scenarios give each image one colour that names its tile. Every terrain
  pixel away from the silhouette must be exactly a known colour: anything else is
  bleed between pages, an uninitialised or reused slot, or a stale table entry.
  The churn scenario moves the camera and the target every frame while images
  arrive late and out of order, and checks captures taken mid-churn.
- Gradient scenarios put each texel's column and row in red and green and the
  level in blue. Picking the ground under a grid of pixels checks placement,
  orientation and texel precision, including level 20 across the dateline and a
  floating-origin world root that moves and turns the world and camera.
- Every scenario then changes only the imagery target and checks that terrain
  vertex buffers and the surface revision did not change. It counts work in two
  timed windows after that: the first 2.5 s may still merge leaves back once the
  coarsening delay and pin expire; the next 3 s, stationary and settled, must do
  no selection, upload or page-table work.

## Sweep (cost and sharpness)

```sh
node benchmarks/map-detail/run-sweep.mjs [output-dir] [--backend=webgpu] [--views=city,mountain,coast-dateline,near-horizon] [--quick]
```

`sweep-page.ts` renders real providers over real elevation with the legacy
per-tile imagery (Low, Balanced, High) and the projected atlas (offsets −2, 0,
+1) at the same views, for a photographic (USGS Imagery), cartographic (USGS
Topo) and mixed (USGS Imagery Topo) source, cold and warm. It records requests
by host (by service for The National Map) and level, and bytes; browser-cache
hits count, since they are what the runtime asked for. It also records settle
time, the selected and delivered level per region, limits, atlas residency,
draw calls, CPU per frame, frame intervals (P50/P95/P99), and a sharpness
figure: the mean absolute Laplacian of luminance over the central two thirds
of a screenshot. On the atlas it also runs a rapid slider drag, a switch to
USGS Topo, and an elevation-source change at a fixed camera.

CARTO is not in the sweep: since August 2026 it answers requests without an
API key with an "API KEY REQUIRED" placeholder tile.

Network speed and provider caches vary between runs, so settle times are
indicative; requests, bytes, levels and the absence of terrain writes are not.
Frame intervals come from headless Chromium's `requestAnimationFrame`, which is
paced like a 60 Hz display, not from a display. GPU timing is recorded where the
backend exposes it and marked unavailable otherwise.

## CARTO variant check

```sh
CARTO_API_KEY=… node benchmarks/map-detail/run-sweep.mjs [output-dir] --variants
```

Downsamples CARTO's `@2x` tiles to 256 pixels and compares them with the
standard tiles at small offsets, for a few tiles in three cities and both
styles. The same extent and content align best at zero offset with a small
difference. It needs a CARTO key; without one CARTO returns its placeholder.
