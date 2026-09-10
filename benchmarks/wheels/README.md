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
