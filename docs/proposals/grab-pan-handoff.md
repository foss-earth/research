# Grab pan: handoff

Pressing and dragging the globe grabs the ground under the pointer or finger.
The camera brings that point to the pointer and glides on when it is let go.
This is the pan counterpart of [navigation anchors](navigation-anchors.md),
which made zoom and rotation act about a point on the ground and mark it.

**Status, 2026-10-12.**
- The first version is built in the engine and is uncommitted.
- The user tried it and is not satisfied: there is no marker on the ground, and it "feels off".
- The work stopped there to save credits. This file records where it is and how to go on.

Copy this prompt into a new coding conversation to resume:

```text
Continue the FOSS Earth "grab pan" work in /Users/felg/gh/foss-earth. Pressing
and dragging the globe grabs the ground under the pointer or finger, brings it
to the pointer and glides on release. A first version is built and uncommitted
in the engine. The user is not happy with it yet.

Do not restart from scratch. Do not revert, stage or commit anything you did not
write: other people's uncommitted work is in these repositories. Commit only
when the user asks.

Read these first:
- research/docs/proposals/grab-pan-handoff.md: the state, the open problems and the plan
- research/docs/proposals/navigation-anchors.md and navigation-anchors-implementation.md
- docs/docs/camera-motion.md: the camera rules
- .github/AGENTS.md

The user's verdict on the current build was: "no, it feels off still, and i do
not see an anchor appear in the ground when i click to move in the globe, that
what i loved so much about rotate/zoom".

Do these in order:
1. Show the grabbed ground point as a navigation anchor marker, in the style of
   the zoom and rotation markers. Show it while the ground is held and through
   the glide after release, until the glide stops. The handoff file has the
   design.
2. Find out what feels off from measurements, not guesses: drive real drags in
   headless Chrome against your own dev server on port 4190, never 5173. Then
   fix what the numbers show. The handoff lists the suspects and the candidate
   fixes. Do not change how the orbit and zoom drags and glides feel without
   asking the user: they love those.
3. Add tests, then run the typecheck, the full engine test suite and lint.
   Re-measure in the browser. Update docs/docs/camera-motion.md. Report to the
   user, and ask them to try it.

Keep it lean. Work in this conversation, and do not run multi-agent workflows
unless the user asks. Scratch goes only in the gitignored app/build/, never in
/tmp or anywhere outside the repository.
```

## What the user asked for

The request, verbatim:

> i think we should also add the same anchored navigation to clicking on the world to change lat/lon we should find the anchor on the ground and move it smothly to the finger, simulating the physical inertia of the camera moving

The verdict on the first build, verbatim:

> no, it feels off still, and i do not see an anchor appear in the ground when i click to move in the globe, that what i loved so much about rotate/zoom

In rotate and zoom, the user loved two things:
- **The marker.** A marker appears on the ground at the point the gesture acts about, and it stays while the glide does.
- **The feel.** The camera behaves like "a physical thing with mass and momentum" (`docs/docs/camera-motion.md` in this workspace).

## What is built

All of this is uncommitted, in `engine/` unless a path says otherwise.

| Piece | Where |
| --- | --- |
| The grab itself: `beginAnchorPan`, `panAnchorTo`, `stepAnchorPan`, `endAnchorPan`, `cancelAnchorPan`, `isAnchorPanActive`, `isAnchorPanMoving`; private `grabbedCenter`, `clientViewDirection`, `metersPerPixel`; the `GrabPan` state and its constants; the `groundAt` port | `src/babylon/cameraState.ts` |
| The ground under a client point (displayed surface, else ellipsoid, else null): `groundAt` | `src/babylon/navigationAnchorService.ts` |
| Stepping the grab each frame, and handing the release velocity to the pan glide | `stepGrab` and `endAnchorPan` in `src/babylon/globeInertia.ts` |
| The setting `camera.grabFollowMs`, "Grab follow time": 0 to 250 ms, default 30, under Controls → Camera | `GRAB_FOLLOW_ID` and `DEFAULT_GRAB_FOLLOW_MS` in `src/input/inertialCameraController.ts`; the entry in `src/settings/catalogue/controls.ts` |
| Wiring: `groundAt` and `grabFollowMs` | `src/babylon/createGlobeRuntime.ts`. Only the `inertialCameraController` import line, the `CameraController` ports and the `createGlobeInertia` ports are the grab's. Every other uncommitted hunk in that file belongs to someone else. |
| Touch: a second finger ends the grab, and the finger left grabs afresh | `setSession` and `startPanSession` in `src/browser/touchController.ts` |
| Removed the unused `ANCHOR_PAN_CHASE` export | `src/babylon/anchorPan.ts` |
| Tests | `tests/grabPan.test.ts` (new, 9 tests, on a real `GeospatialCamera` with a NullEngine), two new tests in `tests/touchController.test.ts`, and an updated mock in `tests/inertialCameraController.test.ts` |
| Docs | `docs/docs/camera-motion.md`: a paragraph under rule 3 and a row in "Where it is built". These are uncommitted, and describe the grab as finished, so revise them when it is. |

How it behaves:

1. **Press.** This is a left mouse press with "Grab the globe" on (`globeAnchorRotation`, in `mouseController.ts`), or one finger.
   - `beginAnchorPan` grabs nothing over a pickable world point (`hasPickablePointAt`) or over sky.
   - Otherwise it copies the displayed surface point under the pointer (a raycast), or the ellipsoid point.
   - The press stops any glide (`base.cancel()`).
2. **Move.** `panAnchorTo` only records the pointer. Each frame then runs this chain: `prepareFrame` → `inertialCameraController.update()` → `stepGrab` → `stepAnchorPan(dtMs, followMs)`. That step does three things:
   1. It solves for the orbit-target centre that puts the grabbed point at the pointer's view direction. The solve is Newton's method over east and north, at the centre's current height, with heading, tilt and distance kept.
   2. It moves the centre toward that solution as a critically damped spring with time constant `followMs`. At 0 it moves there exactly.
   3. It applies the view with `movedOrbitTargetHeightMeters`, so ground following still sets the centre's height.
3. **Release.** `endAnchorPan` turns the centre's velocity into one 60 Hz frame of pan glide, in screen pixels. It does this by inverting `pannedViewState`. `base.panBy` takes it from there, and the existing pan glide slows it by `camera.inertiaDecay`.

**Checked:**
- On 2026-10-12, the full engine suite passed: 95 files, 923 tests.
- The typecheck and lint were clean.

**Not checked:** no agent has run it in a browser. The user did, in the app or in the UMN-VR tour. The tour's dev server on port 5173 runs this same engine source: the tour's `node_modules/foss-earth` is a symlink to `foss-earth/app`, and the app's `node_modules/@foss-earth/engine` is a symlink to `engine/`.

## Open problem 1: no marker on the ground

**Cause.** The grab registers nothing with the markers. The markers come from three places:
- `NavigationAnchorService.markerPoints(gliding)`, which collects the anchors gestures hold, the glide's anchors and the pin;
- `showAnchorMarkers()` in `createGlobeRuntime.ts`, which projects them after each rendered frame and tests whether they are occluded;
- `src/browser/navigationAnchorMarkers.ts`, which draws the SVG shapes: a reticle for zoom, turning arrows for rotation, a dot, and a pin.

These only know zoom, orbit and the pin. `AnchorOperation` is `"zoom" | "orbit"`, and the comment in `navigationAnchors.ts` says "Pan has no anchor of this kind".

**Proposed design.** A design agent was started on this but stopped before it reported, so this proposal is unreviewed.

### Data flow

1. **Expose the point.** `CameraController` gets `grabbedPoint(): Readonly<EcefCoord> | null`, the held point while a grab is active.
2. **Keep it through the glide.** `createGlobeInertia` keeps the point from the press, through the drag, and through the glide that the release starts. It clears the point in these cases:
   - the pan glide stops;
   - `cancel` or `cancelInertial` runs;
   - a new gesture or another pan, orbit or zoom input arrives;
   - the view is replaced or navigation is leased.
3. **Report it.** `anchors()` reports the point. One way is an optional `pan` field on `GlideAnchors`. Another is a small grab hold and release on the service, alongside `hold` and `release`.
4. **Show it.** `markerPoints` adds the point with a new flag, `grab`, merged by `samePoint` like the other markers. Then:
   - `showAnchorMarkers` passes the flag through, so `NavigationAnchorMarkerView` gets `grab`;
   - `kindOf` adds a letter for it;
   - `draw` adds the shape.
5. **Hide it on time.** A glide channel that comes to rest reports no anchor in that frame's `update()`. So the last frame drawn shows no marker, which is how zoom and rotation markers disappear now. Keep the same behaviour for the grab.

### When it appears

Orbit drags follow a "candidate" rule: the pivot is picked at the press, but it only shows once the press becomes a drag.

The user said they expected the marker "when i click to move". The press already holds the ground and stops any glide, so I recommend showing the marker at the press, and removing it at release if the pointer never moved. Ask the user if unsure.

### Shape

Use the same style as the other markers: a dark halo under a `currentColor` line of width 1.75, in a 44 px box with the point at (0, 0). Tell the shapes apart by form, not colour.

A suggestion is four outward arrows around the centre dot:

```
M 0 -6 V -13 M -3 -10 L 0 -13 L 3 -10 M 0 6 V 13 M -3 10 L 0 13 L 3 10
M -6 0 H -13 M -10 -3 L -13 0 L -10 3 M 6 0 H 13 M 10 -3 L 13 0 L 10 3
```

**A tether line.** A thin line from the grabbed point to the pointer, while the spring pulls, would make the pull visible. For a mouse the cursor is visible anyway, and for touch the finger covers the point. Try it only if it helps.

### Words

- **Marker label.** In `describeNavigationAnchorMarker`, the marker reads "Grabbed point", plus ", hidden behind the ground" when it is occluded.
- **Group label.** The overlay's group label changes from "Zoom and rotation points" to "Navigation points".
- **Setting.** `input.showNavigationAnchors` governs this marker too. Keep its id, but change its label to "Show grab, zoom and rotation points" and update its description.

### Tests

- `tests/navigationAnchorMarkers.test.ts`: the shape, the label, and redrawing when the kind changes.
- `tests/navigationAnchorService.test.ts`: `markerPoints` with a grab point, including merging with the pin.
- `tests/grabPan.test.ts`, in its `createGlobeInertia` part: the point through drag, release and glide, and gone at rest and after cancel.
- The runtime test that covers markers. Find it with `grep -rn showNavigationAnchors tests`.

## Open problem 2: it "feels off"

Nothing has been measured yet. The suspects below come from reading the code. Confirm each one with numbers before fixing it.

**Something the user can try now.** Controls → Camera → Grab follow time: 0 holds the ground exactly under the pointer, and 30 is the default spring. Their answer narrows suspect 1 cheaply.

1. **The spring trails the pointer.**
   - A critically damped spring with time constant `followMs` lags a steadily moving pointer by 2 × `followMs` of its motion. The default is 60 ms, which is 60 px at 1000 px/s.
   - Mature globes and maps lock the grabbed point exactly under the pointer while dragging, and add inertia only after release: Google Earth, CesiumJS (`spin3D`/`pan3D`, then `inertiaSpin`), MapLibre (drag pan, then its inertia handler) and OpenLayers (`DragPan` with `Kinetic`). This is from general knowledge, not re-checked against their sources in this work.
   - **Candidate fix:** a default of 0, or a few ms, and let the marker show the hold.
2. **The release glide depends on the frame rate.**
   - `createInertialCameraController.update` applies the pan velocity, in pixels per 60 Hz frame, once per call, whatever the frame time. The decay, `decay^(Δt / 16.67 ms)`, does depend on time.
   - **At 60 Hz** the glide covers v / (1 − 0.82) ≈ 5.6 v.
   - **At 120 Hz** each frame keeps 0.906 of the velocity. The glide starts at twice the hand's speed and covers about 10.6 v, roughly 1.9 times as far.
   - So a release on a 120 Hz Mac would jump in speed.
   - The orbit and zoom channels, and the old drags that add up pointer deltas, work the same way. By the code, if pointer events come once a frame, an orbit drag turns about 1.9 times as much per pixel at 120 Hz. This is not measured. It is long-standing behaviour the user likes, so do not change it for them without asking.
   - **Candidate fix:** give the grab its own time-integrated glide (m/s, decaying by `camera.inertiaDecay` per 1/60 s), or scale only the grab's fling. Keep rule 2 of camera-motion.md: handovers keep momentum. Check `motion()`, `rebaseTo`, navigation leases and tracking.
3. **Terrain following drifts the point.**
   - `stepAnchorPan` solves the centre at its current height. `applyViewState` then sets a new height from `movedOrbitTargetHeightMeters`, which is smoothed over time (`smoothSurfaceHeightMeters`).
   - The new height moves the eye, so the grabbed point leaves the pointer every frame over rough ground. It goes on drifting under a still pointer until the smoothing settles.
   - **Candidate fix:** solve at the height that will be applied (take the height for the solved place, re-solve at it, and apply with that override). Keep re-solving while the pointer is still, so the point stays put.
   - Holding the height fixed during a grab is the other option, but dragging a mountain under the camera could then put the eye inside the terrain.
4. **The pointer direction may be stale.**
   - `clientViewDirection` mixes `clientRay`, which uses the camera's cached `getViewMatrix()`, with axes from `getPose()`. The two disagree if anything moves the camera between the last render and the step.
   - **Candidate fix:** take the direction from the projection alone. Use the pointer's NDC with tan(fov/2), the aspect ratio and the fov mode, which is exact whatever the pose.
5. **The release velocity estimate.**
   - With a spring, the release uses the spring's velocity. At 0 ms it uses a 40 ms moving average.
   - `base.panBy` clamps the fling at 80 px per frame (`MAX_PAN_DELTA_PER_FRAME_PX`).
   - **Check:** compare the point's screen speed over the last frames of the drag with the first frames of the glide. Look for a jump, a change of direction, and the stopped-before-release case.

Also note how the orbit drag the user likes responds. Each pointer event adds its delta to a velocity, and each frame applies that velocity and multiplies it by 0.82. At 60 Hz this is a low-pass of about 84 ms: a mass with friction, pushed by the pointer.

## How to check

**Engine commands:**
- Typecheck: `cd app && npx tsc -p build/engine-tests/tsconfig.json 2>&1 | grep -v sessionTrail`
- Tests: `cd app && npx vitest run --configLoader native --config build/engine-tests/vitest.config.mts [tests/<file>.test.ts]`. Test paths are relative to `engine/`.
- Lint: `cd engine && ../app/node_modules/.bin/eslint --no-config-lookup -c ../app/build/engine-lint/eslint.config.mjs src tests`

**Browser:**
1. **Start your own dev server:** `cd app && npx vite --configLoader native --port 4190 --strictPort --host 127.0.0.1`, logging to `app/build/logs/`. Port 5173 is the user's UMN-VR tour server; leave it alone.
2. **Open the page:** `http://127.0.0.1:4190/app/?bench=1`. With `bench=1`, `window.__fossEarthBench` is the globe app, and its `.runtime` has `getViewState`, `setViewState`, `navigationAnchors` and `scene`.
3. **Start from the template:** `app/build/nav-anchors-browser/run.mjs`. It covers:
   - headless Chrome through `app/node_modules/@foss-earth/browser-testing/src/headlessChrome.mjs`;
   - mouse input with CDP `Input.dispatchMouseEvent`;
   - settings saved in localStorage under `foss-earth.settings.v1`, in `.values`;
   - a page-side probe that projects an ECEF point every animation frame.
4. **Find the grabbed point.** With the camera at rest, run `navigationAnchors.armPick()`, click the press pixel, and read `status().pin.point`. A drag from that pixel grabs the same point.
5. **Scenarios to measure, at Grab follow time 0 and 30:**
   - a slow and a fast steady drag over a tilted city;
   - a flick released while moving;
   - a drag across the Grand Canyon (36.1, −112.14, heading 20, pitch 50, 6 km) and then holding still;
   - a drag across the whole globe;
   - the old pan, with "Grab the globe" off, for contrast.
6. **Know what headless can't show.** Headless Chrome runs at 60 Hz at best. Check the 120 Hz behaviour in unit tests with 8.33 ms frames.
7. **Debug overlay.** `src/browser/anchorPanDebugOverlay.ts` already draws the grabbed point against the pointer, if a host passes `attachAnchorPanDebugOverlay`.

## Repository rules for this work

- **Others' work.** Other people's uncommitted work is in `engine`, `app`, `docs` and `research`. Before staging, read `git status` and each hunk of `git diff` again, because the set changes.
- **Partial staging.** Stage only the grab's files and hunks. `python3 app/build/commit-split/pick.py <repo> <file> <excluded hunk numbers, comma-separated>` stages a file without the hunks you name; the numbers follow the hunks in `git diff -U1` order.
- **Check what is staged.** Build what is staged on its own: check it out into `app/build/staged/node_modules/@foss-earth/engine/`, then run with `app/build/staged/tsconfig.json` and its `vitest.config.mts`.
- **Commits.** Commit only when the user asks.
  - The author is Felipegalind0.
  - Write a sentence-case subject and a prose body.
  - Never add an AI author, committer or co-author.
- **Scratch.** Scratch goes only in `app/build/`, which is gitignored.

**Scratch left by the stopped run.** `app/build/grab-pan-browser/` holds `gpu-check.mjs` and three Chrome profiles. It was a test of which headless Chrome flags (Metal or SwiftShader) give a GPU and what frame rate. Its results are unknown, and it can be deleted.
