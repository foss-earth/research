# Spherical image representation benchmark

Experiments for choosing how FOSS Earth should hold and deliver 360° images in future:
which spherical grid, and which way of refining it over a slow connection. They compare
equirectangular, three cubed spheres, three octahedral squares, HEALPix and three icosahedral
grids, on six of the UMN tour's panoramas.

**[REPORT.md](REPORT.md) has the results and what they support.**
[INVENTORY.md](INVENTORY.md) records what existed before this was written.

Nothing here is used by the app, and nothing in `src/` was changed. This is not an
implementation of any of these representations: it is the smallest code that measures them.

## Running it

From the repository root. Each script writes `results/<name>.json` and `.csv`, with the
commit, runtime, machine and the script's own hash. Every option is listed at the top of
its script.

```sh
B=benchmarks/spherical-image-representation
npm install --prefix build/tools/healpix @hscmap/healpix   # once; only verify.mjs uses it

node $B/verify.mjs             # the maths: maps invert, cells cover the sphere, HEALPix matches a library
node $B/run-geometry.mjs       # 1. cell areas, shapes, lattice quality             (20 s)
node $B/run-reconstruction.mjs # 2. view quality against samples, no compression   (6 min)
node $B/run-hierarchy.mjs      # 3. replacement against residual refinement        (15 min)
node $B/run-codec.mjs          # 4. representation and codec together              (9 min)
node $B/run-progressive.mjs    # 5. quality against bytes, by order of sending     (16 min)
node $B/run-network.mjs        # 6, 7. simulated networks and camera motion        (15 min with five workers; see below)
node $B/run-cpu.mjs            # 8. decode and reconstruction time on the CPU      (5 min; leave the machine alone)
node $B/run-gpu.mjs            # 9. drawing and uploading on WebGL 1, 2 and WebGPU (8 min; leave the machine alone)
node $B/run-gpu.mjs --keep-busy=1 --name=gpu-busy   # 9 again, with one other core kept busy (8 min; see below)
node $B/make-tables.mjs        # results/tables.md: every derived number in the report
node $B/make-plots.mjs         # plots/*.svg
```

`--results=<folder>` on any of them reads and writes results there instead of `results/`,
for a trial that should not replace what the report cites.

Each result records the SHA-256 of the `run-*.mjs` script that wrote it, and the scripts
here are byte for byte what ran. Editing one, even a comment, breaks that match until it is
run again; `lib/` is not hashed. For that reason `run-gpu.mjs`'s header still states the
processor's low-power state as the cause of the slow frames, where the report says only
that it is the likely one. The results name commit `4866615` because the benchmark was
written and run on top of it, before being committed.

The report's sensitivity table also needs five short variants of the network run:

```sh
for variant in "--tile=128 --name=network-tile128" "--tile=512 --name=network-tile512" \
    "--concurrency=2 --name=network-concurrency2" "--concurrency=12 --name=network-concurrency12" \
    "--sharing=ordered --name=network-ordered"; do
  node $B/run-network.mjs --representations=cube,healpix --traces=stationary,quick-turn --series=false ${=variant}
done
```

(`${=variant}` splits the words in zsh; in bash write `$variant`.)

Times are on an Apple M5 (10 cores, 16 GiB) with five worker processes. Experiments 2 to 7
run their work in several processes: half the cores, or fewer where that many would not
fit in half the machine's memory. A worker needs 0.5 to 1.3 GiB, and 3.4 GiB in the network
experiment, so on a 16 GiB machine that one now starts two workers and takes about 40
minutes; the published run used five and made the machine swap, which cost time and
nothing else. `--processes=N` overrides the choice, and every run prints what its workers
used.

Experiments 1–7 are deterministic: the same inputs give the same numbers whatever else the
machine is doing. Experiments 8 and 9 measure time. They wait for ten seconds without
keyboard or mouse input and for normal memory pressure before each round, and run a round
again if there was input, other load, or any compressing or swapping of memory during it.

Experiment 9 is run twice because a frame's work is a short burst after 16 ms of idleness.
With nothing else running, that work took 5 to 20 times longer on this machine than the same
work in a loop, presumably because the processor slows or sleeps between frames;
`--keep-busy=1` spins one other core, and the difference goes away. Neither is the right
answer for a phone. Together they bracket what this machine does.
[Timing a benchmark on this machine](../../docs/validation/timing.md) keeps what this taught
for other benchmarks.

## What it needs

- **The panoramas.** Six 6144 × 3072 JPEGs from the UMN tour's backup of YouVisit, at
  `../UMN-VR/UMN-VR.github.io/.local/youvisit-backup/snapshot-2026-09-27/media/panoramas/`.
  That folder is gitignored and exists only where the backup was made; pass
  `--corpus-root=<folder holding <id>/6144.jpg>` to use another copy. Their SHA-256 hashes
  are in `results/reconstruction.json`. `run-geometry.mjs` and `verify.mjs` need no images.
- **Node 26**, for Zstandard in `node:zlib`.
- **Codecs on the path:** `cjpeg` and `djpeg` (libjpeg-turbo), `cwebp` and `dwebp`
  (libwebp), and macOS's `sips` for AVIF (`--codecs=jpeg,jpeg444,webp` leaves AVIF out).
- **Google Chrome**, for `run-gpu.mjs`; set `CHROME_BIN` for another build.
- **Emscripten** (`emcc`), optional: without it the WebAssembly rows are left out and say so.
  The first compile makes `emcc` cache two of its system libraries in its own install
  folder, outside the repository.

Scratch goes to `build/benchmarks/spherical-image-representation/`: Chrome's profile, the
bundled page, encoded tiles, the compiled WebAssembly kernel.

## Layout

| Path | What is in it |
| --- | --- |
| `lib/representations.mjs` | The eleven chart maps, both ways |
| `lib/geometry.mjs` | Cell area, chart stretch, lattice covering radius |
| `lib/source.mjs`, `lib/field.mjs`, `lib/views.mjs`, `lib/metrics.mjs` | Loading a panorama, resampling it into a representation, drawing views from it, PSNR and SSIM |
| `lib/hierarchy.mjs`, `lib/schemes.mjs` | The quadtree, the area-weighted Haar transform, and the delivery schemes built on them |
| `lib/ordering.mjs`, `lib/evaluation.mjs` | Orders of sending, and drawing a view from whatever has arrived |
| `lib/network.mjs`, `lib/traces.mjs` | The network model and the scripted camera motion |
| `lib/decodeKernel.mjs`, `wasm/decode_kernel.c` | The client's decode loops, in JavaScript and in C for WebAssembly |
| `gpu/page.ts`, `gpu/shaders.ts` | The Babylon page `run-gpu.mjs` runs in Chrome |
| `lib/codecs.mjs`, `lib/quiet.mjs`, `lib/pool.mjs`, `lib/environment.mjs` | Codec wrappers, the idle guard, worker processes, provenance |
| `lib/analysis.mjs`, `lib/svg.mjs`, `make-tables.mjs`, `make-plots.mjs` | What the report derives from the results, and its figures |
| `results/` | Raw results (`*.csv`, `*.json`) and the derived `tables.md` |
| `plots/` | Figures, as SVG that follows the reader's light or dark setting |
