# Progressive 360° image prototype (Phase 2)

An isolated, end-to-end prototype of the delivery Phase 1 pointed to: an equi-angular
cubemap (EAC) cut into a quadtree of JPEG tiles, a coarse whole-sphere bootstrap,
view-prioritised refinement, bounded caches and incremental drawing in Babylon on WebGL 1,
WebGL 2 and WebGPU, with the ordinary cubemap run through the same pipeline as the control
it has to beat, and the current whole-image path as the baseline.

**[REPORT.md](REPORT.md) has the results and the decision.** [INVENTORY.md](INVENTORY.md)
records what existed, the plan and what could not be run.

Nothing here is used by the app. The only production code it touches is imported read-only
by the control: the panorama uploader (`src/engine/babylon/panorama/panoramaTextures.ts`),
so the current path uploads exactly as it does in the app. No production file was changed.

## Running it

From the repository root. Every script lists its options at its top; each writes
`results/<name>.csv` and `.json` with the commit, runtime, machine and its own hash.

```sh
B=benchmarks/eac-progressive-prototype

# 1. The datasets (gitignored, 221 MB): three panoramas, both projections, tiles of 96, 192 and 384.
node $B/preprocess/build-dataset.mjs --tiles=96,192,384                                    # 2 min
node $B/preprocess/build-dataset.mjs --panoramas=pattern --quality=97 --chroma=1x1         # the diagnostic pattern
for q in 60 70 90; do node $B/preprocess/build-dataset.mjs --tiles=192 --quality=$q --residual=false \
  --measure-gutter=false --bootstrap=48 --out=build/benchmarks/eac-progressive-prototype/dataset-q$q; done
for q in 60 70 80; do node $B/preprocess/build-dataset.mjs --face=2048 --tiles=256 --quality=$q --residual=false \
  --measure-gutter=false --bootstrap=48 --out=build/benchmarks/eac-progressive-prototype/dataset-face2048-q$q; done

# 2. Correctness gates (Node; need the datasets).
node --test $B/tests/check-*.mjs                                                          # 30 s
node $B/run-gpu-checks.mjs                       # the GPU against the CPU, three backends, two paths (30–60 min)

# 3. Experiments.
node $B/run-representation.mjs                   # matched quality, EAC against cubemap and the control (10 min)
node $B/run-representation.mjs --face=2048 --qualities=60,70,80 --name=representation-face2048
node $B/run-sim.mjs --sets=policies,representation,insurance,sweeps                      # 897 runs (6 min)
node $B/run-http.mjs                             # every real-HTTP set (about 1 h; the frame-timing sets wait for an idle machine)
node $B/run-http.mjs --sets=warm --plain-http --name=http-warm                             # the warm cache, over HTTP/1.1
node $B/make-screens.mjs --run=build/benchmarks/eac-progressive-prototype/http/<that run>  # pictures at equal times

# 4. What the report cites.
node $B/make-tables.mjs --datasets               # results/tables.md
node $B/make-plots.mjs                           # plots/*.svg
```

`run-http.mjs --from=<a run's folder> --from-log=<its log>` rebuilds every result from that
run's raw output without running the browser again. The published results were made that
way, after the first full run's control replay failed at its last step (see the report).

## What it needs

- **The panoramas**: the tour's `.local/youvisit-backup/…/panoramas/<id>/6144.jpg`, as for
  Phase 1, and the tour's published `public/tour/twin-cities/` for the control. Both live in
  `../UMN-VR/UMN-VR.github.io`; `--corpus-root` and `--tour` point elsewhere.
- **Node 26**, libjpeg-turbo's `cjpeg` and `djpeg`, `openssl` (a certificate for the
  loopback server), macOS `sips` (one test decodes with Apple's JPEG decoder), Google Chrome.
- Vite and Babylon from the repository's own dependencies. Nothing new is installed.

## The three kinds of result, never pooled

| Category | Script | What is real |
| --- | --- | --- |
| Simulation | `run-sim.mjs` | The client, selection, scheduler and caches; Phase 1's network model; quality drawn on the CPU |
| Throttled real HTTP, loopback | `run-http.mjs` | HTTP/2 over TLS from a static server on 127.0.0.1, Chrome's network emulation, the browser's JPEG decoder, the GPU, frame timing |
| Remote static host | – | Not run: nothing was published. `export-package.mjs` makes the folder to publish |

The loopback server serves files only, with GitHub Pages' `Cache-Control: max-age=600`
and cross-origin isolation headers (so the page's clock is fine; GitHub Pages cannot send
them). Its one other route, `PUT /sink/…`, receives the page's results. It listens on
127.0.0.1 on a port the system picks, and closes when the run ends.

## Caches between runs

Every cold run opens a new browser context, so it has its own empty HTTP cache, and also
clears the browser cache over DevTools. The page registers no service worker and uses no
Cache Storage. The `warm` set opens the same page a second time in the first visit's
context; the server's log says which files were not asked for again. It must run with
`--plain-http`: Chrome caches nothing from a connection with a certificate error, and the
loopback certificate is self-signed. A cache-busting URL is never used.

## On a phone

No phone was attached to this machine (`adb devices` listed none), so nothing here has run
on one. To run it on a device:

```sh
node benchmarks/eac-progressive-prototype/export-package.mjs --panoramas=northrop-mall,superblock
```

writes `build/benchmarks/eac-progressive-prototype/package/`: `launcher.html` lists ready
runs (each candidate and the control, each backend, three traces) and one interactive page
with the tile overlay. Serve the folder from any static host the phone can reach (GitHub
Pages, or a LAN server you start), open `launcher.html`, and run each link with the phone
awake, unplugged or plugged as you mean to record, and nothing else open. Each run ends by
offering `<run>.json`; bring the files back and judge them with the same code as the
desktop runs (they have the same shape as `run-http.mjs`'s sink files).

For an Android phone on USB, Chrome's DevTools protocol reaches it through `adb forward
tcp:9222 localabstract:chrome_devtools_remote`; `run-http.mjs` drives a browser over pipes
and would need a WebSocket transport for that, which is not written. Record the model,
Android or iOS version, browser version, the backend the page reports (`backend` in the
results), the drawing buffer, battery saver, charging and temperature for every run.

## Testing by hand

No person has yet looked at the prototype on a phone. To do it, serve the package (made by
`export-package.mjs`) from this computer and open its launcher on the phone:

```sh
python3 -m http.server 8000 --bind 0.0.0.0 --directory build/benchmarks/eac-progressive-prototype/package
npm run qr -- --port=8000 --path=/launcher.html --no-key     # a QR code for a phone on the same Wi-Fi
```

The launcher's "look around" pages show each panorama as EAC or as a cubemap, to drag
around freely, and one with the tile overlay (white tile edges, a colour for each level).
What to ask of the people testing:

1. How long until something appears, and until it looks sharp; whether the blurry start
   looks broken.
2. Whether tiles snapping from blurry to sharp (there is no fade) is distracting.
3. Seams: between two directions (half-way from straight ahead to the side), straight up,
   straight down. Anything seen is checked against the overlay's tile edges.
4. A fast 180° turn after the view is sharp: what shows, and for how long.
5. Stutter while dragging, especially as tiles sharpen; anything going blank, slow or hot
   over a minute of exploring.
6. EAC against the cubemap, blind: someone else opens one of the two without saying which.
7. The same panorama in the live tour (<https://umn-vr.github.io/tour/twin-cities/>), on the
   same phone and network.

Wi-Fi is too fast to show the difference the report measured. On Android, connect USB, run
`adb reverse tcp:8000 tcp:8000`, open `http://localhost:8000/launcher.html` on the phone,
and throttle that tab from desktop Chrome's `chrome://inspect` (Network panel, a custom
profile of 2 Mbit/s and 100 ms). Record the device, OS and browser versions, battery saver,
charging and warmth for every session. The other launcher links play fixed camera traces
and offer a results file at the end; scoring files brought back from a phone needs a small
script that is not written yet.

**What stops it.** On 2026-10-02 a test on an Android phone was tried and did not get
going; the cause was not found. Things known to stop it:

- The phone and the computer on different networks, or a Wi-Fi network that keeps its
  clients apart; macOS's firewall refusing Python's incoming connections.
- A page from a plain `http://192.168…` address is not a secure context, so WebGPU is not
  available there (WebGL is). `adb reverse` with `http://localhost` is one; HTTPS is the other.
- 0sfs keeps a LAN certificate its iPhone trusts (`build/dev-certs`, for `npm run dev:lan`
  there); serving the package over HTTPS with it might work on an iPhone. Not tried.
- Publishing the package to a static host such as GitHub Pages would remove all of these;
  it has not been done.

## Provenance

Each result records the SHA-256 of the script that wrote it. Three were edited after their
results were made, without changing what they compute: `run-sim.mjs` (its configuration
helpers moved to `lib/config.mjs`), `run-representation.mjs` (the `--face` and `--name`
options added) and `run-http.mjs` (`--plain-http` added after `http.json` was rebuilt).
`viewer/page.ts` is not hashed; after the 186 browser runs behind `http.json` it gained the
control replay's two fixes, which the rebuild used, and a larger resource-timing buffer,
which only the warm-cache rerun had.

## Layout

| Path | What is in it |
| --- | --- |
| `preprocess/build-dataset.mjs` | Source panorama → EAC or cubemap pyramid → tiles with gutters, residual tiles, bootstraps, manifest |
| `lib/tiling.mjs` | The only projection-specific code: faces, tile ids, parents, children, outlines |
| `lib/cones.mjs`, `lib/selection.mjs` | Exact tile-against-view overlap; which tiles a view needs and at what level |
| `lib/client.mjs` | Bootstrap, scheduler, bounded caches, eviction, display table: shared by the simulator and the page |
| `lib/residual.mjs` | The residual payload's integer arithmetic, shared by encoder and decoder |
| `lib/sim.mjs`, `lib/render-cpu.mjs`, `lib/judge.mjs` | The network model, the CPU renderer and the quality judge |
| `lib/browser.mjs` | The loopback server, Chrome, network calibration |
| `viewer/page.ts`, `viewer/shaders.ts` | The page: tile atlas, display table, ray lookup and mesh patches, the control, replay, the overlay |
| `tests/check-*.mjs` | Correctness gates: geometry, seams, selection, streaming, caches, residuals |
| `config/` | The default configuration and the frozen experiment sets |
| `results/`, `plots/` | Raw results, derived tables, figures, and enlarged crops of seams in `plots/screens/` |

Scratch, generated tiles and every page's raw output go to
`build/benchmarks/eac-progressive-prototype/`.
