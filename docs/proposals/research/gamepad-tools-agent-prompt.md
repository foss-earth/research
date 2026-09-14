# Implementation prompt: gamepad-tools for foss-earth and 0sfs

Prepared 2026-09-13. This replaces the earlier Gamepad Studio fork/port prompt. The companion findings are [gamepad-tools-research.md](gamepad-tools-research.md).

---

Build **Gamepad Tools**, an independently implemented, open-source controller visualization and input-binding toolkit specifically for **foss-earth and 0sfs**. Deliver a reusable package, working integration into both hosts, and a small standalone page for configuring and observing controllers. This is a focused utility, not a recreation of an entire controller playground.

## 1. Product contract

Repository: **https://github.com/Felipegalind0/gamepad-tools**.

The repository was created independently, with fresh history and an MIT license for its original work. It is not a GitHub fork. The mistakenly created `Felipegalind0/gamepad-studio` was deleted by the user. Do not recreate it or use its history.

The user wants three connected capabilities:

1. See what the connected controller is doing: pressed buttons, analog trigger pressure, stick direction and other exposed inputs.
2. Set and manage bindings between keyboard/gamepad controls and actions in foss-earth or 0sfs.
3. Optionally display an articulated 3D controller, inside the host application or on a normal standalone web page. The model also helps select inputs for binding.

**Babylon.js with WebGPU is required from the first working 3D version.** WebGPU is a central requirement, not a future optimization. Keep binding evaluation and the editor usable when 3D is hidden, unavailable or not loaded.

DualSense Studio is inspiration for an attractive, responsive controller model. It is not a source tree, test suite, architecture template or full-product parity checklist. Write original application code, tests, UI and model configuration. Use independently authored or separately licensed assets with verified provenance.

Do not add games, target practice, mazes, galleries, streamer modes, OBS integration, leaderboards, accounts, donation systems or a full hardware-diagnostics suite. Battery/speaker tests, adaptive-trigger programming, firmware details, calibration writes, gyroscope experiments and touchpad painting are outside this task. Raw-input readouts and axis-response previews serve binding configuration; they do not justify those unrelated features.

Initial support must include standard-mapped Xbox and PlayStation-style controllers plus a numeric view and binding path for other browser-exposed devices. Sony identity must not be a prerequisite. Detailed branded models can develop incrementally; a clearly labeled original generic/asymmetric controller model is acceptable initially if it has real articulated controls and supports the required workflows.

## 2. Work in the correct repositories

Expected checkouts at preparation time:

```text
/Users/felg/gh/Felipegalind0/gamepad-tools
/Users/felg/gh/foss-earth
/Users/felg/gh/0sfs
```

Recheck repository identity, working-tree status, branches and applicable `AGENTS.md` instructions before editing. Preserve user changes. Use isolation only when necessary for concurrent work. Do not force-push or reset existing work.

Shared toolkit logic belongs in gamepad-tools. Globe integration belongs in foss-earth; flight integration belongs in 0sfs. Do not modify JSBSim, its WASM package, aircraft models, calibration, terrain systems or phone networking to implement bindings.

This prompt authorizes implementation and host integration. Follow current instructions for commits, pushes and deployment. Do not publish an npm package, deploy production or send messages to others without applicable authorization. Finish reversible implementation and validation before requesting any necessary final approval.

Use terminal scripts and headless browsers. Do not take over the user's cursor or use a visible browser when headless verification can do the job. Verify real hardware acceleration for GPU comparisons.

At preparation time, `0sfs/AGENTS.md` says: “Never start a development, preview, watch, or other long-running server unless the user explicitly asks the agent to start it.” Honor its current instruction. Complete builds, unit/integration tests and independent work first. If a server remains necessary, give its exact command and explain that this repository instruction requires the user to start it or explicitly authorize it. Do not infer permission from a request to test or another running server.

## 3. Inspect the real host architecture

This inspection record may change; verify paths and interfaces before implementation.

### foss-earth

Existing navigation uses mouse, wheel, touch and Safari gestures. No gamepad polling, keyboard-navigation map, action registry or binding-profile schema was found in runtime source.

| File or surface | Responsibility |
|---|---|
| `src/input/createInputController.ts` | Mouse/wheel/touch/gesture handlers |
| `src/input/inertialCameraController.ts` | Internal `CameraInputTarget` contract |
| `src/camera/cameraState.ts` | Pan, orbit, zoom and north-up behavior |
| `src/input/inputSettings.ts` | Input modes and pointer sensitivity, not keybindings |
| `src/input/public.ts` | Public preference helpers, not a camera-action registry |
| `src/engine/babylon/createBabylonRuntime.ts` | Camera/input wiring, engine, scene and scheduling |
| `src/engine/babylon/createRendererMode.ts` | WebGPU initialization, presentation probes and fallback |
| `src/engine/babylon/renderScheduler.ts` | Demand rendering and continuous-activity reference counting |
| `src/app/createGlobeApp.ts` | Application assembly and north-button action |
| `foss-earth/runtime`, `/input`, `/windowing`, `/layers` | Public package boundaries |

Internal camera methods include `panBy(dxPx, dyPx, canvasHeight)`, `orbitBy(pitchDeg, headingDeg)` and `zoomBy(factor)`. Expose their semantics through a narrow host-owned adapter. Do not add normalized stick values directly to latitude/longitude: the existing camera accounts for zoom, FOV and heading.

Public `getViewState`/`setViewState` exist, but repeatedly calling `setViewState` cancels inertia. Add an intentional input/action hook for continuous navigation rather than importing private files from gamepad-tools. The visible north button exits POI tracking and resets heading and pitch; an internal similarly named method only changes heading. Share the correct host action.

### 0sfs

0sfs consumes foss-earth through public exports and owns flight controls, phone authority, aircraft presentation and JSBSim application integration.

| File | Responsibility |
|---|---|
| `src/flight/input/flightInputManager.ts` | Hardcoded mappings, shaping, persistent controls and local takeover |
| `src/flight/input/applyFlightControls.ts` | Normalized controls to JSBSim properties |
| `src/flight/input/keyboardStickResponse.ts` | Keyboard response behavior |
| `src/flight/input/keyboardStickSettings.ts` | Response preferences, not key assignments |
| `src/flight/createFlightSimApp.ts` | Input construction, separate view shortcut, phone and simulation wiring |
| `src/flight/hud/FlightControlPanel.tsx` | Host panel suitable for the binding editor |
| `src/flight/hud/flightHud.ts` | Accessible focused HUD stick and pointer control |
| `src/flight/input/flightCameraInput.ts` | Mouse/touch orbit and zoom |
| `src/flight/feedback/haptics.ts` | Existing feedback output and selected-device implications |
| `src/remote/protocol.ts` | Validated phone protocol |
| `src/flight/remote/createPhoneControlSession.ts` | Authority, leases and handoffs |

The phone protocol is not a binding schema. It supplies semantic flight values under app-owned authority. Do not change that wire format or write directly to JSBSim from the toolkit.

Both hosts currently declare Babylon core/loaders `^8.21.1`, React `^19.2.4`, TypeScript `~5.9.3` and Vite `^8.0.1`. Inspect actual locked/installed versions. Compatibility with both hosts matters more than selecting the newest standalone engine.

## 4. Package and ownership boundaries

Create a framework-independent TypeScript core, optional Babylon viewer and small UI layer. React can be an optional export or thin host adapter. Core evaluation must not depend on React, DOM rendering, Babylon or JSBSim.

Suggested public surfaces, to implement rather than assume already exist:

```text
@felipegalind0/gamepad-tools/core
@felipegalind0/gamepad-tools/browser
@felipegalind0/gamepad-tools/viewer
@felipegalind0/gamepad-tools/ui
@felipegalind0/gamepad-tools/styles.css
```

Generate declarations and explicit exports. Avoid browser initialization at import time so pure modules work in Node tests. Importing core must not download models, create a GPU device or mount an application.

Dependency direction:

```text
gamepad-tools core <- browser adapter / optional UI / Babylon viewer
foss-earth         -> gamepad-tools + globe action adapter
0sfs               -> gamepad-tools + foss-earth + flight action adapter
```

Gamepad-tools must not depend on either host. Use compatible Babylon peer dependencies for the embedded viewer and externalize them from the library build. Do the same for optional React. The standalone page can bundle its dependencies. Verify that 0sfs plus foss-earth does not instantiate duplicate input managers or ship duplicate Babylon copies.

Keep the toolkit MIT license accurate. Both hosts currently declare AGPL-3.0-only; host-specific implementations remain in their repositories. Do not copy their implementations into the MIT package and relicense them. An unlicensed reference repository is not public domain; independent original work does not require a permission gate for copying code that this task does not need. [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

A small Vite/TypeScript project with library and standalone entries is sufficient. Use a lockfile and inspect package tarball contents. Document local-link development and a reproducible artifact/version/revision for host adoption. Do not publish to npm implicitly or check in machine-specific absolute dependency paths.

## 5. Separate sources, bindings, actions and visuals

Define four data models:

1. Source snapshots: browser axes/buttons, keyboard codes/modifiers, connection state and ephemeral device-session identity.
2. Binding profiles: source-to-action configuration, transforms, contexts and trigger semantics.
3. Action intents: continuous values, direction/rate requests and discrete command edges delivered to a host.
4. Presentation: live readouts and optional 3D articulation observing sources and binding metadata.

The host supplies an action catalog. The toolkit displays/evaluates it without embedding aircraft physics, camera units or one fixed catalog mixing flight and globe commands.

For example, design a complete typed contract around:

```ts
interface ActionDescriptor {
  id: string;
  label: string;
  category: string;
  kind: "axis" | "value" | "rate" | "command";
  range?: readonly [number, number];
  contexts: readonly string[];
  available: boolean;
  unavailableReason?: string;
}

interface HostInputAdapter {
  namespace: "foss-earth" | "0sfs";
  actions: readonly ActionDescriptor[];
  getContext(): string;
  applyIntents(frame: ActionIntentFrame): void;
  setBindingCapture(active: boolean): void;
}
```

These are proposed APIs. Define `ActionIntentFrame`, snapshots, selectors, parsing and disposal fully. Commands carry edges, not a Boolean executed every frame. Rate input remains a rate for the host to integrate with `dt`; never integrate it twice.

Show raw physical values separately from processed action values. The model observes input even if a binding deadzone makes its action zero. A moving preview does not prove the host is acting, especially during capture or phone ownership.

“Keybindings” means application actions. Store keyboard `code` and modifiers and display readable labels. Do not dispatch synthetic global keyboard events to control either host. A browser page is not a system-wide controller-to-keyboard driver.

## 6. Acquisition and selected-device identity

Read fresh `navigator.getGamepads()` snapshots. Handle events plus polling, sparse slots, missing APIs, thrown reads, exposure delayed until controller interaction, disconnection and replacement at the same index. A browser slot is not persistent identity.

Create one source owner per running host. The editor and model subscribe to it rather than polling separately. Support caller-driven polling in 0sfs and a documented scheduler for standalone/globe use. Sampling must not depend on model visibility or the globe rendering a frame.

Offer explicit device selection. Auto selection can prefer a connected standard pad; a custom controller at slot zero must not block another pad. Unknown devices retain numeric binding and live values.

Preserve every exposed axis/button. Do not truncate raw state to four axes or seventeen buttons. Validate finite values before evaluation and distinguish absent/malformed input from a guessed mapping.

Separate label/model profiles from physical identity. Use conservative identification hints and manual override. Do not infer unique identity, transport or hardware revision from an arbitrary browser ID. Multiple identical devices require deliberate association and careful reconnect behavior.

On disconnect, release transient actions and clear stale command edges. Reconnect/resume must require fresh command edges and host-appropriate pickup for persistent values. Plugging in a resting controller must not change throttle, retract gear or trigger pause.

## 7. Binding schema and persistence

Implement a validated, versioned JSON schema containing profile ID/name, host namespace, stable action IDs, contexts, device roles, source selectors, semantics and transforms. Store association separately from transient browser slot.

Support keyboard codes/modifiers, numeric buttons and axes, absolute analog values, continuous signed/rate input and discrete command edges. Include inversion, input range, neutral/center, deadzone and optional response curve. Support alternatives for an action, two digital directions forming an axis, analog trigger pressure and a signed difference between two controls. Define opposing-input arbitration and command hysteresis explicitly.

Keep response ownership clear. The toolkit can transform a binding's physical input, but 0sfs already has keyboard response, smoothing and expo. Do not apply equivalent shaping twice or substitute a visual deadzone for flight settings.

Validate imports before replacing active state. Reject unsupported versions, nonfinite values, invalid ranges, malformed selectors, forbidden duplicate IDs and excessive sizes. Retain unknown host actions as unavailable entries if useful; never execute arbitrary property paths or scripts. Do not use executable configuration or `eval`.

Offer save, export/import, duplicate, rename, reset to defaults and delete-profile operations. Storage is best-effort with usable in-memory fallback. Keep new keys separate from `foss-earth.inputMode`, `foss-earth.inputSensitivity`, `osfs.keyboard-stick` and `osfs.orbit-invert`. Profiles include their host namespace even at a shared origin. Do not add cloud sync or collect serial numbers.

Commit reviewed default profiles as data and test them. Document schema migrations and preserve unrelated preferences.

## 8. Binding UI and capture

The host panel contains device selection, actions grouped by category, live inputs, profile controls and a **Show 3D controller** option. It remains useful without a canvas.

Implement action-first binding: choose an action, press Bind, activate a key/button/axis, inspect the candidate, configure direction/range if necessary, and apply or cancel.

Implement control-first binding: click the model control or select its numeric row, inspect assigned actions, choose a host action and apply. A model click selects an input; it must not silently actuate a flight control. Any simulated preview is clearly labeled and excluded from live host dispatch by default.

Use a capture state machine: inactive, awaiting initial release/neutral, listening, candidate, confirm and cancel. Ignore controls held before capture. Detect deliberate axis movement relative to a baseline, with threshold and stable candidate window. Do not bind stick noise or every component of a diagonal. Let the user resolve ambiguous axis/direction selection. Triggers and non-centering throttle axes need range-aware capture rather than unconditional zero-return.

Capture suspends mapped host effects while raw monitoring continues. In 0sfs that includes P/G/V, the separate view listener, HUD shortcuts, gamepad commands and local takeover callbacks. Stopping DOM propagation in one field is insufficient: implement an explicit host capture gate covering action paths.

Do not automatically pause flight or change phone ownership on capture. Release transient intent through host policy and preserve persistent controls. Cancel on blur, disconnect, unmount or context change; require fresh command edges afterward.

Show conflicts and their contexts. Offer replacement, intentional sharing or cancel. Distinguish conflicting simultaneous contexts from the same input assigned in mutually exclusive globe/flight modes. Never silently overwrite mappings.

Preserve keyboard access, focus restoration, readable labels, touch targets and screen-reader feedback. Do not announce analog samples at frame rate. Typing in profile names or other form controls must not move the aircraft/globe.

## 9. Standard controller presentation

Use neutral semantic IDs internally: south/east/west/north face buttons, shoulders, triggers, sticks, D-pad and menu/system controls. Apply brand labels at presentation time.

| Standard input | Xbox label | PlayStation-style label |
|---|---|---|
| Buttons 0–3 | A, B, X, Y | Cross, Circle, Square, Triangle |
| Buttons 4–5 | LB, RB | L1, R1 |
| Buttons 6–7 | LT, RT | L2, R2 |
| Buttons 8–9 | View, Menu | Create/Share, Options |
| Buttons 10–11 | Stick clicks | L3, R3 |
| Buttons 12–15 | D-pad | D-pad |
| Button 16 | Xbox/Home | PS/Home |
| Axes 0/1, 2/3 | Left/right sticks | Left/right sticks |

Only apply these positional associations to standard mapping. Extra inputs remain numeric unless verified. Index 17 is not universally touchpad, Share or a paddle. Home may be intercepted by the OS. [Gamepad specification](https://www.w3.org/TR/gamepad/).

Basic Xbox input/binding is first-version scope. Detailed asset fidelity can be deferred. State which model is displayed rather than presenting Sony geometry as an accurate Xbox. A generic controller without a suitable model still has a complete numeric workflow.

## 10. Original articulated models

Use independently authored geometry or a separately licensed asset from its original provider. Procedural Babylon geometry is suitable for an early vertical slice. The delivered model must be recognizable, readable and articulated, not a placeholder cube.

Separate moving sticks, triggers and buttons. Define a model descriptor containing semantic node associations, rest transforms, pivots, local motion axes, travel limits, labels and pick targets. Keep descriptors independent of browser indices and host actions.

Animate released/pressed buttons, partial trigger travel and two-axis stick tilt including diagonals. Show stick clicks and combined D-pad states. Apply motion from immutable rest transforms so repeated input cannot accumulate pose errors.

Provide orbit, zoom, reset and useful front/angled views. Preview gestures must not pan the globe or orbit the aircraft. Release state on pointer cancellation/lost capture. Pick nearest geometry before resolving controls so hidden buttons cannot be selected through the shell. Helper graphics must not intercept picking.

Hover/focus labels identify both the physical control and assigned host action(s). Supply accessible DOM anchors or an equivalent list. Cache meshes/materials, clone independently mutable materials and dispose resources by ownership.

For glTF, choose handedness before import, inspect loader roots and verify metadata/pivots against that asset. Do not use DualSense Studio's prepared mesh IDs or pivot algorithms as the implementation contract. Record source/license/modifications in `ASSETS.md`.

## 11. Babylon WebGPU initialization and resources

For standalone or toolkit-owned rendering, initialize `WebGPUEngine` asynchronously. The current `WebGPUEngine.IsSupportedAsync` is a Promise-valued getter: await it, do not call it. Handle support detection, construction and `initAsync()` failures. Support detection alone does not prove initialization or presentation works; verify installed declarations and actual frames. [Babylon WebGPU engine source](https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/Engines/webgpuEngine.pure.ts).

Make WebGPU the primary/default standalone path. If it fails, preserve the binding UI with clear graphics status. An explicitly labeled Babylon WebGL compatibility option is acceptable but cannot satisfy WebGPU acceptance. Do not add Three.js.

Deploy with HTTPS and use localhost for development. Bundle engine and assets locally. Some shader paths use GLSL-to-WGSL translation and default CDN JS/WASM. Inspect the pinned version and configure local compiler/translator paths where required. Some versions load these lazily; do not require unused WASM or assume a simple scene exercises every material path. Test the complete viewer with external origins blocked. [Translator source](https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/Engines/WebGPU/webgpuTintWASM.ts).

Prefer built-in materials initially. If custom shaders are needed, use the installed engine's documented WGSL integration. Coordinate device-loss recovery with Babylon instead of running competing reconstruction loops. Preserve binding state across renderer recreation.

Match compatible host versions. Do not turn this task into a broad engine upgrade or framework migration without a reproduced necessary issue.

## 12. Embedding, ownership and scheduling

The standalone harness uses the same library as both hosts. It may configure a host profile offline, but must not imply it remotely controls a separate simulator tab without an explicit communication feature.

For embedding, inject host rendering integration or deliberately own a small canvas. Document the composition choice. Never instantiate the full foss-earth globe just to display a controller. If reusing a host engine, isolate viewer scene/root/camera state, use supported composition hooks, restore viewport/render state and never dispose the host engine/camera.

Keep the preview in local coordinates rather than the geospatial/floating-origin world root. It must not drift when 0sfs changes its simulation origin. Controller-camera controls and application-camera controls have different ownership.

Foss-earth owns main renderer selection, probes and fallback. Read the actual `runtime.renderer.mode`; requested WebGPU can fall back and persisted WebGL preferences affect automatic selection. Do not label a reused WebGL host as WebGPU.

The host renders on demand. Sampling only in `scene.onBeforeRenderObservable` stalls when the globe idles. Acquire input independently or use a host input tick, and request rendering for changed visible state or navigation. A hidden controller panel must not hold continuous globe rendering.

Balance any `beginContinuous`/`endContinuous` holds. Do not replace `setSimTick`: it is one callback already used by 0sfs. Add a narrow subscription/composition hook in foss-earth if required.

The host custom WebGPU frame brackets presentation with `engine.beginFrame()` and `engine.endFrame()`. Integrate with that loop rather than independently invoking `scene.render()` and assuming presentation. Hiding/closing/disposal releases owned observers, GPU resources and render holds while live action bindings remain active.

## 13. foss-earth adapter

Introduce a globe catalog with stable IDs, such as `globe.panX`, `globe.panY`, `globe.orbitHeading`, `globe.orbitPitch`, `globe.zoom` and `globe.resetNorth`. These are new proposals, not existing APIs. Document units, ranges and contexts.

Convert input directions into per-second rates with `dt`, then existing camera-method units. Preserve zoom-dependent panning and use sensible multiplicative zoom. Handle long timesteps so restoring a hidden tab cannot throw the camera across the world.

Preserve current gestures and sensitivity preferences. Define simultaneous pointer/gamepad arbitration. Capture and preview-camera gestures must not reach globe navigation.

Expose only the required reusable hook through public exports. 0sfs consumes those exports instead of private paths. Respect simulation mode, where foss-earth disables normal globe gestures: do not install globe navigation into flight mode accidentally.

Register a controller/bindings panel using the existing UI/windowing primitives; none is already registered. Preserve Location tools and window layouts. Verify binding an axis to globe movement, applying it, closing the model, continuing navigation and reopening with the same binding and live state.

## 14. 0sfs adapter and default behavior

Feed evaluated local intents into the existing input-manager path. Preserve response shaping, authority arbitration and `applyFlightControls` as the JSBSim boundary.

`ControlSurfaceState` currently has elevator, aileron, rudder, throttle, pitchTrim, rollTrim, flaps and brake. Flight axes and trims are signed; throttle/flaps/brake are 0–1. Gear, pause and view are separate commands. Do not extend the phone wire record with toolkit action IDs.

Provide host actions for axes, absolute throttle, throttle increase/decrease, trim, flap value/rates, held brake, gear toggle, pause and view where supported. Distinguish absolute, rate and command semantics. Keep aircraft rudder-sign conversion in `applyFlightControls`; binding inversion is separate.

Preserve reviewed keyboard defaults as profile data: W/S elevator +1/−1, A/D aileron −1/+1, Q/E rudder −1/+1, either Shift for throttle +.5/second, either Control for throttle −.5/second, F/R for flaps +.5/−.5 per second, B brake, P pause, G gear and V view. HUD arrow-key access remains available when that control owns focus. Response modes and expo remain independent settings.

Existing gamepad mapping reads slot zero: axis 0 aileron, negated axis 1 elevator, axis 2 rudder, axis 3 through `(1 - value) / 2` throttle, button 0 brake. Trigger difference is a rudder fallback only when axis 2 is absent. A centered standard right-stick Y therefore requests half throttle; this is not a neutral generic default.

Do not silently alter all users' mappings. Record compatibility behavior as a clearly named legacy/default profile and offer explicit improved Xbox/PlayStation flight presets with documented throttle policy. Support rate-based throttle or pickup for absolute throttle so a resting/new device does not overwrite an adopted value. Test the chosen default and migration policy.

Route all commands through the action/capture gate. Replacing `KEY_BINDINGS` alone misses the separate V handler and P/G commands. Device selection must also update existing haptic output in `src/flight/feedback/haptics.ts`; do not add unrelated hardware tests to the toolkit.

Mount the shared UI in the host panel. Verify binding an axis to aileron, a button to gear and a key to pause, save/reload, and flight with the model hidden. Preserve existing aircraft, keyboard-assist, camera and phone behavior.

## 15. Phone authority and capture

Phone transport, authentication, leases, epochs, freshness and ownership remain in 0sfs. The toolkit may display host-provided source/authority status. It must not create a new phone server, change protocol v1 or reinterpret semantic phone values as browser axes.

Preserve the sequence: sample local input, select phone/local authority immediately before the physics step, then apply selected controls. Do not bypass `beforeStep` or dispatch directly into JSBSim.

Existing handoff adopts persistent throttle/trims/flaps, centers transient controls and captures a gamepad baseline to prevent resting devices from seizing authority. Deliberate local activity can revoke phone ownership synchronously. Preserve these rules when device selection/bindings change. A remapped control participates under host policy; capture and virtual-model clicks do not.

Pause/gear have existing policies while the phone owns flight axes. Do not globally disable all local commands under remote ownership. Capture, however, must suppress them while learning inputs.

Test phone-to-local handoff, remapping while phone-owned, stale frames, reconnection and capturing P/G/V. Capture must not bypass visibility/freshness checks or cause takeover.

## 16. Tests and production verification

Write original toolkit tests. Do not import DualSense Studio's tests or use its historical results as project validation. Preserve relevant host tests and add focused coverage.

Core checks include source identity and sparse slots; all standard controls and unknown extras; keyboard modifiers/repeats/focus; finite signed/unsigned transforms; inversion/deadzones/curves; analog buttons and paired controls; rate-versus-absolute semantics; frame-rate independence; capture noise/release/cancel; conflict handling; profile validation/migration/round trips/storage failure; and fresh edges after reconnect/capture.

Use Babylon NullEngine for structure/transforms/picking where useful. It renders no pixels and does not establish WebGPU operation. Use real headless browser checks for the actual production build, model articulation, picking, keyboard access, resize, hide/show, lifecycle cleanup, storage and failure states. Inject deterministic gamepad fixtures before startup and identify them as synthetic.

In foss-earth, test action units, existing gestures, capture, idle wakeup and render-hold cleanup. In 0sfs, preserve input-manager, keyboard-response, apply-controls, camera-input, phone-integration and haptic-selection tests. Run host checks/builds without changing JSBSim artifacts.

Respect 0sfs's server-start rule. If browser verification awaits a user-started server, explain the exact command and repository instruction after completing independent work. Do not call mocks a successful full browser integration.

## 17. WebGPU and performance evidence

Distinguish API availability, successful initialization, presented frames and actual hardware acceleration. Record active backend, browser/version, OS and adapter evidence. A screenshot or `navigator.gpu` presence is insufficient.

For GPU benchmarks, verify the headless runtime uses the physical GPU rather than SwiftShader, llvmpipe or another software adapter. Use platform-appropriate diagnostics; do not paste unrelated Linux browser flags onto this Mac. [Chrome headless GPU verification](https://developer.chrome.com/blog/supercharge-web-ai-testing).

If comparing Babylon WebGPU and WebGL, use equal scenes, quality, resolution, lighting, shadows, input traces, warmup and duration. Report distributions and resource counts; report GPU timings only when supported. Missing timing data is not zero GPU cost.

Reuse geometry/materials and avoid rebuilding pipelines for button changes. Evaluate WebGPU bundle/compatibility settings after correctness and keep measured improvements. WebGPU is chosen for performance potential; do not invent a universal speedup or a hardware result from software rendering. [Babylon optimization guidance](https://github.com/BabylonJS/Documentation/blob/master/content/setup/support/webGPU/webGPUOptimization/webGPUNonCompatibilityMode.md).

Measure host impact with the viewer shown, hidden and unmounted. Hidden optional 3D must not force continuous globe rendering, create an uncontrolled loop or disable bindings.

## 18. Physical verification

Document implemented support, synthetic tests and real hardware observations separately. Record model, browser/version, OS, USB/Bluetooth, layout/counts and observed behavior without unnecessary serial identifiers.

Prioritize a standard Xbox-style and a PlayStation-style controller when available. Check sticks, analog triggers, D-pad, face/menu buttons, command edges, disconnect/reconnect and two-device selection. Test a synthetic custom device with more than four axes/seventeen buttons even without a physical HOTAS.

Verify real bindings in both hosts. Record unavailable hardware as unverified. Frame callbacks do not establish hardware polling rate or end-to-end latency. This utility verifies visible state and action routing, not mechanical wear.

## 19. Delivery sequence and artifacts

Work in reviewable stages:

1. Inspect hosts and design minimal public action/adapter contracts.
2. Implement pure snapshots, profiles, evaluation and tests.
3. Build numeric live feedback and the binding editor with persistence.
4. Add the optional Babylon/WebGPU articulated observer.
5. Integrate foss-earth actions, panel and scheduling.
6. Integrate 0sfs defaults, flight intent, phone authority and input/haptic selection.
7. Verify package contents, host builds, browser workflows and actual WebGPU evidence.
8. Finish documentation and present reviewable changes.

Do not leave both host integrations until after polishing a standalone website. An early vertical slice should prove that a shared-editor binding changes a globe action and a flight intent through the correct host boundaries.

Deliver toolkit source/exports/types/lockfile/build/tests; assets with `ASSETS.md`; a standalone harness using the same library; integration changes for both hosts; and documentation for architecture, bindings, each host integration, validation and compatibility.

Use `TODO.md` for related improvements such as detailed models and more device profiles. Games, gallery, OBS and hardware programming are rejected scope, not automatically future commitments. Multi-device rigs or an OS virtual-keyboard bridge require a separate request.

## 20. Definition of done

A user can select a controller, observe its inputs, optionally show an articulated Babylon/WebGPU model, configure keyboard/button/axis bindings, resolve conflicts, save/export/import profiles and use the resulting actions in **both foss-earth and 0sfs**.

Closing the model leaves bindings active. Capture does not move the globe, issue aircraft commands or seize phone ownership. Unknown devices retain numeric bindings. Verify WebGPU separately from fallback. Preserve unrelated host input/runtime behavior.

A controller-only website, a JSON editor with no host dispatch, an empty repository or this prompt is preparation rather than an implemented tool.

Finish with repository/branch/PR links, delivered workflows, package-adoption method, checks run, actual WebGPU/hardware evidence, validation limits and deferred model/profile work. State whether a package/site was published. Make completion status understandable without reading progress messages.
