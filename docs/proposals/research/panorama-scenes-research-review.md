# Review of the second panorama research

Reviewed 2026-09-26. Owner: FOSS Earth. Source:
[Panorama scenes: research findings](panorama-scenes-research.md), committed in
`54ecbae`. This review leaves that research and its figures unchanged.

**Start a staged implementation proposal now.** The research is sufficient to
choose a direction and define the work. It is not sufficient to freeze the claimed
optimal renderer, preferred transition, or resource defaults. Close a small set of
visual-contract questions before committing the production implementation; make
GPU measurements a later implementation stage. Another broad literature survey is
not the next useful task.

The [next-step prompt](panorama-scenes-proposal-prompt.md) makes this concrete:
correct the overclaims, extend the CPU reference for the missing transition cases,
and consolidate the existing preliminary spec into one coherent proposal.

## What the new research accomplished

- The rendered appearance comparisons are useful evidence of what each mapping
  means. They move the window-versus-ball discussion beyond ambiguous terminology.
- Small cube previews, independent immersion detail, and explicit memory arithmetic
  provide a credible starting resource model. These are proposals with reasons,
  rather than the original report's mandatory near/mid/far tiers.
- The installed Babylon checks identify real capability work: current device
  creation requests only timestamp queries, and the installed cube KTX loader does
  not implement the same KTX2 path as its 2D loader.
- The existing-tour inventory is useful product context. The retained response
  logs sum to 8,186,517 bytes on desktop and 2,595,637 bytes in the phone-sized run,
  matching the report's panorama response-size totals. These are sums of reported
  `Content-Length`, not complete page transfer or device-performance measurements.
- The geographic datum issue and the need to distinguish image pose from initial
  view are worth carrying into the proposal.
- The report correctly says it has not benchmarked or qualified a GPU/device.
  Its performance conclusions need to remain consistent with that limitation.

## Corrections before these become implementation requirements

### 1. Full viewport coverage is not the transition handoff condition

The research says the window equals immersion once it fills the screen. Its own
[reference mapping](../../../scripts/render-orb-appearances.mjs) returns the
unchanged view ray only after the orb's angular radius reaches the preview
half-angle, or once the camera is inside. That is a separate condition from
covering the frame.

A counterexample using the report's 90-degree rectilinear preview:

| Quantity | Value |
| --- | ---: |
| Camera distance | 1.5 orb radii |
| Orb angular radius | 41.810 degrees |
| Square viewport, vertical FOV | 60 degrees |
| Angle from view axis to viewport corner | 39.232 degrees |
| Preview half-angle | 45 degrees |
| A ray 30 degrees from the axis samples the panorama at | 32.842 degrees |

The orb covers the whole square viewport but still magnifies its directions.
The entry test goes from 2 radii to 1.25 radii and misses this interval.

For this mapping, specify **both full coverage and directional equivalence** as
handoff conditions. Also preserve orientation, FOV, source readiness and color
processing across render paths. Identical ray math does not guarantee identical
pixels if textures or postprocessing change.

### 2. The preferred fisheye transition is not demonstrated

The entry loop uses `STRIPS.slice(0, 4)`, excluding the fisheye. In the current
fisheye mapping, as the camera approaches the sphere surface from outside,
`tan(alpha)` grows without bound and the sampled directions approach the orb axis.
Inside, the code immediately returns the original view ray. There is no continuous
blend implemented there.

The research acknowledges that a blend needs prototyping, but subsequently calls
both appearances continuously enterable. Keep fisheye as an appearance candidate;
define and validate its radial projection blend before making it the default.

The photographs compare appearances, not interaction quality. The reported
2.1/255 fisheye-versus-bubble difference is a mean for one photographed scene and
view, including unchanged background pixels. It is not a maximum error bound.

### 3. The new performance proof repeats the original research's mistake

One shader texture-sampling instruction is not one physical memory read or a
complete cost model. Filtering, mip selection, locality, ALU, texture binding,
coverage, depth, cache updates and render-target writes all matter. In
`N * P` versus `U * B + N * S`, assuming `S` is close to `P` does not prove caching
can never win.

Use **direct cube previews as the baseline hypothesis**, with caching initially
off for simplicity. Keep the requested cache option and matched-output experiment.
Remove claims that the optimum is proven, caching cannot save computation, the
flat and fisheye variants cost the same, or orb shading cannot matter. Their
fragment arithmetic differs even in the supplied pseudocode.

Likewise, triangle counts and projected pixel counts establish scale, not timing.
A depth-writing quad and a tessellated sphere need actual comparison with the
globe. One full-screen immersion transition is a different workload from tiny
overview markers.

### 4. Sampling rules need their domain of validity

`cubeFaceSize = orbDiameter / tan(previewHalfAngle)` is a center-density heuristic,
not a universal one-texel-per-pixel guarantee. With a 90-degree rectilinear window
whose axis is 45 degrees from a cube-face center, that face center lies at the
window rim. There the proposed face size supplies only 0.5 texel per output pixel.
Fisheye rim derivatives need particular care.

The cache table similarly uses average angle per pixel, `2 * beta / D`.
Rectilinear center angular width is approximately `2 * tan(beta) / D`; at the
rim it is `2 * tan(beta) * cos(beta)^2 / D`. An average is not a maximum-error
criterion.

The proposal can deliberately use center density and document its approximation,
or derive a more conservative footprint rule. Do not name it a guaranteed density
or cache-error limit without the corresponding derivation. A rectilinear full FOV
must remain below 180 degrees; the research's common 30–180-degree control bounds
cannot apply unchanged to both projections.

### 5. Instancing does not supply the missing texture-binding design

Each orb needs a different panorama. Instancing shares geometry/material resources;
it does not automatically make unrelated cube textures selectable per instance.
Choose per-orb/grouped draws for the simple baseline, or specify a functioning
cube-array/packing strategy before promising batching.

At the default 256 texture-array layers, one six-face cube array holds 42 panoramas;
43 needs 258 layers. More arrays/batches or a negotiated higher limit solve that,
but resolution classes, format, mip chains, residency, slot reuse and eviction also
need a contract. A shader processor recognizing `texture_cube_array` is not a
tested upload and binding implementation.
[Babylon instances](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/instances),
[WebGPU limits](https://gpuweb.github.io/gpuweb/).

The uncompressed cube baseline avoids making custom compressed-cube loading a
prerequisite. Compression remains a useful, separate capability stage. A WebGL
fallback is also a product/scope decision; “twenty more shader lines” does not
estimate its resource, capability, recovery and testing work. The user's WebGPU
requirement still governs the proposal.

### 6. Capture position, marker position and navigation are still unresolved

Raising a marker 4 m does not leave the image invariant when the preview axis is
camera-to-marker: at 30 m horizontal distance, its direction changes by 7.595
degrees. Distinguish the marker's silhouette axis from its content-sampling axis
and choose whether the latter refers to the displayed marker or the capture point.
Lack of photographic translation parallax does not imply an unchanged look direction.

The research also promises an unchanged globe view, then recommends rotating the
camera during entry. Preserve the overview snapshot independently if the
presentation camera moves. Define exit after looking around and following links;
it cannot always be the reverse of the original entry.

Growing world-space geometry through terrain may not behave like a screen-space
reveal. Specify how depth/occlusion changes during expansion, how the selected orb
stays visible when the camera turns, and how user cancellation restores input.
Camera/input ownership and resource lifetime remain substantial runtime work.

### 7. Datum handling must be provider-specific

The existing runtime applies decoded heights without a datum correction; that
finding is supported by [the terrain documentation](../../streamed-terrain.md).
Terrarium describes an encoding, however, not one universal vertical reference.
The runtime supports Mapterhorn, AWS and arbitrary provider URLs, without a datum
field. The report's local geoid calculation does not establish the datum or
accuracy of every source or photographed capture position.

Name the source datum, conversion and uncertainty. Do not introduce a blanket
27.3 m terrain correction. A ground-relative marker prototype can proceed while
provider-specific absolute-height conversion is verified. Missing capture altitude
must remain missing or explicitly approximate, rather than becoming invented
survey data.

## Product and evidence boundaries

- **Generic engine scope remains the priority.** The current tour's narration,
  languages, photos and videos are migration requirements to discuss, not automatic
  additions to the first FOSS Earth release. Distinguish a tour stop/group from an
  individual panorama: the reported 23 stops contain 43 panoramas. The scene design
  should not accidentally require one image per stop.
- **Decluttering is a requirement; clustering is one solution.** Screen-space
  spacing estimates do not uniquely choose clustering over filtering, a list,
  reveal-on-selection or another interaction.
- **Separate visible size from hit-target size.** A 24 px orb diameter is not by
  itself an accessibility implementation. Define the actual hit area, overlap,
  keyboard alternatives and the list. The W3C criterion includes exceptions and
  equivalent controls. [Target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- **The Cesium example reverses its API's behavior.** Depth testing is disabled
  beyond `disableDepthTestDistance`, not only near the camera. Choose FOSS Earth's
  policy independently. [Billboard documentation](https://cesium.com/learn/cesiumjs/ref-doc/Billboard.html).
- **The patent paragraph is not an engineering clearance.** Its linked page labels
  legal status an assumption. Keep the document as prior art; the research does
  not establish whether any proposed implementation is covered or excluded, nor
  a new prerequisite for drafting the proposal. [Referenced patent record](https://patents.google.com/patent/US9418472B2/en).
- **Preserve reproducible evidence.** The CPU script and appearance images are
  tracked. Tour inspections and their scripts currently live in ignored build
  folders. If their detailed counts and network observations remain cited design
  evidence, retain a sanitized summary and a reproducible inspection method in
  the owning project's validation layout. A phone-sized desktop browser is not a
  phone performance test. The observed registration error is already appropriately
  described as potentially specific to automation.

## What should happen next

Complete the proposal with a small initial validation stage. Define the flat-window
handoff and fisheye blend; extend CPU fixtures across the missed interval,
off-center markers, aspect ratios, camera rotation and marker offsets. Write down
the resource-binding and navigation contracts. These resolve specific uncertainty
without building the whole feature.

Then implement one complete path: load a neutral scene, show distinct panorama
previews, enter, look, follow one link, exit, and dispose. Use the installed Babylon
WebGPU runtime and simple bounded resources. Follow with the requested mesh/cache
alternatives, compression/tiling as needed, and matched-quality measurements.

The proposal can be written before target phones and performance thresholds are
final. It must label those as release-acceptance gaps and choose any development
defaults transparently as provisional. Do not wait indefinitely for measurements
that require an implementation, and do not present guessed defaults as measured.

This review inspected the existing code, figures and retained logs and checked
the counterexample arithmetic and selected primary sources. No GPU benchmark,
browser session or application test was run.
