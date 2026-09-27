# Panorama campus check, 2026-09-27

The stage 1 acceptance check of [panorama scenes](../../../../docs/proposals/panorama-scenes.md):
one 360° orb 30 m above the University of Minnesota campus (44.974°, −93.235°),
driven through the real globe camera and scene loader in headless Chrome, on this
machine's GPU. [`summary.md`](summary.md) is the run's own summary, and
[`report.json`](report.json) holds every number.

**Result: the automated check did not pass.** Every check of the orb passed. At
the map detail asked for, the globe alone missed the frame budget, and the orb
added nothing measurable to its frame intervals. Manual acceptance is pending.

## Configuration

- **Code:** FOSS Earth commit `47f2d61`, with no uncommitted files. The report
  holds the SHA-256 of the scene manifests, their images, the check and its
  in-page agent.
- **Browser and GPU:** Chrome 153.0.8010.53, headless, WebGPU, on an Apple M5
  (metal-3 architecture, not a fallback adapter; Metal driver 27.0, macOS build
  26A428).
- **Views:** 1440×900 and 720×1280 at DPR 1, with a 60 fps frame-rate cap and a
  90° flat window.
- **Map:** the default keyless sources, USGS Imagery Topo imagery and Mapterhorn
  elevation, fetched live. Requests carried `foss-earth-check/1.0` and nothing
  about the person running it.
- **Scenes:** `umn-single` (the photograph), `umn-cardinal` (a synthetic image
  with N, E, S and W on it) and `campus-pair` (two linked panoramas). All three
  are in [`public/examples/panorama-scenes/`](../../../../public/examples/panorama-scenes/).

## Results

| Check | Result |
| --- | --- |
| Cold load, empty cache | App 820 ms; scene and preview 875 ms; marker placed 2084 ms |
| Mapping: the CPU contract applied to each pixel's GPU ray, against the direction the GPU sampled | at most 3.6e-4° over 67 probes (tolerance 0.01°) |
| Rays: each pixel's GPU ray against the CPU's pixel-centre ray | at most 1.3e-4° (tolerance 0.002°) |
| End to end | 2.8e-3°, 0.15% of what one pixel shows (the flat window magnifies ray differences 25.5 times there) |
| Draws | 3881 frames drew the orb, none with an earlier camera; draw and live camera within 7e-6 m |
| Negative control: uniforms one frame late | rejected (18.2°, 240 stale frames) |
| Pointer drags through the globe's input | the camera moved and the orb stayed exact (2.6e-4° at most) |
| Colour and orientation: photograph and cardinal image, looking north and east, landscape and portrait | 8 of 8 pass; mirrored and turned images all rejected |
| Panorama image requests while the camera moved | none |
| Entering, immersion against the CPU rays | 1.2e-5° at most |
| Exit | camera restored exactly (0 m, 0 rad) |
| The linked pair: enter A, follow to B, Back, Exit | Back returns to A; camera restored exactly |
| Exit chip and credit, as the browser lays them out | shown only while a panorama is entered |
| Frame intervals during motion | **globe alone misses the budget**; see below |

### Frame intervals

The same camera trace ran three times without readbacks: with the orb shown, with
it hidden (scene unloaded), and shown with profiling off. The map was held at the
detail asked for, and each run started once the map had stopped streaming.

| Run | Frames | p50 ms | p95 ms | p99 ms | Max ms | Over 100 ms |
| --- | --- | --- | --- | --- | --- | --- |
| Orb shown | 2863 | 16.7 | 66.6 | 83.4 | 133.3 | 4 |
| Orb hidden | 2838 | 16.7 | 66.7 | 83.4 | 150.1 | 2 |
| Shown, profiling off | 2835 | 16.7 | 66.7 | 83.4 | 133.3 | 8 |

The budget was p95 ≤ 20 ms, p99 ≤ 33.3 ms and none over 100 ms.

- **The orb's increment:** shown minus hidden is −0.1 ms at p95 and 0 at p99.
  The orb's own work, the scene's placement and uploads (0.11 ms) and the
  panorama uniforms (0.01 ms), comes to about 0.13 ms a frame.
- **Where the time goes:** the map's raster-tile update averages 7.4 ms a frame,
  with p95 28 ms and a maximum of 76 ms. GPU time is 1.9 ms. Each timed run asked
  for 5800 to 8500 imagery tiles and 2600 to 2900 elevation tiles as the camera
  moved. These count requests, some of which the browser may have answered from
  its own cache.
- **Why earlier runs passed:** before the check held the map's detail, it
  measured p95 16.7 ms. Automatic detail adjustment coarsens the map after the
  slow screenshot frames, by 1 to 1.75 levels in the runs that recorded it. At a
  frame-rate cap it never refines again, by design: detail returns only when
  frames average under 0.84 of the goal (`map.auto.refineBelow`), and capped
  frames never do. With the default settings, then, the globe holds 60 fps on
  this machine by drawing a coarser map than the one asked for.

The proposal says to report a globe-only miss separately, with the orb's
increment, and not to lower quality silently. Whether to change the targets, the
default map detail or the globe's tile work is the user's decision.

## Files

- `report.json`, `summary.md`: the run's report and summary.
- `screenshots/`: the four landscape views. The report also lists the portrait
  views, which were not kept.
- `traces/correctness-probes.json`: every probe of the correctness replay.
- `traces/timing-*-frames.json`: every frame's time and segment in each timed run.
- `traces/timing-*-profile.json`: every frame's sections, with the orb shown and
  hidden.

The photograph is Greg Zaal's
[Buikslotermeerplein](https://polyhaven.com/a/buikslotermeerplein), CC0, from
Poly Haven. Its provenance and the retained 512×256 input are in the
[visual-contract evidence](../visual-contract-2026-09-27/README.md). It was not
taken in Minneapolis: the scene places it there only as a test.

## Running it again

From the FOSS Earth root, with Chrome installed and the network available:

```sh
node scripts/validation/panorama-campus.mjs
```

It builds the app and serves the build to headless Chrome through request
interception, with no server. It takes about eight minutes and writes to
`build/validation/panorama-campus/<local time>/`. Its options are listed at the
top of the script. On macOS it holds off idle sleep while it runs.
Closing the lid still sleeps the machine, and a step the machine slept through
stops the check with that reason.

Results depend on live map tiles and the machine. The orb's direction, colour and
navigation results should repeat closely; the frame intervals are this machine's.

## Manual acceptance

Start the development server, which this check did not do:

```sh
npm run dev
```

1. **Load the scene.** Open <http://localhost:5173/?scene=umn-single>, or open
   Scenes (◎) → Content and choose **UMN — test panorama**.
2. **The starting view:** the camera starts 100 m south of the orb, at about its
   height, looking north. From the south, looking north, the orb shows the photograph's north:
   paving with a yellow object on it, a low wall, then lawn and trees under a
   cloudy sky.
3. **Looking east:** move round to the west of the orb and look east. The orb
   shows tall apartment blocks behind a wide lawn. With **UMN — cardinal test
   image**, the orb shows N looking north and E looking east, matching the
   globe's own compass letters in the sky.
4. **Reset the view:** Scenes → Content → **Back to the scene's view**.
5. **Enter the panorama:** click or tap the orb. Leave with the **Exit panorama**
   chip or Escape, which returns to the view you entered from.
6. **Frame budget:** click the GPU chip in the toolbar to open the Renderer tab,
   then Performance debug → Frame budget → **Measure frame time**.

**Known behaviour.** The orb stands 30 m above the ground the map displays, and
that includes tiles drawn flat until their elevation arrives. While terrain
loads, the orb can drop and rise, by hundreds of metres for a moment. In this
run it travelled 105 m before it settled at 286.1 m, and 0.4 m during the
correctness replay.

## Not covered

- **Hardware:** one desktop GPU in headless Chrome, not a phone or a visible
  browser window.
- **Tested elsewhere:** keyboard and gamepad look, reduced motion, device loss and
  cancellation are covered by unit tests, not here.
- **Stage 3:** the mesh, cache and appearance alternatives.
