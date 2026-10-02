# What existed before this benchmark

Recorded on 2026-10-01, before any file was added, from FOSS Earth at commit `4866615` and
the UMN tour (`../UMN-VR/UMN-VR.github.io`) at `9e8a058`. Nothing in either repository was
changed to make the benchmark work; everything it adds is in this folder.

## Benchmarks in FOSS Earth

`benchmarks/` held six areas, none about panoramas' image representation:

| Folder | What it measures | How it runs |
| --- | --- | --- |
| `terrain/` | Terrain sampling lattices and mesh building, CPU only | Node, Babylon's NullEngine |
| `collision/` | Surface queries and a BVH prototype, CPU and a GPU comparison | Node; headless Chrome for the GPU part |
| `wheels/` | Wheel contact kernels | Node; one browser run |
| `map-detail/` | Map imagery binding and detail sweeps on WebGPU, WebGL 2 and WebGL 1 | Playwright driving the installed Chrome |
| `globe-compare/` | The globe against other globes | Headless Chrome |
| `scene-ab/` | A built app with a scene, such as the UMN tour, under A/B settings: pixel equivalence, CPU and GPU time per frame at a phone's viewport | Headless Chrome through pipes, tiles recorded and replayed |

Conventions they share, which this benchmark follows: plain `.mjs` scripts run with `node`;
tracked `results*.json` beside the scripts; everything else in the gitignored
`build/benchmarks/<area>/`; a README per area; no server and no visible browser.

## Headless GPU harness

[docs/validation/README.md](../../docs/validation/README.md) lists the harnesses.
[scripts/lib/headlessChrome.mjs](../../scripts/lib/headlessChrome.mjs) drives the installed
Chrome over DevTools pipes; pages are bundled with Vite's library mode and served by request
interception. Real WebGL 1 comes from an engine built with `disableWebGL2Support` or from
Chrome's `--disable-webgl2`. WebGPU needs `--enable-webgpu-developer-features` for
fine-grained timestamps. GPU time comes from the WebGL disjoint timer query (one frame in
every few; on WebGL 1 Babylon's reading never updates after the first) and from WebGPU
render-pass timestamps ([src/perf/frameProfiler.ts](../../src/perf/frameProfiler.ts)).
`run-gpu.mjs` here uses the same helper and the same GPU timers.

## Panorama rendering

- Babylon.js `@babylonjs/core` 8.56.2 is installed (`^8.21.1` declared).
  [createRendererMode.ts](../../src/engine/babylon/createRendererMode.ts) picks WebGPU,
  then WebGL 2, then WebGL 1, or the one the user forces; there is no further renderer
  abstraction, and code that differs by backend asks whether the engine is WebGPU.
- [src/engine/babylon/panorama/](../../src/engine/babylon/panorama/): the renderer draws each
  preview "orb" as a quad whose pixels cast rays at a sphere, and the immersive view as one
  triangle covering the screen. Both are ray lookups: a pixel's ray becomes a cube-map or
  equirectangular texture position. Shaders exist twice, WGSL for WebGPU and GLSL for WebGL.
- Textures are RGBA8, sRGB, with mipmaps where the backend can make them. Uploads are
  chunked by rows against a per-frame byte allowance
  ([panoramaTextures.ts](../../src/engine/babylon/panorama/panoramaTextures.ts),
  [panoramaWebGlTextures.ts](../../src/engine/babylon/panorama/panoramaWebGlTextures.ts)).
- No tiled, hierarchical or view-dependent panorama representation exists. The proposal
  ([docs/proposals/panorama-scenes.md](../../docs/proposals/panorama-scenes.md)) names tiled
  immersion as a later capability that "must specify tile dimensions, levels, borders, mip
  policy and URL addressing".

## Asset format and loading

- The scene format ([docs/scenes/format.md](../../docs/scenes/format.md),
  [src/scenes/](../../src/scenes/)) gives each panorama interchangeable representations:
  `projection: "cube"` (six face files) or `"equirectangular"` (one file), each with its
  size and `encodedBytes`.
- The loader ([loadScene.ts](../../src/scenes/loadScene.ts),
  [panoramaResources.ts](../../src/scenes/panoramaResources.ts)) fetches the smallest cube
  preview of every panorama first, sharpens previews, and on entering a panorama fetches one
  whole equirectangular image at the chosen size. A whole image must finish downloading and
  decoding before any of it is shown.

## Conversion tools

[scripts/prepare-panorama.mjs](../../scripts/prepare-panorama.mjs) with
[scripts/lib/panoramaImage.mjs](../../scripts/lib/panoramaImage.mjs): equirectangular in;
cube previews and whole equirectangular sizes out; resampling in linear light from an
area-averaged pyramid; PNG through its own codec and JPEG through `jpeg-js`. This benchmark
reuses its conventions (axes, cube face table, equirectangular mapping) and its PNG codec,
and copies nothing else. `jpeg-js` writes baseline JPEG without chroma subsampling and with
the standard Huffman tables.

## Tests, build, package manager

npm; `npm run ci` is lint, Vitest (96 test files under `src/`) and a Vite build. ESLint
covers `**/*.{ts,tsx}`; TypeScript's build covers `src/` only. So `gpu/*.ts` here is linted
and the `.mjs` scripts are not.

## The UMN tour's panoramas

- 60 panoramas in the published scene (`public/tour/twin-cities/`), each as cube previews of
  64, 128 and 256 px faces and whole equirectangular JPEGs 2048, 4096 and 6144 px wide,
  written by `prepare-panorama.mjs` at quality 80: 263 MiB in all.
- The sources are 79 files (64 distinct images) in the tour's gitignored
  `.local/youvisit-backup/snapshot-2026-09-27/media/panoramas/<id>/6144.jpg`: 6144 × 3072
  equirectangular JPEGs, YouVisit's largest derivative. The camera originals are lost, so
  these are the highest-quality copies that exist, and they are already compressed once.
  The benchmark reads six of them and never writes to that folder.
- The tour is served from GitHub Pages: static files, no control over response headers.

## Tools on this machine that the benchmark uses

Node 26.9.0; libjpeg-turbo 3.2.0 (`cjpeg`, `djpeg`); libwebp 1.6.0 (`cwebp`, `dwebp`); macOS
`sips` (AVIF and JPEG 2000); Node's zlib, Brotli and Zstandard; Emscripten 6.0.9 (`emcc`);
Google Chrome 154. Not installed, so not tested: `avifenc`, `cjxl`, `basisu`/`toktx` (KTX2,
Basis), Python's numpy, matplotlib and healpy. One package was added outside the
dependencies, into the gitignored `build/tools/healpix/`: `@hscmap/healpix` 1.4.12, used only
as an independent check of this benchmark's HEALPix.
