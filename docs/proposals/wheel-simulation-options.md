# Wheel simulation options and compute budgets

Status: implementation specification and measured algorithm-cost envelope,
2026-09-10. This document does not add new gameplay modes. The current
experiment is described in [flight-sim's implementation notes](../../../flight-sim/docs/wheel-spin-experiment.md).

## Implementation status (2026-09-10)

| Roadmap step | State | Where (flight-sim) |
|---|---|---|
| 2. Durable controls | **Implemented.** `GroundInteractionSettingsV1` store with migration (unversioned/partial → Minimal-safe fields; newer versions are never downgraded and become session-only), Minimal / Landing feedback presets, Custom derivation, locks, Auto-within-choices vs Manual, requested → active → reason, capped named profiles (12, 1 KiB each) with validated import/export. Wheel response, force, contact and backend changes apply only when paused, reset, teleported or at a new flight; volume, haptic strength and audio/haptic modes apply immediately. Ground handling and Rough terrain presets, and every unimplemented mode, are shown disabled with their missing capability. Debug A/B stays session-only; **Keep experiment choices** copies it into Settings explicitly. | `src/flight/settings/groundInteractionSettings.ts`, `src/flight/hud/GroundInteractionSettingsPanel.tsx` |
| 3. Cue bus and presentation | **Implemented** (contact resonators still proposed). `WheelCue` published only from accepted fixed steps; no queue, sinks aggregate latest values; epochs advance on pause, reset, fault, teleport, mode change and terrain re-placement (`groundRevision`). The slip sound now reads the bus (same mean power as before) and has an immediate volume. Optional haptics: 50 ms latest-value envelopes (≤ 60 ms), touchdown impulse → low-frequency, spin-up slip (first 0.4 s of contact only) → high-frequency; gamepad `dual-rumble` with capability detection and session disable on rejection; paired phone via an additive, sub-versioned `feedback` field on the existing 50 ms heartbeat (TTL 90 ms, sent once, only while the phone owns control) and `navigator.vibrate`, off by default, "Unavailable on this device" where unsupported. Cancellation on pause, hidden page, reset, disconnect, ownership loss, stale host, expiry, disable and disposal. | `src/flight/feedback/`, `src/remote/protocol.ts`, `src/remote/phoneControllerClient.ts`, `src/flight/remote/createPhoneControlSession.ts` |
| 4. Coupled rigid wheels | **Contract and reference solver only; not in the game.** The native/WASM boundary (`WheelContact`, `WheelForceResult`, `NativeWheelContactBridge`) and a capability probe exist. The installed `@0x62/jsbsim-wasm` 1.2.4-beta.4 has no per-wheel contact packet or accepted-impulse entry point, and this machine has no Emscripten/CMake toolchain to build one, so the probe reports unavailable and JSBSim remains the only friction owner. The probe also refuses any bridge that has not disabled JSBSim's own longitudinal friction. A reference coupled solver (axle-point accounting, internal equal/opposite brake torque, clamped sequential impulses, epoch-cleared warm start with a cold-solve energy guard) passes conservation/stability tests in an isolated rigid-body harness with prescribed normal loads. That is **not** integrated validation. | `src/flight/physics/wheelContact.ts`, `src/flight/physics/coupledRigidWheels.ts` |
| 5. Combined slip | **Not started** — gated on step 4 being validated inside the integrated JSBSim step. | — |
| 6. Per-wheel support / footprint | **Not started** — needs the same native contact interface; must precede step 7. | — |
| 7. Local compliance | **Not started** — gated on step 6. | — |
| 8. Conservative Auto | **Not started.** Current Auto only substitutes cheaper *implemented* choices; it never changes force/contact/timestep and no GPU/worker/WASM backend is selectable. | — |

The implemented `WheelContact` differs from the sketch below in one deliberate
way: it carries the axle offset from the CG plus the tire radius instead of a
single contact point, because the airframe must receive the tangential impulse
at the axle (`r_axle × J`) while the wheel receives `−R·J`. Applying it at the
contact point and also spinning the wheel double-counts angular momentum.

**Measured** 2026-09-10 on Apple M5 / Node 26 (integrated, real C172 WASM):
grounded whole fixed step 33.5 µs p50 / 38.5 µs p95 with feedback off and
39.0–39.5 µs p50 / 46–48 µs p95 with Instant, Inertia or Inertia + cues +
haptics; JSBSim `Run()` 6–7 µs; wheel adapter 5.5 µs (15 reads); cue bus and
sinks ≈0.1 µs. Headless Chromium 153 on a verified hardware GPU: the tire graph
costs 0.77–0.80 ms of offline render per audio second whether silent or active,
and the wheel overlay adds ~7 µs CPU per frame in an isolated scene. Streamed
terrain queries, GPU execution time, real-time audio, other browsers and
devices are **unmeasured**. Details and labels: [benchmark README](../../benchmarks/wheels/README.md#integrated-fixed-step-path).

## Start with the actual cost

The current finite-inertia wheel model is small: three angular speeds and angles,
with bounded integration between stopping and rolling. It does not run a tire
mesh or deformable-body solver. Existing measurements on Apple M5 / Node 26:

| Existing path | Measured CPU time for all three wheels per 120 Hz step | Scope |
|---|---:|---|
| Feedback off | No added wheel feedback integration | JSBSim ground contact still runs |
| Instant rolling (A) | 0.053–0.078 µs | Scalar math only |
| Finite inertia (B) | 0.079–0.102 µs | Scalar math only |

B's isolated math amounts to about 0.010–0.012 milliseconds of CPU work per
simulated second, or about 0.00016–0.00020 ms per rendered frame averaged over
60 FPS. These are repeated hot-loop measurements, not browser frame profiles.
Property access, geometry queries, visuals and audio are excluded. Another
device/browser must be measured; a single M5 is not a hardware selection policy.
[Benchmark method and results](../../benchmarks/wheels/README.md).

A follow-up measurement includes the actual JSBSim SDK adapter and property
reads. Frozen, verified C172 telemetry gives the following on the same machine:

| State | Instant A, µs per update | Inertia B, µs per update | B equivalent ms per 60 FPS frame |
|---|---:|---:|---:|
| Airborne | 1.291 | 1.286 | 0.00257 |
| All three wheels grounded | 4.562 | 4.610 | 0.00922 |

The adapter reads five properties airborne and fifteen grounded. Grounded
property reads alone took 4.533 µs with a separate measurement loop. The small
A/B difference is near measurement noise; access to telemetry dominates. B's
grounded adapter uses about 0.553 CPU milliseconds per simulated second, or
0.056% of one core. A 60 FPS frame has 16.67 ms available, so this is a small
fraction of that time. The conversion is not a measured game frame time.

This is a warmed Node/V8 measurement of static inputs. It excludes simulation
advance, sound, visuals, dynamic contact transients and browser/rendering load.
[Raw adapter results](../../benchmarks/wheels/results-adapter.json) and
[reproducible script](../../benchmarks/wheels/run-adapter.mjs).

An instantaneous animation mode is a useful baseline. The measured difference
does not justify presenting it as a substantial battery-saving optimization.
More useful savings may come from reducing property transfers, unnecessary
queries, audio work while silent, and rendering. Measure these before adding
specialized algorithms or automatic switching.

### Proposed-model cost envelope

To compare the shapes of the next three algorithms before their production
integration exists, a terminal-only reference kernel now exercises three
wheels, a coupled airframe state, and bounded tire/contact state. It was run on
the same Apple M5 / Node 26 machine:

| Reference kernel | Median µs per 120 Hz, three-wheel step | CPU ms per simulated second at 120 Hz |
|---|---:|---:|
| Coupled rigid wheel | 0.032 | 0.0039 |
| Combined-slip brush tire | 0.182 | 0.0218 |
| Brush tire plus 8 local compliance cells/wheel | 0.392 | 0.0470 |
| Brush tire plus 32 local compliance cells/wheel | 0.905 | 0.1086 |

The measured differences within this one harness are useful: relaxation and a
friction ellipse add scalar work, and local compliance scales with cells. These
figures are **not comparable** to the SDK-adapter table and do not predict an
integrated game's cost. They deliberately exclude JSBSim/WASM, telemetry,
terrain/mesh queries, the contact solver, rendering, audio, and browser load;
the compliance field is not an FEA tire or persistent soil model. The rigid
kernel's especially small number is a reason not to make a production claim
from a microbenchmark. [Script](../../benchmarks/wheels/run-reference-kernels.mjs),
[raw results](../../benchmarks/wheels/results-reference-kernels.json), and
[methodology](../../benchmarks/wheels/README.reference-kernels.md).

## Independent dimensions

"Wheel quality" is several different choices. A user should be able to choose
accurate handling with sound off, inexpensive handling with rich audio, or a
rough-ground contact model with minimal graphics.

### Rotation and force model

| Method | Behavior and use | Performance expectation | Availability |
|---|---|---|---|
| Existing ground model, feedback off | Current suspension/braking; no added spin feedback | No extra spin work; mandatory collision cost remains | Implemented |
| Instant rolling | Wheel circumference speed immediately follows contact speed | Measured math above; reads still needed | Implemented A |
| Authored spin-up envelope | A timed speed ramp and contact chirp; cheap sensory approximation | Constant small work per wheel; not measured and not necessarily faster than B | Possible alternative, lower priority |
| Finite-inertia feedback | Load-dependent spin-up, retained spin after liftoff, slip-driven cue | Measured math above; no additional terrain query in current adapter | Implemented B; aircraft forces unchanged |
| Coupled rigid wheel | Inertia, friction and brake torque feed forces/moments back to aircraft | Few states per wheel, so potentially modest arithmetic; coupling and contact-query cost unmeasured | Proposed next physics step |
| Transient handling tire | Longitudinal/lateral slip, relaxation and combined grip; crosswind/braking behavior | More states and parameter evaluation; no justified runtime figure yet | Research/prototype |
| Flexible tire and deformable soil | Tire carcass deformation, ruts and detailed contact stress | Many degrees of freedom and contact solves; highest expected cost here | Specialist research, no production promise |

The final three rows change handling. They are not interchangeable graphics
quality levels. More equations also do not ensure more accurate C172 behavior:
wheel data, surface properties and validation are essential.

Project Chrono provides open-source examples of rigid, semi-empirical handling,
and finite-element tires. Its handling models separate the tire force law from
point/envelope contact, and it identifies finite-element tires as its most
computationally expensive class. These are reference implementations to study,
not browser-ready aircraft plugins. [Chrono tire model documentation](https://api.projectchrono.org/wheeled_tire.html).

### Contact geometry

| Ground representation | Work to budget | Where it helps |
|---|---|---|
| Current shared terrain elevation plus JSBSim points | Reuses the existing terrain pipeline; spin adds no new query | Smooth runways and current gameplay |
| Separate support under each wheel | Approximately three support queries per update if implemented that way | Cross-slopes and different wheel heights |
| Wheel footprint/envelope | Several samples per wheel; e.g. four samples × three wheels is twelve queries, not a measured 4× total runtime | Small bumps, runway edges, tire bridging |
| Swept finite wheel shape | Broad phase, shape/mesh narrow phase and continuous contact | Curbs, obstacle strikes and rough strips |

The three/twelve counts are proposed query workloads. The current JSBSim
interface receives one terrain elevation; per-wheel terrain support needs an
actual solver/ground-callback integration, not merely three extra raycasts.
Query cost depends strongly on terrain type, BVH availability and scene density.
Our existing ray benchmark is not a benchmark of cylinder sweeps or tire contact.

Surface presets (dry pavement, wet pavement, grass) are another dimension.
Changing material coefficients can add little arithmetic while changing
behavior substantially. Wet-runway hydroplaning needs an appropriate model and
data; reducing a friction coefficient alone is only an approximation.

### Feedback and secondary effects

| Component | Independent choices | Cost considerations |
|---|---|---|
| Tire audio | Off / contact sample / continuous slip cue / spatial per-wheel sound | Playback/graph processing and active voices; a sample trades assets/memory for synthesis. Neither path is measured faster yet |
| Visuals | Off / asset wheel rotation / debug outlines / contact vectors, smoke, skid marks | Rendering and draw calls; debug display should not force a more expensive physics model |
| Thermal state and wear | Off / a few slowly updated scalar states / detailed spatial model | Scalar temperature/wear need not be expensive; detailed distributions are a different scope |
| Haptics | Off / contact impulse and vibration / advanced device output | Device/API support and authoring; budget separately from wheel forces |

The current tire sound is one mixed noise/filter/oscillator graph, not three
independent spatial tire voices. It keeps a loop and oscillator while enabled;
mute gains should not be assumed to remove all browser audio processing.
Sleeping the graph after its release tail is a candidate optimization to measure.
Custom DSP could use AudioWorklet if warranted; the browser API explicitly
supports audio rendering work apart from main-thread control.
[Web Audio processing model](https://www.w3.org/TR/webaudio/#rendering-loop).

## Compute backend and scheduling

| Option | Intended use | Constraint |
|---|---|---|
| CPU JavaScript | Current three-wheel adjunct | Already very little scalar work |
| CPU WASM alongside JSBSim | Future coupled model or batched property access | Likely integration benefit is fewer boundary crossings; no measured speedup claimed |
| Whole physics step in a worker | Preserve input/render responsiveness if physics grows | Moving only three wheel states out and back introduces a dependency; reduced main-thread blocking is not automatically less total CPU |
| GPU compute | Future large fleets, many terrain contacts or deformable research | Dispatch, synchronization, device support and JSBSim's CPU dependencies must be included |

Offer Auto / CPU / GPU only when equivalent, validated implementations exist.
Show why an unavailable backend cannot run. Do not silently claim GPU physics
because Babylon renders wheel graphics on the GPU. CPU is today's sensible
default for this workload, not a permanent architecture restriction.

Keep contact and coupled forces on a validated fixed timestep. At 30 m/s, the
aircraft travels 0.25 m in a 120 Hz step, 0.5 m at 60 Hz and 1 m at 30 Hz.
Dropping contact samples can therefore change obstacle detection. Substeps must
refresh contact motion/load and integrate the aircraft where needed; repeatedly
solving a wheel with stale input is not a higher-fidelity force simulation.

Safe candidates for adaptation: sleep grounded stationary tires, integrate
airborne coast analytically, omit invisible wheel rendering, reduce diagnostic
refresh, sleep silent audio, and run slow thermal states less often. Keep
touchdown events and cumulative slip work so presentation throttling does not
lose a brief chirp. Current bounded spin integration already resolves arrival
at rolling speed within a step; oversampling it alone may provide little value.

## Implementation specification for the three advanced force models

The current A/B wheel experiment is deliberately one-way: it reads JSBSim's
motion but does not change the aircraft. The following three modes are separate
implementations, not a switch that can be placed around the current adapter.
They need a real per-wheel contact interface. The installed SDK exposes whole
simulation stepping and string properties, but no typed per-wheel normal load
or ground-contact callback. Compression-derived load and `wheel-speed-fps` are
good enough for a visual experiment, not authoritative inputs to a coupled
solver.

Every model therefore starts with one fixed-step input/output boundary:

```ts
type WheelContact = {
  wheel: "NOSE" | "LEFT_MAIN" | "RIGHT_MAIN";
  pointBodyM: Vec3; normalWorld: Vec3; forwardWorld: Vec3; lateralWorld: Vec3;
  wheelCenterVelocityMps: Vec3; groundVelocityMps: Vec3;
  normalLoadN: number; compressionM: number; steeringRad: number;
  groundRevision: number; contactEpoch: number;
};
type WheelForceResult = {
  bodyImpulseNs: Vec3; bodyAngularImpulseNms: Vec3;
  wheelAngularImpulseNms: number; longitudinalSlipMps: number;
  lateralSlipMps: number; normalImpulseNs: number; dissipatedJ: number;
};
```

`groundRevision` invalidates cached support data after terrain streaming or
rebuild. `contactEpoch` increments on contact enter, reset, teleport, fault,
and terrain re-placement so stale cues or warm-start impulses cannot leak into
a new contact. All values are finite and bounded before solving. The bridge
must either put the complete coupled contact calculation inside JSBSim/native
WASM or provide a single accepted impulse interface; passing loose property
values across JavaScript and then adding forces separately is not enough.

### 1. Coupled rigid wheel

This is the next production physics candidate. It retains one angular speed per
wheel and solves a contact impulse along each wheel's rolling direction. For a
candidate tangent impulse `J`, use the wheel point's relative speed and an
effective mass containing airframe translation, airframe rotation at the axle,
and tire rotation. Clamp `J` by the Coulomb limit `μ × normalImpulse` and
brake/bearing torque. Apply the result once as equal-and-opposite linear and
angular impulse to the airframe and as axle torque to the wheel.

The accounting matters. Applying a force at the contact point and then also
applying `radius × force` to wheel spin can double-count angular momentum unless
the axle/joint reaction is in the same generalized solve. A shared contact
Jacobian/effective-mass solve, or an equivalent explicit axle-force plus
joint-reaction calculation, is required. The current JSBSim longitudinal
rolling/brake friction must be replaced or disabled for these wheels; stacking
the new force on it double-counts braking and is a likely source of energy gain
and the old launch behavior.

Implementation order:

1. Add the native/WASM contact packet and a capability flag. Keep the existing
   JSBSim path as the default fallback.
2. Implement bounded sequential impulses at the existing 120 Hz physics
   timestep, with warm-start data cleared by `contactEpoch` and a fixed solver
   iteration cap. Resolve normal contact before friction; never invent a normal
   impulse merely to spin a wheel.
3. Route brake commands to one owner. Keep the current visual/audio spin state
   as a view of the coupled state, rather than integrating a second wheel.
4. Require conservation and stability tests before exposing the option: free
   rolling, a locked brake, asymmetric one-main touchdown, repeated bounce,
   reverse taxi, and high-speed ground/body impacts. Track work, rotational
   energy, contact impulse and frame-to-frame velocity; no unbounded launch is
   acceptable in the normal mode.

An optional **Arcade launch** effect may preserve the funny old behavior, but
it belongs in Effects, defaults off, has an explicit multiplier, and is never
used to mask a physics regression.

### 2. Combined-slip brush tire

Build this only on the coupled wheel, never beside JSBSim's lateral tire force.
For each wheel calculate longitudinal slip ratio, lateral slip angle and local
contact speed. Filter them over documented longitudinal/lateral relaxation
lengths. Evaluate provisional longitudinal and lateral force from a bounded
brush/Pacejka-like curve, then apply a combined-friction ellipse/circle before
the same generalized impulse solve. Use a low-speed formulation that transitions
continuously through zero; raw division by speed is a common source of taxi
instability.

The first implementation has scalar per-wheel state only: angular speed,
longitudinal/lateral relaxed slip, temperature/wear placeholders, and
warm-start impulses. It should support dry pavement and fixed coefficient
presets before claiming wet grass, hydroplaning, or tire data it does not have.
Tune against C172 takeoff roll, stopping distance, crosswind landing and
steering behavior with documented aircraft inputs. Test braking while turning,
one wheel on a low-grip preset, zero-speed direction changes, and same-state
replay at 30/60/120 Hz rendering. Exact input replay must have equivalent
physics independent of render rate.

### 3. Local compliant tire and soil

This is a research mode, not a promise of a browser FEA simulation. Start with
a bounded 8-cell local footprint per tire. Each cell tracks normal deflection
and a short-lived compaction state; integrate the cell pressures into one normal
reaction and the brush model's tangential limit. Keep the state local to the
tire in the first prototype. Permanent ruts, granular soil, aquaplaning, and a
high-degree-of-freedom tire carcass require calibrated material data, broad
terrain ownership and a separate design.

Increase to 32 cells only after the 8-cell result improves a measured case such
as a runway edge or rough strip. Bound memory, solver iterations, contact patch
dimensions and terrain samples. Clear or reproject the patch on `groundRevision`,
teleport, contact loss, model change and reset. Do not use mesh triangle jitter
as deformation. A finite wheel-envelope/sweep should provide stable support
first; the compliance model adds load distribution, not collision coverage.

## Geometry-driven rolling sound

We can make rolling sound respond to shape without pretending we know the
surface material. Geometry gives support-height change, contact normal, contact
impulse and rolling distance. It does not tell us whether an unknown mesh is
asphalt, gravel, wood or grass, nor does it contain texture smaller than its
sampling/LOD resolution. The audio should use a neutral surface preset and
known aircraft/tire resonators; material tags can refine it later when real
metadata exists.

At successful fixed physics steps, publish a compact `WheelCue` from the
accepted contact result:

```ts
type WheelCue = {
  epoch: number; sequence: number; simTimeS: number; wheel: string;
  onGround: boolean; rollingDistanceM: number; normalLoadN: number;
  normalImpulseNs: number; slipDissipatedJ: number;
  supportDeltaM: number; supportConfidence: number; groundRevision: number;
};
```

The physics side emits only after an accepted step. Reset/pause/fault/teleport
and an epoch or terrain-revision change discard queued cues. The audio side
coalesces them at its own rate; it never sends raycasts or terrain requests from
the audio thread. Keeping rolling distance rather than frame time prevents a
30 FPS render from changing the cadence of bumps.

The proposed tiers are:

| Sound setting | Signal | Added simulation work | Status |
|---|---|---|---|
| Off | None | None | Available |
| Slip cue | Existing dissipated slip work drives the current noise/tone graph | No new terrain query | Available experiment |
| Contact cues | Touchdown/edge normal impulse excites 2–4 damped tire/gear resonators | Reuses accepted contacts | Proposed |
| Geometry rolling | A distance-domain, de-trended support profile modulates neutral rumble; impulses excite resonators | Reuse footprint/sweep support when available; otherwise optional explicit support samples | Proposed |
| Detailed | More resonator modes and per-wheel spatial voices, capped at three active wheels | Audio CPU/voices must be measured | Research |

For geometry rolling, accumulate a short wheel-distance profile, remove the
local slope, filter it into a few broad spatial bands, and map its bounded
energy to rumble intensity. A bump/edge event comes from a thresholded support
change or normal impulse with hysteresis. At 30 m/s a 120 Hz contact stream is
spaced 0.25 m apart, so it cannot truthfully reproduce shape wavelengths below
about 0.5 m. Fill the high-frequency texture with a stable, quiet procedural
noise seeded by terrain tile/contact location, labelled as an approximation.
Never make a new 48 kHz physics query for audio.

Use built-in Web Audio nodes first. Move to an `AudioWorklet` only if a measured
multi-resonator mix needs custom DSP; an AudioWorklet runs rendering code off
the main JavaScript thread, but it still has a bounded audio deadline. The
current offline check validates bounded/silent/deterministic output, not
real-time audio CPU. Add an offline cue-trace test and a headless real-time
profile before displaying an audio cost. [AudioWorklet guidance](https://developer.chrome.com/blog/audio-worklet/),
[processing block contract](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process),
[modal contact-sound research](https://www.cs.cornell.edu/projects/Sound/mc/ModalContactSound2011.pdf).

## Haptic feedback for gamepad and phone

Haptics consume the same `WheelCue` stream and are presentation only. They may
never feed into contact forces, control authority or Auto's handling choice.
Map a brief touchdown normal impulse to a low-frequency pulse, spin-up slip to
a short high-frequency pulse, and sustained roughness to a sparse, low-amplitude
rumble. Aggregate the three wheel cues to one device envelope every 50 ms; cap
duration at 60 ms, avoid a pending-event queue, and replace stale output with
the newest envelope. This is both cheaper and less buzzy than one call per
physics step.

For a connected controller, feature-detect `gamepad.vibrationActuator` and call
`playEffect("dual-rumble", { duration, strongMagnitude, weakMagnitude })` only
when enabled. Calls override a running effect, and unsupported/hidden documents
can reject, so failures must disable the capability for the session rather than
retrying. Call `reset()` when available and zero the presentation state on pause,
hidden page, reset, disconnect, feature disable and disposal. This API has
limited browser/device availability. [Gamepad haptic actuator](https://developer.mozilla.org/en-US/docs/Web/API/GamepadHapticActuator/playEffect).

For the paired phone, add a compact, latest-value `feedback` field to the
existing 50 ms desktop heartbeat after protocol versioning. Do not reuse the
normal control/telemetry slot where it could displace fresh inputs, and do not
send a history of impacts across its unordered, no-retransmit channel. Include
session, epoch, heartbeat lease and an expiry less than 100 ms; the phone ignores
wrong/stale values. The client uses `navigator.vibrate(duration)` only if it is
present and the phone Haptics setting is enabled. It offers coarse on/off pulses,
not intensity control, and availability is limited; cancellation is
`navigator.vibrate(0)`. Vibration must stop on ownership loss, pause, hidden
phone page, expired lease, disconnect and disable. [Vibration API](https://developer.mozilla.org/en-US/docs/Web/API/Vibration_API).

Tests need a mock actuator that records replacements, capability fallback,
50 ms rate limiting, expiry, cancellation and no output after lifecycle changes.
Physical tests need at least one supported gamepad plus Android Chrome and iOS
Safari; unsupported devices must simply show “Unavailable on this device,” not
an error or a fake vibration control.

## UI proposal

Put user preferences under **Settings → Ground interaction**. Keep instantaneous
RPM, slip, load and collision visualization under Debug. Show familiar presets
first and reveal independent controls under Custom:

| Preset | Force/contact model | Rotation and feedback | Purpose |
|---|---|---|---|
| Minimal | Existing JSBSim contact | Extra feedback off | Lowest incremental cost, testing or accessibility |
| Landing feedback | Existing JSBSim contact | Inertia; optional sound and wheel visuals | Proposed everyday recommendation after user evaluation |
| Ground handling | Coupled tire forces on suitable terrain | Inertia, slip feedback; cosmetic preferences retained | Landing/braking/crosswind fidelity; future |
| Rough terrain | Validated force model plus footprint/swept contact | Optional richer effects | Bush flying and obstacle contact; future |

Auto is a selection policy, not a fifth realism level. Custom makes overrides
explicit. A low audio volume or muted device must not cause Auto to disable
force realism. Save/import named profiles so users can maintain, for example,
"VR, silent, full handling" and "Laptop, runway, landing cues".

Conceptual layout, with labels rather than invented live performance numbers:

```text
Ground interaction
Profile        [ Landing feedback v ]     [Save as…]
Selection      [ Auto within my choices | Manual ]

Wheel response [ Finite inertia v ]        [Lock]
Ground forces  [ Existing JSBSim v ]        [Lock]
Ground contact [ Shared terrain v ]        [Lock]
Tire audio     [ Slip cue v ]   Volume [——] [Lock]
Haptics        [ Off v ]        Strength [——] [Lock]
Wheel visuals  [ Off v ]                   [Lock]
Compute backend[ Auto (CPU today) v ]       [Lock]

Performance    [ Profile this device ]     [Advanced…]
CPU: model + property reads [measured / unknown]
Ground queries [measured / unknown]   GPU [measured / unknown]
Audio [measured / unknown]            Headroom [measured / unknown]
Requested: …   Active: …              Reason: …
```

### Persistent settings contract

The first implementation stores only controls that exist. Proposed modes remain
visible in the documentation and may be shown in the UI as disabled roadmap
entries, with their missing capability stated plainly. A saved profile never
silently changes its requested mode; it records the active fallback and reason.

```ts
type GroundInteractionSettingsV1 = {
  profile: "minimal" | "landing-feedback" | "ground-handling" | "rough-terrain" | "custom";
  selection: "auto" | "manual";
  rotation: "off" | "instant" | "inertia";
  forceModel: "jsbsim" | "coupled-rigid" | "combined-slip" | "compliant-soil";
  contactModel: "shared" | "per-wheel-point" | "footprint" | "swept";
  backend: "auto" | "cpu-js" | "cpu-wasm" | "worker" | "gpu";
  tireAudio: "off" | "slip" | "contact" | "geometry" | "detailed";
  tireAudioVolume: number; // 0..1
  haptics: "off" | "landing" | "roughness";
  hapticStrength: number; // 0..1
  wheelVisuals: "off" | "asset";
  locked: Partial<Record<"rotation" | "forceModel" | "contactModel" | "backend" |
    "tireAudio" | "haptics" | "wheelVisuals", boolean>>;
};
```

Migrate missing fields to `minimal`, manual selection, `off` rotation/audio/
haptics, and the existing JSBSim/shared-terrain CPU path. Preserve the current
session-only Debug A/B controls until this preference store is tested, then
migrate their values only with an explicit one-time “keep experiment choices”
action. Store named profiles separately from the active profile and cap their
count/serialized size. Profile import validates enums, numbers and version
before writing. Debug collision geometry, telemetry and the arcade launch effect
are not preferences in this public quality profile.

At runtime resolve `requested → active → reason` against device support and
model dependencies. Example: a requested `geometry` sound becomes `slip` only
if the user has allowed Auto and geometry support is unavailable; Manual leaves
the request inactive with “requires footprint contact.” CPU JS is the current
active backend. GPU, worker and WASM entries stay disabled until the same
validated model exists behind them. Changing force/contact/backend choices is
queued to pause/reset or a new flight. Changing volume, haptic strength or
wheel visuals is immediate and does not reset wheel physics.

Locks mean Auto cannot alter that choice. Show unsupported combinations with a
plain reason and the smallest necessary change. For example, transient slip
audio needs slip state, whereas a prerecorded touchdown cue can use a contact
event without a rotational model. Custom preferences need not force debug
geometry or smoke. Do not expose proposed methods as working production options.

Advanced includes a frame-rate target, a CPU work target for the selected ground
features, backend selection when available, and only validated timestep/contact
combinations. Example targets such as 0.10/0.25/0.50 ms per frame at 60 FPS are
**user-selected allowances, not predictions or measured tier costs**. Store the
equivalent CPU work per simulated second and make the conversion visible when
FPS changes. Keep GPU and audio-thread measurements separate; summing overlapping
thread times into a single frame-time percentage is misleading.

A budget is a soft target, not permission to skip collision or discard physics
time. If locked settings exceed it, report the overrun and recommend changes.
Never change handling, friction or contact geometry mid-landing automatically.
Apply such choices at a deliberate paused/reset boundary with consistent state
transfer. Cheap visual/audio settings can change immediately with smooth tails.

## Implementation roadmap and comparison gates

1. **Lock the baseline.** Keep the current one-way A/B wheel experiment as a
   regression fixture. Run its pure math and JSBSim-adapter benchmarks plus the
   new reference-kernel benchmark in the terminal. Add trace replays for gentle
   touchdown, firm one-main contact, bounce, brakes, reverse taxi, banked
   clearance and high-speed crash. Record source/WASM hashes and M5 results;
   repeat on at least one non-Apple device before making an Auto policy.
2. **Make the existing controls durable.** Implement `GroundInteractionSettingsV1`,
   named profiles, requested/active/reason display, presets and safe-boundary
   switching. Ship only Minimal and Landing feedback at first. Preserve default
   JSBSim handling and keep all debug visualizations optional.
3. **Add one cue bus, then presentation.** Publish accepted fixed-step wheel
   cues. Route existing slip sound through it, add contact-resonator prototypes,
   and then gamepad/phone haptics with capability checks and lifecycle
   cancellation. Benchmark audio and transport separately; silence/disable must
   sleep or avoid work after the release tail. Do not attach any of this to
   aircraft forces.
4. **Build and validate coupled rigid wheels.** Add the native contact/impulse
   capability, transfer ownership of longitudinal brake/rolling friction, and
   prove bounded energy/momentum behavior. Compare against the baseline on the
   same inputs with p50/p95 whole-step time, contact-query count, missed-frame
   count, memory and deterministic replay. Only then unlock Ground handling.
5. **Add combined slip.** Transfer lateral-force ownership as well, add
   relaxation/combined grip and calibrate dry-pavement C172 cases. Make wet or
   low-grip presets explicit approximations. Repeat the full physics and
   performance matrix before this can replace coupled rigid in a preset.
6. **Improve support before compliance.** Implement per-wheel support and a
   stable footprint/sweep. Benchmark each query class on real streamed terrain;
   the existing ray benchmark is not evidence for sweep cost. Geometry rolling
   audio may consume this output without new audio-thread queries.
7. **Prototype local compliance.** Start at eight cells and require a visible,
   repeatable improvement over the brush/footprint path. Scale to 32 only if it
   earns its cost. Keep it Experimental until it has terrain-revision handling,
   validated safety bounds and data-backed parameters.
8. **Add conservative Auto last.** Profile every active subsystem in batches,
   separately per main CPU, worker, GPU and audio thread. Auto can shed debug,
   visual detail and richer audio, but it cannot alter force model, contact
   model or timestep during a landing. It needs sustained overload/hysteresis
   and a clear active/fallback explanation.

For every comparison, hold aircraft, approach, brake inputs, terrain, target
frame rate and sound level constant. Record pilot A/B preference separately
from correctness and CPU/GPU measurements. OS-level power needs an independent
energy measurement; FPS alone cannot demonstrate battery impact.

Ship a short useful list first. Keep experimental algorithms in an advanced
catalog with their supported aircraft/surfaces, validation status and last
measured cost. A larger catalog gives freedom only when its choices are real
and their differences are understandable.
