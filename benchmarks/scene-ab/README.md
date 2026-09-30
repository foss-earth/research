# Scene A/B benchmark

Compares conditions, sets of registry values, in a built FOSS Earth app with a scene, on this
machine's real GPU in headless Chrome, with no server. It was written for the
[work-saving experiments](../../docs/validation/panorama-experiments.md) and the UMN campus
tour, whose performance on phones is what they are for.

## Running it on the UMN tour

Build the tour's app once (the photographs stay in `public/` and are served from there):

```sh
cd ../UMN-VR/UMN-VR.github.io && npm run build:app && cd -
node benchmarks/scene-ab/run.mjs \
  --dist=../UMN-VR/UMN-VR.github.io/dist-app --content=../UMN-VR/UMN-VR.github.io/public \
  --page=/tour/twin-cities/ --rounds=5 --seconds=5
```

Add `--webgl1` to start Chrome without WebGL 2, so the app gets a real WebGL 1 context
(`?renderer=webgl` alone does not guarantee one). Other options are listed at the top of
[run.mjs](run.mjs): the stops, the workloads (`look` inside each stop, `overview` of the
campus with its orbs), the conditions, the viewport and the renderer.

Output goes to a new `build/benchmarks/scene-ab/<local time>/` folder: `report.json`, a
`summary.md` and a `heatmaps/` folder.

## Using the machine while it runs

You can, but the run takes longer. Each timed stretch starts only after `--idle-seconds` (10)
without keyboard, mouse or trackpad input, which macOS reports as `HIDIdleTime`. The
benchmark's own touches do not count. A stretch is run again, up to `--retries` (3) times, when
there was input during it, or when the machine had more than `--max-extra-cores` (1.5) cores
busier than during the undisturbed stretches so far, as a build or a video call would make
it. A stretch still disturbed after that stays in `report.json` and is left out of the
comparison, and the summary says how many.

What it cannot see is load that stays constant through a whole run, such as a long build
started before it. That slows every condition alike, and the A/A control shows how much
noise it adds. Nothing here makes a shared machine as quiet as a dedicated one. The real
target, a phone, is also the quietest machine to run on: Chrome on Android speaks the same
DevTools protocol over `adb`, so connecting a phone is the next step for this harness.

## What it does

1. Serves the build, then the content folder behind it, through request interception. Map
   tiles and other outside requests are fetched once, identified as `foss-earth-check/1.0`,
   and replayed from `build/benchmarks/scene-ab/tile-cache/` after that.
2. Opens the page with `?panoramaTest=1` and the frame profiler on, at a phone's viewport
   (412 × 915 CSS px at DPR 2.625, touch), and waits for the scene and its previews.
3. Visits every workload once and compiles every condition's shaders, so no timing includes a
   first compile.
4. **Equivalence:** holds the view still and reads the canvas back under each condition. The
   baseline is read twice first, which is the noise floor. Differing pixels are counted and
   drawn as a heat map.
5. **Timing:** rounds of every condition, and the baseline a second time (`baseline-again`),
   in a new random order each round, switched live in the same page. Each is a stretch of
   scripted one-finger drags with frames held continuous, and each condition is paired with
   the same round's baseline.

## Reading the numbers

- The result is work per frame. `Render` is Babylon's scene render on the main thread by the
  clock, broken down into active-mesh evaluation, drawing and panorama uniforms. `Main
  thread` is Chrome's own count of the main thread's CPU time per frame (the Performance
  domain in thread ticks). It includes everything in the frame (input, the HUD, garbage
  collection) and leaves out time the thread waited for a core. `GPU` is the GPU's frame from
  the WebGL timer query; Babylon times one frame in every few.
- On WebGL 1 the frame profiler's GPU timer gives one reading and never another, so the
  summary shows `stale` there instead of a number.
- *Meshes examined* and *draw calls* are counts, so load cannot move them. They show whether
  work was removed even when the milliseconds are noisy.
- `baseline-again` is the noise floor: a change no larger than the difference between the
  two baselines is not a result.
- Frame intervals say little here. An Apple M-series machine meets the display rate with or
  without a change, so the interval sits at 16.7 ms either way.
- Chrome's CPU throttling (`Emulation.setCPUThrottlingRate`) is not a phone stand-in here.
  At 4× it made the profiler's per-frame sections shorter and noisier, not longer, so the
  option was removed. The GPU is never throttled either way, so GPU savings on this machine
  only suggest what a phone's GPU would save.
- Every response is served cross-origin isolated, because Chrome otherwise rounds
  `performance.now()` to 100 µs, which erases sub-millisecond sections. The report records
  `crossOriginIsolated`.
- Headless Chrome on macOS draws through ANGLE on Metal. Android Firefox, where the tour was
  reported slow, draws through Gecko on the phone's own GL driver. This benchmark decides
  whether a change removes work; whether that is enough on a phone is for a device trial.
