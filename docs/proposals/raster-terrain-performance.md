# Flat-basemap performance recovery

Status: Stage A implemented — awaiting user in-game validation; Stages B–D proposed
Date: 2026-09-07  
Scope: foss-earth raster basemaps and their flight-sim integration

## Implementation record — 2026-09-07

The pre-change checkpoints are `foss-earth` commit `860d217` and `flight-sim`
commit `c0126d98`. Stage A retains the existing tile density, texture resolution
and 1.2-second refinement duration.

- **A1 is complete.** Terrain load callbacks now only mark work pending. Each
  runtime update performs at most one refinement/seam pass after coverage is
  adopted, and stationary simulation frames no longer reselect coverage solely
  because the render loop is active. The nine-tile benchmark reduced active
  refinement from 10.16–10.19 ms to 5.08–5.10 ms at LAX/LA hills and from 2.76
  ms to 1.38 ms at Rainier in the CPU-only reference run.
- **A2 is complete.** Raster `surface.sample()` indexes adopted tile triangles
  directly. It reads the current position buffers, including morphs and stitched
  seams, and checks only the owning/adjacent patches. The general `raycast()` API
  is unchanged. The same benchmark measured 0.88–0.94 µs median production
  sampling and 1.08–1.17 µs P95, versus 225–700 µs for the former scene raycast.
  Height agreement was better than 0.00003 m; no fixture query needed a restricted
  fallback.
- **Stage 0 capture is available.** Add `terrainCapture=1` to the app URL, then
  inspect `window.fossTerrainPerformance?.snapshot()` in DevTools. It is opt-in,
  bounded to 3,600 frames, and records CPU timing, query/seam/write counters and
  sampled resource estimates. It reports unavailable GPU/process measurements as
  `null` and adds no capture buffer or per-query clock when disabled.

Focused geometry tests, the full foss-earth suite, production build, and the full
flight-sim test suite passed. These are CPU and correctness checks; they do not
replace the required browser test for frame pacing, heat or GPU upload stalls.

## Recommendation

Improve the existing implementation in small, measurable steps. Start with two
changes that preserve terrain detail: process refinement once per frame, then
replace routine scene-wide height raycasts with direct lookup of the displayed
terrain triangles. Test each change separately. Proceed in stages, using smooth
flight and acceptable sustained resource use as the decision criteria.
Configurable, hardware-adaptive LOD is part of the intended
design; the existing fixed high-detail ring is not the desired final policy.

If those changes are insufficient, remove continuous terrain morphing and update
only affected terrain when data arrives. Add distance- and view-dependent detail
with hardware-adaptive budgets in Stage C. Changes to nearby terrain quality remain
an explicit visual tradeoff. Keep the square-versus-hex decision open: the benchmarks
do not establish a large speed advantage for either local sample arrangement.

The initial implementation scope proposed for approval is **Stage A** below.
Stage C specifies the planned LOD behavior, independent elevation-provider
selection and basemap hot-swapping; its implementation follows the Stage A review.
Stage B and the remaining Stage D fixes are guided by observed bottlenecks.
This proposal does not authorize an automatic rewrite.

## Requirements that every stage must preserve

- Flight remains playable while terrain loads. Download failure retains usable
  existing coverage; a missing surface never reuses another location's height.
- Raster height queries use the triangles representing the displayed surface,
  including their current refinement and seam adjustments. Higher-resolution
  downloaded heights do not independently become the physics surface.
- When replacement terrain rises through the aircraft, correct its position
  above that surface without a launch impulse. Preserve heading and horizontal
  motion. Grounded aircraft can follow downward changes; airborne aircraft do not.
- Distinguish a surface change at a fixed location from flight into an existing
  hill. A surface change elsewhere must not turn an ordinary collision into a lift.
- Preserve teleport initialization, invalid-state recovery and fault pausing.
- Preserve the bundled real coarse fallback and Mapterhorn as the default height
  provider. Flat basemaps must allow an independent elevation-provider choice.
- Imagery detail can improve without requiring a denser terrain mesh. Slow height
  downloads should not unnecessarily prevent sharper imagery from appearing.
- Source-switching work must preserve the running app and flight state. A flat
  basemap change replaces imagery while retaining the selected elevation and
  adopted physical surface; it must not reload the page or reset the simulation.
- Concentrate high detail near the aircraft and where it visibly matters. Adapt
  the amount of detail to available runtime capacity within explicit limits,
  while reserving headroom for the rest of the game.
- Basemap/elevation changes, teleport, or disposal must invalidate obsolete pending
  work while preserving reusable data belonging to an unchanged source.

Google 3D Tiles rendering and collision algorithms are outside this proposal.
The only Google-related addition is the app lifecycle needed to switch between
Google and raster modes without restarting the application, described in C4.
The older smooth-elevation proposal is not the physics-surface specification for
this work. New datum-conversion machinery and full aircraft-versus-triangle contact
response are also outside this performance change; additional elevation adapters
must first validate compatibility with the runtime height convention. JSBSim still
consumes local support height.

## Evidence and uncertainty

The [benchmark report](../../benchmarks/terrain/README.md) records methodology,
scripts, repeated results and limitations. On the tested Apple M5:

| Measured workload | Result | Implication |
|---|---:|---|
| Current height raycast, nine detailed tiles | About 0.69 ms/query | Repeated physics/HUD queries are worth optimizing |
| Direct intersection of triangles in a known tile | About 0.00023–0.00027 ms/query | Strong prototype result; production tile lookup and transforms still needed |
| Morph and stitch nine detailed tiles twice | About 10 ms | Duplicate and continuous geometry work are substantial CPU costs |
| LA requested leaf geometry, fully loaded | About 5 million triangles | Geometry density needs a budget if GPU/memory pressure remains |
| Pure desired-tile selection | About 0.04 ms | Rewriting this arithmetic is a low priority |

The triangle count is before frustum culling. The timings use a CPU-only Babylon
NullEngine, not a running game. They do not measure texture decode/upload, GPU
time, thermal behavior or complete frame time. Removing one of two refinement
passes should reduce that component substantially; it does not promise twice the
game FPS. The direct-query prototype likewise does not imply a thousands-fold
improvement to the whole game.

## Stage 0 — establish a recoverable checkpoint and measurements

Before application edits, save a local checkpoint of the current source in both
repositories, including tracked modifications and relevant untracked files. Record
its location and the exact files changed by each subsequent step. Preserve existing
user work. Reverting a failed experiment must be possible without resetting either
repository to an unknown old commit.

Extend existing diagnostics with an opt-in performance capture, using bounded
numeric storage and infrequent summaries. No new always-running profiler or
per-frame console output. Record:

- Frame intervals, terrain-update CPU time, and aggregate surface-query CPU time.
- Height-query count, triangles tested, exceptional fallback count, geometry
  writes, seam passes, and surface revision changes.
- Active leaf and cached triangle counts, actual draw calls where available,
  estimated owned buffer/texture bytes, and loading/preparation queue lengths.
- Separate time spent preparing geometry and submitting updates from GPU time.
  Report unsupported GPU or process-memory measurements as unavailable.

Instrumentation must cover load-completion callbacks as well as the render tick;
otherwise loading stalls would be missed. Diagnostics should add less than 0.1 ms
per frame in a controlled overhead comparison. With capture disabled, do not keep
per-query clocks or allocate telemetry records.

Stage C's automatic LOD controller may retain lightweight frame/work aggregates
when detailed capture is disabled. It must reuse bounded counters and existing
frame timestamps; automatic quality is not permission to run a full profiler.

## Stage A — preserve detail and remove expensive repeated work

### A1. One refinement pass per frame

Reorder raster updates so selection/visibility changes are collected and geometry
is processed once at the frame boundary. Continue an active refinement even when
the camera has not moved. A stationary camera must not strand pending terrain.

Load callbacks may enqueue changes; they must not cause a second full geometry
pass in the same frame. At this stage keep the existing transition duration, grid
density and seam behavior. Preserve synchronization with the simulation: an adopted
surface must be available to terrain-contact handling before the next physics
step that could use it, including while paused.

Acceptance:

- At most one full refinement/seam pass per frame; zero geometry writes and
  geometry revision increments when the terrain is settled and unchanged.
- The nine-tile active-refinement benchmark's median CPU cost decreases by at
  least 35% from its approximately 10 ms two-pass baseline, on the same setup.
- Stationary-camera loading, pause/resume, parent replacement and disposal checks
  pass. Terrain detail and texture resolution remain unchanged.

This is the smallest first patch. It leaves the remaining cost of one full pass
visible in measurements rather than hiding it behind other changes.

### A2. Direct lookup for raster `surface.sample(lat, lon)`

Maintain an index of the currently adopted terrain coverage keyed by tile address.
Given latitude/longitude, find the covering leaf or active parent, locate its grid
cell and intersect the actual position-buffer triangles. Use mesh segment metadata
and the rendered diagonal. Return the existing point, height, geometric normal,
distance, mesh ID, revision and quality contract.

This path must handle longitude wrapping, tile edges/corners, Earth curvature,
floating-origin translation/rotation, active morphing, and adjusted seam vertices.
Tile lookup must not walk every scene mesh. A tile remains queryable when it is
part of adopted coverage but merely outside the camera frustum.

Nominal grid addressing can be imperfect where seam processing shifts vertices.
Check neighboring cells/adjacent adopted patches as needed. An exceptional miss
may use a raycast restricted to the relevant terrain patches, with a diagnostic
counter. Do not silently fall back to scanning the entire scene on every substep.
If this fallback is frequent, correct the index/boundary handling before release.

Read adopted mesh positions, not a separately interpolated source DEM. Retain the
general arbitrary-direction `surface.raycast` API for consumers that need it.
Route all routine raster height sampling, including the camera/HUD and simulation,
through the optimized path. Preserve custom terrain overrides and missing-surface
behavior. Do not lower physics frequency or remove simulation snapshots here.

Acceptance:

- Agreement with the existing mesh raycast within 1 cm at deterministic test
  points; normal agreement within 0.1 degrees away from triangle-edge ties.
  At edges accept either incident face normal but require consistent height.
- Tests include mixed detail, adjusted seams/corners, transformed roots,
  antimeridian, active parent fallback, invalid inputs, and misses. No NaNs near
  the provider's latitude limit; unsupported polar coverage may return null.
- A production-path benchmark including tile selection and transforms has median
  cost at most 0.01 ms/query and P95 at most 0.05 ms/query on the reference setup.
  These are proposed targets, not existing measurements.
- Increasing irrelevant scene geometry or cached noncovering tiles does not cause
  a proportional increase in query cost. All routine interior samples use the
  direct path; any boundary fallback is reported and its total cost is measured.
- Existing real-JSBSim refinement, genuine hill encounter, teleport and recovery
  regression cases pass.

**Review gate:** after A1 and A2 have separately passed their checks, the user tests
the game. Keep successful fixes and use the results to choose whether Stage B or
the planned Stage C LOD work comes next. If performance is acceptable, defer
unnecessary optimization machinery. Known imagery defects remain separately
tracked even if flight performance becomes acceptable.

## Stage B — remove continuous geometry animation if needed

This is a larger change than Stage A. Replace the 1.2-second CPU vertex morph with
a single prepared surface replacement. A visible height pop on data arrival is
the proposed tradeoff for lower CPU use. Safe aircraft correction remains required.

Prepare changed tiles and the edge/corner dependencies affected by them. Coalesce
multiple pending refinements of a tile to the newest usable result. Recompute from
unmodified target data so repeated seam adjustments cannot accumulate distortion.
Do not copy or upload all other displayed tiles because one tile changed.

Keep the old surface active while preparing the new one. Commit a coherent set of
geometry, coverage-index and revision changes at a frame boundary, so rendering
and subsequent physics see the same version. Shader-only displacement of the
surface is outside this stage because CPU collision queries would also need it.

Use a preparation queue with a proposed 2 ms CPU allowance per frame. Work that
cannot fit must be split across frames, or require a separately reviewed worker
step. A large job must neither run unbounded nor be deferred forever. Retain parent
coverage while preparing dependent neighbors; do not expose cracked partial groups.

Acceptance: settled terrain has zero geometry writes; changing one tile does not
rewrite unrelated distant tiles; stale results cannot commit after a teleport;
seams remain closed; downward and upward replacement cases stay safe. Proposed
P95 combined preparation/commit CPU cost is below 4 ms per loading frame. Browser
upload stalls must be measured separately and may require smaller commit batches.

## Stage C — nearby detail, hardware-adaptive LOD and source switching

### C0. Provider-specific available levels

The [provider detail appendix](raster-provider-detail.md) defines the supported
source ranges, sample spacing and candidate mesh sizes. Low/Balanced/High are
budget policies, not universal texture or height levels. Each adopted patch must
identify its imagery source level, actual elevation source level and mesh detail
separately. A provider's advertised range, local availability and our approved
request cap are distinct limits.

Current request caps are USGS 16, OSM Standard 19, CARTO 20, OpenTopoMap 17 and
Mapterhorn elevation 15. These are application settings, not universal provider
maxima. Mapterhorn's documentation describes regional levels through 17; USGS
lists matrix entries through 23 but a service display scale corresponding to
about level 16. The appendix records evidence and verification gaps.

Hardware adaptation must choose among useful available levels. It must not equate
256-pixel imagery with 512-pixel elevation at the same zoom, repeatedly request
missing regional detail, or grow geometry merely because another basemap permits
larger zoom numbers. The first LOD pass retains current approved source caps;
raising a cap needs separate availability and performance validation.

### C1. A configurable spatial detail policy

The current raster runtime already has coarse parents and a high-detail focus
ring, but its ring sizes and mesh subdivisions are fixed. It does not select a
terrain budget based on hardware or measured performance. Retaining the highest
previously requested focus zoom can also retain excessive detail after a climb.

Replace that policy incrementally, keeping the existing tile hierarchy and data
sources. First implement and validate fixed quality profiles; then add automatic
selection between bounded settings in C2. This separates LOD correctness from the
feedback controller's behavior.

| Region | Proposed detail and retention policy |
|---|---|
| Aircraft contact area | Reserve a small, bounded set of surrounding patches with sufficient local geometry for the current altitude/approach. Preserve adopted support when the camera looks away. |
| Nearby visible terrain | Highest useful geometry and imagery detail that fit the selected quality ceiling and budgets |
| Farther visible terrain | Progressively coarser geometry and textures, retaining mountain shape and globe curvature |
| Short predicted flight corridor | Bounded advance preparation based on speed and measured loading latency where the source permits it; lower priority than current coverage |
| Outside the view and contact/corridor regions | Coarse coverage where needed; recent detail may stay cached but does not force active rendering or more downloads |

Distance is measured to patch bounds rather than just the tile center. Include
camera field of view and actual render resolution: a distant patch occupying only
a few pixels should not request the same detail as one filling the screen. Nearby
detail is the priority, with refinement of distant silhouettes only when their
projected error is noticeable and spare budget permits it. Visible imagery uses
camera distance; the protected contact area uses aircraft position and altitude.

Use separate terrain and imagery error targets. Terrain selection should account
for estimated geometric error projected into pixels; imagery selection should
account for projected texel size. The two share priority, coverage and budget rules,
but need not request the same zoom or arrive together. This follows the general
screen-space-error approach exposed by
[3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/src/core/renderer/API.md);
it does not require adopting that library's default thresholds or switching renderer.

Our raster source does not supply ready-made per-mesh geometric error. Start with
a documented conservative estimate using patch size, curvature and available
height variation; refine the estimate during mesh preparation where cheap. Label
it as an estimate. Exact error estimation must not itself require a per-frame DEM
scan or downloads of detail merely to decide whether it is needed.

Expose the following internal configuration dimensions in one policy object:

- Target frame rate, reserved frame-time headroom and a maximum quality setting.
- Terrain pixel-error target and imagery texel-size target, varied with distance.
- Bounded aircraft-local retention, useful-detail distance and prefetch horizon.
- Limits on active terrain triangles, draw calls, decoded/GPU resource estimates,
  pending bytes, preparation work and concurrent loading.
- Separate thresholds for adding/removing detail and a minimum residency time.

The first profiles should be Low, Balanced and High, with Auto as the default
selector. Concrete radius/triangle/byte values must be calibrated against the
fixture views and supported devices before implementation is accepted; the
profile names are not a claim that those budgets have already been measured.
Source zoom and renderer limits remain hard ceilings, not performance estimates.
Apply provider-specific request and memory rules from the appendix to each
profile, including tile dimensions, missing levels and prefetch restrictions.

Keep contact-area reservations within those budgets, including replacement
headroom. If finer data is unavailable, retain the best adopted surface. Camera
motion or hardware adaptation must not repeatedly refine/coarsen ground under
the wheels. Outside this small reservation, replace the indefinite highest-zoom
latch with hysteresis and recent-use retention. A climb should eventually release
unneeded detail. Quality must not require retaining every previously visited tile.

At shared edges, use compatible neighboring detail and existing seam rules. If
neighbor dependencies would exceed a budget, retain the parent rather than reveal
incompatible children. Rendering and physics must adopt any LOD change together
through the safe surface-change path.

### C2. Adapt to measured capacity, using hardware as an initial hint

Hardware information can seed a conservative starting profile and resource limits,
but runtime feedback is authoritative. CPU count is not GPU speed; reported device
memory is approximate and is unavailable in some browsers. Do not infer usable
graphics memory or quality from those fields alone. See the documentation for
[hardwareConcurrency](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency)
and [deviceMemory](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory).

Initialize conservatively when hints are absent. Use renderer capabilities to
validate supported features/resource sizes. Observe normal gameplay rather than
running a startup stress test. Faster hardware may support detail farther away or
finer useful geometry; it must not automatically expand detail until it runs hot.

The controller should:

1. Evaluate bounded rolling frame/work statistics about once per second, not
   rebuild the world every frame. At 60 FPS, the frame budget is 16.7 ms; initially
   aim to leave roughly 25% of measured work capacity unused. This is a tuning
   target, not a direct measurement of power or temperature.
2. After sustained overload, lower one bounded setting at a time. Reduce optional
   prefetch and distant detail before reducing useful nearby detail. If loading
   work is the bottleneck, reduce preparation/upload admission; if memory is the
   bottleneck, restrict cached/pending resources. Do not keep lowering geometry
   indefinitely if it produces no timing improvement.
3. Increase quality cautiously only after sustained evidence of spare capacity,
   with no request backlog or memory pressure. Proposed starting delays are two
   consecutive overloaded one-second windows to step down, ten healthy seconds
   before a step up, and at least five seconds between ordinary quality changes.
   Hard resource admission limits apply immediately regardless of these delays.
4. Preserve headroom and the selected quality ceiling even on faster hardware.
   A user-selected Low/Balanced/High setting can lock the profile; Auto adjusts
   within its configured bounds. Keep the controls understandable to the player.
5. Exclude hidden-tab pauses, debugger pauses and deliberate simulation suspension
   from quality decisions. Treat teleports and startup as loading bursts: throttle
   work, but do not permanently classify the device from a single stall. Observe
   sustained slowdowns later in a session as well as initial performance.

Frame intervals at a frame cap cannot reveal spare GPU capacity. Use CPU work
timings and supported asynchronous GPU measurements when available. Without GPU
timings, stable capped FPS alone must not trigger endless upgrades; hold a
conservative profile or make a bounded, reversible quality trial. Do not introduce
synchronous GPU readbacks. Resolution and field-of-view changes invalidate the
screen-space demand estimate and require reassessment within the same budgets.

Reserve space for parents, decoded images/DEMs, mesh buffers and pending
replacements **before** accepting additional work. A high-end hardware hint does
not authorize unlimited cache growth. Numeric budgets and byte accounting needed
by this controller must land with Stage C, rather than waiting for Stage D.

### C3. Choose elevation independently of the flat basemap

Add an Elevation selector alongside Basemap and Quality, backed by a foss-earth
provider registry and live switching API. Mapterhorn remains the default;
Mapzen/AWS Terrain Tiles is the proposed second adapter, pending validation.
The [provider selection contract](raster-provider-detail.md#independent-elevation-provider-selection)
defines persistence, provider-specific limits, custom host sources and acceptance.

Switching elevation preserves imagery and the running flight. Keep the existing
visible/physical surface until coherent replacement patches are ready, then use
the same revision and safe aircraft-correction path as refinement. Source switches
must fit the shared work/memory budget, reject stale completions and report failures.
Changing imagery preserves the elevation choice and reusable terrain. Google mode
remembers the choice but does not load or use raster elevations.

This is a separate implementation step after Stage A, not extra work folded into
the first performance patch. It may precede C1/C2 if the provider descriptors,
bounded replacement path and required switching checks are ready.

### C4. Hot-swap basemaps while the app keeps running

Replace the reload-based map-selection handlers in both foss-earth and flight-sim
with a shared runtime API. For flat-to-flat changes, replace imagery in place,
keeping elevation data, terrain geometry and flight state. Update the URL without
navigation. The [hot-swap contract](raster-provider-detail.md#hot-swap-basemaps-without-restarting-the-app)
defines loading continuity, cancellation, persistence, resource limits and checks.

Implement flat-to-flat switching as a focused step after the Stage A review; it
need not wait for automatic LOD or a second elevation provider. Follow it with a
separately checked Google/raster mode handoff that preserves the app and simulation
while adopting the destination surface safely. Neither step changes the selected
graphics backend (WebGL/WebGPU). This is required source-switching behavior,
independent of whether the performance measurements justify Stage D optimizations.

### Acceptance and staged evaluation

- For the same view, detail falls off with distance. Approaching a region refines
  it; turning away releases optional work but retains aircraft support.
- A weaker simulated capacity profile chooses less optional detail than a stronger
  one. Missing hardware hints still produce playable conservative behavior.
- Deterministic controller tests cover overload, recovery, quality bounds,
  cooldowns, capped FPS, loading bursts, memory admission and tab suspension.
- Small camera movements or alternating timing samples do not repeatedly rebuild
  terrain. A stationary settled view has no geometry work due solely to polling
  the quality controller. Its bookkeeping fits the diagnostic overhead allowance.
- The user reviews both sustained playability and visible LOD transitions at
  ground level, during climb, and across the horizon. Profile changes must not
  create physics launches, holes, stale height or texture downgrade loops.

As one density experiment within these profiles, 128-to-64 subdivisions cuts a
tile's triangles by 75%. Apply it selectively and measure it; it is not the entire
LOD strategy. For the benchmark LA view, retain the provisional target of at least
50% fewer requested leaf triangles while preserving comparable nearby usefulness.
Report imagery-detail changes separately so geometry savings are not attributed
to a hidden reduction in texture quality. Recheck peak errors, curvature and
runway/ridge behavior; a P95 source error alone is not a flight-quality guarantee.

## Stage D — loading and imagery follow-up, guided by capture

Use Stage C's admission accounting to investigate any remaining loading bursts or
memory growth. Refine scheduling/cancellation where traces show waste. A full
cache must not permanently block refinement. Do not merely change a tile-count
limit to another arbitrary count, or allocate more resources to mask stale work.

For the reported sharp texture boundary, first reproduce and distinguish missing
requests, parent promotion waiting for terrain, source imagery differences, and
texture filtering. The behavioral contract is: use an available parent image while
detail loads, promote ready imagery without unnecessarily waiting for terrain,
retain coverage on errors, and avoid repeated detail promotion/demotion. A sharper
image alone must not change the physical surface revision. Imagery-only child
patches may inherit the parent's exact triangle surface until their terrain is ready.

A connected texture/height streaming redesign, geometry clipmaps, a renderer
migration, and a recursive hex hierarchy require their own proposal. They are not
prerequisites for trying Stage A.

## Proposed playability targets and validation

Use the same browser, canvas size, camera, aircraft, basemap and frame-rate setting
for before/after comparisons. Record those settings. A provisional 60 FPS goal is
steady-flight P95 frame interval at most 20 ms and P99 at most 33 ms over a 60-second
sample; average FPS alone is insufficient. Existing frame-cap changes must not be
used to disguise regressions. Adjust these targets explicitly if the user's device
or chosen settings call for a different budget.

Capture both loading and settled flight. Aim for terrain CPU work, including its
height queries, below 1 ms/frame on average when settled, and below 4 ms at P95
during refinement. Loading should cause no terrain-attributable main-thread task
over 50 ms. These are acceptance targets to evaluate, not a near-zero-cost promise.

The user performs the browser tests:

| Scenario | What to check |
|---|---|
| USGS Imagery Topo, teleport to LA, set altitude to 500 m | Responsive controls; correct destination support; no extreme altitude/NaNs |
| Fly about 100 m above LA hills and cross a detail boundary | Frame pacing, terrain/texture changes, no unintended launch or buried aircraft |
| MSP departure and paused refinement | Grounded alignment and safe repositioning; no repeated physics resets on settled terrain |
| Turn around, climb, revisit terrain, then teleport | No repeated loading churn, stale commits or growing cache use across repeated routes |
| Compare Low/Balanced/High and Auto, then resize the view | Useful nearby detail, progressively coarser distance, bounded resource use and stable adaptation |
| Switch elevation providers on one flat basemap, then change basemap | Independent selections, continuous flight, safe surface changes and bounded resource use; errors retain usable coverage |
| Hot-swap flat basemaps during flight and while paused; repeat rapidly with delayed/failed imagery | No page reload, flight/UI reset, terrain rebuild or blank map; latest choice wins and resources stay bounded |
| Google ↔ raster round trip, when the mode-handoff step is ready | Preserved app/flight state, coherent visual/physical surface adoption and usable old coverage if preparation fails |
| Load errors or delayed refinement | Usable parent/fallback coverage; no stale invisible ground |
| A several-minute settled flight | Sustained responsiveness and acceptable heat/fan behavior, not just a brief FPS improvement |

The agent runs focused automated geometry/physics regression checks and repeatable
benchmarks, then required lint/type/build checks for changed projects. Timing
targets are reviewed from dedicated runs rather than brittle unit-test assertions.
User feedback and frame/resource measurements decide whether to continue to the
next stage. Heat cannot be inferred from the CPU microbenchmarks alone.

## Expected code ownership

| Area | Expected responsibility |
|---|---|
| `foss-earth/src/engine/babylon/createRasterTilesRuntime.ts` | Update ordering, adopted tile index, later queued surface changes and spatial LOD policy |
| A focused raster quality-policy module | Hardware hints, fixed quality profiles, budget admission and lightweight runtime adaptation |
| `foss-earth` terrain provider registry, runtime configuration and public API | Provider descriptors, independent elevation preference, live switching, attribution and cancellation |
| `foss-earth/src/terrain/surfaceQuery.ts` and a focused raster query helper if needed | Optimized raster sampling; preserve the public surface contract |
| `foss-earth/src/terrain/meshRefinement.ts` | Existing seams in A; affected-neighbor preparation in B |
| `foss-earth/src/engine/babylon/createBabylonRuntime.ts` | Route raster queries, expose optional diagnostics and coordinate live source/mode changes |
| `foss-earth/src/engine/babylon/resolveMapRuntimeConfig.ts` and `src/app/createGlobeApp.ts` | Shared preferences without navigation; standalone map controls use the runtime switching API |
| `flight-sim` terrain contact, map controls and app integration | Preserve safety behavior and consume the same surface; wire live basemap and independent elevation selection |
| `benchmarks/terrain` | Repeatable comparisons with implementation hashes and stated measurement limits |

## Decisions requested in this review

1. Start with Stage A, tested as two separate patches, then evaluate playability.
2. Treat instantaneous terrain replacement in Stage B as an acceptable candidate
   if continuous morphing remains expensive.
3. Plan configurable distance/view LOD with automatic hardware/runtime adaptation
   after Stage A; decide its order relative to Stage B from the measurements.
   Preserve nearby detail first, and tune distant imagery and geometry independently.
4. Adopt separate provider-aware texture, elevation-source and mesh levels from
   the appendix; retain existing request caps until further levels are validated.
5. Plan independent elevation selection for flat basemaps, with Mapterhorn as the
   default and a second validated adapter; implement separately from Stage A.
6. Hot-swap flat basemaps without resetting the app, terrain or flight; check
   Google/raster handoff separately while preserving the same session continuity.
7. Use the provisional measurement targets above to judge progress, with in-game
   validation performed by the user before expanding implementation scope.
