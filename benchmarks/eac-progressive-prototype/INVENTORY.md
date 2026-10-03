# Inventory and plan (Milestone A)

Recorded on 2026-10-02 from FOSS Earth at `dc1feb4` (Phase 1 committed on top of `4866615`)
and the UMN tour at `9e8a058`, before any file of this benchmark was written. One untracked
file existed in FOSS Earth (`q0.md`, empty) and was left alone.

## What Phase 1 left that this reuses

| Phase 1 | Reused as | Changed |
| --- | --- | --- |
| `lib/representations.mjs`: the cube face table, the gnomonic and equi-angular warps | imported by `lib/tiling.mjs` | nothing; `verify.mjs` there checks them |
| `lib/source.mjs`, `lib/field.mjs` `resample`: each texel the mean of its cell in linear light | imported by the preprocessor, with the face continued past its edge for gutters | nothing |
| `lib/views.mjs`, `lib/metrics.mjs`, `lib/evaluation.mjs`: views, PSNR, luma SSIM, the twelve evaluation views | imported | nothing |
| `lib/network.mjs`: the network model | rewritten as a transport (`lib/sim.mjs`) with the same assumptions, so the real client runs on it | the scheduler is now the client's, not the simulator's |
| `lib/traces.mjs`: four camera traces | imported unchanged, with start orientations added (`lib/traces.mjs` here) | timing unchanged |
| `lib/codecs.mjs`: cjpeg/djpeg wrappers, 4:2:0, optimized Huffman tables | imported | nothing |
| `lib/schemes.mjs` `predictTile`: the residual prediction | re-derived in integers with gutters (`lib/residual.mjs`) | see the report |
| `lib/quiet.mjs`, `lib/pool.mjs`, `lib/environment.mjs`, `lib/svg.mjs` | imported | nothing |
| `gpu/page.ts`: engine creation, GPU timers, readback inside the frame | patterns followed in `viewer/page.ts` | – |

Phase 1's results are read, not rerun. Two of its findings were rechecked because the
prototype depends on them: the residual-against-replacement byte ratios (the datasets give
them again at full resolution) and the bilinear tap at a tile edge (Phase 1 read the
neighbouring tile; the prototype carries a gutter and its tests check the seams).

## The current panorama path (the control)

- `src/scenes/panoramaResources.ts`: on entering, the largest image the panorama offers up
  to `scene.panorama.immersionWidth`, which defaults to the widest offered: for the tour,
  `immersion-6144.jpg`, one equirectangular JPEG of 4.6 to 5.7 MiB written by
  `scripts/prepare-panorama.mjs` with jpeg-js at quality 80, no chroma subsampling. The
  64-texel cube preview is fetched first for every panorama of a scene.
- `src/engine/babylon/panorama/panoramaTextures.ts`, `panoramaWebGlTextures.ts`: the whole
  image decoded, then uploaded in rows at `scene.panorama.uploadMiBPerFrame` (4 MiB by
  default), with mipmaps (sRGB storage on WebGPU, encoded RGBA8 on WebGL).
- The control in `viewer/page.ts` fetches the same files and uploads them with that uploader
  at its default allowance; it draws with a lookup written to the production shader's
  conventions. It does not include the orbs, the globe or the app's scene: it is the
  panorama alone, which is the equivalent isolated workload the brief allows.

## The corpus

Three of the six Phase 1 panoramas, chosen for different content, all 6144 × 3072
equirectangular JPEGs (baseline, 4:2:0), already compressed once by YouVisit:

| Corpus id | Tour asset | Source bytes | Content |
| --- | --- | ---: | --- |
| northrop-mall (363729) | northrop-mall | 3,830,737 | sky with the sun, lawn, trees |
| bookstore (365382) | student-union-bookstore | 1,231,639 | signage and text, smooth surfaces |
| superblock (363760) | superblock | 4,623,586 | tree canopy overhead, fine detail at the zenith |

Their SHA-256 hashes are in every dataset manifest (`panorama.sourceSha256`).

## Devices, backends and tools available

| | Available | Notes |
| --- | --- | --- |
| Desktop | Apple M5, 10 cores, 16 GiB, macOS 27.0 | the only machine |
| Browser | Chrome 154, headless, ANGLE on Metal | WebGL 1 (engine with WebGL 2 disabled), WebGL 2, WebGPU |
| Phones | **none**: `adb devices` listed nothing; no iOS tooling (`xcrun xctrace` absent) | mobile validation blocked |
| Remote static host | not used: publishing needs authorisation | the export package is ready |
| Network shaping | Chrome's `Network.emulateNetworkConditions`; no OS shaper (dummynet/pfctl) without root | calibrated per profile |
| Codecs | libjpeg-turbo 3.2.0, libwebp 1.6.0, `sips` | JPEG only in this phase, as asked |

## The plan as run

Correct default first, then one factor at a time:

1. **Datasets**: EAC and cubemap at 1536-texel faces (the source's density at the horizon),
   tiles of 192 with a one-texel gutter, plus 96 and 384; bootstraps of 24, 48, 96 and 192
   texels a face; residual tiles for every level above 0; a JPEG quality ladder for matched
   quality, and 2048-texel faces as a check on the face size.
2. **Gates** before any performance number: addressing, orientation, exact coverage,
   seams, gutters, mixed levels, the residual arithmetic, the streaming invariants, and the
   GPU against an independent CPU renderer on every backend.
3. **Simulation** of progression (direct, every level, residual), representation, insurance
   and single-parameter sweeps, on four network profiles and Phase 1's four traces from six
   start orientations.
4. **Real HTTP** for the candidates and the control on two throttled profiles, then
   backends, frame times in both processor states, cold and warm caches, a small cache over
   a long trace, and injected failures.
5. **Phones**: blocked; a package and instructions instead.

Performance targets, fixed before the runs were scored: no blank pixel once the bootstrap
is shown; no work queue or cache above its limit; a view within 1 dB of its own finished
picture ("high") and within 3 dB ("acceptable"), Phase 1's thresholds; no frame whose
main-thread work reaches a 60 Hz frame (16.7 ms) because of refinement. These are tied to
the 1081 × 2401 phone viewport at 75° and to this desktop; none is a claim about a phone.
