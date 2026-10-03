# WebGL panorama performance review and optimization toolbox

Review date: 2026-09-28. Status: findings and candidates for selection, **not an
implementation plan approved for execution**. No runtime changes or new performance
runs were made for this review. The subsequent documentation task records the review.

**Update 2026-09-29:** candidates 3, 5, 6 and 7 are implemented behind switches, off by
default, and are waiting for device trials. See
[Work-saving rendering experiments](validation/panorama-experiments.md) for what each does,
how to turn it on, and the headless A/B results on the UMN tour. The rest of this review is
unchanged.

**Update 2026-10-03:** part of candidate 15 is built and on by default: an orb loads the
preview its size on screen asks for, only while it is on screen, and no orb is sharpened
while a panorama is entered. Bounded nearby retention is not: a preview once loaded stays
until the GPU budget needs its room. Images are also kept between visits now, which this
review did not list. See [the panorama proposal](proposals/panorama-scenes.md), "Loading
once", for both and their measurements.

The release requirement is a usable tour on inexpensive and older devices while
preserving the richer experience on capable hardware. The user reports that 360
images appear to be the largest slowdown in Android Firefox without WebGPU, and
considers static sprites a last resort for very weak hardware. **Prioritize the new
panorama WebGL path, without limiting optimization to one phone or browser.**

FOSS Earth owns the shared renderer, scene format, loader, preparation tools,
settings, and capability fallbacks. The consuming application owns its photographs,
tour routes, content delivery, and accessible content. The
[UMN companion review](../../UMN-VR/UMN-VR.github.io/docs/webgl-performance-review.md)
records the content inventory, payload findings, and application work; its
[roadmap](../../UMN-VR/UMN-VR.github.io/docs/roadmap.md) links this review.

## Scope and confidence

Inspected the tour bootstrap and asset pipeline; FOSS Earth's WebGL1/2 panorama
shaders, textures, resources and scene lifecycle; Google and raster map rendering;
imagery and terrain preparation; scheduling, profiling, UI updates, and settings;
and relevant installed Babylon and 3D Tiles adapter code. This was not an exhaustive
audit of every third-party engine feature.

The reviewed working trees contained uncommitted changes. Their HEADs were FOSS
Earth `c814908` and UMN `50101cf`; those commits alone do not reproduce the reviewed
state. Installed Babylon was 8.56.2 in both; `3d-tiles-renderer` was 0.4.24 in FOSS
Earth and 0.4.28 in UMN. Findings describe that local state, not a verified live
deployment. Recheck cited symbols before implementation as the new WebGL code evolves.

- **Confirmed observation:** behavior visible in the inspected source or a counted
  local asset/artifact. It establishes work being done, not its milliseconds.
- **Candidate:** a proposed change with an expected bottleneck and tradeoff. No FPS
  increase or device qualification is claimed.
- **Static compatibility concern:** a potentially unsupported code path requiring
  a real capability-limited context to establish its runtime outcome.

The existing [WebGL validation](validation/panorama-webgl.md) covers a small Chrome
fixture on Apple M5/ANGLE/Metal. Its timings are CPU submission timings, not phone
GPU performance. No tests, benchmarks, servers, deployments, or device trials were
run as part of this review.

## Panorama-first priorities

This ordering incorporates the user's clarification that 360 imagery is the main
problem. IDs refer to the complete catalogue below and remain stable for follow-up
selection. Order within a bottleneck should follow measurement.

| Order | Candidate IDs | First question to resolve |
| --- | --- | --- |
| 1 | 5 | Remove ordinary-use diagnostic recording without changing rendering. |
| 2 | 8, 15 | How much work disappears when only useful orbs/previews are admitted? |
| 3 | 7, 6 | Can equivalent shader math and opaque immersion reduce steady viewing cost? |
| 4 | 3, 10, 11 | Does retained globe/scene/UI CPU work dominate otherwise simple immersion? |
| 5 | 4, 20, 24 | Can loading stay responsive with cancelled jobs removed and real peak-work budgets? |
| 6 | 16 | At matched visible quality, does prepared cube immersion outperform equirectangular immersion? |
| 7 | 14, 25 | Can the current view use an adequate smaller representation and recover gracefully under pressure? |
| 8 | 32, 33 | Apply existing resolution/AA controls only when pixel cost warrants the visual tradeoff. |
| 9 | 1, 2 | Fix broken map memory accounting and repeated traversal calculations; both affect the surrounding experience. |
| Later | 17, 18 | Consider tiled panoramas and GPU compression if whole-image residency or sampling remains limiting. |

Static photographic sprites/icons are an independent **marker fallback**, not a
reason to remove interactive viewing inside a stop. A weak device could draw cheap
overview markers and still open a good 360 photograph. Static perspective photographs
inside a stop are a more severe, final fallback when usable interactive viewing is
unavailable. Keep all stops, descriptions, links, attribution, and accessible
navigation available through every fallback.

Distinguish steady rotation from loading: low FPS after all work settles implicates
fragment work, sampling, framebuffer size, or per-frame CPU work. Stalls as photos
arrive implicate decoding, allocation, copying, uploads, and mip generation. Smaller
downloads alone do not fix steady rotation.

## Confirmed findings

### Panorama draw and shader work

In [panoramaRenderer.ts](../src/engine/babylon/panorama/panoramaRenderer.ts),
`currentFrame` formats a camera digest, `drawFrame` maintains negative-control frame
history, and `record` pushes and trims a 600-entry draw-record array during ordinary
rendering. Gate this test/capture work explicitly. Each orb has separate normal and
reveal meshes/materials with `alwaysSelectAsActiveMesh = true`. Immersion currently
uses an alpha-blended material even at full opacity.

In [panoramaShadersWebGL.ts](../src/engine/babylon/panorama/panoramaShadersWebGL.ts),
the orb fragment computes distance, axis and cone terms that are constant per draw.
The immersive fragment rotates the direction per pixel; its equirectangular path
normalizes a direction already normalized earlier. Cube direction lookup allows
additional simplification. Compiler optimization may already remove some work;
validate image equivalence and measure before claiming gains.

The renderer's common availability gate requires fragment depth, derivatives and
high-precision fragments for all panoramas. A simple cube viewer need not inherit
all analytic-orb requirements. The WebGL1 atlas also emits `dFdx`/`dFdy` in its
lowest-capability mode; its extension-free outcome needs a real-context check.
See [imageryMaterialPlugin.ts](../src/engine/babylon/imagery/imageryMaterialPlugin.ts).

### Loading, admission, and cancellation

In [loadScene.ts](../src/scenes/loadScene.ts), every entry starts preview loading at
mount. Preview selection uses the maximum marker diameter, not the current projected
diameter. Preview handles remain referenced. `refine` selects the largest admissible
whole representation by default because `scene.panorama.immersionDensity` is off.
Its existing screen-density choice needs triggers for zoom, viewport and rendering
resolution changes plus hysteresis; current look updates present the view and emit
status, and explicit refinement watchers cover only image/budget settings.

[Scene defaults](../src/settings/catalogue/scenes.ts) derive panorama GPU allowance
from 128 MiB of preview room plus two equirectangular images as wide as the maximum
texture dimension. These are limits, not allocations made immediately. A legal
texture dimension does not establish that a phone has enough memory for that policy.
Cube representations also need their separate cube-map dimension limit checked.

In [panoramaResources.ts](../src/scenes/panoramaResources.ts), eviction can abort the
consumer and release a reservation while an upload still owns a not-yet-returned
texture. The upload completes, generates mips, and is then discarded. The
[WebGL uploader](../src/engine/babylon/panorama/panoramaWebGlTextures.ts) has FIFO jobs
and only global cancellation. Allocation happens before queued row pacing, and
`finish` calls `generateMipmap` for the entire texture. The byte limit meters uploaded
base-level strips, not all allocation/mip work. WebGL1 has no fence-based completion
measurement; its staging allowance must not be presented as one.

Downloaded chunks are copied into a contiguous buffer and then a Blob is used for
decode. Cube loading waits for all downloads, reserves all decoded faces, then
submits them together. Temporary copies, canvases, browser resources and allocations
in flight need headroom beyond the current logical pools.

### Hidden world and map costs

[createBabylonRuntime.ts](../src/engine/babylon/createBabylonRuntime.ts) already stops
map admission/update work through navigation suspension and switches the camera to
the presentation layer. **Do not describe invisible-world rendering as wholly
unimplemented.** However, Babylon 8.56.2's default `scene.js` candidate list is
`scene.meshes`. `_evaluateActiveMeshes` performs per-mesh work before layer-mask
rejection, so retaining a detailed world can still cost CPU while viewing a photograph.
The app's [before-render HUD callback](../src/app/createGlobeApp.ts) also continues
view, anchor, compass, culling and metrics work.

Both inspected `3d-tiles-renderer` versions contain these methods in
`src/babylonjs/renderer/tiles/TilesRenderer.js`:

- `calculateBytesUsed(tile)` has a TODO and returns `1`. FOSS Earth configures
  307.2–409.6 MiB and 6,000–8,000 tile cache ranges, but the byte counter does not
  represent actual memory. Tile count is not a reliable substitute for bytes.
- `calculateTileViewError` derives camera/projection state, inverts the group matrix,
  and creates transformed frustum planes per tile. The local
  [wrapper](../src/engine/babylon/createTilesRuntime.ts) still calls this native method
  for each tile despite caching its own additional focus calculations.

The adapter also multiplies render dimensions by hardware scaling when calculating
screen error, cancelling framebuffer downscaling in that calculation. A resolution-aware
detail policy needs explicit units and visual validation rather than a silent change
to what the world-detail slider means.

Google defaults admit 25 downloads and 5 parses independently of panorama work.
The raster path has additional main-thread DEM decode, disposable terrain mesh
construction on data arrival, and whole-patch imagery publication opportunities.
Sources: [loading settings](../src/settings/catalogue/loading.ts),
[raster runtime](../src/engine/babylon/createRasterTilesRuntime.ts),
[DEM loader](../src/terrain/terrainTiles.ts),
[imagery runtime](../src/engine/babylon/imagery/createImageryRuntime.ts).

### Settings and UI

Rendering defaults to full device-pixel resolution with antialiasing. Existing
controls expose resolution scale, AA, frame cap, image detail and resource budgets.
They are building blocks, not a coordinated tour performance controller.

The [automatic detail controller](../src/terrain/autoDetail.ts) uses the shortest
observed frame interval as its measured goal. Its
[settings](../src/settings/catalogue/auto.ts) explicitly default automatic adjustment
off because a short interval can poison that goal. The observation/adjustment path is
wired to raster detail, not a common Google/panorama/framebuffer controller. The
existing Smooth motion preset turns those automatic flags on; its presence is not
evidence that the timing issue is resolved.

[Scene panels](../src/shell/scenesPanel.ts) and
[panorama tabs](../src/shell/panoramaTabs.ts) already guard against unnecessary DOM
rebuilds, but serialize status to discover changes during look updates.
[Performance metrics](../src/perf/metrics.ts) copy/sort frame history for a percentile
every rendered frame. Separate metadata changes from camera changes and update
informational statistics at a bounded rate without delaying input.

## Memory and workload arithmetic

These are RGBA8 storage calculations, not measured process memory or FPS gains.
JPEG/WebP/AVIF file size does not determine decoded or uncompressed GPU size.

| Equirectangular image | Decoded base image | GPU base plus full mip chain |
| --- | ---: | ---: |
| 1024 × 512, proposed emergency representation | 2 MiB | approximately 2.7 MiB |
| 2048 × 1024 | 8 MiB | approximately 10.7 MiB |
| 4096 × 2048 | 32 MiB | approximately 42.7 MiB |
| 6144 × 3072 | 72 MiB | approximately 96 MiB |

Old and incoming textures, decoded images, preview textures, staging and maps can
coexist. Sixty cube previews with six 256 × 256 RGBA faces take approximately
120 MiB including mipmaps if all are resident. These figures do not claim that all
representations are loaded simultaneously. WebGL1 NPOT textures omit mipmaps.

Framebuffer scale applies to both dimensions: 0.75 scale draws 56.25% of the pixels
(43.75% fewer); 0.5 draws 25% (75% fewer). That is a pixel-work reduction, not the same
percentage improvement in frame time. A CPU-bound frame may barely improve.

## Complete candidate catalogue

Every row is a proposal, including using existing settings in a new adaptive policy.
No row is marked implemented by this review. Benefits are conditional on the actual
bottleneck. Effort: **S** localized; **M** coordinated changes; **L** substantial
pipeline/architecture work. Shared work belongs in FOSS Earth; adapter fixes should
be upstreamed; application/content work belongs in the consumer.

### Equivalent rendering and less repeated work

| ID | Candidate | Expected performance effect | UX cost and effort |
| --- | --- | --- | --- |
| 1 | Real Google tile memory accounting, deduplicating shared textures/buffers and including mips/staging | Makes memory limits meaningful; reduces uncontrolled growth/context-loss risk | Accounting has no visual cost; smaller-cache eviction delays revisits. **M**, adapter/shared runtime |
| 2 | Cache native Google camera/frustum invariants once per traversal | Potentially substantial CPU and GC reduction at fine world detail | Same selection if equivalent. **M**, adapter |
| 3 | Panorama-only scene candidates or a separate lightweight scene during complete immersion | Avoids retained-world mesh evaluation each frame | None; restore world correctly during transitions. **M** |
| 4 | Per-job upload cancellation, active-image priority and correct reservation lifetime | Eliminates obsolete uploads/mips and foreground queue blocking | Improvement only. **M** |
| 5 | Gate panorama draw history, camera signatures and negative controls behind capture | Less allocation, string formatting and array movement | None. **S** |
| 6 | Opaque material variant for full-opacity immersion, including internal image blends | Potentially less framebuffer blending bandwidth | None; retain blending during globe-entry opacity fades. **S** |
| 7 | Equivalent shader simplification: vertex image rotation, one necessary normalization, cubemap direction simplification, per-draw orb constants; specialize unused outline/reveal branches | Less per-fragment arithmetic | Verify seams, orientation, precision and depth; compiler may already optimize some work. **S–M** |
| 8 | Conservative frustum/horizon culling before orb submission | Fewer draws, uniforms and fragments | None with correct expansion/edge cases. **M** |
| 9 | Shared geometry/materials and packed/instanced preview batches | Fewer draw calls, binds and objects | Preserve per-marker culling and seam-safe mips; WebGL1 fallback required. **L** |
| 10 | Separate camera updates from metadata/status publication; defer hidden panel work | Less serialization, allocation and DOM bookkeeping while looking | None; input remains immediate. **M** |
| 11 | Lower-rate informational HUD/percentile updates; skip hidden diagnostics | Less sorting and UI work per frame | Readouts refresh less often, navigation does not. **S–M** |
| 12 | Reuse hot-path vectors/arrays/matrices and unchanged uniforms; selectively freeze truly static transforms/materials | Less GC and engine bookkeeping | None with correct invalidation; never freeze a changing scene wholesale. **M** |
| 13 | Prepare likely shader variants during bounded idle work; use nonblocking completion where available | Fewer first-transition compilation stalls | Additional preparation/memory; avoid compiling every possible variant. **M** |

### Panorama delivery, textures and resource management

| ID | Candidate | Expected performance effect | UX cost and effort |
| --- | --- | --- | --- |
| 14 | Complete viewport/FOV/render-scale-aware representation selection with zoom/resize triggers and hysteresis | Avoids resolution the current view cannot display | Potentially imperceptible; zoom must be allowed to sharpen. **M** |
| 15 | Visible-first preview loading, projected-size selection, bounded nearby retention and suspension of irrelevant preview upgrades during immersion | Lower startup, network, decode and preview memory; prioritizes active image | Newly exposed previews may briefly sharpen; preserve list destinations and look-ahead. **M** |
| 16 | Offline cubemap immersion representations | Avoids equirectangular trig/seam-gradient work; smaller individual textures | Match actual angular sharpness, not nominal width; six faces alone do not guarantee memory savings. **M**, shared tool plus content |
| 17 | Multiresolution visible panorama tiles over a complete low-resolution fallback | High-detail viewing/zoom with much smaller detailed working set | Detail may appear after turns; need margins, priorities, gutters and seams. **L** |
| 18 | KTX2/Basis or native supported GPU-compressed representations | Potentially large GPU-memory and sampling-bandwidth reduction | Compression artifacts, transcoder CPU cost and fallback support. **L** |
| 19 | Offline mip chains with bounded upload | Moves mip generation off device; fewer entry spikes | Extra pipeline work and possibly bytes; preserve color/seams. **M–L** |
| 20 | Meter allocation, base uploads, mip work and completed large textures separately in time and bytes; adapt work to interaction | Reduces hitches not covered by current row-byte allowance | Slower sharpening while interaction stays responsive. **M–L** |
| 21 | Immutable WebGL2 texture storage with known levels | Less driver allocation/validation uncertainty | None; retain WebGL1 backend, allocation still costs time. **M** |
| 22 | Reuse bounded staging surfaces; reduce canvas resize and redundant pixel-store operations/queries | Less upload copying/setup overhead | None; coordinate state with Babylon, measure rather than assume typed-array readback is faster. **M** |
| 23 | Pipeline cube faces through fetch/decode/upload and release bitmaps safely | Lower temporary decoded peak and improved latency | Hide incomplete texture until usable. **M–L** |
| 24 | Shared map/panorama/decode/upload/overlap admission with browser/driver headroom | Avoids independently safe pools overwhelming one device | Background work waits; active content takes priority. **M–L** |
| 25 | Backpressure for temporary occupancy and smaller-representation recovery for actual allocation failure | Fewer avoidable failures and memory spikes | Temporary reduced detail instead of unavailable stop. **M** |
| 26 | Reduce chunk/contiguous-buffer/Blob copies and account for transient storage | Lower peak RAM and GC during loading | None; retain header validation and response limits. **M** |
| 27 | One fetchable container per six-face preview cube | Fewer small requests | Same pixels possible; do not bundle the whole scene and defeat selective loading. **M** |
| 28 | Pass through validated native-resolution source JPEGs when no transformation is needed | Smaller full-size downloads and avoids lossy re-encoding; quantified in UMN companion | No reduced detail; validate orientation/color/metadata. Does not reduce GPU size. **S–M**, shared tool plus content |
| 29 | Optimize reduced JPEGs and evaluate WebP/AVIF variants | Smaller transfers at matched appearance | Compare total fetch+decode time; old CPUs can decode a smaller file more slowly. Requires format/header support and JPEG fallback. **M** |
| 30 | Content-hashed URLs, suitable cache policy and bounded visited-stop/offline caching | Faster repeats and less network traffic | Storage/eviction costs; no mandatory whole-tour download. **M**, content delivery/shared optional cache |
| 31 | Predict likely next stops within explicit idle/data/memory allowances | Lower navigation wait | Wrong predictions waste data/heat; cancel or disable under pressure. Do not download every intermediate resolution by default. **M** |

### Deliberate visual or latency tradeoffs

Apply these only when needed or selected. Existing controls do not imply a new
automatic policy is implemented or approved.

| ID | Candidate | Expected performance effect | UX cost and effort |
| --- | --- | --- | --- |
| 32 | Lower framebuffer resolution independently of source-photo detail | Strong lever for pixel-bound GPU work | Softer canvas; HTML controls remain sharp. Existing `renderer.resolutionScale`: **S** manual, **M** adaptation |
| 33 | Disable MSAA on constrained devices | Less framebuffer memory and possibly GPU work | More jagged geometry/marker edges; little benefit to photo sampling itself. Existing `renderer.antialias` needs restart/recreation. **S** |
| 34 | Cap whole-image width; add a smaller emergency representation; retain suitable POT choices for WebGL1 | Large decode/upload/residency savings, potentially better sampling locality | Softer photo and less zoom detail. WebGL1 POT alternatives permit mips. **S–M** |
| 35 | Smaller preview textures without shrinking touch targets or labels | Lower preview memory/transfer/sampling work | Softer markers, independent of immersive photo quality. **S** |
| 36 | Static photo sprites/icons and optional marker clustering | Cheaper marker shaders, fewer draws, fewer required capabilities | Loses spherical/directional preview behavior; clustering adds a selection step. Last-resort marker mode, not a global downgrade. **M** |
| 37 | Reduce map anisotropy, for example 4 to 1–2 | Potential sampling-bandwidth reduction | Softer oblique terrain; retain useful mip filtering. **S** |
| 38 | Shorten/disable image replacement crossfades under pressure | Less overlap memory and two-source fragment work | More abrupt replacement/sharpening. **S–M** |
| 39 | Simpler entry/exit transitions using existing motion controls where applicable | Lower peak world/reveal/expansion work | Less animated geographic continuity; maintain camera handover contract and reduced-motion support. **S–M** |
| 40 | Evict distant/high-detail map caches during long immersion, keeping coarse return coverage | More room for photos; less retained scene overhead | Globe reloads/sharpens on return. **M** |
| 41 | A stable 30 FPS cap where selected/appropriate | Less heat and excess work when device has headroom | Less fluid than 60; cannot turn a 20 FPS workload into 30. Existing `renderer.frameRateCap`. **S** |
| 42 | Replace backdrop blur, large shadows/glows with simple fills | Potential compositor savings over moving content | Modest appearance change; preserve contrast. **S** |
| 43 | Temporary motion-time resolution/detail reduction with delayed restoration | Limits expensive refinement during interaction | Temporary softness/pop-in; prevent oscillation and repeated reloading. **M** |
| 44 | Selective lower shader precision for proven-safe local/color math | Possible older-GPU ALU/register benefit | Risk of banding/seams/jitter; preserve precision for sensitive UV/depth computations. Experimental **M** |

### Map and terrain work

| ID | Candidate | Expected performance effect | UX cost and effort |
| --- | --- | --- | --- |
| 45 | Skip Google reselection until camera/settings/transform/relevant residency changes | Less traversal while other work keeps frames active | None with complete load/retry/eviction invalidation. **M** |
| 46 | Coordinate Google download/parse concurrency with active panorama and input work | Fewer decode/completion bursts and less contention | Slower background refinement. **M** |
| 47 | Time-budget Google traversal, parsing, preprocessing and GPU commits | Fewer long frames from a single large job | Later refinement, preserve coarse coverage. **M–L** |
| 48 | Relate Google detail to actual render pixels through an explicit policy | Avoids detail a reduced framebuffer cannot resolve | Possible geometry change; retain meaningful detail-slider units. **M** |
| 49 | Defer unnecessary map completion/commit work during immersion; cancel obsolete demand | Less background CPU/upload contention | Globe may take longer to sharpen on return; avoid cancel/reload thrashing. **M** |
| 50 | Pure typed-array raster geometry preparation instead of disposable replacement meshes | Avoids temporary mesh uploads, extraction and disposal | Same geometry. **M** |
| 51 | Worker DEM decode and terrain preparation with bounded fallback | Less main-thread blocking | Same image; worker capability fallback needed. **M** |
| 52 | Shared immutable grid topology; omit normals only where verified unused | Less computation, geometry memory and upload | Same verified unlit output; check picking/debug consumers. **M** |
| 53 | Cache immutable terrain-selection data and bound traversal/commit work across all entry paths | Less allocation and fewer synchronous stalls | Later refinement; preserve crack-free atomic neighbor updates. **M** |
| 54 | Configurable byte-based DEM admission/retention, stale-demand cancellation, careful neighbor/border strategy | Fewer irrelevant loads/decodes and retained grids | Smaller limits slow revisits; changing borders needs seam checks. **M** |
| 55 | Incremental imagery page-table publication and maintained residency counters/queues | Less whole-patch scanning, sorting and hashing | None. **M** |
| 56 | Budget individual imagery pages, mips and page-table writes, not just complete images | Stops large first-image/publication work bypassing frame limits | Slower sharpening; publish complete fallback-safe state. **M** |
| 57 | Worker cancellation for stale imagery jobs and sliced main-thread fallback preparation | Less work after demand disappears; fewer fallback stalls | None. **M** |
| 58 | Reserve old/new atlas overlap or resize incrementally | Prevents temporary double allocation during budget changes | Best implementation preserves coverage; emergency drop may show coarse map. **M–L** |
| 59 | Minimal unlit raster shader; shared-grid/material/batched submission where compatible | Less material/driver work, possibly fewer draws | Preserve mapping, culling, depth and picking. **M–L** |
| 60 | Backface culling only for terrain/camera cases where it is correct | Less reverse-face work | Terrain disappears from below if used indiscriminately. Conditional **S–M** |
| 61 | Batch persistent map-cache index writes/pruning and bound body duplication | Less storage I/O, serialization and transient memory | Abrupt exit may lose newest cache bookkeeping, requiring redownload. **S–M** |

### Startup, simpler experiences and compatibility

| ID | Candidate | Expected performance effect | UX cost and effort |
| --- | --- | --- | --- |
| 62 | Audit broad Babylon value imports and use specific modules plus explicit registrations | Smaller initial download/parse/compile/heap footprint | Same features if registrations remain correct; inspect bundle before claiming size savings. **M** |
| 63 | Lazy-load unused engines/providers/editors/panels and defer hidden DOM construction | Lower startup work and memory | First opening a deferred feature may wait. **M** |
| 64 | Meaningful tour HTML with stops/descriptions/thumbnails before graphics initializes | Faster first usable content and useful failure path | Improvement; application-owned content. **M** |
| 65 | Lightweight panorama-first entry with globe loaded when requested | Avoids globe startup/data/scene overhead for photo-first visitors | Defers continuous world travel/map context. Shared viewer + app composition. **L** |
| 66 | Simple campus map or low-relief aerial fallback before sacrificing photos | Less world geometry/data/rendering | Loses photogrammetric buildings or unrestricted globe exploration. Shared capability + app content. **M–L** |
| 67 | Static perspective photos/text when interactive 360 cannot run | Almost no continuous graphics cost; content usable without WebGL | Final fallback loses free look while retaining tour information/navigation. Application work. **M** |
| 68 | Separate analytic-orb, simple-marker and immersive-viewer capability gates | Broadens device coverage | Reduce only unsupported decoration/features. **M** |
| 69 | Qualify real WebGL1 variants: derivative-free atlas path, cube dimension limits, allocation failure, context restoration | Avoids nominally supported devices failing | Better reliability; static concerns require real-context tests. **M** |
| 70 | Explicit browser support floor and feature-tested API fallbacks | More older browsers can boot and load content | Compatibility, not a steady-FPS cure. Syntax transforms do not supply missing APIs. **M** |

## Existing optimizations and traps to avoid

- Rendering already sleeps after motion/animation settles and pauses when the page
  is hidden. Audit remaining downloads/decodes/auxiliary timers separately; do not
  reimplement the scheduler or delay the input that wakes it.
- Immersion is already a full-screen triangle, not a highly tessellated sphere.
  Steady WebGL viewing already skips sRGB decode/re-encode; those operations matter
  during source crossfades. A hardware sRGB path is an optional experiment with color
  validation, not an established universal speedup.
- Uploads already use strips, bypass the staging canvas for complete images that fit,
  run before drawing, and use one WebGL2 fence per submitted frame. Extend these
  mechanisms rather than assuming uploads are wholly unbounded.
- Resource reuse, LRU for unreferenced sources, request/decode limits, header checks,
  independently ready previews, priority semaphores and device-loss invalidation exist.
  Referenced previews are not made evictable merely by having an LRU.
- Raster imagery has worker preparation, time-sliced selection, prioritized residency,
  fallback coverage, guttered mip pages and separation of imagery from terrain detail.
  Raster lighting is already disabled and terrain is not continuously CPU-morphed.
- WebGL1 NPOT images use clamp/bilinear without mips. Do not remove useful mips from
  other paths indiscriminately; they also improve minified sampling locality and
  stability. Do not pad a large image upward without considering the memory increase.
- Do not globally replace `highp`, remove analytic depth, or move discard ahead of
  derivative-dependent samples without an equivalent or explicitly degraded variant.
  Fragment depth/discard can affect early rejection on mobile GPUs, but changes need
  device tests and correct LOD derivatives.
- Smaller JPEG/AVIF files and a new media host target transfer behavior, not necessarily
  GPU memory or settled FPS. Splitting a modest manifest into many requests is low
  priority. Full-resolution originals may be reusable without re-encoding; do not
  automatically download every intermediate image rung.
- A frame cap saves work only when there is headroom. Longer animations do not reduce
  the cost of each frame. Missing WebGPU is a backend/capability fact, not a performance
  tier. Static sprites must remain an optional fallback, not a downgrade for everyone.
- The app's WebGL/WebGL2 choices currently use the same engine-construction path in
  [createRendererMode.ts](../src/engine/babylon/createRendererMode.ts). Selecting
  WebGL is not reliable proof of a forced WebGL1 context. Use an actually forced
  context when qualifying the fallback.

## Adaptive policy to evaluate

Reuse the settings registry and the useful 0sfs principles of measured evidence,
bounded shedding and cautious restoration. Do not copy flight-specific thresholds
or assume the flight's quality system qualifies this workload.

1. Measure globe navigation, settled panorama rotation, transitions, and loading
   separately. Do not infer one workload's settings from another's FPS.
2. Distinguish CPU, GPU, memory and network pressure. Reduce traversal/DOM/decode for
   CPU pressure, pixels/shader cost for GPU pressure, residency/overlap for memory,
   and requested bytes for network pressure. Missing measurements remain unknown.
3. Repair the frame-time goal. Reject poisoned intervals, exclude idle/background
   gaps, respect intentional caps, and do not interpret vsync-bound frames as proven
   spare GPU time. Observe frame distribution/stalls, not just average FPS.
4. Change one useful control at a time and observe the result. Downgrade after
   sustained trouble or a real allocation failure; restore slowly with hysteresis
   and enough headroom to avoid repeated downloads, allocations and oscillation.
5. Keep actual numeric controls, units, ranges, defaults, reasons and locks visible.
   Automatic changes stay within user-set limits. Presets are explicit copied values,
   not hidden branches on labels such as Low/Medium/High. Follow the
   [settings specification](proposals/settings.md).
6. Preserve immediate input, camera momentum, readable text, touch targets and all
   destinations. If motion is reduced, follow the existing
   [camera contract](camera-motion.md). Shed decorative/world work before fundamental
   navigation. Marker appearance, immersive source quality and framebuffer resolution
   are independent axes.
7. Treat device hints as a starting estimate only. Missing memory information is not
   evidence of abundant memory; maximum texture size is not a safe allocation budget.
   Persist user preferences separately from temporary automatic adjustments.

## How to turn the shortlist into measured decisions

No new runs were authorized or performed for this review. A future qualification
task should record source/build identity, actual context version/capabilities,
framebuffer dimensions, selected source representation, counts/bytes and workload
phase alongside timings. The testing device is a representative sample, not the
optimization target. Include older Android Firefox and other browser/GPU combinations,
with real WebGL1 and WebGL2 coverage and no accidental software GPU fallback.

Test cold startup, time to first usable stop, populated overview, steady 360 dragging,
zoom, loading while dragging, repeated/rapid stop changes, return to globe, and a
sustained session long enough to expose heat and memory growth. Include UI open/closed
and cold/warm cache comparisons. Preserve source content and viewpoint when comparing
representations or shaders, including seams, poles, text, fine foliage and orb depth.

Use the existing frame profiler and add panorama/decode/upload/mip/scene-evaluation
visibility as needed. Record p50/p95/p99 frame times, long stalls, interaction response,
load time, resource peaks and context losses. Compare against the 33.3 ms frame budget
for 30 FPS; define actual release thresholds from the intended device range. CPU
submission time is not GPU time. Use asynchronous disjoint timer queries where
supported and report unavailable/disjoint samples honestly. Do not turn timing
collection itself into permanent high-overhead production work.

Prioritize equivalent-output changes first. Then compare cubemap/equirectangular
immersion at matched visible quality. Use controlled resolution/source-size changes
to distinguish pixel cost from texture residency and CPU work. Retain results and
limitations before selecting compression, tiling, or visual fallbacks. Runtime fixes
belong in their owning repositories and need the applicable owner/consumer checks;
this documentation-only task needs no typecheck, test suite or build.

## Primary technical references

These support mechanisms, not measured speedups for this application:

- [MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices): allocation, batching, precision, mipmaps and avoiding blocking work.
- [Khronos KHR_parallel_shader_compile](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/): nonblocking compilation-completion polling.
- [Khronos EXT_disjoint_timer_query](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query/): asynchronous GPU timing.
- [Khronos WebGL specification](https://registry.khronos.org/webgl/specs/1.0/): capabilities, limits and error behavior.
- [Khronos KTX](https://www.khronos.org/ktx/): GPU-compressed texture delivery.
- [MDN WebGL textures](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Using_textures_in_WebGL): WebGL1 power-of-two restrictions.
- [MDN EXT_sRGB](https://developer.mozilla.org/en-US/docs/Web/API/EXT_sRGB): texture color-space capabilities.
- [Babylon ES6 packages](https://doc.babylonjs.com/setup/frameworkPackages/es6Support/): module import and registration considerations.

The source observations and application asset arithmetic above come from the local
review. Performance gains and fallback choices remain to be selected and measured.
