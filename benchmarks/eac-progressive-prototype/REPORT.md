# Progressive 360° image prototype: Phase 2 report

Run on 2026-10-02 against FOSS Earth `dc1feb4` (Phase 1 on `4866615`) and the UMN tour
`9e8a058`, on one desktop. No production file was changed and nothing was committed,
pushed or published. How to run everything is in [README.md](README.md); what existed,
the plan and what was unavailable are in [INVENTORY.md](INVENTORY.md). Every number below
is in `results/`, and [results/tables.md](results/tables.md) regenerates the derived ones.

## Summary

What ran: an end-to-end prototype (offline EAC and cubemap pyramids with gutters; a
one-image bootstrap; exact view selection; a scheduler with cancellation and back-pressure;
bounded GPU, CPU and request budgets; a display table that never shows an absent tile; a
Babylon page on WebGL 1, WebGL 2 and WebGPU), the correctness gates below, 897 simulated
runs of the real client on Phase 1's network model, a matched-quality comparison of the
packaged datasets, and 186 runs over real HTTP/2 (and 8 over plain HTTP/1.1 for the warm cache) through Chrome's network emulation
on this machine's GPU. **No phone was available. Nothing here is a phone result.**

What the evidence supports, under those conditions:

1. **The architecture works and is correct.** On all three backends the GPU's picture
   matches an independently written CPU renderer (median 51 dB on WebGL, 63 dB on WebGPU,
   no blank pixel in 276 states); selection misses no tile in 81,000 checks; seams, face
   edges, cube corners and mixed levels pass their gates; queues and caches stay within
   their limits, a left panorama's late responses change nothing, and failed or late tiles
   never leave a hole.
2. **Fetch the level the view needs, directly.** Looking forward at 2 Mbit/s the view is
   within 1 dB of finished after 1.25 s with "direct", 1.75 s with residual tiles and 2.0 s
   visiting every level, for 277, 376 and 462 KiB (simulation, median of 12 runs).
   Intermediate levels and residuals only help in the first moments after a quick turn.
3. **EAC keeps an advantage over the ordinary cubemap at full resolution, smaller than at
   Phase 1's scale.** At matched view quality EAC needs 0.85× the cubemap's bytes with
   1536-texel faces and 0.92× with 2048-texel faces (geometric means; Phase 1: 0.86×). The
   advantage is the cubemap's coarse face centres; at cube corners the cubemap is better.
4. **Background insurance does not earn its bytes on these traces.** Fetching the rest of
   the sphere after the view costs a viewer who never turns 28% (level 0) to 140% (level 1)
   more bytes and does not shorten the recovery after a quick turn at any link speed; it
   lowers the shortfall at the instant the turn ends by 1.8 to 5.5 dB at 10 and 2 Mbit/s.
5. **Residual refinement is correct but not worth adopting now.** Its chain is exact,
   error does not build up over three levels, real content clips 0.0006% of values at
   most, and CPU reconstruction is cheap; but against direct replacement it costs 36% more
   bytes for a forward view and reaches high quality later.
6. **Against the current path the difference is large.** Over real HTTP/2 at 2 Mbit/s
   the current viewer shows its 64-texel preview for the whole 10-second trace on two of
   the three panoramas: their 4.7 and 5.5 MiB images take 20 to 24 s. The EAC client is
   within 1 dB of its finished view after 1.26 s and 258 KiB. Its uploads never made a
   frame late on this desktop; the control's whole-image upload costs 6 to 7 ms of
   main-thread work in each of 20 frames on WebGL, and one 76 ms frame on WebGPU.
7. **The simulator predicted the real-HTTP results closely**: times to high quality within
   0.26 s in 15 of 16 comparisons, and bytes within 6%.

**Decision: continue with one specific experiment before proposing production.** The
architecture (EAC, 192-texel tiles with a one-texel gutter, a one-image bootstrap, direct
replacement, ray lookup) is supported on this desktop. Whether it holds on a phone (decode
and upload per frame, memory, a phone GPU's lookup cost) is the decisive missing evidence;
the package and instructions for that trial are ready ([Where this leaves it](#where-this-leaves-it)).

## What was run

| # | What | Script | Category | Ran |
| --- | --- | --- | --- | --- |
| 1 | Datasets: 3 panoramas × EAC and cubemap × tiles 96, 192, 384; quality ladder; 2048-texel faces | `preprocess/build-dataset.mjs` | – | yes |
| 2 | Geometry, selection, seams, gutters | `tests/check-geometry.mjs` | Node | yes, 8 gates |
| 3 | Streaming and cache invariants | `tests/check-client.mjs` | Node, the network model | yes, 8 gates |
| 4 | Residual arithmetic, chains, decoder mismatch | `tests/check-residual.mjs` | Node, libjpeg-turbo, macOS ImageIO | yes, 3 gates |
| 5 | GPU against CPU, every backend, both drawing paths | `run-gpu-checks.mjs` | headless Chrome, real GPU | yes, 276 states |
| 6 | Representation at matched quality | `run-representation.mjs` | Node | yes |
| 7 | Delivery policies, representation, insurance, sweeps | `run-sim.mjs` | simulation | yes, 897 runs |
| 8 | Candidates and the control over real HTTP; backends and frames; warm cache; small cache; failures | `run-http.mjs` | throttled real HTTP, loopback | yes, 186 runs + 8 warm-cache runs over HTTP/1.1 |
| 9 | Remote static host | `export-package.mjs` | – | **not run**: publishing was not authorised |
| 10 | Phones | – | – | **blocked**: no device attached |

**Environment and device matrix.**

| | WebGL 1 | WebGL 2 | WebGPU |
| --- | --- | --- | --- |
| Apple M5 desktop, macOS 27.0, Chrome 154 headless, ANGLE on Metal | ran (engine with WebGL 2 disabled; GPU timer invalid) | ran | ran (`timestamp-query`) |
| Low/mid-range Android | not run: no device | not run | not run |
| Modern Android | not run: no device | not run | not run |
| Older iPhone | not run: no device or iOS tooling | not run | not run |
| Modern iPhone | not run | not run | not run |

**Viewport.** 412 × 915 CSS pixels at a device pixel ratio of 2.625, a drawing buffer of
1081 × 2401 on the GPU (1082 × 2402 in Node), 75° vertical field of view: the phone viewport
of `benchmarks/scene-ab`. Its pixels are 0.037° at the centre, finer than the source's
0.059°, so the finest level is needed everywhere in the view. Quality is judged on every
second pixel each way, which keeps that density.

**Configuration** (`config/default.json`, frozen): EAC, 1536-texel faces, 192-texel tiles
with a one-texel gutter (194 stored), levels 0–3, JPEG quality 80 4:2:0 with optimized
tables (libjpeg-turbo 3.2.0), a 48-texel bootstrap fetched first and alone, a 5° margin,
direct replacement, cancellation on, 6 requests and 4 MiB in flight, 12 tiles pending, 2
decodes at once, 2 uploads a frame, 196 GPU slots (a 2716² atlas, 28 MiB), 32 MiB of CPU
texels. Experimental defaults, not production recommendations.

## The architecture as built

```
6144 × 3072 source ─ resample (cell means, linear light) ─ faces of 1536 + gutter ─ tiles 194² ─ JPEG
                                                                                      │
manifest.json + boot-48.jpg + t/{face}/{level}/{x}/{y}.jpg (+ r/… residuals) ── static files
                                                                                      │
camera → exact selection (lib/selection.mjs) → scheduler (lib/client.mjs) → fetch → decode
       → upload one 194² sub-image into a 196-slot atlas → display table (6 × 8 × 8 cells)
       → one draw: ray → face, (u, v) → cell → slot and level → one bilinear tap
```

- **Addressing** is `{face}/{level}/{x}/{y}`; level l has 2^l × 2^l tiles a face. The
  manifest (version 1) records the projection, face frames and axes, level sizes, logical
  and stored tile sizes, codec and options, bootstrap, the reconstruction rule, the
  residual convention and per-level byte totals; `tiles.json` (5.5 KiB) has every tile's
  size and is not fetched by default.
- **Face size.** 1536 texels: the source is 6144 around, and an equi-angular face spans a
  quarter turn at a constant rate, so this matches the source's density at the horizon
  exactly (the tests check it: 1.00 at a face centre, 0.94 at a corner). A cubemap face of
  1536 is 1.27 times coarser than the source at its centre and 0.60 at its corners.
- **Gutters** are the face continued past its edge, resampled from the source, so a tile
  is filtered from its own texels only; a neighbouring tile, a missing one, or another
  level is never read. Every level is resampled from the source by the same rule.
- **Selection is exact.** Tile edges are great-circle arcs in both projections, so a tile
  overlaps the view exactly when a corner of either is inside the other or two edges cross
  (`lib/cones.mjs`). A first, sampled version missed slivers of tiles at the view's border
  and was replaced. Levels come from scout rays and are approximate: of the pixels sampled
  every 37 in each direction over 128 views, 1 to 9 per configuration needed one level more
  than their cell got.
- **The display table** gives each finest cell the finest resident tile at or below the
  level it needs, or the bootstrap. It is rebuilt when something arrives or leaves and
  uploaded whole (6 KiB); tiles are never re-uploaded by it.
- **Minification** is bounded by choosing the level per cell; there are no mipmaps and no
  blending between levels. At the phone viewport everything is magnified; shimmer during
  motion on a low-density display was not inspected.

## Observations

### 1. Correctness gates

All passed; the details are in [results/tables.md](results/tables.md#correctness-gates).

- **Orientation and mapping**, against a derivation written out in the test: faces, axes
  and the equi-angular warp agree to 10⁻⁹ on 100,000 directions; 200,000 directions each
  fall in one tile per level and the levels nest; the round trip is within 10⁻⁶ rad.
- **Coverage**, against every pixel's own ray: 0 of 29,606 (tiles of 96), 8,386 (192) and
  2,629 (384) tiles under 128 views were missed, on four viewports including 110° and
  1920 × 1080, with roll, at the poles, at edges and corners.
- **Seams.** Two directions 10⁻⁷ of a face apart on either side of a boundary differ by a
  mean of 3.8 bytes across a tile boundary, 4.4 across a face edge and 3.3 at a cube
  corner on a real panorama (EAC, 192), against 10.3 between texels one apart inside a
  tile: two independently coded JPEGs disagree about their shared edge by about their
  coding error, which is less than the picture changes over a texel. Within one texel of a
  face edge the picture is no further from the closed-form pattern than 4 to 16 texels in
  (7.7 against 8.0 for EAC). Enlarged crops: [plots/screens/](plots/screens/).
- **Gutters** across face edges and at cube corners are as close to the truth as interior
  texels (mean error 3.5 across edges, 0.4 at the four corner texels checked, 4.1 inside).
- **Mixed levels** never show uninitialized memory: the atlas is allocated zeroed, and a
  cell shows a tile only once its slot holds it. The finest level beside the bootstrap is
  a visible step (mean 34 bytes); beside the level below, 8.7.
- **Streaming**: with one request in three failing and every response 400 ms late, no cell
  ever showed a tile that was not resident; responses arriving after the panorama was left
  changed nothing (6 of 6 ignored); every received byte, cancelled ones included, was
  counted; a residual tile was never decoded without its own parent; every request
  recorded why it was made.
- **GPU against CPU**: 276 states read back on WebGL 1, WebGL 2 and WebGPU, both paths,
  the pattern and a real panorama, including the residual payload decoded by the browser.
  Ray lookup agrees with the CPU at a median of 51.2 to 51.5 dB on WebGL and 62.6 to
  64.6 dB on WebGPU; the worst states (45–55 dB) are the bootstrap beside the finest level,
  where a pixel on the boundary picks the other side. The GPU's picture is as close to the
  closed-form pattern as the CPU's to 0.1 dB on every backend. No pixel was blank.

### 2. Representation at matched quality

Phase 1's twelve views at the phone viewport, every cell at the finest level, against the
source ([tables](results/tables.md#representation-at-matched-quality)).

| Ladder | EAC bytes ÷ cubemap bytes at equal PSNR | at equal SSIM | Points |
| --- | ---: | ---: | ---: |
| 1536-texel faces, 192-texel tiles | 0.849 (0.78 to 0.94) | 0.832 | 9 |
| 2048-texel faces, 256-texel tiles | 0.916 (0.88 to 0.98) | 0.902 | 6 |
| Phase 1, 768-texel faces, whole charts, 4:2:0 | 0.86 (0.80 ÷ 0.93) | 0.86 | – |

- The advantage depends on where the view is. Looking forward at a face centre, EAC's
  finished view is 2.1 dB better than the cubemap's; at a cube corner and looking up the
  cubemap is 0.4 to 0.5 dB better (simulation, final PSNR by start orientation).
- A **2048-texel face** at equal bytes is −0.8 to +0.6 dB against 1536 for EAC and −0.2 to
  +0.9 dB for the cubemap: the cubemap gains more because 1536 undersamples its centres.
  The extra fidelity is to the source's own grid and its JPEG artefacts as much as to
  detail. It costs 1.78 times the texels to decode, upload and hold.
- **Gutters** cost 6.0% to 6.4% more encoded bytes for 2.1% more texels with 192-texel
  tiles (JPEG pays for the extra 8 × 8 blocks), 10% to 12% with 96 and 3% with 384.
- **Tile size** does not change quality (every size shows the same texels); it changes
  bytes, requests and what falls outside the view (section 4).
- **Residual chain**, final picture: −0.39 to +0.07 dB against replacement tiles at the
  same setting, for 0.80× the bytes of the finest level and 1.13 to 1.22× the bytes of
  fetching only the finest level (with level 0, which the chain needs).
- **The current path's image** (6144 wide, jpeg-js quality 80, no chroma subsampling) is
  39.6, 48.2 and 38.9 dB on the same views for 4.7, 1.5 and 5.5 MiB, against 36.0, 44.1
  and 33.0 dB for the whole EAC finest level (3.2, 1.1 and 3.4 MiB). That image lies on the
  source's own grid, from which the reference is drawn: it is the source re-encoded once,
  and any resampled grid starts behind it. Its 4096 version scores 33.8, 42.1 and 32.9 dB
  for 2.3, 0.8 and 2.8 MiB. Absolute PSNR therefore cannot rank the control against the
  tiles fairly; times to the control's own finished picture can.
- **Bootstraps** of 24, 48, 96 and 192 texels a face cost 1.5–1.9, 3.9–5.4, 11.5–18.7 and
  36.5–72.7 KiB and score 16.7–23.6, 17.6–25.3, 18.6–27.4 and 20.1–29.8 dB: about 1.5 dB per
  doubling for 3 to 4 times the bytes.

### 3. Delivery and progression (simulation)

The real client on Phase 1's network model (fixed rate shared equally, a round trip before
the first byte, 300 bytes of headers, no loss, no slow start), judged on the CPU. Medians
over three panoramas and four start orientations (n = 12).
[Figure](plots/quality-vs-time-sim.svg); [figure](plots/quality-vs-bytes-sim.svg).

![Shortfall over time, simulation](plots/quality-vs-time-sim.svg)

Looking forward:

| Link | Policy | Acceptable s | High s | KiB at 1 s | KiB in all | Requests |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 10 Mbit/s, 50 ms | direct | 0.50 | 0.50 | 277 | 277 | 50 |
| | every level | 0.75 | 0.75 | 462 | 462 | 74 |
| | residual | 0.75 | 0.75 | 376 | 376 | 74 |
| 2 Mbit/s, 100 ms | direct | 1.25 | 1.25 | 150 | 277 | 50 |
| | every level | 1.75 | 2.00 | 151 | 462 | 74 |
| | residual | 1.63 | 1.75 | 154 | 376 | 74 |
| 0.75 Mbit/s, 150 ms | direct | 2.75 | 2.75 | 44 | 277 | 50 |
| | every level | 3.88 | 4.25 | 46 | 462 | 74 |
| | residual | 3.38 | 3.75 | 42 | 376 | 74 |

After a quick turn (forward for 2 s, 180° in 0.6 s):

| Link | Policy | Short before the turn dB | Short as it ends dB | Acceptable after s | High after s |
| --- | --- | ---: | ---: | ---: | ---: |
| 10 Mbit/s | direct | 0.0 | 11.6 | 0.40 | 0.40 |
| | every level | 0.0 | 5.5 | 0.40 | 0.40 |
| | residual | 0.0 | 4.9 | 0.40 | 0.40 |
| 2 Mbit/s | direct | 0.0 | 16.1 | 1.02 | 1.15 |
| | every level | 2.2 | 11.4 | 1.27 | 1.52 |
| | residual | 1.1 | 10.8 | 1.02 | 1.27 |
| 0.75 Mbit/s | direct | 12.7 | 16.6 | 3.02 | 3.27 |
| | every level | 10.5 | 16.4 | 4.28 | 5.15 |
| | residual | 9.4 | 15.4 | 3.27 | 4.15 |

- At the full source resolution a phone view needs about 57 tiles, 277 KiB for a forward
  view (Phase 1's view-first figure at its reduced scale was 142 KiB), and the first view
  is complete in 1.25 s at 2 Mbit/s: Phase 1's quick turn at 2 s now often comes before
  the first view is finished at slower links.
- Direct reaches high soonest on every link and sends the fewest bytes. Visiting every
  level adds 67% more bytes and 0.25 to 1.5 s. Residual tiles cost 36% more than direct
  for a forward view and reach high 0.25 to 1 s later.
- The intermediate levels help at one moment only: as a turn ends on a fast link, the
  coarse tiles of the margin are already there (5 to 6 dB short against 11.6). By 0.4 s
  later every policy is acceptable. At 2 Mbit/s residual recovers as fast as direct;
  visiting every level is slower.
- A person who explores (16 s, up and down) sees most of the sphere: direct receives
  2.6 MiB at 2 Mbit/s with a mean shortfall of 6.5 dB, every level 2.9 MiB and 4.8 dB,
  residual 2.7 MiB and 4.5 dB. Here progression helps: the camera never waits long enough
  for the finest level anywhere.

### 4. Parameters, one at a time (simulation, two panoramas, off-axis start)

From [results/tables.md](results/tables.md#one-parameter-at-a-time-two-panoramas-off-axis-start), at 2 Mbit/s, looking forward unless named:

| Change from the default | High s | KiB | Requests | Effect |
| --- | ---: | ---: | ---: | --- |
| default (192-texel tiles, 6 requests, 48-texel bootstrap, 5° margin) | 1.75 | 376 | 46 | |
| tiles of 96 | 2.88 | 423 | 162 | 12% gutter bytes, 3.5× the requests |
| tiles of 384 | 2.13 | 447 | 16 | more of each tile outside the view |
| 2 requests at once | 3.13 | 376 | 46 | round trips dominate |
| 12 requests at once | 1.75 | 376 | 46 | no faster than 6 |
| bootstrap of 24 / 96 / 192 | 1.75 / 1.75 / 1.88 | 372 / 389 / 439 | 46 | at the turn: 17.7 / 15.2 / 13.5 dB short against 16.5 |
| no margin / 15° | 1.75 / 1.75 | 324 / 590 | 41 / 73 | a 15° margin does not help a 180° turn |
| no cancellation | 1.75 | 376 | 46 | after a turn: acceptable 1.65 s against 1.40 |
| bootstrap not alone | 1.63 | 376 | 46 | 0.1 s sooner |
| link to the earliest request | 1.63 | 376 | 46 | 0.1 s sooner |

### 5. Quick turns and insurance (simulation)

[Figure](plots/quick-turn-insurance-sim.svg). Policy B fetches, once the view has every
tile it asked for, the rest of the sphere up to a level, nearest the view first, on two
requests at most.

![Quick turn with and without insurance](plots/quick-turn-insurance-sim.svg)

| | Extra KiB for a person looking forward | Short as the turn ends: 10 / 2 / 0.75 Mbit/s | Acceptable after: 10 / 2 / 0.75 Mbit/s |
| --- | ---: | --- | --- |
| A: the view only | 0 | 12.3 / 16.7 / 17.1 dB | 0.40 / 1.40 / 3.40 s |
| B, then level 0 everywhere | +78 (+28%) | 9.3 / 14.9 / 17.1 | 0.40 / 1.40 / 3.40 |
| B, then level 1 | +388 (+140%) | 6.8 / 14.9 / 17.1 | 0.40 / 1.40 / 3.40 |
| B, then level 2 | +1,152 to +1,456 | 6.9 / 14.9 / 17.1 | 0.40 / 1.40 / 3.40 |

Insurance lowers the shortfall at the instant the turn ends, by 1.8 dB at 2 Mbit/s and 3 to
5.5 dB at 10 Mbit/s, and changes nothing that follows: the new view is acceptable at the same moment with or
without it, on every link. At 0.75 Mbit/s the first view is not finished when the turn
comes, so nothing is spent on insurance. Phase 1 found it halved the shortfall at 2 Mbit/s;
at full resolution there is too little idle time before the turn for that.

### 6. Over real HTTP (throttled, loopback)

HTTP/2 over TLS from a static server on 127.0.0.1, Chrome's network emulation (calibrated:
a small request took 107, 160 and 55 ms against nominal round trips of 100, 150 and 50 ms;
1 MiB arrived at 1.95, 0.74 and 9.38 Mbit/s against 2, 0.75 and 10), WebGL 2, the
phone viewport, cold cache. Three panoramas, two repetitions in alternating order, an
off-axis start (n = 6 a cell). The page script is loaded before the network is throttled
and is not counted (`page.js`, the same for every variant). [Figure](plots/quality-vs-time-http.svg).

![View quality over time over real HTTP](plots/quality-vs-time-http.svg)

| Link | Variant | Looking forward: high s | KiB | Requests | Quick turn: short as it ends dB | Acceptable after s |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 2 Mbit/s | EAC, direct | 1.26 | 258 | 46 | 17.2 | 1.65 |
| | EAC, every level | 2.26 | 463 | 69 | 13.5 | 1.91 |
| | EAC, residual | 2.01 | 375 | 69 | 13.3 | 1.66 |
| | cubemap, direct | 1.26 | 234 | 45 | 16.4 | 1.28 |
| | current: preview, then 6144 image | never (4 of 6) | – | 7 | 19.1 | never (4 of 6) |
| 0.75 Mbit/s | EAC, direct | 2.76 | 258 | 46 | 17.5 | 4.15 |
| | EAC, every level | 5.01 | 463 | 69 | 17.2 | 5.15 |
| | EAC, residual | 4.25 | 375 | 69 | 16.5 | 4.16 |
| | cubemap, direct | 2.51 | 234 | 45 | 17.0 | 3.53 |
| | current | never (6 of 6) | – | 7 | 19.1 | never (6 of 6) |

- **The current path.** Its 64-texel preview (six files, about 12 KiB) is on screen at 0.18 s
  at 2 Mbit/s, and for two panoramas it is all that is shown for 10 s, 20 dB short of the
  whole image; the bookstore's 1.5 MiB image arrives at 6.4 s and is shown at 6.8 s, after
  a 63 ms decode and 306 ms of uploading. Unthrottled, the northrop image (4.7 MiB) is
  shown at 0.48 s: 61 ms to decode, 300 ms to upload in 4 MiB rows, 96 MiB on the GPU with
  its mipmaps. Its time to high is relative to its own image, which is better than the
  tiles' against the source (section 2); its delay is the size of that image.
- **The cubemap** reaches its own finished picture sooner and with 9% fewer bytes, and
  recovers from a turn sooner. Its finished picture is 0.8 dB worse than EAC's on
  average (worse at face centres, better at corners): shortfall measures delivery, not
  the representation.
- **Simulated against measured** ([tables](results/tables.md#throttled-real-http-over-the-loopback-chromes-emulation-webgl-2-unless-named)):
  time to high within 0.26 s in 15 of 16 pairs (the exception: every level on the quick-turn
  trace, first high at 2.0 s simulated and 4.8 s measured, either side of the turn), bytes
  4% to 6% fewer measured (the model charges 300 bytes of headers a response; the page
  counts bodies), mean shortfall within 0.5 dB. Chrome's
  emulation and Phase 1's model behave alike at these rates; neither is a real network.

### 7. Backends, drawing paths and frames

Unthrottled, the quiet guard on (ten seconds without input before each round, rerun if
disturbed; 8 of 54 rounds stayed disturbed after their retries and are marked), two
repetitions, the forward view and the exploring trace. [Figure](plots/frame-times-http.svg).

![Frame intervals and work](plots/frame-times-http.svg)

- **No frame was late because of tiles** on any backend: frame intervals p99 17.0 to
  18.1 ms, the worst 19.0 ms; the worst frame that uploaded a tile had 1.4 to 5.2 ms of
  main-thread work. A tile is one 147 KiB sub-image upload: 0.02 to 0.16 ms in the call
  (median), 0.29 ms at most. The display table, 1.5 KiB, is uploaded whole 23 times for
  a forward view.
- **The current path's upload** costs 6.2 to 6.9 ms of main-thread work in each upload frame
  on WebGL (20 frames, 300 ms), and on WebGPU 1.2 to 2.3 ms, with one 76 ms frame in one
  run. Phase 1 saw 17 ms for filling such a texture at once; the app's row-by-row uploader
  spreads it.
- **Decoding** a 194² JPEG tile took 1.2 to 1.8 ms median off the main thread
  (`createImageBitmap`) and 0.24 ms to read back; **reconstructing** a residual tile on
  the CPU 0.8 to 1.3 ms, 2.3 ms at most, and 0.35 ms with another core kept busy.
- **Selection and scheduling** cost 0.04 ms a frame while the camera is still and 0.8 ms
  while it moves (p99 2.0 to 2.5 ms, at most 6.7 ms); 0.18 ms with another core busy.
  This is the largest per-frame cost the prototype adds, and the first to watch on a phone.
- **GPU time per whole frame** (timer, sampled): ray lookup 0.73 to 1.0 ms, mesh patches 0.50
  to 1.39 ms on WebGL 2 and WebGPU, too close and noisy on this GPU to rank. WebGL 1's
  timer repeats one value and is reported as invalid. The render call costs 0.2 to 0.3 ms
  of main thread on WebGL and 0.4 to 0.5 ms on WebGPU.
- **Mesh patches** (12,288 triangles, 32 × 32 quads a face) agree with the exact picture to
  40 to 48 dB, and with the closed-form pattern to within 0.3 dB of the ray lookup: their
  error is a fraction of a texel. Ray lookup is one triangle.
- **Memory.** The atlas is one 28 MiB allocation made at start; a forward view uses 45 of
  its 196 slots and exploring fills them all. Residual texels held on the CPU peaked at
  3.3 MiB for a forward view and 17.5 MiB exploring, inside their 32 MiB budget. The
  control holds 96 MiB on the GPU.

### 8. Caches, small budgets and failures

- **Warm cache** (rerun over plain HTTP/1.1, see the caveats): the second visit asked the
  server for nothing (47 of 47 files from the browser's cache); the bootstrap was shown at
  7 ms instead of 117 and the view was high at 0.51 s instead of 2.25 s, the rest being the
  client's limit of two uploads a frame. The control's preview came from the cache; its
  whole image, cut off by the end of the first visit, was fetched again.
- **A small GPU budget** (64 slots, three laps of the exploring trace at 10 Mbit/s): resident
  tiles never passed 64, no cell ever lacked something to show, no frame passed 20 ms, and
  the footprint was steady ([figure](plots/resources-over-time-http.svg)). The price was
  churn: 1,079 evictions and 793 re-downloads (10 MB received against 3.5 MB for one lap)
  with direct tiles; with residuals and 4 MiB of CPU texels, 1,858 re-downloads and 76
  parents fetched again only to predict a child. The browser's cache could not absorb the
  re-downloads here (the same certificate caveat); on a real host it would.
- **Failures**: with one tile request in four answered 503, 29 failed, all were retried, the
  view was high at 5.0 s, and nothing was ever blank; with every tile 500 ms late, at 6.5 s.


## Interpretation

The questions the prototype was built to settle, answered for this desktop and these
conditions only.

**Representation.** EAC retains a quality-per-byte advantage over the ordinary cubemap at
the source's resolution after gutters and tiling: 15% fewer bytes with 1536-texel faces,
8% with 2048. It comes from the cubemap's undersampled face centres, so it shrinks as the
cubemap is given more texels, and at cube corners the cubemap is ahead. Its cost in drawing
is two arctangents a pixel: on this desktop a whole frame took 0.7 to 1.0 ms of GPU time with
the ray lookup and 0.5 to 1.4 ms with mesh patches, and the difference is within the timer's
noise. A phone GPU's cost was not measured.

**Progression.** Jumping straight to the level the view needs gives the best image soonest
for a still or slowly moving view, with the fewest bytes and requests. Visiting every level
is never better. Residual refinement improves the first moments after a turn and the
exploring trace by 0.2 to 2 dB of mean shortfall, at 36% more bytes for a still view and a
dependency on CPU-held parents; its byte saving holds only against a full replacement
pyramid, which nobody need send. It does not justify its implementation now.

**Startup and surprise turns.** A one-image bootstrap of 48 texels a face (4 to 5 KiB, one
request) is on screen in 0.12 s at 2 Mbit/s and covers every direction; it is a placeholder
(17.6 to 25.3 dB), not a picture. 96 texels (12 to 19 KiB) buys about 1.3 dB at a turn for little
delay and is the better default if a turn's first frame matters. Insurance spends 28% or
more for nothing measurable afterwards; it is not recommended on these traces.

**Rendering and reconstruction.** Both drawing paths are one draw call on all three
backends and agree with the exact picture to a fraction of a texel. On this GPU they cannot
be told apart in time; ray lookup is the default because it is exact and needs no geometry,
and mesh patches stay the fallback if a phone GPU finds the arctangents costly. CPU
reconstruction of a residual tile costs about one decode (1 ms, 0.35 ms with the processor
awake), so a GPU path could save at most that per residual tile; since residual tiles are
not recommended, it was not built. The backends drew the same pictures and showed the same
frame behaviour; WebGPU's render call costs about twice WebGL's main-thread time.

**Resources and delivery.** 192-texel tiles and six requests at once are the measured
optimum here (96 and 384 are slower; two requests much slower, twelve no faster). Memory
and work stay bounded: a 28 MiB atlas against the control's 96 MiB, queues within their
limits, no hole and no late frame under a budget a third of the default, and memory
pressure turns into re-downloads rather than gaps. Each arriving tile is one small upload;
nothing re-uploads the panorama. The simulator's predictions held over real HTTP/2 through
Chrome's emulation. Whether a remote static host preserves them (GitHub Pages' handling of
50 to 150 small requests, its cache, a lossy network) was not measured.

## Unknowns

- **Phones.** Nothing ran on one. Decode and upload per frame, a phone GPU's cost for the
  ray lookup and the dependent reads, memory pressure, thermal behaviour and whether a phone
  idles between frames as this desktop does are all unmeasured.
- **A remote host.** Nothing was published. GitHub Pages' HTTP/2 behaviour with 50 to 150
  small requests, its priorities, and a real network's loss and variability are unmeasured.
  Chrome's emulation shapes inside the browser: the loopback server sends at full speed,
  so the server never sees a cancelled transfer; the page's own byte counts are the measure.
- **Perception.** PSNR and luma SSIM only. The step where a tile of the finest level meets
  the bootstrap is plain to see in the crops; whether people mind it was not asked.
- **Minification and shimmer** on low-density displays were not inspected; at the phone
  viewport everything is magnified.
- **The GPU residual path** was not built (see the status table).

## What failed, and caveats

- **Selection, first version.** Sampling the view with rays missed slivers of tiles at its
  border (27 tiles of 8,386); the independent per-pixel check caught it, and selection is
  now exact.
- **Shaders.** A uniform named `layout` compiled on WebGL 1 and failed on WebGL 2, where it
  is a reserved word; renamed.
- **Readback.** WebGPU's canvas on this Mac reads back as BGRA, not RGBA, and the first
  WebGPU comparison showed 11 to 20 dB until the channel order was detected. Phase 1
  compared each backend only with itself, which cannot see this.
- **Drawing buffer.** The page first drew at the CSS size (412 × 915), not the device
  pixel ratio's; caught by the readback size.
- **Replay atlas.** Replaying a whole-sphere table overflowed a 196-slot atlas and drew
  garbage on later faces; replay now sizes its atlas to the pyramid and an out-of-range
  slot throws.
- **A parsing bug** turned "never" into 0 s in an early summary; fixed before any table here.
- **Calibration** of the 0.75 Mbit/s profile outran a DevTools call's 15 s limit and stopped
  the first HTTP run before any experiment; it now runs in the page and is polled.
- **The first warm-cache runs were not warm.** Over HTTPS with the loopback's self-signed
  certificate, Chrome stored nothing in its HTTP cache (it does not cache past a certificate
  error, even one it was told to ignore), and the second visit fetched every file again.
  The set was rerun over plain HTTP/1.1 on 127.0.0.1; only that rerun is reported. The same
  cause kept the browser's cache out of the small-budget runs' re-downloads.
- **The first full HTTP run lost its tables.** All 186 browser runs completed, then the
  control's replay deadlocked (it waited for an upload that only its own frame loop could
  pump) and, once fixed, failed on WebGPU (a texture bound before it existed). The results
  were rebuilt from the runs' raw output with `--from`, without running the browser again;
  the server's own byte log, kept only in memory, is therefore absent from them.
- **Two earlier starts of that run were stopped** and restarted: judging inline made it slow,
  and each page downloaded its script through the throttled link before starting. Neither
  affected a measurement (the trace's clock starts after the script runs); the page now
  loads unthrottled and waits at a gate, and judging runs afterwards in four processes.
- **Resource timing** stops at Chrome's default 250 entries, so the page's transfer-size
  totals undercount long runs; the client's own byte counters are complete and are the ones
  reported. The page now asks for a larger buffer.
- **Chrome's emulation shapes inside the browser**, after the loopback server has sent each
  response at full speed, so the server never sees a transfer cut short; cancelled bytes
  are the page's count of what it had received.
- **The control's absolute quality** is not comparable with the tiles' (section 2).
- **One machine, three panoramas,** all from one camera pipeline and compressed once
  before they arrived. The simulated medians pool panoramas and start orientations.
- CPU-heavy steps (datasets, simulation, judging) shared the machine with the correctness
  runs, never with a timed set: the frame-timing sets ran under the quiet guard.

## Status of every requirement

| Brief item | Status | Note |
| --- | --- | --- |
| 1 Read Phase 1 | done | INVENTORY.md |
| 2 Architecture, cubemap control in the same pipeline | done | |
| 3 Preprocessor, two projections, manifest, regeneration | done | face size argued in "The architecture as built" |
| 4 Tile and face boundaries | done | gates in section 1 |
| 5 Bootstrap, sizes measured, never evicted | done | not evictable by construction; four sizes |
| 6 Geometric selection, coverage check, overlay | done | overlay in the page's debug mode, off in timing runs |
| 7 Scheduler, logged reasons, bounds, cancellation | done | prediction not built (optional) |
| 8 Policies A and B, quick turns, rotated starts | done | |
| 9 Replacement, direct against every level | done | |
| 10 Residual tiles, verified, compared | done | |
| 11 CPU against GPU reconstruction | CPU done; **GPU deferred** | the residual does not survive the comparison in 9–10, so its GPU path would not change a decision |
| 12 Ray lookup against mesh patches | done | on desktop only |
| 13 Incremental updates | done | one sub-image upload a tile; the table uploaded whole |
| 14 Bounded caches, eviction, switching, failures | done | context loss not exercised |
| 15 Static HTTP, cold and warm | done on the loopback | remote host not run |
| 16 Network profiles | done | Chrome's emulation, calibrated; no OS shaper |
| 17 Traces, starts, elapsed time | done | |
| 18 Quality of what is seen | done | judged on the validated CPU renderer; screenshots by GPU replay |
| 19 Phones | **blocked** | no device for automated runs; a test by hand on an Android phone was tried on 2026-10-02 and did not get going (cause not found). Package and instructions in the README |
| 20 One dataset on three backends | done | |
| 21 The existing viewer as control | done, isolated | absolute quality not comparable (section 2) |
| 22 Cubemap as close competitor | done | native cube-texture route deferred: it cannot hold mixed levels without a different texture design |
| 23 Projection-specific code apart | done | lib/tiling.mjs only |
| 24–28 Questions, matrix, gates, artefacts, report | done | |

## Where this leaves it

**Phones, by hand.** After the report, a test by hand on an Android phone was tried and did
not get going; the cause was not found. README.md, "Testing by hand", has the instructions
and what is known to stop it. Nothing in this report has been seen by a person on a phone.

**Outcome: continue with one specific experiment, then propose production.** Under the
tested conditions (this desktop, Chrome 154 on three backends, loopback HTTP/2 with
Chrome's emulation, three UMN panoramas, the 1081 × 2401 phone viewport) the evidence
supports:

- **EAC faces of 1536 texels, 192-texel tiles with a one-texel gutter, JPEG 4:2:0 quality 80,**
  addressed `{face}/{level}/{x}/{y}` with a version-1 manifest;
- **a one-image bootstrap** fetched first (48 texels a face; 96 if the first frame after a
  turn matters more than 10 KiB);
- **direct replacement**: the level the view needs, nothing in between, no residuals, no
  insurance;
- **ray lookup**, one atlas, a display table, bounded queues and caches as built.

Provisional: every per-frame cost (they are this desktop's); the GPU budget of 196 slots;
two uploads a frame (it sets the warm revisit's 0.5 s); selection every frame while moving
(0.8 ms here; it could run less often); JPEG over WebP or AVIF (not compared in this
phase); the face size (2048 is a little better per byte for the cubemap and mixed for EAC).

Not supported, because not measured: anything about a phone, a remote host, perception, or
shimmer on low-density displays.

**The single next experiment** with the most information: the exported package
(`export-package.mjs`) on a low- or mid-range Android phone and an iPhone, served from
GitHub Pages or a LAN static server on a real throttled connection, running EAC direct
(ray lookup, then mesh patches) against the current path on the forward, quick-turn and
exploring traces. It would settle, in order: whether selection, decoding and uploading
tiles make a phone miss frames (the desktop's 0.8 ms selection and 1.5 ms decodes,
multiplied by a phone's factor); whether a phone GPU affords the ray lookup's arctangents
and dependent reads or needs mesh patches; how much memory a phone tolerates for the atlas;
and whether a real static host keeps the 1.3 s against "never in 10 s" seen here. If it
does, the architecture above is ready to be proposed for production; if per-frame work is
the problem, the selection rate and the upload budget are the first parameters to move.
