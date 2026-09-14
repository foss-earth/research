# Gamepad Tools: scope and host integration research

Research date: 2026-09-13. The implementation handoff is [gamepad-tools-agent-prompt.md](gamepad-tools-agent-prompt.md). This decision supersedes the earlier Gamepad Studio proposal.

## The product

**[Felipegalind0/gamepad-tools](https://github.com/Felipegalind0/gamepad-tools) is an independently written Babylon.js/WebGPU-first controller visualization and input-binding utility for foss-earth and 0sfs.** Its purpose is to show live controller input and let users configure keyboard, button and axis assignments to host application actions. An articulated 3D controller is optional: binding configuration must remain usable without loading a model or starting a GPU renderer. The viewer can also run standalone or be embedded in either host.

The independent repository has been created and verified with `isFork: false`, `parent: null`, and an MIT license. The user deleted the mistaken `gamepad-studio` fork; the old repository returned HTTP 404. The current deliverables are the repository and implementation handoff. This report does not claim that the utility, integrations or their tests have been implemented.

DualSense Studio is a reference for controller visualization and interaction only. Write original application code, tests and documentation, using original models or assets with verified licenses. Its missing application license does not make its source public domain; that observation does not block independently written work. [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

There are no games, galleries, streamer/OBS modes, full diagnostics suite, WebHID output experiments or full DualSense Studio parity requirements. They are outside this product, not deferred completion milestones.

## Shared package boundaries

Keep the core independent of React, foss-earth, JSBSim and 0sfs. It should provide input snapshots, binding evaluation, versioned profiles and configurable presentation. Thin host adapters supply action definitions, defaults, availability and action dispatch. Optional DOM/React adapters mount the editor and viewer.

Keep three data models separate:

| Model | Required responsibility |
|---|---|
| Input snapshot | Selected device identity, connection, mapping, browser-provided axes/buttons and keyboard codes; preserve raw values for display |
| Binding profile | Schema version, host namespace, source selectors, action IDs, alternate assignments, thresholds, inversion, deadzones, ranges and edge/hold semantics |
| Host action | Stable ID, label, value kind/range, context, availability and host-owned dispatch |

The host should drive polling or supply snapshots so the simulator, editor and viewer observe one selected controller. Rendering must not become the source of action state. The editor needs capture mode, conflict feedback, reset, validated import/export and storage-failure handling. Capture must suspend host action dispatch while continuing to observe input; initially held buttons and resting axis noise must not become accidental assignments.

Standard Xbox and DualSense inputs are practical first-release targets. Preserve raw numeric controls for unrecognized devices and do not promise every hardware feature on every controller. Standard Gamepad mapping defines buttons 0–16; additional controls need a verified profile before receiving brand-specific names. [Gamepad specification](https://www.w3.org/TR/gamepad/).

## foss-earth: actual integration points

The inspected source has no gamepad polling, configurable keyboard map or action registry. Its existing [input controller](../../../src/input/createInputController.ts) attaches mouse, wheel, touch and Safari gestures. [Input settings](../../../src/input/inputSettings.ts) contain mouse/trackpad/touch sensitivities for `pan`, `orbit` and `zoom`, plus mode and anchor-pan preferences. These are not binding profiles.

The real movement operations are the internal [CameraInputTarget](../../../src/input/inertialCameraController.ts): `panBy(dxPx, dyPx, canvasHeight)`, `orbitBy(pitchDeltaDeg, headingDeltaDeg)` and `zoomBy(factor)`. [CameraController](../../../src/camera/cameraState.ts) already converts screen-space pan into geographic movement using heading, zoom and field of view. Add a narrow runtime input hook rather than duplicating that conversion.

Proposed action IDs such as `globe.panX`, `globe.panY`, `globe.orbitHeading`, `globe.orbitPitch`, `globe.zoom` and `globe.resetNorth` are new design work. They are not existing exports. Continuous actions need time-based rates translated into the camera methods' units.

The [GlobeAppHandle](../../../src/app/createGlobeApp.ts) exposes `runtime`; [BabylonRuntime](../../../src/engine/babylon/createBabylonRuntime.ts) exposes engine, scene, renderer, `getViewState`, `setViewState`, `requestRender`, and continuous-render controls. However, its inertial controller is private, and [foss-earth/input](../../../src/input/public.ts) exports preference helpers only. `setViewState` cancels inertia, so repeatedly using it for stick movement would change existing gesture behavior. Reset-north should share the current host command, including its POI-tracking exit policy.

The existing [input HUD](../../../src/hud/inputModeHud.ts) edits modes and sensitivity. Add binding configuration through a distinct panel or an explicit extension. [foss-earth/windowing](../../../src/windowing/index.ts) supplies optional React docking primitives; it does not already register a controller panel. Preserve existing pointer controls and their storage keys.

## 0sfs: preserve flight and phone ownership

[flightInputManager.ts](/Users/felg/gh/0sfs/src/flight/input/flightInputManager.ts) owns hardcoded keyboard/gamepad mapping, response shaping, persistent controls and local/phone takeover behavior. Integrate binding evaluation there while leaving flight response app-owned. [applyFlightControls.ts](/Users/felg/gh/0sfs/src/flight/input/applyFlightControls.ts) remains the normalized-controls-to-JSBSim boundary, including aircraft-specific rudder direction.

The existing control record is `elevator`, `aileron`, `rudder`, `throttle`, `pitchTrim`, `rollTrim`, `flaps`, and `brake`. Gear, pause and view are separate commands. Keep them separate: the phone protocol validates the current semantic record. Throttle/flaps need both absolute input and increase/decrease-rate intents; pause/gear/view need discrete edges rather than repeated firing while held.

Current Gamepad input always reads slot zero: axes 0/1 control aileron/elevator, axis 2 controls rudder, axis 3 sets throttle, and button 0 brakes. Triggers supply rudder only when axis 2 is absent. This is a custom flight mapping, not a standard Xbox gameplay preset. Preserve defaults through an explicit migration; a new Xbox preset should be deliberate and documented.

[createFlightSimApp.ts](/Users/felg/gh/0sfs/src/flight/createFlightSimApp.ts) also owns a separate `KeyV` view listener, phone-session integration and the selection of local/phone input immediately before physics. The [flight HUD](/Users/felg/gh/0sfs/src/flight/hud/flightHud.ts) has focused arrow-key stick interaction. Binding capture must gate all these paths, preventing a captured key from changing view, toggling gear, pausing or taking control from the phone.

Keep pairing, authentication, leases, epochs, freshness and ownership in [createPhoneControlSession.ts](/Users/felg/gh/0sfs/src/flight/remote/createPhoneControlSession.ts) and [protocol.ts](/Users/felg/gh/0sfs/src/remote/protocol.ts). Preserve control adoption, persistent throttle/trims/flaps and deliberate local-takeover detection. Phone input can appear as a host-provided semantic source/status; it should not pass through a second arbitrary gamepad-axis transform. Existing [haptics.ts](/Users/felg/gh/0sfs/src/flight/feedback/haptics.ts) uses slot zero too: changing controller selection must keep that existing output aligned, without adding output features to this package.

## WebGPU and optional rendering

Use Babylon `WebGPUEngine` from the first viewer implementation. Babylon supports asynchronous WebGPU initialization and a WebGL compatibility backend. Verify the actual active backend rather than inferring it from browser capability or a requested setting. [Babylon WebGPU support](https://github.com/BabylonJS/Documentation/blob/master/content/setup/support/webGPU.md).

For embedded use, accept compatible host Babylon objects and honor their ownership. foss-earth uses a right-handed scene, large-world rendering and an [on-demand scheduler](../../../src/engine/babylon/renderScheduler.ts). Request rendering after visual changes; release continuous-render holds when hidden or disposed. Its frame loop brackets rendering with `beginFrame`/`endFrame`, which is needed for WebGPU presentation. Do not overwrite the single `setSimTick` callback owned by 0sfs. An `onBeforeRenderObservable` listener can update visuals, but cannot independently discover input after the host renderer idles.

Standalone viewing should create a small dedicated Babylon scene, not instantiate foss-earth's terrain runtime. Keep model assets, viewer imports and GPU startup optional. Start with original articulated procedural models and replace them with detailed assets through model descriptors containing control identities and pivots.

WebGPU enables modern GPU features and useful optimization opportunities; the speedup for this workload must be measured. A controller viewer does not inherit performance figures from compute benchmarks. [Babylon WebGPU internals](https://github.com/BabylonJS/Documentation/blob/master/content/setup/support/webGPU/webGPUInternals/webGPUOverview.md), [Chrome WebGPU overview](https://developer.chrome.com/blog/webgpu-io2023/).

## Validation boundary

Test binding semantics, default equivalence, capture isolation, profile validation, device replacement/disconnection, phone ownership and cleanup. Verify editing with the viewer disabled, host camera independence, repeated mount/unmount and actual WebGPU presentation. Use terminal/headless checks; hardware benchmarks must verify a real GPU. Physical controller/browser/transport results remain distinct from synthetic fixtures. Respect each repository's AGENTS instructions, including 0sfs's restriction on starting long-running servers without an explicit request. Historical upstream tests provide no validation of this new utility.
