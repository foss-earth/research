# Next task: close the visual contract and complete the panorama proposal

Copy the prompt below into the next agent conversation.

---

Work in `/Users/felg/gh/foss-earth`. Follow its `AGENTS.md`. This is generic FOSS
Earth scene/panorama work, not a UMN-themed application and not 0SFS code.

We have enough broad research. Your task is to resolve the specific remaining
visual-contract gaps and complete a staged implementation proposal. Do not begin
the production feature or repeat a general literature survey.

Read:

- `docs/proposals/research/panorama-scenes-research-review.md` — the latest critique.
- `docs/proposals/research/panorama-scenes-research.md` — useful research, with
  qualifications established by the critique.
- `scripts/render-orb-appearances.mjs` and its tracked figures.
- `docs/proposals/panorama-scenes.md` — the existing scaffold to consolidate.
- `docs/360-images-virtual-tour-review.md`, `docs/proposals/settings.md`,
  `docs/ui-layout.md` and relevant current runtime code.

Requirements that remain in force:

- Babylon.js and WebGPU for the new feature.
- Camera-responsive panorama orbs, immersion and reversible navigation.
- Selectable quad/sprite and mesh-sphere implementations, adjustable sphere
  quality, and user-controlled output caching. Appearance and implementation are
  separate: a mesh sphere can render window-family imagery too.
- A documented, versioned custom-scene format, owned by FOSS Earth.
- Named settings for compute, memory and bandwidth choices; no hidden tiers.
- Preserve the user's original generic-scene priority. The tour's existing media
  inventory informs later product scope; it does not authorize a full migration.

First, settle the small visual contract using the existing CPU reference:

1. Correct the transition claim. Full-screen coverage and equality to immersive
   view rays are separate conditions. Include the counterexample: square 60-degree
   viewport, 90-degree preview, distance 1.5 radii. Write the exact handoff condition
   and domain, including the inside/near-surface case.
2. Define a continuous fisheye-to-rectilinear mapping during entry. The current
   reference does not implement or test it. Preserve the endpoints, keep the radial
   mapping monotone and evaluated directions finite, and document boundary limits,
   filtering and any derivative singularity. If a proposed blend
   fails, report that and use the flat mapping as the validated baseline; do not
   quietly call the fisheye continuous.
3. Extend the CPU tool only as needed to check landscape, portrait and square
   viewports; centered/off-center markers; the near-handoff interval; concurrent
   camera rotation; marker offsets; and projection-specific FOV limits. Include
   cardinal/text fixtures and the existing photographic fixture. Compare ray
   directions as well as images so background pixels and smooth photographs cannot
   conceal errors. State what remains a later interactive-usability question.
4. Distinguish capture position, displayed marker position, clipping axis and
   content direction. Propose an explicit orientation policy, including entry
   leveling, saved overview and exit after visiting another panorama.

Retain compact evidence with reproducible commands and configuration. Use the
owning project's validation layout for new retained evidence; scratch stays in
`build/`. Do not delete previous runs. No GPU benchmarks or dev/preview/watch
servers are required for this task.

Then rewrite `docs/proposals/panorama-scenes.md` as one coherent implementation
proposal. Remove contradictory superseded sections rather than appending another
layer of recommendations. Clearly distinguish requirements, proposed decisions,
evidence, provisional development defaults and unresolved user decisions.

The proposal must specify:

1. **Scope and ownership.** First useful release, deferred features and public
   package surfaces. Keep optional tour branding, registration and content
   migration separate. Preserve extensibility for other custom-scene entity types
   without building a general scripting system. Distinguish a stop/group from a
   panorama when grouping is needed.
2. **Data contract.** Versioning, IDs, assets versus instances, representations,
   image pose and initial view, capture/display placement, optional/unknown height,
   datum conventions, links, attribution, relative URLs, validation, unsupported
   content and replacement/disposal. Include a neutral sample manifest and exact
   semantics, not just a list of field names.
3. **Visual contract.** Window family, selectable appearance where useful,
   silhouette/depth/picking rules, entry conditions, color pipeline, source LOD
   changes and reduced motion. Label center-density formulas as approximations
   unless a conservative bound is derived. Rectilinear FOV must exclude 180 degrees.
4. **Asset delivery.** A practical preview preparation/loading path and explicit
   immersion limits. Keep uncompressed cubes as a simple baseline. Decide when
   whole-image variants suffice and when tiled immersion is necessary, using
   budgets and image dimensions rather than an unexplained universal 8K cutoff.
   Compression can be a separate stage with a tested loader and capability path.
5. **Resource binding and residency.** Explain how different orbs sample different
   panoramas. Per-orb/grouped draws are an acceptable baseline. Do not promise one
   draw call merely because thin instances exist. If using cube arrays, account
   for six layers per cube, default array limits, resolution/format groups, mip
   chains, slot reuse, eviction and invalidation. Bound decode, uploads, source
   memory, cache memory, transition overlap and prefetch independently.
6. **Navigation/lifecycle APIs.** Cancellable camera and input ownership; pointer,
   keyboard and existing gamepad routing; inertia; stale async results; scene/map
   changes; saved overview; browser history; exit after multiple destinations;
   device loss and teardown. Explicitly choose which view, if any, drives terrain
   streaming during immersion. Do not reuse flight `simMode` for panorama mode.
7. **Settings and UI.** Stable IDs, units, bounds, defaults with reasons, UI homes
   and readings. Give unmeasured defaults an explicit provisional rationale and
   validation task. Separate visible marker size, hit target and decluttering.
   Use the existing registry/shell and paragraph-grid layout.
8. **Implementation stages.** Begin with one complete neutral scene path: multiple
   distinct previews → enter → look → link → exit → dispose. Follow with scale,
   the requested mesh/cache alternatives, and justified optimization. Define
   dependencies, affected repository surfaces and acceptance checks for each stage.
9. **Validation.** Pure math/lifecycle fixtures, targeted visual checks, consumer
   compatibility, and a later matched-output GPU experiment with the globe running.
   Compare real different panorama assets, not repeated copies of one texture.
   Keep device selection and numerical performance acceptance explicit; missing
   phone measurements block qualification, not drafting the proposal.

Do not carry these research assertions into requirements:

- One texture instruction proves optimal GPU cost or proves caching cannot help.
- Full viewport coverage by itself guarantees a pixel-identical handoff.
- Fisheye entry has already been validated.
- Thin instances automatically batch arbitrary independent panorama textures.
- Raising the displayed marker cannot change camera-to-marker sampling direction.
- All Terrarium sources share a datum or need the same local geoid correction.
- A WebGL fallback costs only the shader's additional lines. It remains an optional
  scope decision under the user's WebGPU requirement.
- Prior-art patent discussion establishes clearance or a new implementation gate.

Ask only questions that materially affect the contracts and cannot be resolved
from the user's instructions. Continue independent work while awaiting answers.
Offer a recommendation and mark unanswered preferences as provisional; do not
invent user approval or turn missing device benchmarks into an indefinite stop.

Deliver the corrected evidence and consolidated proposal, then report: decisions
ready for implementation, genuine user decisions still needed, and what the first
implementation stage will prove. Do not commit or push as part of this task.
