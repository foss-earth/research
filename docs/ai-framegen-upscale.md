# Shared FOSS Earth AI frame generation and upscaling: research review

Reviewed **2026-10-12**. Status: source audit and experiment proposal; no inference
prototype or application performance results were produced in this review.

The supplied report contains useful terminology and some real upstream features,
but its implementation guide is not usable as written. Its central rejection of
browser frame generation is too broad for the requested tradeoff: **smoother
presentation, with explicitly accepted additional latency**. The appropriate next
step is a small WebGPU feasibility experiment, not a promise of production gains.

## Scope and provenance

This study covers optional, client-side neural frame interpolation and neural
super-resolution shared by FOSS Earth applications, including the UMN tour,
globe/panorama viewers, and 0SFS. Both should default to off and work independently.
Research and reusable implementation belong in FOSS Earth. Work in a consumer
repository is warranted only for an integration requirement that cannot be
handled by the shared owners; the initial experiments require none.
Non-neural scaling is included only as a comparison needed to establish whether
AI adds value. JPEG/jpeg-js work, WASM sky work, terrain/streaming optimization,
physics optimization, and general renderer tuning belong to the separate ongoing
workstream. Nothing in those implementations was changed for this review.

The [original report](sources/ai-framegen-upscale-original.md) is preserved
verbatim, including its unverified claims and Google grounding redirects. It was
copied from `foss-earth/research/ai_framegen_upscale.md` after the user saved it.
Its 35,759 bytes have SHA-256
`1293c43723ec53d8764d3954d1531b8838f52b5e8f777b9bf75bcffacbf32761`.
That archive is evidence of what was reviewed, not an endorsed implementation.

The links below are direct primary references replacing reliance on opaque
redirect citations. Upstream pages and local working trees were inspected on the
review date; upstream `main`/`master` links can change. Local findings concern
source checkouts, not generated `app/build/ws/...` copies or a verified deployed
build. Several working trees contain uncommitted work, so their HEAD commits
alone would not reproduce this state.

## What the report gets right, and what needs correction

| Report claim | Assessment | Consequence |
| --- | --- | --- |
| Spatial upscaling, temporal upscaling, and frame generation are different operations. | Correct. FSR 1 processes one image; FSR 2 reconstructs using temporal inputs; interpolation produces additional images. | Keep these distinct in settings and measurements. |
| The proposed FSR path answers the AI request. | Incorrect classification. FSR 1, FSR 2, and the original FSR 3 pipeline discussed here are analytical, not neural. | Useful controls; they do not evaluate AI inference. Later ML FSR products must not be conflated with these versions. |
| Babylon has `FSR1RenderingPipeline`. | True upstream: PR #18723 merged August 13, 2026. False as an immediately available dependency here: installed Babylon is 8.56.2 and lacks it. | An upgrade/backport would be separate work, unnecessary for the initial neural-model harness. |
| Missing swapchain access makes browser frame generation impossible. | Overreach. Native SDK pacing is unavailable, but an application can display generated textures on browser presentation ticks. | Buffered interpolation remains a legitimate experiment for this user. |
| Added latency makes 30→60 interpolation unacceptable. | A preference presented as a technical prohibition. | Measure and disclose the cost; the user explicitly accepts that tradeoff. |
| rAF means a universal 60 Hz / 16.67 ms limit. | Incorrect. Callbacks generally follow display refresh, subject to browser scheduling and throttling. | Measure available cadence; 60→120 requires a browser/display path actually delivering about 120 updates/s. |
| `scaleFactor = 0.5` enables FSR performance mode; `1` disables it. | Both wrong for upstream Babylon's API. | See the code critique below. |
| A 12.21% pixel difference from bilinear proves reconstruction quality. | Misinterpreted visualization check. It establishes different output, not fidelity, recovered detail, or speed. | Use reference images, motion sequences, timing, and user evaluation. |
| Half-resolution rendering normally guarantees 40–60% more FPS. | Unsupported as a prediction for 0SFS. | Pixel work may decrease, but CPU work, geometry, reconstruction, and presentation still cost time. |
| `@pmndrs/upscaler` is effectively a ready FSR/Babylon integration. | Misleading. The current integration targets Three.js; a renderer-independent core is still proposed. | Raw device access alone does not supply an adapter. |
| Camera lifecycle and HUD separation matter. | Correct concerns; the sample is incomplete. | Track actual world views and resource lifecycle; preserve readable UI and specify timing. |
| Generic WASM speedups establish that JSBSim saturates this app's CPU. | Unsupported extrapolation. | Profile this app; image reconstruction does not accelerate physics. |

The original report targets 0SFS, so the audit retains that context where needed
to assess its claims. It does not make flight-specific integration the shared
feature's implementation plan.

Algorithm distinctions are supported by [AMD's FSR 1 documentation](https://gpuopen.com/fidelityfx-superresolution/),
[FSR 2 documentation](https://gpuopen.com/fidelityfx-superresolution-2/), and the
[FSR 3 analytical pipeline presentation](https://gpuopen.com/download/GDC2024_High_Performance_Rendering_in_Snowdrop_Using_AMD_FidelityFX_Super_Resolution_3.pdf).
The upstream feature and pixel-difference check are recorded in
[Babylon PR #18723](https://github.com/BabylonJS/Babylon.js/pull/18723).

The report's hardware limits also need qualification. A 4096×4096 RGBA8 base
texture is 64 MiB by arithmetic; mipmaps, extra copies and format change the
allocation. That does not imply universal mobile memory or draw-call crash
thresholds. Its 24 ms versus 48 ms latency example and 8.22×–26.99× WASM numbers
are not measurements of this application and should not be used for planning.

Upscaling alone does not inherently need future-frame buffering. It can reduce
or increase latency depending on whether saved rendering work outweighs its
inference cost. Bidirectional frame interpolation introduces a different,
explicit lookahead cost; this is another reason for independent controls.

## Why browser interpolation remains possible

The browser owns composition and does not expose AMD's native replacement
swapchain or a JavaScript command guaranteeing presentation at an arbitrary
wall-clock instant. AMD's native integration provides special pacing and UI
composition; its interpolation compute itself can run synchronously or
asynchronously. Those native integration facilities are not prerequisites for
the mathematical act of synthesizing another image.
[AMD integration documentation](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-interpolation/).

`requestAnimationFrame` schedules work before repaint; a WebGPU canvas accepts a
texture to be composited. **Engineering inference:** an application can render
its expensive world less often, retain source images, generate intermediate
images, and draw the chosen image at each available presentation tick. It cannot
force additional visible refreshes beyond the browser/display cadence or
guarantee that every submitted image is displayed.
[rAF documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame),
[GPU canvas interface](https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext).

Conceptual steady-state sequence, after buffering:

```text
Source scene images:       A ---------------- B ---------------- C
Presented image content:   A ------ I(A,B) --- B ------ I(B,C) --- C
                           presentation runs behind source production
```

`I(A,B)` is a generated midpoint. Showing A and later inserting an earlier
midpoint after B has already been shown would reverse visual time. Ordered
timestamps and a deliberate presentation delay prevent that mistake.

For source interval T, the midpoint represents time T/2 but requires the endpoint
at T. Its lookahead alone is T/2, before endpoint completion and inference. A
simple prototype can budget about one source interval of presentation buffering,
plus processing/scheduling allowance. That policy contributes about 33.3 ms at
30 source FPS or 16.7 ms at 60; it is **not** a universal latency minimum or total
input-to-photon estimate. End-to-end latency includes input polling, simulation,
render completion, inference, queueing, composition and scanout.

More tolerance for latency makes buffering useful. It does not increase
throughput: a GPU that needs more work per second than it can execute will keep
falling behind. A source frame that blocks the main thread for 30 ms can also
prevent a 60 Hz presentation loop from running on time. These are measurable
failure modes, not reasons to prohibit the feature categorically.

Treat 30→60 and 60→120 as experiment targets. AMD recommends at least 60 source
FPS for its own FSR 3 implementation and warns against sub-30 input because
artifacts become more prominent. That is useful quality context, not proof that
every independent neural interpolator must use the same threshold.
[AMD FSR 3 guidance](https://gpuopen.com/fidelityfx-super-resolution-3/).

## Why the supplied code should not be pasted into the app

The [upstream Babylon implementation](https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/PostProcesses/RenderPipeline/Pipelines/fsr1RenderingPipeline.ts)
uses `scaleFactor` as an output/input dimension ratio: performance is **2**,
quality is **1.5**. The render-target scale is its reciprocal. Thus `0.5` asks
for a larger input target, and `1` retains EASU/RCAS at native size rather than
turning the pipeline off. The constructor defaults to `scene.cameras`; passing
`[]` avoids attachment but still creates resources. Its default four MSAA
samples also belong in cost comparisons. Changes to the scale rebuild the
pipeline. These facts refer to upstream code, not the installed 8.56.2 package.

Other problems are integration choices rather than FSR API details:

- The example starts the pipeline at performance scale while its React checkbox
  starts false. That violates the requested opt-in behavior.
- A global `window.flightSimFSR` and local checkbox state bypass the existing
  settings/lifecycle ownership and can become stale across app teardown.
- Attaching to every camera except one named `uiCamera` is not a reliable
  declaration of which views should be reconstructed. Camera creation also does
  not cover all activation, removal, resize, or history-reset cases.
- The example lacks observer removal, actual bypass, resource cleanup, device
  loss handling, and interaction with the existing resolution-scale setting.
- Access to a private `_device` is an implementation dependency, not a complete
  texture, synchronization, or ownership contract for another library.

The current [pmndrs README](https://github.com/pmndrs/upscaler) describes a
Three.js WebGPU integration and an FSR-derived temporal architecture that differs
from AMD's original pass graph. It does not supply neural inference or frame
generation. A [renderer-independent core proposal](https://github.com/pmndrs/upscaler/issues/61)
remains open as of this review. Its decision to omit frame generation does not
establish that a separate browser implementation is impossible.

## Shared ownership and reuse

The intended implementation is a reusable presentation feature in FOSS Earth,
consumed by the UMN tour and other apps through their existing runtime integration.
Keep algorithm selection, model loading, capability checks, settings definitions,
buffering, fallback and diagnostics shared. Do not duplicate an inference loop
or graphics settings implementation in each app.

| Owner | Proposed responsibility |
| --- | --- |
| `foss-earth/research` | This assessment, replay fixtures, model-export experiments and benchmark evidence. It remains a development/research package, not a runtime dependency. |
| `foss-earth/renderer` | GPU capture/conversion, inference adapter, reconstruction/presentation, bounded history, frame scheduling, diagnostics and renderer setting definitions. Fit into its existing resource and device lifecycle. |
| `foss-earth/app` | Compose the shared runtime and register/expose renderer settings. Use the existing single scheduler and lifecycle rather than adding a consumer-owned animation loop. |
| `foss-earth/ui` | Existing shared settings registry and controls. Renderer-specific policy belongs to the renderer feature. |
| `foss-earth/engine` | Any necessary shared preparation/timing or temporal-input contracts. Keep source preparation independent from generated-image presentation. |
| `foss-earth/360` and `foss-earth/scenes` | Existing view/navigation/transition behavior. Communicate relevant discontinuities and presentation needs through shared contracts; keep inference in the renderer. |
| Consumer apps | Only genuinely app-specific overlay timing or integration policy that shared settings/contracts cannot express. No initial 0SFS or UMN repo edits are required. |

These are proposed responsibilities, not already implemented API contracts. A
separate runtime package should be introduced only if demonstrated reuse or
dependency isolation warrants it; simply sharing the renderer feature does not
require one.

## What the FOSS Earth checkout implies

Paths below are relative to the shared checkout directory containing
`foss-earth/`. Line numbers are observations on the review date, not stable APIs.

| Local evidence | Finding and implication |
| --- | --- |
| `foss-earth/app/package.json:65`; `foss-earth/renderer/package.json:88`; `foss-earth/engine/package.json:123`; installed `foss-earth/app/node_modules/@babylonjs/core/package.json:3` | Babylon is pinned/installed at 8.56.2. No FSR files were found in that installed package. |
| `foss-earth/renderer/src/babylon/createRendererMode.ts:93` | WebGPU already exists, with fallbacks. Large-world rendering and reverse depth matter for temporal reconstruction. |
| `foss-earth/app/src/app/runtimeComposition.ts:72`; `foss-earth/renderer/src/babylon/rendererLifecycle.ts:137` | App composes the scheduler and renderer; lifecycle owns begin-frame → prepare → scene render → end-frame. This is the likely generic presentation boundary. |
| `foss-earth/renderer/src/babylon/rendererLifecycle.ts:80` | Existing resolution scale changes hardware scaling. It is an important non-AI baseline. |
| `foss-earth/renderer/src/settings/catalogue.ts:6`; `:25`; `:54` | Renderer settings already describe backend, resolution and frame-rate behavior. Shared AI controls should extend that feature ownership. |
| `foss-earth/app/src/settings/catalogue/index.ts:26`; `foss-earth/app/src/settings/appSettings.ts:23` | App registers owner-provided settings through the shared registry. |
| `foss-earth/renderer/src/renderScheduler.ts:106`; `foss-earth/engine/src/babylon/createGlobeRuntime.ts:675` | Frame capping gates preparation, and simulation delta comes from Babylon's frame delta. A second presentation cadence cannot simply reuse this coupling. |
| `foss-earth/renderer/src/babylon/rendererLifecycle.ts:102`; `:107`; `:108` | Resize, hidden-page pause and device-generation changes already have lifecycle handling. Inference must follow the same lifecycle. |
| `foss-earth/360/src/globeBindings.ts:119`; `foss-earth/360/src/viewer.ts:694` | Panorama animation joins engine preparation. Synthetic presentation should not rerun it. |
| `foss-earth/360/src/viewer.ts:246`; `:371`; `:534` | Animation/inertia hold and release rendering; entry/exit changes the presentation view. Preserve idle behavior and communicate history boundaries. |

No general runtime motion-vector/depth export or existing AI presentation path
was found in the inspected shared renderer and engine source. This is a scoped
search finding, not a claim about every dependency. Neural image-pair
interpolation avoids needing engine motion vectors; a temporal upscaler or
engine-assisted interpolator would need valid velocity/depth/history inputs,
including camera motion, moving geometry and origin shifts.

**Critical timing constraint:** inserting synthetic `beginFrame/endFrame` calls
can change `engine.getDeltaTime()` to a display interval while host updates still
run only on source frames. Keep application/simulation time, source-render time,
and presentation time explicit. Generated images must not advance navigation,
transitions or physics an extra time or reduce their intended update cadence.
The original flight audit found an existing fixed-step simulation and separate
HUD, illustrating why consumers may need overlay timing policy; those specifics
do not belong in the generic reconstruction algorithm.

Coordinate any later shared adapter change with the other agent. The first
model experiment can use recorded frames in `foss-earth/research` and avoid
touching live consumer, rendering or sky code entirely.

## UMN tour and other viewer workloads

Benefit is a hypothesis for each workload, not an automatic consequence of using
FOSS Earth. A tour fixture should cover panorama rotation, zoom, scene changes,
transitions, image refinement, navigation hotspots and overlay text. A globe
fixture should cover orbit/translation, terrain silhouettes and changing tile
coverage. Flight sequences remain an additional stress case rather than the
only benchmark.

Keep idle views idle. Once a static panorama settles, repeatedly generating
identical frames adds work without motion smoothness. Stop inference when the
shared scheduler no longer needs continuous presentation, and resume with valid
history when motion restarts. Allow a bounded delayed tail to finish, then release
the presentation work instead of retaining an always-running loop. On scene
switches or discontinuous imagery changes,
reset or explicitly handle history so interpolation does not invent a morph
between unrelated locations. Deliberate transition effects need their own
quality test and a way to bypass reconstruction when it harms the transition.

DOM labels and controls can remain outside reconstruction. Picking and
scene-anchored overlays need an explicit relationship to the displayed image:
interacting with a delayed panorama using only the newest camera state can
misalign a hotspot or highlight. Prefer a shared presentation timestamp/camera
contract that consumers can use when needed. No UMN-specific performance or
interaction correctness has been established by this review.

## Actual neural candidates

These are candidates to test, not browser-ready integrations or performance
endorsements. Pin the implementation, exported graph, weights and hashes before
recording benchmark results.

| Candidate | Proposed role | Verified basis and remaining work |
| --- | --- | --- |
| Practical-RIFE lite, initially 4.25.lite | Generate one midpoint between real images. | Maintainer publishes lower-compute lite models and explicitly licenses linked weights under MIT. Official path is Python/PyTorch; export and browser execution need validation. [Repository](https://github.com/hzwer/Practical-RIFE). |
| RT4KSR x2 | First compact neural super-resolution comparison. | Official models/checkpoints and an inference reparameterization path exist; project is Apache-2.0. Export the inference form and test actual rendered globe/panorama images, not only the paper's downsampling setup. [Repository](https://github.com/eduardzamfir/RT4KSR), [paper](https://openaccess.thecvf.com/content/CVPR2023W/NTIRE/papers/Zamfir_Towards_Real-Time_4K_Image_Super-Resolution_CVPRW_2023_paper.pdf). |
| SPAN | Optional second SR candidate if the first merits further work. | Efficient single-image SR with official implementation/checkpoints and Apache-2.0 project license. No inspected source demonstrates this workload in this browser app. [Repository](https://github.com/hongyuanyu/SPAN). |

RIFE is a practical first hypothesis because it operates on images rather than
requiring a new full-scene motion-vector pass. Its trained image/video priors can
still fail on fast camera rotation, panorama seams, thin architecture, scene
transitions, newly revealed terrain and tile replacement. Flight fixtures should
add wings, cockpit edges and propellers. Single-image neural SR similarly
does not guarantee temporal stability: compare flicker and invented detail over
time, not just attractive still frames.

The missing step is more than downloading weights. A plausible execution route
is ONNX Runtime Web's WebGPU provider. Its GPU-buffer input/output support can
avoid CPU round trips; its default tensor path otherwise copies between CPU and
GPU. A shared device can be configured before the first WebGPU session.
[ORT GPU tensors](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html),
[device configuration](https://onnxruntime.ai/docs/api/js/interfaces/Env.WebGpuFlags.html).

Renderer textures still need GPU conversion to the model's layout, channel order,
range and precision, then conversion back to a display texture. Measure these
passes. Verify color space, alpha, padding/cropping, resize and output parity with
the model's reference implementation. A second GPU device cannot simply consume
the first device's buffers.

Operator coverage is an early rejection test, not proof of correct execution.
RIFE's warp uses `grid_sample`; the inspected ORT WebGPU support table lists
`GridSample` for opsets 16–19. Check the exact exported graph's operators,
attributes, shapes and precision, and detect unintended CPU fallback. Optional
graph capture needs static shapes and execution on GPU throughout.
[RIFE warp](https://github.com/hzwer/ECCV2022-RIFE/blob/main/model/warplayer.py),
[ORT operator table](https://github.com/microsoft/onnxruntime/blob/main/js/web/docs/webgpu-operators.md),
[graph capture requirements](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html).

The initial live prototype should be WebGPU-only with normal rendering as
fallback. Capability checks and a short benchmark are more useful than assuming
all browsers or GPUs supporting WebGPU can run a particular model fast enough.
Keep models unloaded while the options are off; acquire and initialize them only
when the user enables the experiment. Record model size, startup cost, license
and weight provenance alongside results.

## Experiment that would settle the question

1. **Make shared replay fixtures in FOSS Earth research.** Capture repeatable
   world-only panorama/tour and globe sequences with source timestamps and
   higher-cadence reference frames. Include rotation, zoom, scene transitions,
   tile/image refinement and idle-to-motion changes; include hotspot/overlay
   alignment in a separate interaction check. Add flight sequences as an optional
   consumer stress case. Use both steady and irregular source cadence. This does
   not require changes to JPEG or sky algorithms or work in consumer repos.
2. **Prove the GPU path.** Test a fixed-size RIFE-lite export and an RT4KSR x2
   export separately. Validate output against the reference models and measure
   conversion → inference → conversion → presentation with GPU-resident data.
   Include warmup and steady-state measurements. Do not extrapolate CUDA timing
   or a model-only microbenchmark to the live app.
3. **Compare controls.** Measure native rendering; ordinary reduced-resolution
   scaling; reduced source cadence with repeated frames; neural SR alone; neural
   interpolation alone; and combined SR/interpolation. Add FSR 1 only if cheaply
   available in the harness. Repeated-frame and ordinary-scaling controls expose
   the benefit from changing source workload before crediting the neural model.
4. **Integrate only a successful candidate.** Add world-color capture and
   presentation through the existing lifecycle, bounded history, separate clocks,
   and true off/bypass behavior in FOSS Earth's shared owners. Expose independent
   opt-in settings through the common renderer/settings integration. No native
   dependency upgrade or consumer-specific pipeline should be assumed to be part
   of this experiment.
5. **Measure on target devices while the app is busy.** Include discrete and
   integrated GPUs, with device/browser/driver versions, actual canvas pixels and
   refresh cadence recorded. Keep other optimization settings and build inputs
   fixed between comparisons; rerun against the other agent's final baseline.

Start with 2× presentation only. Compare both orderings when combining features:
upscale real images then interpolate at output resolution, or interpolate at
source resolution then upscale every presented image. The first makes frame
generation more expensive spatially; the second invokes SR more often. Neither
ordering is automatically faster or better looking.

For the second ordering, a useful **illustrative capacity check**, in milliseconds
of GPU work per source interval, is:

```text
R_low + G_low + 2*U + 2*P + C < 1000 / sourceFPS

R_low = real world render work; G_low = one generated midpoint
U = one neural upscale; P = one presentation/composition
C = remaining copies, layout conversions and other GPU work
```

This is a necessary average-work screen for a serialized workload, not a timing
guarantee. Dependencies, CPU submission, competing work and per-slot deadlines
still matter. On a GPU already near capacity, inference can lower source FPS and
make the result worse. SR alone earns a speed claim only when lower-resolution
rendering plus reconstruction and transfer overhead beats the comparison at an
acceptable quality level.

The promising interpolation case is a reasonably steady source cadence with
spare GPU capacity: fewer full scene draws may leave room for synthesized images.
It does not remove the simulation's CPU work, and long main-thread stalls can
still spoil presentation. Severe GPU saturation is a poor starting point unless
lower-resolution rendering first creates enough headroom.

For a prototype, require bounded queues (for example, two source frames, a
generated result and a limited in-flight slot). Tag outputs with source time,
camera, size and device generation. Drop obsolete work rather than accumulate
ever-older results. Reset on cuts/view switches, teleport, resolution changes,
pause/resume and device loss; origin changes require either correct reprojection
or invalidation in a temporal geometry-aware path. Hold or show a valid real
image when interpolation is unavailable, with an explicit transition back to
the delayed timeline. Do not interpolate across a discontinuity.

Keep controls/text outside image synthesis. Define how scene-anchored overlays
and picking follow the displayed frame; consumers such as flight apps must also
decide whether instruments show delayed world time or current simulation state.
Buttons and cursor feedback can remain responsive without making the world image current.
The existing hidden-page/idle cancellation and device cleanup must also stop
inference and release its textures/buffers.

Report at least:

- Real scene renders/s, generated images/s, submitted presentations/s, repeated
  frames, and missed deadlines separately. A single FPS counter is misleading.
- p50/p95/p99 source and presentation intervals, GPU stage time where available,
  main-thread stalls and queue age. rAF/submit timing is not proof of physical
  scanout; use capture/external measurement for an input-to-photon claim.
- Added input-to-visible delay relative to the same build with the option off,
  including warm and sustained behavior. Report a timing proxy as a proxy.
- Peak allocations, model download/initialization time, sustained thermal/power
  behavior, and whether results degrade after several minutes.
- Sequence quality against held-out real intermediate/high-resolution frames,
  plus human review of motion and controls. Pixel metrics alone miss objectionable
  warping, temporal shimmer and readability failures.

Proposed advancement criteria: parity-correct model execution, sustained target
cadence with measured headroom, bounded delay within the selected user budget,
fewer repeated/missed presentation slots than the matched control, acceptable
motion quality, and correct teardown/timing. Stop a candidate that fails these
tests; accepting more latency is not a reason to ship unbounded buffering or
worse sustained pacing.

## Recommendation

Preserve the report as background, replace its browser-impossibility conclusion,
and reject its copy-paste implementation. First evaluate **RIFE-lite midpoint
interpolation** and **RT4KSR x2 upscaling** independently in a small browser
harness in `foss-earth/research`. Implement a successful result through the
shared FOSS Earth renderer/app/settings owners so the UMN tour and other apps
can consume it. Advance whichever demonstrates a benefit on target hardware; combine
them only after measuring the additional cost. Use explicit opt-in controls that
describe smoother motion, delayed response and possible image artifacts, with
normal rendering available immediately when disabled.

This review establishes plausible mechanisms and concrete integration risks. It
does not establish realtime neural inference, image quality, latency, or a net
performance gain for the UMN tour, 0SFS, or any other FOSS Earth app. Those are the
outputs of the proposed experiment.
