# Wheel spin-up experiment

This terminal benchmark compares two **one-way** wheel-feedback modes against
the same deterministic input traces:

| Mode | Wheel state | Aircraft forces |
|---|---|---|
| A · instant | Angular speed matches ground speed in one 120 Hz step | Unchanged JSBSim ground model |
| B · inertia | Three wheel angular states accelerate from tire/strut load | Unchanged JSBSim ground model |

The experiment deliberately does not add a force to the aircraft. JSBSim already
applies rolling and braking friction; adding a second full tire-force solver on
top would double-count it. This measures the sensory feedback experiment, not a
replacement longitudinal tire model.

Run from the `foss-earth` root after the matching flight-sim source is present:

```sh
node benchmarks/wheels/run.mjs
```

It writes [results.json](results.json), which contains medians from nine samples
after warm-up. The fixture covers a gentle and firm touchdown, bounce, braking,
and reverse taxi. It includes pure model update time for all three wheels; it
excludes JSBSim property reads, rendering, audio synthesis, frame time, and
power. Use `--traces /private/tmp/wheel-traces.json` only when a full 120 Hz
slip-power trace is needed for offline audio verification.

The recorded M5 results show B at roughly 0.08–0.10 µs per three-wheel physics
step, versus 0.05–0.08 µs for A. At the modeled 30 m/s gentle touchdown, B
settled the left main wheel in 0.158 s and dissipated 3.03 kJ of virtual tire
slip work across all three wheels; A reported zero slip work. These
figures are a reproducible compute comparison, not a claim about whole-game FPS,
battery draw, measured C172 wheel inertia, or subjective landing realism.

The one-way fixture also adds approximately 3.03 kJ of virtual rotational kinetic
energy to the wheels, supplied by the prescribed motion. Slip dissipation alone
is not total contact work, and none of it is removed from the aircraft.

## Including actual JSBSim property reads

```sh
node benchmarks/wheels/run-adapter.mjs
```

Requires Node 26 and the installed flight-sim dependencies; writes
[results-adapter.json](results-adapter.json). The script verifies airborne and
all-three-grounded states in actual C172 WASM, freezes the telemetry, warms the
adapter, then alternates case order over eleven timing rounds. It records input
telemetry, individual samples, SDK version and source/WASM hashes. All tests run
in the terminal; no browser, renderer, server or audio device is opened.

Recorded on Apple M5 / Node 26:

| Telemetry | Mode | SDK reads per update | µs per three-wheel update | Equivalent ms per frame at 60 FPS / 120 Hz |
|---|---|---:|---:|---:|
| Airborne | Instant | 5 | 1.291 | 0.00258 |
| Airborne | Inertia | 5 | 1.286 | 0.00257 |
| Three wheels grounded | Instant | 15 | 4.562 | 0.00913 |
| Three wheels grounded | Inertia | 15 | 4.610 | 0.00922 |
| Grounded reads only | Reference | 15 | 4.533 | 0.00907 |

Grounded inertia takes about 0.553 CPU milliseconds per simulated second,
approximately 0.056% of one core. The instant/inertia difference is near timing
noise; property access dominates this workload. The reads-only case uses a
different sum/loop, so subtracting it is not an exact isolation of wheel math.

This second experiment includes SDK lookup and JS/WASM boundary cost but excludes
advancing JSBSim, dynamic touchdown input, rendering, audio and browser overhead.
The equivalent frame figures are arithmetic conversions, not measured FPS or
frame latency. These results do not establish performance on another device or
in Safari/Chrome with streaming and rendering active.

## Proposed force-model kernels

```sh
node benchmarks/wheels/run-reference-kernels.mjs
```

This writes `results-reference-kernels.json`. It measures deterministic,
three-wheel **reference kernels** for the proposed coupled rigid, combined-slip
brush, and local compliance models. The result is a useful algorithm-cost
envelope only: it excludes JSBSim/WASM, property reads, terrain queries,
collision detection, rendering, audio, and validation against aircraft data.
It must not be reported as a game-frame or production-physics prediction. See
[the companion methodology](README.reference-kernels.md) and the implementation
gates in the [wheel simulation proposal](../../docs/proposals/wheel-simulation-options.md).

For a terminal-only OfflineAudioContext check, run the companion command from
`flight-sim` after its source is applied:

```sh
PLAYWRIGHT_MODULE=/private/tmp/flight-phone.hd8Ggu/browser-tools/node_modules/playwright/index.mjs \
node benchmarks/wheels/run-audio-headless.mjs
```

It opens no visible browser or server. It checks silence for A, a bounded B
spin-up chirp, deterministic repeated output, and immediate silence on pause.

## Integrated fixed-step path

```sh
node --expose-gc benchmarks/wheels/run-integrated.mjs
```

Writes [results-integrated.json](results-integrated.json). Unlike the scalar
kernels above, this drives the **production** fixed-step loop
(`createFixedStepPhysicsLoop`: validity guards, per-step safety snapshot,
JSBSim `Run()`), the production terrain-contact and swept body-collision code,
flight-control writes, the wheel adapter, the `WheelCue` bus with its slip-audio
sink, and haptic aggregation — each timed per accepted 120 Hz step. Every run
uses a fresh C172 WASM instance (re-running IC on a reused instance was found
not to be bit-reproducible), with one warm-up round and five alternating-order
rounds of 12 simulated seconds per mode. Two traces: a gentle touchdown →
rollout → full braking from 6 s, and a powered airborne cruise 150 m up. The
first 0.5 s after each spawn is reported separately as a transient.

The script also **asserts one-way invariance**: altitude, u, q, r, latitude and
longitude every simulated second are identical with feedback off, Instant,
Inertia, and Inertia + cues + haptics. Audio and haptics do not change physics.

Recorded 2026-09-10, Apple M5 (10 cores) / macOS / Node 26.0.0,
`@0x62/jsbsim-wasm` 1.2.4-beta.4. **Measured**, µs per accepted step, p50 / p95:

| Trace, phase | Mode | SDK reads/step | Whole step | JSBSim `Run()` | Terrain contact | Body collision | Wheel adapter | Cue bus + sinks | Loop residual |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Touchdown, grounded | Feedback off | 67.0 | 33.5 / 38.5 | 6.8 / 7.9 | 2.3 / 2.5 | 4.2 / 5.0 | — | — | 17.0 / 19.6 |
| Touchdown, grounded | Instant | 81.8 | 39.4 / 46.1 | 6.9 / 8.1 | 2.3 / 2.8 | 4.2 / 5.0 | 5.5 / 6.5 | 0.08 / 0.13 | 17.2 / 20.4 |
| Touchdown, grounded | Inertia | 81.8 | 39.0 / 47.9 | 6.9 / 8.5 | 2.3 / 2.7 | 4.1 / 5.0 | 5.5 / 6.4 | 0.08 / 0.13 | 17.0 / 21.4 |
| Touchdown, grounded | Inertia + cues + haptics | 81.8 | 39.5 / 46.8 | 6.9 / 8.3 | 2.4 / 2.7 | 4.2 / 5.0 | 5.5 / 6.3 | 0.13 / 0.17 | 17.2 / 20.5 |
| Cruise, airborne | Feedback off | 66.0 | 30.5 / 35.6 | 6.2 / 7.2 | 2.0 / 2.4 | 2.3 / 2.6 | — | — | 16.8 / 20.0 |
| Cruise, airborne | Inertia + cues + haptics | 71.0 | 32.3 / 38.5 | 6.2 / 7.4 | 2.0 / 2.3 | 2.3 / 2.6 | 1.6 / 1.8 | 0.13 / 0.17 | 16.9 / 20.3 |

Per rendered frame (60 FPS, every second step): haptic tick 0.04–0.08 / 0.21 µs,
slip-audio sink read 0.04 µs. Haptic output: 3 bounded envelopes per touchdown,
none in cruise or during sustained braking. The flight-state bridge read
(`readFlightState`) costs 2.3 µs and runs twice per step inside the loop.

What this shows (**measured**, this machine only):

- Wheel feedback adds about 6 µs p50 (~18%) to a grounded fixed step and ~2 µs
  airborne, almost all of it the adapter's 15 (grounded) / 5 (airborne) string
  property reads. The cue bus, slip sink and haptics are near timer resolution
  (Node `performance.now()` ≈ 0.04 µs granularity).
- JSBSim `Run()` itself is only ~6–7 µs. The largest JavaScript cost is the
  loop residual (~17 µs: safety snapshot, two flight-state reads, guards). A
  batched/native property interface would help more than any wheel algorithm.
- p95 spawn transients (first 0.5 s after instance creation) reach 43–105 µs.

**Inferred**, not measured: at 120 Hz a 39.5 µs step is ≈4.7 ms of CPU per
simulated second (~0.5% of one core), i.e. ≈0.08 ms per 60 FPS frame. Browser
V8 and Safari JavaScriptCore will differ. **Unmeasured**: the terrain surface is
an analytic flat plane and swept raycasts return no hit, so streamed
Google/raster tile lookups and BVH/mesh traversal are *not* represented; airborne
flight near terrain; main-thread contention in a browser; other devices; power.
The heap figure in the JSON (~17 MB allocated per 12 s run in every mode, forced
GC before the loop) is an allocation-volume indicator dominated by the existing
loop, not resident memory, and the per-mode differences are within GC noise.

## Browser tire audio and wheel-overlay rendering

Run from `flight-sim` (headless Chromium via Playwright; no visible browser, no
server — request interception serves the page with COOP/COEP headers so timers
are cross-origin isolated):

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node benchmarks/wheels/run-feedback-browser.mjs
```

It writes [results-feedback-browser.json](results-feedback-browser.json) and
records the unmasked WebGL renderer so a software rasterizer cannot be reported
as a GPU result. Recorded 2026-09-10: Chromium 153.0.8010.37 headless,
**hardware GPU verified** ("ANGLE (Apple, ANGLE Metal Renderer: Apple M5)").

| Audio (OfflineAudioContext, 48 kHz, 10 s, 7 alternating repeats) | Render ms per rendered second, p50 / p95 | Main-thread `update()` µs per 60 Hz frame |
|---|---:|---:|
| Empty context | 0.063 / 0.065 | — |
| Tire graph, gains at zero | 0.767 / 0.786 | 1.2 |
| Tire graph, touchdown trace from the real inertia model | 0.800 / 0.812 | 1.2 |

| Wheel overlay (isolated 1280×720 scene, 20-frame batch means, 1,440 frames per case) | Draw calls | CPU `scene.render()` ms/frame, p50 / p95 |
|---|---:|---:|
| Overlay off (ground + 3-box stand-in airframe) | 4 | 0.011 / 0.020 |
| Overlay on (3 line-system tires, per-frame update) | 7 | 0.018 / 0.056 |

**Measured**: a silent tire graph costs ~96% of an active one in offline
rendering, so zero gains do not remove audio processing — the existing
suspend-on-disable/pause is what saves work; sleeping the graph after its
release tail while enabled remains a candidate optimization. The overlay adds
~7 µs CPU submit per frame at p50 in this small scene. **Inferred**: offline
render speed (~1,250× faster than real time) suggests ample real-time audio
headroom, but it is not a real-time audio-thread measurement. **Unmeasured**:
GPU execution time (Chromium's `gl.finish()` added only ~2 µs, so it is not
GPU-completion timing and no timer query was used), the full globe/terrain
scene, a real-time `AudioContext` on an audio device, Safari/Firefox/mobile.
