# Startup and runtime audit

Times how the three FOSS Earth apps start and what they cost once running:

- the UMN tour, `/tour/minneapolis/`;
- the FOSS Earth app, `/app/`;
- 0sfs, `/fly/`.

The results are recorded in [Performance audit](https://github.com/foss-earth/docs/blob/main/docs/performance-audit.md)
and in [Startup](https://github.com/foss-earth/docs/blob/main/docs/proposals/startup-loading.md#startup-measurements)
in foss-earth/docs.

## Running it

Build each app first. Each build is passed to the script as data; the script imports
nothing from it.

- The tour: `npm run build` in `UMN-VR/tour`, which writes `dist/`.
- The app: `npm run build` in `foss-earth/app`, then in `foss-earth.github.io`. The
  second writes the site to `dist/`, with the landing page at `/` and the app at `/app/`.
- The flight: `npm run build` in `0sfs/fly`, then in `0sfs.github.io`. The second writes
  the site to `dist/`, with its landing page at `/` and the flight at `/fly/`.

```sh
node scripts/benchmarks/startup-audit/run.mjs --serve --runs 3 --audit \
  --tour-root ../../UMN-VR/tour/dist \
  --app-site ../foss-earth.github.io/dist \
  --fly-root ../../0sfs/0sfs.github.io/dist
```

Options, all listed at the top of [run.mjs](../../scripts/benchmarks/startup-audit/run.mjs):

| Option | What it does |
| --- | --- |
| `--targets tour,app,fly` | The pages to measure. |
| `--runs 3` | Cold and warm visits per page, each in a new browser profile. |
| `--until settled` | When a visit ends: `settled` (`boot:settled`; the flight, 15 s after `boot:content`), `content` or `globe`. |
| `--audit` | After each warm visit, the runtime audit: frames, CPU and memory. |
| `--audit-seconds 8` | The length of each runtime stretch. |
| `--app-root <dist>` | The app's own `dist/`, served at `/app/`, instead of `--app-site`. |
| `--via <path>` | Opens a page that links to the target first, such as `/`, and waits there until the target's service worker is active, as a visitor reads a landing page. |
| `--live` | Measures the published pages over HTTP/2 instead of local builds; leave out `--serve`. |
| `--filmstrip` | Keeps what the screen showed about every 100 ms of each cold visit. |
| `--binary <path>` | A Chrome to use. Without it, `CHROME_BIN` or Google Chrome's usual place. |

Output goes to a new `build/benchmarks/startup-audit/<label>/<local time>/` folder:

- `summary.md`, the tables;
- `results.json`, every visit;
- `<page>-<run>-cold.json` and `-warm.json`, each visit with its requests;
- `<page>-<run>-audit.json`, the runtime audit;
- a screenshot of each visit.

The script starts headless Chrome on this machine's GPU and serves the builds on ports
4173 to 4175. It does not check that the machine is quiet. It records the load average
with each runtime stretch instead. Agree on an exclusive window before treating a run as
more than indicative.

## What it does

1. **Network and CPU.** It serves each build like GitHub Pages: gzip,
   `Cache-Control: max-age=600` and ETags, over HTTP/1.1. Tiles come from the real tile
   servers, and the tour's photographs from the published site.
2. **Throttling.** Every visit runs under DevTools' Fast 4G preset (165 ms latency,
   1,012,500 B/s down) and a 4× CPU slowdown. Both are applied to the page, its workers
   and its service worker. Chrome refuses both in dedicated workers, so their requests
   wait the page's latency but their CPU runs at full speed.
3. **Cold visit.** It opens the page on a new, empty profile. A first visit reloads once
   to become cross-origin isolated. Such a visit is timed from its first navigation: the
   HTML, the terminal and the first paint come from the first load, and the other marks
   from the last load.
4. **Warm visit.** It opens the page again in the same profile, through the service
   worker the first visit installed.
5. **Marks.** It reads the page's `boot:*` marks and paint entries, plus the bytes the
   network carried before the first 3D frame. Blocking time is the sum of each long
   task's time past 50 ms, for the tasks that began before the mark. This is total
   blocking time, measured to the globe instead of to interactive.
6. **Runtime.** With `--audit`, after the warm visit reaches its moment, it runs
   8-second stretches at 1× and then at 4× CPU slowdown. Each speed has a still stretch
   and a left-button drag that swings the view back and forth, about a fifth of the
   width every two seconds. The flight flies by itself, so it has only still
   stretches. Each stretch records:
   - the `requestAnimationFrame` intervals;
   - main-thread CPU time from Chrome's thread ticks;
   - each Chrome process's CPU time.
7. **Memory.** After the stretches, it records:
   - each V8 heap, on the page and on each of its workers;
   - the page's array buffers, its WebAssembly memories among them;
   - each Chrome process's macOS footprint, with its graphics part.

## Profiling a stretch

[profile.mjs](../../scripts/benchmarks/startup-audit/profile.mjs) makes the same visit,
then records a V8 CPU profile of each stretch and maps it to source functions through the
build's source maps. Build the page with `vite build --sourcemap --outDir build/<name>`.

```sh
node scripts/benchmarks/startup-audit/profile.mjs --target app \
  --root ../app/build/perf/<name> --label <name> --rates 1,4 --seconds 8
```

- `--motion still|drag`: the tour and the app are dragged by default. The flight
  flies itself, so it is left still.
- `--probe '<expression>'`: an expression read before and after each stretch, such
  as counters patched into a build.
- `--memory`: after the stretches, the macOS footprint by category of the page's
  renderer and of the GPU process, and a memory-infra dump by allocator.

It writes `summary.md`, with each stretch's frames, main-thread share and self and
inclusive time by function and file, and each `.cpuprofile`, which DevTools opens.
[profile-tree.mjs](../../scripts/benchmarks/startup-audit/profile-tree.mjs) prints the
call tree under one function of a saved profile:

```sh
node scripts/benchmarks/startup-audit/profile-tree.mjs --profile <file.cpuprofile> \
  --root <dist> --base /app/ --focus "update createImageryRuntime.ts" --depth 4 --min 2
```

## Reading the numbers

- **Frame intervals are the display's pace, not GPU time.** A 60 Hz display caps them
  at 16.7 ms.
  - A still page that draws on demand still shows 60 frames/s, because the
    audit's own `requestAnimationFrame` loop keeps frames coming.
  - Read "frames over 25 ms" and the main thread's share alongside the intervals.
  - For time per frame section, CPU and GPU, use the renderer's frame profiler
    (`?set.renderer.profiling.enabled=1`).
- **Main thread busy** is the fraction of one core the page's main thread ran. At 4×,
  Chrome slows that thread, so the share grows about fourfold for the same work.
- **Page renderer CPU** is the busiest renderer process, which is the page's own. It
  includes the compositor, the raster threads and the workers. At 4× it also appears to
  include Chrome's throttling itself, which ran at about 0.8 of a core while the page
  was still. Compare the main thread there instead.
- **Memory.**
  - Graphics memory is from macOS `footprint`, as the dirty memory in the
    `(graphics)`, `IOSurface` and `IOAccelerator` categories. Browsers have no
    GPU-memory API.
  - A shared WebAssembly memory is counted again by each worker that holds it. The
    summary therefore gives the page's array buffers alone, and the workers' heaps
    without their array buffers.
  - `performance.measureUserAgentSpecificMemory()` is not used: on these pages it did
    not resolve within 60 s.
- **The CPU slowdown is not a phone.** The GPU is never throttled, and worker CPU is
  not slowed. The 4× figures show where the main thread runs out first, not a phone's
  frame rate.
