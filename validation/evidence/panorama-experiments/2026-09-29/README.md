# Work-saving experiments on the UMN tour, 2026-09-29

The first pass of the [work-saving rendering experiments](../../../../docs/validation/panorama-experiments.md),
measured on the UMN campus tour's own build and photographs with the
[scene A/B benchmark](../../../../benchmarks/scene-ab/README.md), and checked for correctness
with the [panorama campus check](../../../../scripts/validation/panorama-campus.mjs) on WebGL 2.

**Result:** every experiment draws the tour as before. Four of them are pixel-identical, and
the simpler shaders differ by at most 1/255 in under 0.3% of pixels. Inside a stop, skipping
the hidden globe removes about a quarter of Babylon's render time on the main thread. No
experiment made a GPU difference that could be told from noise on this machine. Device trials
are pending.

## Configuration

- **Code:** FOSS Earth commit `5900583` with this pass's changes uncommitted; they were
  committed unchanged as `2eac80c`, with the same SHA-256 for the renderer, its WebGL shaders
  and the candidate filter. UMN tour commit `33ee967`, built with `npm run build:app`
  (main bundle SHA-256 `c67628ab…`), with its photographs served from `public/` (scene
  manifest SHA-256 `61df6bd1…`).
- **Browser and GPU:** Chrome 154.0.8037.58, headless, on an Apple M5 through ANGLE on Metal
  (driver 27.0, macOS build 26A428). WebGL 2, and WebGL 1 with Chrome started with
  `--disable-webgl2`.
- **View:** a phone's viewport, 412 × 915 CSS px at DPR 2.625 with touch, so 1081 × 2401 px
  drawn. Stops `northrop-mall` and `rarig-theater`, each showing its 6144 × 3072 image, and the
  campus overview with its orbs (107 draw calls a frame).
- **Map:** USGS Imagery Topo with Mapterhorn elevation, replayed from the benchmark's tile
  cache after first fetches identified as `foss-earth-check/1.0`.
- **Timing:** 5 rounds of 5 s touch drags for every experiment, all together, the baseline and
  the baseline again, in a new random order each round, switched live in one page. Each
  stretch waited for 10 s without keyboard or mouse input. The WebGL 2 run kept all 105
  stretches with none repeated; the WebGL 1 run repeated one after keyboard input during it
  and kept all 105.

## Results

Folders: [`tour-webgl2/`](tour-webgl2/summary.md) and [`tour-webgl1/`](tour-webgl1/summary.md)
(summary, full report and heat maps of every differing pixel);
[`campus-webgl2-off/`](campus-webgl2-off/summary.md) and
[`campus-webgl2-all/`](campus-webgl2-all/summary.md).

### Equivalence (canvas read back with the view held still)

| Experiment | Stops (WebGL 2 / WebGL 1) | Overview (WebGL 2 / WebGL 1) |
| --- | --- | --- |
| Panorama draws without test records | identical | identical |
| Opaque panorama | identical | identical |
| Skip the hidden globe | identical | identical |
| Simpler panorama shaders | ≤ 1/255 in 0.03–0.27% of pixels | ≤ 1/255 in 16 / 22 pixels |
| All | as the shaders | as the shaders |

The baseline read twice was identical every time. An earlier version of the simpler shaders
flipped about 200 pixels, by up to 155/255, where orbs photographed at nearly the same spot
overlap: their depths tie, and precomputing the orb's distance on the CPU settled the ties
differently. The shaders now keep the distance and depth arithmetic per pixel, and this run is
of that version.

### CPU per frame, inside a stop

Median of 5 rounds; change against the same round's baseline, and in how many rounds lower.

| Experiment | Render ms, WebGL 2 | Main thread ms, WebGL 2 | Render ms, WebGL 1 |
| --- | --- | --- | --- |
| Baseline (northrop-mall / rarig-theater) | 1.465 / 1.455 | 2.677 / 2.676 | 1.490 / 1.470 |
| Baseline again (noise) | −0.0% / −0.7% | +0.3% / −0.7% | +3.0% / −2.0% |
| Skip the hidden globe | **−23.9% / −25.8%, 5/5** | **−13.8% / −15.4%, 5/5** | **−25.8% / −26.9%, 5/5** |
| All | **−27.3% / −26.5%, 5/5** | **−14.9% / −15.8%, 5/5** | **−27.5% / −27.9%, 5/5** |
| Panorama draws without test records | +0.7% / +0.0% | +1.4% / −0.3% | +0.0% / −0.7% |
| Opaque panorama | −1.4% / +0.3% | −0.1% / +0.3% | +2.0% / −1.4% |
| Simpler panorama shaders | −0.0% / +1.7% | −0.4% / **+2.7%, 0/5 lower** | **+2.3%, 0/5 lower** / +0.3% |

Babylon examined 1 mesh a frame instead of the 289 map meshes kept behind the panorama. The
simpler shaders cost the CPU a little more in every round: 5–10 µs in the panorama's uniforms
and about 10 µs in the draw, where the view's two matrices into the images' frames are now
worked out and set each frame. The larger changes in the render totals in that row are mostly
noise on top of that. In the overview, the only change above the noise was the test records, on WebGL 2:
render −4.2% and main thread −5.1%, lower in 5 of 5 rounds each, against a baseline-again
difference under 1%. The overview's baseline-again moved by up to 7.8% on WebGL 1, so nothing
there is a result.

### GPU

On WebGL 2 the GPU took 1.25–1.29 ms a frame inside a stop and 2.41–2.45 ms in the overview.
The baseline-again control itself moved by up to 1.7%, and was lower in all 5 rounds at one
stop, so drift of that size is real. The opaque panorama moved −2.2% and −1.6% at the two
stops and −0.2% in the overview; the simpler shaders −1.4%, −0.2% and −2.5%, the last lower in
only 3 of 5 rounds. None is both clearly larger than the control and consistent across
rounds. Apple's GPUs blend in tile memory and have arithmetic to spare, so this machine is the
wrong one to judge these two; a phone has to.

On WebGL 1 the frame profiler's GPU timer gave a single reading (0.473 ms) and never another
through the whole run, so the GPU was not measured there. The summary marks it as stale.

### Correctness on WebGL 2 (campus check)

Both runs passed. The GPU's sampled directions matched the CPU mapping within 4.5e-4° with the
experiments off and 4.8e-4° with all of them on (tolerance 0.01°). Rays matched within 1.4e-4°
and 1.3e-4° (tolerance 0.002°). The entered panorama was within 1.4e-5° of the CPU rays off,
and 7.4e-6° on, since the simpler shader composes the view and the image's rotation on the
CPU in float64. Colour and orientation errors were the same in all eight views, and the
negative control, entering, following a link, Back and Exit all passed. The campus check had
only run on WebGPU before; its probe waited for its shaders to compile to run on WebGL at all.

## Limits

- One Mac. Its CPU and GPU are several times faster than the phones in question, and headless
  Chrome draws through ANGLE on Metal, not a phone's GL driver. Whether these savings are
  enough on a phone is for the device trials.
- Main-thread time outside Babylon's render, such as input and the HUD, was about 1.2 ms a
  frame inside a stop and about 3 ms in the overview on this machine. None of these
  experiments touch it.
- Seen but not investigated: on WebGL 1 the overview made 5,558 imagery requests (replayed
  from the tile cache) against 319 on WebGL 2 over the same drags.
