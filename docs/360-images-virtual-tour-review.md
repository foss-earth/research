# Panorama scenes: research review

Reviewed 2026-09-26. Owner: FOSS Earth.

The questions this review left open are answered in the
[research findings](proposals/research/panorama-scenes-research.md): what the orb shows,
with rendered comparisons; the existing tour's content and delivery; resolution, memory and
placement rules. The GPU measurements remain.

The [original research](360-images-virtual-tour-research.md) contains useful
techniques to investigate, but is not reliable enough to turn directly into an
implementation specification. It promotes hypotheses to mandatory architecture,
omits essential interaction and resource contracts, and contradicts the requested
selectable sphere renderer. Its source list names domains rather than identifiable
documents, so its numbered citations cannot be audited as written.

The [preliminary implementation spec](proposals/panorama-scenes.md) records the
proposed direction and remaining decisions. It is deliberately not a completed
handoff to an implementation agent. No performance experiments have been run.

## What survives the review

- Babylon.js and WebGPU are project requirements. They are not evidence that a
  particular algorithm wins, or that another engine cannot render panoramas well.
- Analytic sphere impostors, directly shaded quads, textured sphere meshes and
  cached views are useful candidates. They must be compared at equivalent visual
  quality, with the actual globe running.
- Preview resolution should follow projected size, and caching trades additional
  storage and update work against repeated projection work.
- The generic scene loader, panorama renderer and navigation belong in FOSS Earth.
  Campus branding and content can be scene data or a thin consuming application.

## Corrections that change the design

| Original claim | Finding and consequence |
| --- | --- |
| Sphere impostors are mathematically proven cheapest; mesh spheres must be abandoned | No proof or workload model is supplied. Impostors reduce vertices but introduce fragment work, discarded coverage and possibly depth writes. Keep the requested mesh option and adjustable tessellation. NVIDIA's impostor work also identifies fill rate and overdraw as costs; it does not establish this report's optimum. [True Impostors](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-21-true-impostors) |
| WebGPU guarantees smooth 60 FPS and makes fragment projection cheap | Unsupported without a device, workload and measurement. Native WGSL can avoid Babylon's GLSL translation startup cost; it does not remove pixel or texture bandwidth costs. [Babylon WGSL support](https://github.com/BabylonJS/Documentation/blob/master/content/setup/support/webGPU/webGPUWGSL.md) |
| Equirectangular always uses less GPU memory; cubemaps need six allocations and have inherent seams | A WebGPU cube view uses six layers of a texture and has seamless face sampling. Equal-quality memory depends on dimensions, format and mipmaps. Cubemaps can be prepared offline. Independently tiled faces and mip generation still need correct borders. [WebGPU texture views](https://www.w3.org/TR/webgpu/#enumdef-gputextureviewdimension) |
| Live rendering and caching are each definitively inefficient, so three distance tiers are mandatory | Unsupported. Caching can add a render pass and bandwidth when refreshed often. FOSS Earth's scheduler already stops static views. The proposed 10 m, 50 m, 5 degrees and two-updates-per-frame values have no established basis. |
| Analytic rendering offers infinite image fidelity | It can remove polygonal silhouette error; photograph resolution and sampling still limit detail. |
| Longitude can be recovered from an unsigned `acos`; choosing two UV charts guarantees every seam is fixed | Longitude needs quadrant information. Silhouette coverage, longitude derivatives, poles, texture wrap and mip filtering are separate problems. Explicit corrected gradients are an available technique, not a substitute for correctness fixtures. [WGSL textureSampleGrad](https://www.w3.org/TR/WGSL/#texturesamplegrad) |
| A quad is visually equivalent to a sphere automatically | Its depth is planar unless the shader writes the intersection depth. Bounds, clipping, overlap, silhouette and picking also need matching semantics. [WGSL fragment depth](https://www.w3.org/TR/WGSL/#builtin-values-frag_depth) |
| `scene.environmentTexture` swaps the globe for the immersive panorama | It supplies shared environment/reflection data to materials. Displaying a panorama and controlling globe visibility require their own rendering path. [Babylon environment documentation](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/materials/using/HDREnvironment.md), [PhotoDome](https://doc.babylonjs.com/features/featuresDeepDive/environment/360PhotoDome/) |
| Physics impostors should handle orb clicks | Ordinary ray intersection and picking suffice. The visible circle and transparent quad corners must not have identical hit behavior. [Babylon picking](https://doc.babylonjs.com/features/featuresDeepDive/mesh/interactions/picking_collisions/) |
| glTF plus KHR_interactivity makes this custom renderer and tour behavior portable | Interactivity graphs do not define portable arbitrary WGSL materials, panorama streaming or FOSS Earth's navigation mode. Those require a host contract or custom extension. Use glTF for model assets where appropriate. [glTF specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html), [interactivity specification](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_interactivity/Specification.adoc) |
| Twenty geographically placed panoramas require 3D Tiles, which natively defines their meaning | 3D Tiles describes hierarchical geospatial content and refinement, not a panorama-tour schema. It may later index large scene collections; twenty records do not require it. [OGC 3D Tiles](https://www.ogc.org/standards/3dtiles/), [normative source](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc) |

The July 2026 interactivity announcement is real. The current Khronos registry
and specification now mark the extension ratified. Babylon implements a loader;
the local installation inspected is 8.56.2 and includes it. That does not establish
conformance to the newly ratified revision. If adopted later, pin versions and
test a representative asset. Rejecting the proposed architecture does not require
claiming that this extension is nonexistent or unsupported.
[Khronos announcement](https://www.khronos.org/news/press/gltf-interactivity-extension-submitted-for-ratification),
[extension registry](https://github.com/KhronosGroup/glTF/blob/main/extensions/README.md),
[Babylon loader](https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/loaders/src/glTF/2.0/Extensions/KHR_interactivity.pure.ts).

## First decide what the orb means

These are different pictures, not interchangeable optimization strategies:

| Appearance | Sampling concept | Entry implication |
| --- | --- | --- |
| Textured ball | Sample the panorama using the exterior sphere's surface direction | The front surface points toward the observer; this is generally opposite the observer's viewing direction. Entering is not automatically continuous. |
| Window into a panorama | Sample view rays from a virtual camera at the photograph's capture point, inside a circular or spherical boundary | Preview orientation and FOV can be carried into the immersive view. A circular window need not perform a sphere intersection for its image mapping. |
| Reflective or refractive bubble | Transform rays with a chosen optical model | Adds deliberate distortion and different continuity rules. It should not be accidentally produced by the cheapest shader. |

This distinction follows from geometry. The recommendation is to explore a
directional window first because it most closely matches “a window into the 360
image.” The user has not yet selected the visual contract. A mesh and a quad may
both support a chosen appearance; changing the renderer should not silently change
which part of the photograph is visible.

A single monoscopic panorama records directions from one capture point. It does
not contain the depth or missing surfaces needed for correct translation through
the photographed space. Globe movement can reveal different previews; immersion
should initially rotate at the capture point. An animated transition can be
convincing without claiming reconstructed parallax.

## The budget the research largely omitted

The following are arithmetic examples, not measured allocations or recommended
defaults. Assume uncompressed RGBA8 and no depth attachments or staging copies:

| Resources | Base-level memory | With a full mip chain, approximately |
| --- | ---: | ---: |
| Twenty 8192 × 4096 panorama sources | 2,560 MiB | 3,413 MiB |
| Twenty 1024 × 512 panorama preview sources | 40 MiB | 53.3 MiB |
| Twenty 1024 × 1024 rendered sprite caches | 80 MiB | 106.7 MiB |
| Twenty 128 × 128 rendered sprite caches | 1.25 MiB | 1.67 MiB |

Calculation: width × height × bytes per texel × count. Full mip chains approach
4/3 of the base level. Download compression and GPU texture compression are
different: small JPEG files can decode to large textures. KTX2/Basis is a candidate
for GPU compression, with quality, supported target formats and transcode cost to
evaluate. [Khronos KTX guide](https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXArtistGuide.md).

Separate three policies: **source residency**, **rendered-view caching**, and
**geometry detail**. Rendering a low-resolution source directly already avoids
loading the full source; it does not require baking a sprite first. The selected
panorama can refine independently. Existing viewers demonstrate persistent
previews and visible-region image pyramids without dictating which engine to use.
[Pannellum formats](https://pannellum.org/documentation/overview/),
[Marzipano setup](https://www.marzipano.net/docs.html),
[visible-tile selection](https://www.marzipano.net/reference/CubeGeometry.html).

A useful cache cost model is `N × P` for direct projection, versus
`U × B + N × S` for cached display, where N is rendered frames, U is cache updates,
P is direct projection cost, B is bake cost including target writes, and S is
cached sampling cost. Caching helps only when saved work exceeds its added costs.
This is a reasoning model, not a performance result. FOSS Earth's
[render scheduler](../src/engine/babylon/renderScheduler.ts) already reduces N
to zero while idle.

Screen footprint depends on object size, distance, projection/FOV, viewport and
render scale. For a small on-axis sphere, projected diameter is approximately
`viewportHeight × radius / (distance × tan(verticalFov / 2))`. Use conservative
projected bounds in implementation, including close and off-axis cases. Distance
also changes exterior-sphere perspective; caching only heading and pitch is not
exact. An angular-bin cache grows as heading bins × pitch bins × resolution levels,
with further dimensions if the visual model requires them, rather than an inherent
fixed set of “three knobs cubed.”

## Missing work that matters to the experience

1. **Interaction and orientation.** Define preview direction, entry framing,
   drag-versus-click, touch and keyboard operation, zoom, linked viewpoints, exit,
   cancellation, browser Back and return-camera behavior. Performance alone does
   not make navigation intuitive.
2. **Asset preparation.** Decide accepted images, preview generation, orientation
   editing, image dimensions, partial panoramas, color treatment, hosting/CORS and
   readiness/failure states. Define capture position separately from the orb's
   decorative display height. GPano already distinguishes image pose, initial
   view and crop metadata; use or explicitly translate those conventions.
   [Photo Sphere metadata](https://developers.google.com/streetview/spherical-metadata).
3. **Discovery and occlusion.** Orbs behind buildings, overlapping markers, small
   touch targets and interior viewpoints need a policy. A scene list can preserve
   access to places that are not currently visible in the globe.
4. **Navigation ownership.** Current globe handlers, inertia and map changes can
   continue to control the globe camera. Panorama entry needs a generic session
   contract rather than the flight-specific simulation mode. Async scene teardown
   and late texture arrivals also need explicit ownership.
5. **Accessible operation.** Named, keyboard-operable destinations and focus
   restoration belong in the first usable path. Honor reduced motion for entry
   animation. These improve the proposed interaction; this review makes no legal
   compliance claim. [W3C keyboard guidance](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html),
   [interaction animation guidance](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html).
6. **Capability and quality targets.** Name actual target devices/browsers,
   frame-time and loading targets, source resolutions and total scene sizes.
   The original research invented a Snapdragon baseline. Current FOSS Earth can
   fall back to WebGL even when WebGPU is requested; the new feature needs an
   explicit behavior when actual WebGPU initialization fails.

## What to research or compare next

The research items below are answered in the
[research findings](proposals/research/panorama-scenes-research.md); the rendering
experiment is listed there under what still needs measuring.

First settle the orb appearance and the first release's entity types. Then compare
one representative entry/exit interaction and establish an asset contract using
representative images. Only then should a rendering experiment choose defaults
among direct projection, adjustable mesh geometry and optional cached output.
Benchmarking unrelated projections would answer the wrong question.

The old [side-by-side viewer source](https://github.com/Felipegalind0/360-Side-By-Side/blob/main/components/panorama-viewer.tsx)
is useful as a feature reference: one sphere material selects between two textures
using a screen-space divider, and its render loop runs continuously. This does not
prove its bottleneck is Three.js or WebGL. No code reuse is proposed. Whether
comparison mode belongs in the new first release is still a product decision.

This review inspected the local FOSS Earth architecture and primary technical
sources. The supplied YouVisit hash URL returned the marketing page to the text
fetcher, not an inspectable tour session. Therefore this is not an observed UX or
performance diagnosis of the current UMN tour. A focused evaluation should later
record time and mistakes for finding a location, entering, looking around, moving
to another stop and returning to the overview, alongside rendering measurements.
