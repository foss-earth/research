# Mesh inspector GPU check — 2026-10-05

[Report](report.json) from
[`node scripts/validation/mesh-inspector.mjs`](../../../../scripts/validation/mesh-inspector.mjs).
Chrome 154.0.8037.98 on the Apple M5 GPU passed **23 checks on each backend**:
WebGPU, WebGL 2, and WebGL 1 forced with `--disable-webgl2`. The runner and page
independently record the actual backend and reject software rendering. Console
errors and shader-validation warnings fail the run; there were none.

The fixture uses 384 × 384 pixels with antialiasing disabled, the production
renderer bootstrap and reverse depth. The gallery uses an orthographic camera
with near/far planes 0.05/100 m. Perspective checks use a camera at 10 m and
1,000 m with near/far planes 0.05/25,000 m, scaling the fixture at the farther
distance to retain the same angular size. Both projected front-face diagonals
have 80/80 sampled points within one pixel of orange edges in the orthographic
case; the selected mesh has 80/80 at both perspective distances. An opaque
foreground mesh hides its selected edges at every tested distance.

Other checks cover solid fill and original materials, nested group selection,
deselection, inherited motion, ancestor enablement, source visibility, reused
geometry, selection retained across disabling, and overlays/material/observers
released on disable, model unload and disposal. The source hashes are in the
report. This synthetic fixture does not qualify performance, all model formats,
other browsers or other devices; it records no benchmark timings.

Screenshots, each showing baseline, all selected, all deselected, nested group
selected, nested group moved, and hidden ancestor:

- [WebGPU](webgpu.png)
- [WebGL 2](webgl2.png)
- [WebGL 1](webgl.png)

Requests were intercepted locally with no server and no external network.
Chrome was closed through its normal shutdown path in `finally` after each
backend. Working bundles, browser profiles, logs and failed development controls
remain in the checkout's ignored `build/validation/mesh-inspector/` tree.
