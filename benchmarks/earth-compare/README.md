# Earth comparison (W0)

The harness measures signed-out Google Earth, published FOSS Earth, and a local
FOSS Earth build in the installed, headed Chrome. It never intercepts Google
Earth, saves its responses, or replays its assets. Screenshots and traces remain
in ignored `build/benchmarks/earth-compare/`. Disposable profiles are deleted.
The Google Maps key is injected only into the FOSS app's origin, never its URL,
and is redacted from written diagnostics. There are no new dependencies.

W0 is **in progress**. Source tests and a synthetic headed smoke test pass;
these are harness checks, not a comparison baseline. No performance gain or
15 W flight result has been established.

Run from this repository:

```sh
node scripts/benchmarks/earth-compare/run.mjs --plan
node scripts/benchmarks/earth-compare/run.mjs --calibrate \
  --local-dist=../app/dist --view=umn-campus
```

Build the app before timing, using its own build instructions. Record its
revision, working tree changes and build path; an old `dist/` is only a
diagnostic. `--view` selects one view; omit it for all five. Calibration writes
actual camera poses, final frames, 50% overlays and recorded Google camera
motions. Review landmarks, scale, horizon, loaded detail, and the mask on both
apps. An address alone cannot prove what the camera displayed.

The camera target is the measured ECEF centre, not an assumed height of zero.
Source currently follows resolved ground plus the compass offset (default
zero); effective settings or unresolved ground can differ. The orbit uses 1° tilt because FOSS Earth's
public camera clamps pitch to 89°. No app default changes. FOV is measured from
the live camera, and Google receives the same height, distance and vertical FOV.

Create a calibration review JSON under `build/`, keyed by view then target
(`google-earth`, `published`, `local`). Each target needs `cameraMatched`,
`maskReviewed`, `landmarks`, `detail`, `renderGeometryMatched`, `labelsExcluded`
and `animationExcluded` all `true`, plus `reviewer`, `source`, `evidence` and
the exact `imagePolicySha256` from the calibration overlay metadata. Fill these
from inspected artifacts, never from this example:

```json
{"umn-campus":{"local":{"cameraMatched":false,"maskReviewed":false,
  "landmarks":false,"detail":false,"renderGeometryMatched":false,
  "labelsExcluded":false,"animationExcluded":false,"imagePolicySha256":"",
  "reviewer":"","source":"","evidence":""}}}
```

With those reviews, `--capture --local-dist=... --calibration=.../calibration.json
--qualification=.../reviews.json` collects three repeats, alternating target
order. Cold uses a fresh profile; warm reloads within it. Each view also has 60 s
at rest and 10 s each of pan, orbit and zoom, followed by settling captures.
Use `--runs=1` for a diagnostic, not a three-repeat baseline. Each motion starts
from the calibrated pose. FOSS replays Google's recorded poses per animation
frame; sampled actual paths must match throughout. Sparse or stationary URL
updates, fewer than three distinct poses, refused shortcuts and unmatched paths
remain separate observations. The initial campus run exposed only before/after
Google addresses during motion; those recordings do not establish path parity.

Raw captures always have `qualified: false`. Review each exact final PNG, then
create another JSON keyed by its relative observation `directory`. Copy its
`finalSha256`, and add the same review fields above. Offline analysis validates
that digest before accepting a final image:

```sh
node scripts/benchmarks/earth-compare/analyze.mjs \
  --directory=build/benchmarks/earth-compare/<run> \
  --reviews=build/benchmarks/earth-compare/<run>/final-reviews.json
```

`analysis.json` reports accepted medians and ranges without changing raw
captures. Unreviewed, blank, failed or coarse final views cannot qualify.
Frames stream to disk with bounded pending writes; overflow or failed writes
invalidate visual continuity. Full-resolution PNG casts can use substantial
disk space (bounded at 4 GiB encoded per phase). Inspect free space before a
full matrix, and keep Google screenshots private in ignored `build/`.

The predeclared visual rule is per-channel RGBA tolerance 8, agreement of at
least 99.5% of included pixels, and a final matching suffix lasting 2 s. The
included rectangle is x=20–80%, y=30–78% **of the measured render canvas**.
The public DOM helper records canvas bounds, backing size, clipping, CSS effects,
UI rectangles and sparse hit-test samples. A unique fully visible canvas with
matching projection aspect, CSS dimensions, backing dimensions and DPR is
required. Calibration overlays and offline analysis crop exact canvas pixels;
they never stretch images or crop away a different camera projection. Missing
or ambiguous geometry, clipping, unsupported transforms and included UI keep a
capture unqualified. DOM hit tests cannot find labels drawn inside the canvas.

Use `--masks=<json>` in calibration and capture to declare one common mask per
view, applied to every provider, phase and repeat. Coordinates run from 0 to 1
inside that canvas. For example:

```json
{"umn-campus":{"include":{"left":0.2,"top":0.3,"right":0.8,"bottom":0.78},
  "exclude":[{"left":0,"top":0,"right":1,"bottom":0.4,"kind":"animation"},
    {"left":0.4,"top":0.6,"right":0.5,"bottom":0.7,"kind":"labels"}]}}
```

These coordinates are an example, not a reviewed campus mask. Review UI,
canvas-rendered labels and animated sky through the whole calibrated motion;
keep landmark/detail evidence visible. Exclusions name `ui`, `labels` or
`animation`. Thresholds stay fixed and at least 10% of the canvas must remain
included. Overlays include a mask preview. Changing a mask requires new
calibration and review; `method.json` and the exact policy hash bind offline
analysis to it. Old captures without geometry/method evidence cannot qualify
through review booleans alone. Shared/observe, headless and nonvisual captures
also remain diagnostic regardless of review approval.

Event-driven casts represent an unchanged image until the next
event; only a complete, acknowledged recording can establish that continuity.

Frame intervals come from Chrome's display presentation feedback, with
duplicates removed, not app counters or requested frames. This is the headed
Chrome display's cadence, including its UI; use one disposable window and no
other tabs. Ambiguous streams are rejected. No presentation signal means
unavailable, not a substitute FPS. Reports also include encoded network bytes,
main-thread `TaskDuration`, JS heap, per-process CPU/RSS, source/detail/render
size, and machine-state samples. The instrumentation affects both providers;
retain its telemetry and do not treat smoke timings as app results.

Timings require adapter power. Battery runs require user-controlled Low Power
Mode, fixed brightness and an idle baseline at the same brightness. These
commands only read power state:

```sh
node scripts/benchmarks/power/battery.mjs --idle \
  --brightness=<fixed-setting> --duration-seconds=60
node scripts/benchmarks/earth-compare/run.mjs --capture \
  --local-dist=../app/dist --calibration=<calibration.json> \
  --qualification=<reviews.json> --power=battery \
  --brightness=<same-setting> --baseline=<idle-run>/power.json
```

Discharge current is decoded as signed 64-bit before calculating watts. The
time-weighted integral never bridges missing or charging samples. Qualification
requires continuous discharge/LPM evidence, at least 95% coverage and an idle
baseline; missing watts stay null. Read live power telemetry outside a sandbox
that exposes stale state. No command invokes sudo or changes system settings.
An optional user-run powermetrics log can add the CPU/GPU power split later.

If Google refuses automation, launch a dedicated signed-out Chrome with a
profile under this repository's ignored `build/` and a loopback debug port,
then use `--watch-port=9222 --view=umn-campus`. The watcher records observations
while the user drives. It disconnects without closing that browser. Delete that
manual profile after quitting Chrome. Those paths remain unmatched unless
independently verified.

The flight routes are documented in
[0SFS fly](https://github.com/0SFS/fly/blob/main/docs/benchmark-routes.md).
Their candidate Stockton track still needs live coverage and tracking checks.
Measure headed flights on adapter power, and whole-machine watts separately
on battery after the build and machine have settled.

| View / flight | Adapter baseline | Battery baseline | Qualification |
| --- | --- | --- | --- |
| grand-canyon | Pending | Pending | Camera/detail review required |
| umn-campus | Pending | Pending | Calibration under test |
| manhattan | Pending | Pending | Camera/detail review required |
| ksfo-approach | Pending | Pending | Camera/detail review required |
| orbit | Pending | Pending | Uses supported 1° tilt |
| cruise | Pending | Pending | Coverage and AP tracking unverified |
| low | Pending | Pending | Diagnostic completed; altitude error 35.14 m exceeds 20 m limit |

The full baseline requires every view, both power states, both flights, three
repeats and recorded medians/ranges. W1 and later measured optimizations cannot
use this table until W0 is qualified.

## Working while the machine is shared

The other agent has finished. The user requested controller and comparison
source work first, followed by an agreed exclusive window before any live
baseline. The user chose to schedule that window later and will set brightness
to 0%; take a fresh idle baseline at that setting when the window begins.
No live run has restarted. The first low route
completed all 21,600 steps but exceeded its predeclared altitude-hold limit
(35.14 m error against 20 m); its power recording is diagnostic, not a
qualified flight baseline. The cruise run has not been measured.
The tuned controller now passes installed-JSBSim simulations using the actual
AP/control boundary: low maximum error 13.97 m, cruise 13.36 m, and low starts
at 100/120 kt stay below 20 m. These are correctness checks without a browser,
renderer, network or wall-clock pacing; live route/map verification is pending.

The default full matrix takes at least **14 h 15 min**, plus **47 min 30 s**
calibration, setup, quiet waits and retries. Split capture by view, power state
and repeat with `--view=umn-campus --runs=1 --repeat-start=0` (then 1 and 2).
Each such block needs at least 28 min 30 s at the default 60 s load/settling
limit. The global repeat id preserves target order across sessions. Keep the
method, masks, source build and power state with every block; three distinct
repeats are still needed for a complete baseline. `--plan` reports the selected
batch's minimum duration without running it.

`scripts/benchmarks/earth-compare/shared.mjs` provides relative regression
testing without an idle wait. It runs counterbalanced, seeded A/B trials and a
same-build A/A control, retaining observations of background work. It reports
paired medians and a 95% bootstrap interval. An interval containing zero, noisy
A/A controls, missing measurements, or differing output fingerprints produce
an inconclusive result. More background activity can require more repetitions;
it does not require stopping the user's other programs.

```sh
node scripts/benchmarks/earth-compare/shared.mjs \
  --a=build/measure-baseline.mjs --b=build/measure-candidate.mjs \
  --pairs=12 --seed=1 --maximum-seconds=600
```

Each explicitly supplied measurement module exports `async measure()`, returning
`{ value, digest, disturbances }`. `value` is a positive elapsed time for the
same fixed workload; lower is better. `digest` fingerprints the actual output,
and must match across A, B and control. Prepare fixtures and imports outside
the measured interval, use a batch long enough to time, and validate the
fingerprint independently. `disturbances` may carry telemetry from the caller.
The runner does not discard usable trials because other programs were active.
It finishes the current three-trial block before checking its time budget;
measurement functions must themselves finish. Output remains under ignored
`build/benchmarks/shared-comparison/`.

This helper is for relative regression evidence. Correlated background work can
still confound an estimate; the report states that assumption. It does not
qualify absolute watts, Google Earth parity, or W0. No shared-machine performance
experiment has been run as part of adding it; its schedule, noise rejection,
fingerprint failures and budget behavior have deterministic source tests.

Two remaining comparison-method gaps are deliberately unqualified: Google
cold/warm captures currently include public Clean-style preparation, which adds
work FOSS does not perform, and the initial campus screenshots need render-rect
alignment and label-mask qualification. The harness records those reasons.
The public UI helper is prepared but still needs a live DOM qualification.
Motion and settling now share one uninterrupted recording; analysis uses only
the motion portion for frame intervals and records settling from motion end.
