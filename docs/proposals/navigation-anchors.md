# Configurable zoom anchors and rotation pivots

Status: implementation specification; runtime changes are not implemented by this document.
Date: 2026-10-12.

## Intended result

Wheel zoom approaches the ground or building under the pointer. A mouse orbit
starts around the point pressed, even when that point is away from the center
of the view. Touch pinch and tilt use the point beneath the initial midpoint
of the two fingers. Selecting a point changes no camera pose by itself.

People can choose these behaviors independently, keep the existing compass
target behavior, or use a point they explicitly pin. Keyboard, controller and
on-screen navigation commands use the compass target by default. Every choice
is available through the existing settings system.

The user requested both Google Earth Web and Pro as references and asked to
maximize user choice. This specification defines FOSS Earth's behavior. It
does not claim exact compatibility with either Google product.

## Scope and governing documents

Implement the settings, picking, anchored camera operations, gesture and glide
lifecycle, pinned-point controls, marker feedback and validation described here.
The feature belongs to globe navigation, including globe navigation used by
the campus and flight applications. A panorama or flight camera that currently
owns navigation continues to interpret its own inputs.

Follow the shared [camera motion rules](https://github.com/foss-earth/docs/blob/main/docs/camera-motion.md),
[settings specification](https://github.com/foss-earth/docs/blob/main/docs/proposals/settings.md)
and [UI layout rules](https://github.com/foss-earth/docs/blob/main/docs/ui-layout.md).
In particular, preserve camera pose and momentum at handovers, use the existing
glide decay, and give every setting one home.

This feature does not change button bindings, invert preferences, input
classification, single-finger pan, or the meaning of **Grab the globe**. Adding
touch twist recognition, free-look rotation at the eye, optical/FOV zoom, or a
complete Google Earth binding preset is separate work. The existing Safari
rotation gesture is covered because it already exists.

The earlier [camera pivot and zoom work prompt](../camera-pivot-and-zoom-prompt.md)
is historical context. This document replaces its zoom feature instructions.
Its river-to-bluff height scenario becomes a regression check; first establish
whether the current implementation still has that bug. Its old paths, commands
and instruction to ask which default to use are not this implementation's contract.

## Evidence and current implementation

Google's [desktop engineering explanation](https://maps.googleblog.com/2008/04/swoop-from-space-to-streets-in-google.html)
describes selecting a target with middle drag or Shift + left drag and orbiting
around it. The [older desktop guide](https://earth.google.com/intl/ar/userguide/v4/index.htm)
also describes navigation controls rotating around the view center. These are
historical Google-authored sources, not a test of the current Pro build.

A [firsthand Mac Web report from 2023](https://support.google.com/earth/thread/231321728/improve-and-document-navigation-controls?hl=en)
reports pointer-terrain wheel zoom, clicked-point drag orbit, view-center
keyboard orbit, and a separate in-place look gesture. Google's
[current Web navigation documentation](https://developers.google.com/maps/documentation/earth/navigate-the-globe)
documents gestures without specifying their exact anchors. Current Web/Pro
behavior, touch midpoint semantics and terrain-miss behavior were not tested
live. The rules below are explicit product decisions where those sources are
incomplete.

The inspected implementation has these properties:

- `CameraController.orbitBy()` changes heading and pitch about `camera.center`;
  `zoomBy()` changes distance to that center. Neither receives pointer coordinates.
- Wheel, touch and Safari input eventually call those centered operations.
- `input.globeAnchorRotation` changes drag panning only.
- `beginAnchorPan()` currently picks the WGS84 ellipsoid. It is useful prior
  work for screen-ray and projection helpers, not terrain-accurate picking.
- `SurfaceQuery.raycast()` can return a displayed terrain or 3D-map hit in ECEF.
- `createInertialCameraController()` stores motion rates without anchor context.
- The app places the compass using the tracked POI or camera center and a height
  resolver. POI tracking also writes the camera center each frame.

These are observations of the 2026-10-12 working copies, which contained other
uncommitted work. Recheck integration points before editing them; do not replace
those changes. Source paths in this document are relative to their named owner.

## Terms

| Term | Meaning |
| --- | --- |
| Compass target | The existing geographic orbit target represented by the camera and compass. It can have a configured height above the surface. It is not defined as the literal midpoint of the screen. |
| Picked point | A copied ECEF position obtained from a ray through a client-coordinate location. It may be on terrain, a 3D building, or the fallback ellipsoid. |
| Zoom anchor | The point approached or receded from by a zoom operation. |
| Orbit pivot | The point around which heading and tilt move the camera. |
| Pinned point | An explicitly selected, stationary ECEF point retained across gestures for this globe session. It does not follow a moving POI. |
| Gesture session | A recognized mouse drag, a wheel gesture classified by the existing wheel state machine, a Safari gesture, or a stable pair of touch contacts. |
| Inertial tail | Motion still belonging to a gesture after direct input ends. Its anchor remains associated with that motion. |

## Settings and defaults

Add these `choice` parameters to the engine controls catalogue. All use
`unit: "none"`, `persistDefault: true`, and the existing registry's persistence,
help, validation, URL and transfer mechanisms. Defaults have one source in the
registry; input normalization obtains the same definitions.

| ID | Label | Values | Default | Controls section |
| --- | --- | --- | --- | --- |
| `input.mouse.zoomAnchor` | Wheel zoom anchor | `pointer`, `target`, `pinned` | `pointer` | Mouse and trackpad |
| `input.mouse.orbitPivot` | Mouse rotation pivot | `pointer`, `target`, `pinned` | `pointer` | Mouse and trackpad |
| `input.trackpad.zoomAnchor` | Trackpad zoom anchor | `pointer`, `target`, `pinned` | `pointer` | Mouse and trackpad |
| `input.trackpad.orbitPivot` | Trackpad rotation pivot | `pointer`, `target`, `pinned` | `pointer` | Mouse and trackpad |
| `input.touch.zoomAnchor` | Pinch zoom anchor | `gesture`, `target`, `pinned` | `gesture` | Touch |
| `input.touch.orbitPivot` | Touch rotation pivot | `gesture`, `target`, `pinned` | `gesture` | Touch |
| `input.nonPointer.zoomAnchor` | Key, controller and button zoom anchor | `target`, `pinned` | `target` | Orbit |
| `input.nonPointer.orbitPivot` | Key, controller and button rotation pivot | `target`, `pinned` | `target` | Orbit |

Display values as **Under pointer**, **Gesture start**, **Compass target** and
**Pinned point** as applicable. Mouse rotation help explains that Under pointer
means the point at the original press, held for the drag. Touch help explains
that Gesture start means the initial two-finger midpoint. Trackpad help explains
that a browser's pointer location is used, since physical finger positions on
the trackpad are not generally available.

Default reason for pointer and touch choices: operate on the place the person
indicates without requiring a preliminary pan. Default reason for nonpointer
choices: there is no pointing position, so use the current compass target.

All eight choices are main-level parameters in their stated sections, using
the existing wrapping choice pills. Do not add a separate navigation settings
tab or duplicate the choices beside the compass. Include requested choice,
effective anchor source and any temporary override in the existing help/status
presentation; an effective fallback does not overwrite a saved preference.

Add two named presets through the existing preset system:

- **Pointer and touch anchors:** applies the defaults in the table.
- **Compass-centered:** sets all eight parameters to `target`.

Each preset changes only these eight fields. Rates, inversion, glide, limits,
bindings and the current pin are independent. A user can mix choices after
applying either preset.

Own the two preset value maps in the engine and expose them through its public
settings exports. The app registers them alongside its existing presets
(`src/settings/presets/`); standalone engine hosts can register those same maps
with their settings UI. Do not maintain divergent copies of their values.

Missing new IDs, including on an existing installation, receive the new
defaults. There was no saved zoom/orbit anchor preference to migrate. Do not
infer one from Grab the globe or rewrite its legacy key. No settings record
version bump is needed just to add these IDs. Preserve valid explicit choices,
including an explicitly selected default, through reload, export and import.
Invalid values follow the registry's existing rejection/reporting behavior.
Host defaults and forced values retain their existing priority and provenance.

## Pinned-point interaction

Place **Pick point**, **Pin compass target** and **Clear pin** actions in
Controls → Orbit. These are actions on session state, not extra copies of the
anchor preferences. Show whether a point is pinned and its coordinates using
the existing coordinate formatting.

Disable Pick point and Pin compass target while a navigation lease or external
camera owner is active, with an explanation in the section. Do not pin a
panorama's synthetic camera center. An existing pin survives, and Clear pin
remains available.

1. Pick point arms a one-shot map selection and displays an instruction in that
   section. A primary click or tap on the map resolves a point using the picking
   rules below. Reserve the candidate press/release from POI and scene recognizers
   from pointer-down, not only after a click has already been dispatched. A drag
   crossing the existing threshold continues navigation with the same held press
   and leaves selection armed; the person does not have to lift and start again.
2. A successful pick stores the copied ECEF position and disarms selection.
   That click/tap is consumed; it cannot also activate a POI, scene or double-click
   navigation action. A miss leaves selection armed and reports that no surface
   was found. Suppress the synthetic mouse/click events generated by a consumed
   touch selection too. Pin creation accepts terrain or ellipsoid, not the
   compass fallback.
3. Escape, pressing Pick point again, leaving globe navigation, or disposal
   cancels armed selection. Cancellation keeps an existing pin.
4. Pin compass target offers a keyboard-accessible way to pin the current target
   without precise mouse placement. All three actions use normal focus and
   button activation semantics.
5. Pinning or clearing changes no camera pose and does not change the eight
   preferences. An active gesture keeps its captured pin through its tail; the
   next gesture uses the replacement or fallback. The marker for current motion
   continues to identify the point actually in use.

The pin is session state, excluded from settings export and URL parameters and
cleared on globe-runtime destruction/reload. It survives ordinary panning,
zooming, map-source changes and temporary navigation leases in the same runtime.
Its coordinates stay fixed even if new geometry places that point above or
below the displayed surface. Collision rules still apply to the camera.

If Pinned point is selected without a pin, use the compass target and show
**No pinned point; using compass target** in the relevant help/status. Keep
Pinned point selected so creating a pin enables it on the next gesture.

At each acquisition, a pin must have finite coordinates, nonzero usable distance
from the eye and a forward/projectable direction. It must also be on the visible
side of the ellipsoid: the eye-to-pin segment must not pass through Earth before
reaching the pin. Otherwise retain the pin but use the compass target for that
gesture and report the reason, such as **Pinned point behind camera** or
**Pinned point beyond horizon**. A forward pin outside the viewport is usable;
it is not automatically recentered. A nearer hill/building occluding an otherwise
valid pin is handled by collision constraints, not by replacing the pin. If
mixed motion invalidates an already acquired pin, stop its blocked operation
at the last valid pose and reacquire on new direct input; do not retarget in
the middle of a tail.

## Resolving an anchor

For Under pointer or Gesture start, resolve once when acquiring an anchor:

1. Construct a world/ECEF ray from the actual camera view and projection and
   the client-coordinate point. Respect canvas offsets, CSS scaling, viewport,
   render resolution and device pixel ratio.
2. Query the current displayed surface through the existing surface-query
   service. Choose the nearest valid forward hit on eligible map geometry.
   Exclude POI sprites, orbit markers, overlays and helper meshes.
3. If no displayed-surface hit is available, intersect that same ray with the
   WGS84 ellipsoid.
4. If the ray misses Earth or coordinates are unavailable, use the compass
   target for that acquisition. Never substitute the world origin, a ray at
   `(0, 0)`, or a stale pointer from a previous camera owner.

Record the resolved source (`surface`, `ellipsoid`, `target` or `pinned`) and,
when present, the surface revision for diagnostics. Copy coordinates rather
than retaining a mutable mesh position. Do not obtain an ellipsoid hit and
raise it to a height sample: the resulting point generally leaves the pointer
ray in a tilted view.

Freeze a picked point's ECEF position through its gesture and inertial tail.
Loading terrain, changing LOD, or retrying a height sample does not replace it.
Resolve a fresh point for the next gesture. A target fallback is also retained
for that gesture; terrain arriving partway through must not switch it to a
pointer pick. Normal compass-target mode retains its existing ground-following
behavior instead of becoming a frozen terrain pick.

A finite client coordinate of zero is valid. Pointer availability must be
explicit; it must not be inferred from truthiness. Coordinates forwarded by
the existing panel/HUD input pass-through are interpreted against the canvas
at that location. A panel that consumes an event does not initiate navigation.

## Gesture contract

| Input | Acquisition and lifetime |
| --- | --- |
| Mouse orbit/tilt drag | Capture the candidate pick at the original press. Activate it only when the existing drag threshold commits an orbit. Keep that world pivot for the drag and its tail. Moving the mouse changes angles, not the selected pivot. |
| Mouse wheel zoom | Acquire at the first accepted wheel event. Keep the pick while the client position is unchanged. A subsequent accepted event at a new client position acquires a fresh point without changing the current pose; rebase remaining motion as described below. Mere hover movement produces no camera motion. |
| Wheel-based orbit | Acquire at the first event classified as orbit and hold the pivot for that wheel session and tail. |
| Trackpad pinch delivered as wheel | Use the classifier's trackpad zoom policy and available pointer coordinates. Follow the wheel zoom acquisition rules. |
| Safari scale/rotation | Acquire at gesture start, using event coordinates or a valid current pointer in the same navigation owner. Keep a shared picked point for the gesture when both settings request Under pointer; fall back to the target when no usable location exists. |
| Two-finger touch | When the stable pair is established, capture its initial midpoint and world pick. Use the same pick for zoom and orbit when both request Gesture start. Retain it until that pair ends and its motion settles or is handed over. |
| Keyboard, controller, on-screen navigation | Resolve target/pinned on the start of the command or continuous input episode. Do not read pointer state. Controller return to its existing dead zone ends direct input; normal glide rules then apply. |

Use the existing wheel classification and `WHEEL_GESTURE_IDLE_MS` boundary.
The current value is 180 ms; this feature adds no independent wheel timer.
Classification and preference selection are latched for each gesture. In
explicit trackpad mode Shift + wheel currently means zoom; do not change it to
orbit based on the stale wheel-controller comment. Preserve Safari's suppression
of duplicate wheel pinch events.

Map classifier output explicitly: `wheelZoom` reads `input.mouse.zoomAnchor`;
`pinchZoom` reads `input.trackpad.zoomAnchor`, including Ctrl-wheel interpreted
as pinch while mouse mode is selected. Wheel orbit reads `input.mouse.orbitPivot`
in explicit mouse mode and `input.trackpad.orbitPivot` in trackpad or Auto mode.
A mouse-button drag always reads the mouse rotation setting. Native Safari
gestures always read the trackpad settings. This rule resolves the device family
once for the gesture instead of guessing again on each event.

Touch midpoint translation already controls heading/tilt. Therefore a pinch
does **not** also pan to follow the moving midpoint. Gesture start refers to
the initial midpoint, not a continuously chased midpoint. The existing
recognizer's scale, translation thresholds and inversion still apply. A
changed contact pair starts a new acquisition from the current pose; lifting
one finger can continue existing single-finger pan without a jump. This work
does not add twist detection to touch.

If the anchor settings for simultaneous operations differ, retain a separate
context for each. Apply existing pan, then orbit, then zoom order once per frame.
Each operation preserves its own anchor's screen position immediately before
that operation. Motion from another operation may move that anchor on screen;
do not add a correction that undoes the other operation. When orbit and zoom
share a point, use one combined solve where possible so both preserve it.

## Camera operation contract

### Zoom

Picked/pinned zoom moves the eye toward or away from the anchor and keeps the
anchor at its current screen position in an unconstrained step. It is distance
zoom, with unchanged field of view. For eye position `E`, anchor `A`, and zoom
factor `f > 0`, the ideal unconstrained translation is:

```text
E_next = A + f * (E - A)
```

Retain the view orientation for the ideal translation and commit the equivalent
rendered pose through the camera adapter. A screen-anchor solver may implement
the same observable behavior, but simply changing `camera.radius` cannot
implement off-center zoom. Factors below one approach the anchor; factors
above one recede. Apply current sensitivity and logarithmic glide rates once.

### Rotation and tilt

Orbit moves the eye around the selected point. The requested heading increment
uses the pivot's WGS84 local vertical; the requested tilt increment uses a stable
camera-right direction after heading. These axes express input intent. The
constrained pose solver may adjust the eye/orientation path to satisfy the
horizon-level, distance and projection requirements together; exact rigid
rotation of both eye and orientation about those axes is not required.
Within limits, preserve eye-to-pivot distance and the pivot's screen position.
Picking, activating and releasing a pivot must leave the camera pose continuous.
The initial off-center point must not be pulled to the center of the view.

Keep ordinary globe navigation horizon-level under its existing heading/tilt
convention. The off-center solve must satisfy the projection and distance
requirements under that convention; do not assume rotating arbitrary eye,
forward and up vectors can be losslessly converted to the existing yaw/pitch
fields. Near singularities and active limits, use the constrained-step rules
below instead of flipping the camera.

### Representation and numerical requirements

The interaction pivot and the camera's canonical look target are separate
state. Do not implement this by calling `setViewState({ lat, lon })` on the
picked point or assigning it directly to `camera.center`.

Prototype the pose adapter before wiring inputs. Prefer a constrained,
horizon-level solve that works with the current GeospatialCamera representation.
Prove acquisition, operation and release using the real camera's matrices. If
that representation cannot meet the contract, add explicit internal pose/offset
support and update snapshots and restoration as one change. Property-only
mocks are not evidence that the rendered view is continuous.

Use ECEF float64 math and a stable local basis; avoid integrating raw longitude
differences across the antimeridian. Share screen-ray/projection helpers between
pan and the new operations, fixing reciprocal CSS scaling if necessary without
changing pan semantics. There is one host clock, frame scheduler and camera
authority; no additional rendering loop is introduced.

Commit complete candidate poses through one path. Do not expose intermediate
center/radius/orientation assignments to rendering or collision sweeps. After
the gesture, preserve the final pose and derive the canonical target on the
current sight line as needed; do not restore the pre-gesture compass target.

### Height, limits and collisions

Compass-target operations retain their configured orbit height and continuous
surface following. Picked and pinned points bypass compass height offsets and
height smoothing: they represent an exact acquired position. The legacy zoom
behavior that lowers a raised target at minimum distance applies only to
compass-target zoom, never to a picked or pinned point.

For an anchored operation, the distance limit refers to eye-to-effective-anchor
distance. Do not let an unrelated canonical `camera.radius` clamp defeat that
rule. Selecting a nearby point must not snap the camera out to the minimum
distance; generalize the existing soft-limit/`allowNearer` principle to both
ends of the range. For a newly acquired distance below the minimum or above the
maximum, allow motion back toward the legal range and block motion farther
outside it. Acquisition itself never snaps. Preserve the documented pitch
convention and limits.

Collision and hard limits take priority over keeping the anchor perfectly fixed
on screen. Validate the complete candidate motion with the existing collision
authority; screen-error correction may not bypass it or tunnel through terrain.
Clamp or reject the blocked motion component without accumulating pressure that
causes a later jump. Allow unblocked motion to continue. Keep the selected world
point, even when its screen projection must drift at a constraint; report that
constraint in diagnostics instead of silently replacing the point.

After a target moves horizontally, resolve its surface height through the current
bounded ground-following path. Confirm the river-to-bluff pan then orbit scenario
works without a zoom being needed to refresh height. Target height resolution
alone is not proof of eye-to-terrain collision safety.

## Glide, changes and camera ownership

Store anchor context with each motion channel in the existing inertial controller.
A context includes a session identifier, navigation owner, input family, selected
policy, resolved source, copied point when applicable, and surface revision.
Ending direct input stops acquisition, not the associated inertial tail. Release
the context only after that channel settles or its motion is explicitly handed
to another owner.

Use `camera.inertiaDecay` for all glide. Do not introduce another decay or an
anchor-specific ease-out. Reduced-motion handling follows the existing policy.

| Event | Required transition |
| --- | --- |
| New gesture or pointer-wheel reanchor during glide | Preserve current eye, orientation and FOV. Convert existing eye/turn velocity into the new anchor's motion representation before adding new input; do not apply old scalar rates blindly to the new pivot or discard momentum merely because the pivot changed. |
| Preference change, preset application, pin replacement/clear | Current gesture and tail keep their contexts. New direct input acquires with the new settings. No camera movement occurs solely from the settings/action change. |
| Pointer cancel, lost capture or device loss | End direct input and suppress clicks; retain already committed motion as its normal tail when the owner remains valid. Clear uncommitted candidates. |
| Canvas resize/CSS scale or FOV change | Rebase screen constraints from the current pose before the next step; do not enforce obsolete pixel coordinates. Preserve the anchor and motion unless the pose is invalid. |
| Map-source/terrain revision change | Keep copied active points and pins; invalidate pick caches for the next acquisition. If the runtime/camera is replaced, use the ownership handover path. |
| Navigation lease acquisition | Retire globe transient contexts after capturing the existing pose/motion handover state. No pre-lease pointer state can later resume accidentally. |
| Lease handback | Preserve existing `keepWheelSince` and held-press rules. The person's interrupting gesture acts immediately; acquire from the handed-back pose. Old-owner wheel momentum remains ignored. |
| Explicit programmatic view replacement | Clear transient contexts together with the existing explicit view-change cancellation. Keep the existing view command's behavior; pinned session state is independent. |
| Invalid/nonfinite candidate pose | Reject the candidate, keep the last valid pose, and retire only the failing operation with a diagnostic. |
| Runtime disposal | Release contexts, pin, armed selection, markers and listeners. |

Changing pivot can require a pan component to preserve existing eye velocity.
Use the existing pose/motion conversion work in `cameraGlide.ts` and
`navigationCamera.ts` as a starting point; test the actual velocity continuity.
If a hard constraint makes it impossible, remove only the prohibited component
and document that constraint. Do not quietly implement a global `cancel()` at
every acquisition.

The current touch flight-handback continuity gap is documented in the camera
motion rules. Carry the interrupting contact pair through `InputHandback` and
test it as part of this feature's touch integration. The existing gap is a
dependency to resolve before claiming the complete touch acceptance below.

### POI tracking and nonpointer commands

An active navigation lease has first authority. While ordinary POI tracking is
active, the tracked point supplies the effective zoom and orbit target for all
input families. This preserves tracking's explicit user intent and prevents its
per-frame center writer from fighting a picked-point operation. Explain the
temporary override in Controls; retain the saved preferences and pin.

Leaving tracking restores those preferences for the next gesture. Transitions
into or out of tracking retire/rebase transient contexts through the same pose
and momentum handover path. Any existing POI-entry snap encountered in that path
must be replaced by a continuous transition or reported as an unresolved release
blocker for this feature's no-jump acceptance.

The nonpointer preferences apply to user-issued globe zoom/orbit commands,
including keyboard, gamepad and HUD controls. They do not reinterpret direct
programmatic `orbitBy`, `zoomBy`, fly-to, view restore or panorama handback calls.
An old caller that supplies no anchor retains the centered API contract.

## Visual feedback

Keep the existing compass as the canonical target display. Show a small,
noninteractive marker at an active picked/pinned point so users can see where
zoom or rotation acts. Position it from the exact copied ECEF point without
compass height smoothing or offsets. When zoom and orbit use different points,
distinguish their markers by shape and accessible descriptions, not color alone.
Do not draw duplicates when points coincide.

An active marker lasts through its inertial tail. A pinned-point marker remains
while a pin exists. Hide projected markers behind the camera and handle
occlusion through the existing visualization conventions. Markers do not
participate in picking or capture pointer input. Honor the existing compass
visibility setting for the compass itself; give navigation markers one
independent boolean, `input.showNavigationAnchors`, default `true`, homed in
Controls → Orbit. Reset/presets for the eight anchor choices do not change it.

Ordinary interaction feedback says what point is in use. Surface revision,
solver errors and fallback detail belong in existing diagnostics, not extra
floating product panels.

## Implementation ownership and sequence

| Owner / current path | Responsibility |
| --- | --- |
| engine: `src/settings/catalogue/controls.ts`, `src/settings/inputPreferences.ts`, `src/input/inputSettings.ts` | Choice metadata, normalized policy, registry reads and compatibility defaults. |
| engine: `src/babylon/anchorPan.ts`, `src/babylon/surfaceQuery.ts`, `src/surface/contracts.ts` | Shared screen rays/projection and terrain-aware acquisition, with ellipsoid fallback. |
| engine: `src/babylon/cameraState.ts`, `src/camera/cameraGlide.ts` | Pose-preserving anchored operations, canonical target reconciliation, limits and motion conversion. |
| engine: `src/input/inertialCameraController.ts`, `src/babylon/globeInertia.ts` | Operation contexts and their lifetime through glide. |
| engine: `src/browser/mouseController.ts`, `wheelController.ts`, `touchController.ts`, `safariGestures.ts`, `createInputController.ts` | Acquisition coordinates and device/session lifecycle; no duplicate camera math. |
| engine: `src/babylon/createGlobeRuntime.ts`, `src/browser/globeBindings.ts`, `src/input/globeIntentMotion.ts` | Standalone engine wiring, settings subscriptions, nonpointer intent and public optional ports. |
| engine: `src/babylon/navigationCamera.ts`, `src/navigation/navigationLease.ts`, `src/layers/poiTracking.ts` | Ownership, snapshots, motion handover and tracking precedence. |
| engine: `src/panels/controlsPanel.ts`; app: `src/app/createGlobeApp.ts` | Settings homes, pin actions, markers and app integration through engine APIs. |
| ui: existing settings and preset exports | Reuse public controls and registry behavior. Add generic functionality only if the existing API cannot represent the feature. |

1. **Geometry and pose proof.** Add a real-camera fixture and prove off-center
   zoom/orbit, release, limits and snapshot round trips. Select the internal
   camera representation here, before wiring gesture handlers.
2. **Anchor and motion service.** Add typed acquisition and operation contexts,
   pinned session state, per-channel inertia and pose/momentum rebase. Keep
   Babylon vectors out of browser-neutral public input types.
3. **Inputs and ownership.** Connect all covered input families, leases,
   tracking, pass-through events and nonpointer commands. Implement the touch
   handback required by the release scope.
4. **Settings and feedback.** Register the choices and marker switch, add
   narrowly scoped presets and pin actions, wire both standalone engine and app.
5. **Consumer and browser validation.** Run the acceptance matrix and owner
   checks, reconcile affected camera/compass documentation, then report evidence.

Keep `CameraInputTarget.orbitBy(pitch, heading)` and `zoomBy(factor)` source
compatible. Add optional anchored capabilities/context methods and a safe
centered fallback for external consumers that do not implement them. Distinguish
unsupported capability from a pick miss in diagnostics. The shipped globe
runtime must implement the capabilities; a silent fallback is not feature
completion. New externally constructed input-option fields are optional and
normalized by the engine.

Navigation snapshots must capture every field that affects the actual rendered
pose. If representation support adds fields, provide an explicit snapshot
version/compatibility path and retain restoration of version 1 snapshots.

The current compass-height document describes a height-provider assumption that
differs from the app's current `runtime.surface.sample()` path. Reconcile it with
the implementation when documenting the new anchor/height distinction.

## Acceptance and verification

The following are release criteria. Numerical checks use real high-precision
GeospatialCamera view/projection matrices, following `navigationCamera.test.ts`,
with representative valid FOVs, zoom levels and tilted views. Exclude intentional
limits/collision correction from unconstrained anchor-error assertions and test
those corrections separately.

| Area | Required evidence |
| --- | --- |
| Acquisition/release | An off-center pick alone and its activation/release cause at most 0.5 CSS px landmark displacement attributable to the transition, with no FOV jump. Include an already moving camera. |
| Zoom | An off-center terrain or building point remains within 1 CSS px of its pre-step projection during unconstrained zoom and glide; with other motion disabled it does not drift cumulatively beyond 1 CSS px across the gesture. Zoom in/out is reversible within those tolerances when glide and constraints are disabled. |
| Orbit | An off-center point remains within 1 CSS px across an unconstrained drag and its tail. Eye-to-pivot distance changes by at most `max(0.001 m, distance * 1e-6)` in a pure orbit. No recentering on press, threshold crossing or release. |
| Centered compatibility | All-target settings reproduce current target-based navigation, height offset, inversion and limits. Grab the globe still controls only pan. |
| Coordinates | Offset canvas, scaled bounding rectangle, DPR 1/2, changed resolution, viewport resize and nondefault FOV all use reciprocal pick/project coordinates. |
| Fallbacks | Terrain hit beats ellipsoid; terrain miss uses ellipsoid; sky/space miss uses target. No invalid pose at horizon, limb, poles or antimeridian. No mid-gesture switch when terrain arrives. |
| Geometry changes | Higher-detail terrain/buildings, source changes and height retries leave active copied points and pins unchanged. New gestures can acquire the newer geometry. |
| Gesture lifetime | Press origin survives drag threshold. Fixed wheel location keeps its anchor; a changed location reanchors without a pose jump. Pair replacement, pointer cancellation and lost capture cannot leave a stuck context or cause a click. |
| Simultaneous input | Touch pinch plus midpoint tilt, and Safari scale plus rotation, apply each effect once with shared or independent anchors as configured. Touch does not gain unintended pan or twist. |
| Glide | Correct anchor survives release. Reanchor during glide preserves representable eye/turn velocity before new input, measured within 1% of magnitude plus 0.0001 m/s for eye velocity and 0.000001 rad/s for turn; there is one decay setting and no motion at idle from stale contexts. |
| Collision/limits | A blocked zoom or tilt cannot tunnel, oscillate or accumulate a jump. Acquisition below minimum or above maximum distance, and panorama handback, honor soft limits. Screen correction cannot bypass collision decisions. |
| Height regression | Pan from low river terrain to a bluff without zoom, then orbit. Current target height refresh and eye collision are verified separately. |
| Ownership | POI tracking overrides anchor preferences predictably. Leases suspend globe interaction. Interrupting wheel, mouse and the covered touch pair continue immediately on handback; old-owner momentum does not leak. |
| Pins | Pick, replace, clear, no-pin/behind-eye/beyond-horizon/zero-distance fallback, offscreen-forward use, session lifetime, keyboard-accessible pinning and consumed selection clicks work. Reserved pointer-down and suppressed synthetic touch clicks cannot activate a POI. A pin never becomes moving-POI tracking. |
| Settings | Fresh and existing records get the stated defaults; explicit default choices survive; invalid input is reported; export/import, URL overrides, host layers, presets and reset work without altering unrelated values. |
| Public consumers | Old centered callers compile and retain behavior; new engine consumers can configure anchors without app-private imports. Snapshots restore the actual final pose. |
| Feedback/accessibility | Correct marker follows actual active point through glide, does not intercept input, works with marker visibility off, and selection/status are keyboard and screen-reader usable. |

Extend existing camera, surface-query, input, inertia, navigation, settings and
POI tests rather than writing tests that only mirror enum definitions. Add focused
mouse-controller coverage where missing. Keep geometry proof separate from DOM
event tests so a mocked controller cannot conceal projection failures.

For manual/browser acceptance, use a flat map, a tilted mountain view, a loaded
3D building away from center, a globe-edge view, the river-to-bluff case, and
entry/exit from a campus panorama. Exercise mouse wheel/right drag, explicit
trackpad mode, Safari pinch/rotation, touch pinch/tilt and nonpointer commands.
Repeat with default, all-target and mixed pinned choices. Include streamed
terrain arriving during motion and reduced motion enabled. Record browser,
device/input, map source and any unavailable coverage.

Run owner checks using the repository's installed source dependencies:

```sh
npm --prefix research run check:source
npm --prefix engine run check:implementation
npm --prefix app run check:implementation
```

During implementation, first run focused related tests/typechecks in changed
owners, then their complete required checks. Run other affected owners' checks
and public-consumer checks if public ports change. Typecheck the actual current
0SFS and UMN-VR consumer packages using their own documented scripts; do not
assume the organization directory is a buildable package. Browser evidence must
exercise the rendered camera, not only DOM assertions. If a device or consumer
is unavailable, report the exact coverage gap rather than calling it verified.

Completion requires all delivered settings and inputs to meet this contract,
an implementation report with test/browser evidence and remaining platform
limitations, and updated user-facing controls help. Writing this specification
alone establishes no runtime or browser acceptance result.
