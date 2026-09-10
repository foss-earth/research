# Wheel interaction implementation handoff

Copy this prompt into a new coding conversation when ready to implement the
roadmap:

```text
Continue the FOSS Earth / flight-sim wheel-interaction roadmap. Do not restart
the investigation or overwrite unrelated dirty work. Read these first:

- foss-earth/docs/proposals/wheel-simulation-options.md
- foss-earth/benchmarks/wheels/README.md and results-reference-kernels.json
- flight-sim/docs/wheel-spin-experiment.md
- flight-sim/src/flight/physics/wheelSpin.ts
- flight-sim/src/flight/physics/createWheelSpinExperiment.ts
- flight-sim/src/flight/audio/createTireAudio.ts
- flight-sim/src/flight/createFlightSimApp.ts
- flight-sim/src/flight/remote/createPhoneControlSession.ts
- both repositories' AGENTS.md files

Context: the existing A/B wheel feature is a one-way, read-only JSBSim adjunct.
Mode B has angular inertia, visual wheel outlines and quiet slip audio, but it
does not apply forces to the aircraft. Its all-three-wheel grounded adapter cost
on Apple M5 / Node 26 is 4.610 microseconds per 120 Hz update, dominated by 15
JSBSim property reads. The proposed reference kernels measured 0.032 µs
(coupled rigid), 0.182 µs (combined-slip brush), 0.392 µs (8-cell local
compliance), and 0.905 µs (32-cell compliance) per three-wheel step. Those are
algorithm-only measurements: do not call them integrated game performance.

Execute the documented roadmap in safe, reviewable phases. Begin with the
persistent GroundInteractionSettingsV1 model, profiles, presets, requested /
active / fallback-reason UI, and safe-boundary changes. Ship only settings whose
implementations exist; leave advanced choices disabled with a clear dependency.
Then create the accepted fixed-step WheelCue bus, route the existing slip sound
through it, and implement optional bounded gamepad and paired-phone haptics.
Use 50 ms latest-value aggregation, no haptic event backlog, capability
fallbacks, and cancellation on pause, hidden page, reset, disconnect, expiry,
feature disable and disposal. Do not change flight physics for audio or haptics.

For force physics, do not stack a new solver on JSBSim friction. First add a
native/WASM or single accepted-impulse contact interface that supplies genuine
per-wheel contact state, normal load and contact velocity. Implement coupled
rigid wheel impulses with equal/opposite linear and angular reaction, one owner
for brake/rolling friction, fixed-step bounds, contact epochs and energy/
momentum tests. The normal default must never launch an aircraft; an optional
Arcade launch effect, if retained, is off by default and separate from physics.
Only after that passes, add combined-slip/relaxation and transfer lateral-force
ownership. Add stable per-wheel footprint/sweep support before an 8-cell local
compliance prototype. Do not claim FEA, permanent ruts, hydroplaning or material
identification without data and validation.

For sound, geometry can drive support-change/normal-impulse timing and a neutral
rolling texture, but it cannot identify a surface material. Never query terrain
from the audio thread or at audio rate. Start with built-in Web Audio nodes;
introduce AudioWorklet only after a measured need.

Run terminal/headless tests and benchmarks only. Do not take over the user’s
cursor or use visible Chrome. Do not start a development or watch server. Keep
tests proportional and add deterministic tests for energy bounds, reset/epoch
handling, haptic expiry/rate limits, unsupported devices, and settings migration.
Measure the integrated path separately from scalar kernels: JSBSim/WASM bridge,
terrain/contact queries, audio, rendering, memory and p50/p95 fixed-step cost.
Record machine/browser/version and label every result measured, inferred or
unmeasured. CPU is today’s default but not a permanent CPU-only decision; do not
offer GPU/worker options until an equivalent validated implementation exists.

Preserve all unrelated changes in both dirty worktrees. Make small coherent
commits only if asked. At each completed phase, state exactly what is implemented,
what is still proposed, what was measured, and which automated tests passed.
```

The source of truth is the linked wheel-simulation proposal. This handoff keeps
the important boundary: M5 measurements establish a good current default, not a
hardware-wide policy or proof that the advanced modes are cheap in the game.
