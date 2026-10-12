# Navigation anchors: implementation report

This reports what was built for [Configurable zoom anchors and rotation pivots](navigation-anchors.md),
what evidence there is for each release criterion, and what was not covered. The work is uncommitted
in the engine, app and 360 owners as of 2026-10-12.

## What was delivered

- **Settings.** There are eight choice settings, `input.<family>.zoomAnchor` and `input.<family>.orbitPivot`, for
  `mouse`, `trackpad`, `touch` and `nonPointer`, in `engine/src/settings/catalogue/controls.ts`.
  - Defaults: Pointer for mouse and trackpad, Gesture start for touch, and Compass target for keys,
    controllers and buttons.
  - Each choice is saved even at its default (`persistDefault`).
  - The marker switch is `input.showNavigationAnchors` ("Show zoom and rotation points"), on by default.
  - The two presets are "Pointer and touch anchors" and "Compass-centered" (`NAVIGATION_ANCHOR_PRESETS`).
    They set the eight choices and nothing else. The app registers them beside its own presets.
- **Anchor service.** `engine/src/babylon/navigationAnchorService.ts` handles acquisition:
  1. It casts a ray through the client point using the camera's own matrices.
  2. A displayed-surface hit wins. Otherwise it uses the WGS84 ellipsoid on the same ray, and otherwise the compass target.
  3. The point is copied and frozen.

  The service also owns the candidate → held → released lifetime, the pinned point, Pick point
  selection, retirement on view changes and leases, and the marker points. The runtime exposes it as
  `runtime.navigationAnchors`, through the `GlobeNavigationAnchors` facade.
- **Camera operations.** `engine/src/camera/anchoredMotion.ts` and `CameraController.planAnchored` /
  `commit()` in `engine/src/babylon/cameraState.ts` do the following:
  - Zoom moves the eye along the line to the point.
  - Orbit turns the eye and look about the point's geodetic vertical and the view's right axis.
  - After each step, the orbit target is put back where the line of sight meets its height.
  - Limits are measured from the eye to the point. A clamp is reported (`constrained`).
- **Glide.** `inertialCameraController.ts` keeps one context per channel:
  - Pan, orbit and zoom each glide about the anchor they were set moving with.
  - When orbit and zoom share a point, they move in one combined step.
  - When a new anchor arrives, the motion under way is rewritten about it before the new input is added.
  - There is one decay setting, `camera.inertiaDecay`.
- **Inputs.** The mouse, wheel, touch, Safari gesture, gamepad and key controllers acquire at the
  moments the spec names:
  - **Mouse:** a right press acquires a candidate, which is held once the press passes the drag threshold.
  - **Wheel:** a gesture acquires once. It acquires again when the pointer moves, keeping the choice the gesture began with.
  - **Touch:** the pair's first midpoint is used, and a changed pair picks again.
  - **Safari:** a gesture acquires where it starts.
  - **Keys and controller:** a run acquires once.

  After a navigation lease, a held mouse press and a covered touch pair carry on without a new press.
- **Pins.** Controls → Orbit has a Pinned point section (`engine/src/panels/navigationAnchorPinSection.ts`):
  - **Pick point** pins the surface point under the next click or tap, or the ellipsoid point when no surface is there.
  - **Pin compass target** pins the compass target as it is.
  - **Clear pin** removes the pin.

  The click that picks is consumed. Esc cancels Pick point. While a lease or simulation holds the camera, Pick point
  and Pin compass target are disabled with an explanation, and Clear pin keeps working. The pin lasts for the
  session and is never saved, exported or put in the URL.
- **Tracking.** While a POI is tracked, it is every gesture's centre, and Controls says so beside each
  choice. The centre eases onto a newly tracked point at the pace set by `camera.inertiaDecay`.
- **Markers.** `engine/src/browser/navigationAnchorMarkers.ts` draws the markers as an SVG group beside the
  canvas that takes no pointer input:
  - a reticle for zoom;
  - turning arrows for orbit;
  - a pin.

  A marker hidden by the ground is drawn dashed and faint. Each marker has an accessible name.
- **Compatibility.**
  - `CameraInputTarget.orbitBy(pitch, heading)` and `zoomBy(factor)` are unchanged. The anchored methods are
    optional, and a target without them is moved about its orbit target as before.
  - Navigation snapshots stay at version 1 with no anchor or pin fields. A restore retires gesture contexts.
- **Docs and help.**
  - `docs/docs/camera-motion.md` describes touch and the anchored operations.
  - `engine/docs/compass-height-model.md` now describes the app's real height provider
    (`runtime.surface.sample`), not the smooth model. It has a table that sets compass-target height rules
    against picked and pinned points.
  - `engine/docs/globe-runtime.md` documents `runtime.navigationAnchors`.
  - The app's help modal says what wheel, pinch, right drag, keys and the controller act about, and where to change it.

## Defects found and fixed during validation

| Defect | Effect | Fix |
| --- | --- | --- |
| The screen ray started at NDC depth 0. Under WebGPU's reversed infinite projection that is at infinity. | In the app, Pick point always missed, and every pointer anchor fell back to the compass target. NullEngine tests (WebGL depth) could not show it. | `clientRay` in `anchorPan.ts` takes the ray from the eye through depth 0.5, a finite point in both conventions. A regression test runs the same views with WebGPU depth settings. |
| Orbit used the geodetic vertical only. Where it could not keep the look level, the turn stalled (`not-ahead`) in a steep valley. | A rotation stopped mid-drag. | When the geodetic vertical has no solution, it retries about the geocentric up, which is at most about 0.19° away. |
| An anchored tilt step could pass straight down. | The view flipped over. | The step is limited to 89.9° of dip at the eye, and the clamp is reported as `tilt-limit`. |
| The line-of-sight solve stopped at a 1 cm miss. | The centre height drifted step by step. | The tolerance is 0.01 mm. |
| `applyViewState` clamped the tilt before writing the zoom. | A restored pose could come back with a different tilt. | Fields are written so the clamp sees the final zoom. Anchored moves use the atomic `commit()`. |
| A Pick point press whose pointer capture was lost was never cleared. | The next click did not pick. | Lost capture forgets the pick press. |
| The tracking note stayed after tracking ended. | Controls kept saying the tracked point was the centre. | The note is dropped once tracking has ended. |

## Evidence by release criterion

The numerical tests use real `GeospatialCamera` view and projection matrices on Babylon's NullEngine.
`anchoredCamera.test.ts` has four views:

- a tilted city block;
- a steep mountain valley;
- a low, grazing look;
- the antimeridian.

`anchoredMotion.test.ts` adds the antimeridian and a near-pole view, with several fields of view.

| Area | Evidence | Status |
| --- | --- | --- |
| Acquisition/release | **Tests:** a step of nothing about an off-centre point does not move the view. A candidate is shown only once it is held, and a released press holds nothing. A moving glide is rewritten about a new anchor before new input. **Browser:** a pin, then a wheel at its pixel, moved it by at most 1.5e-9 px. No FOV is written. | Met. The browser covers this only for wheel and right drag. |
| Zoom | **Tests:** an off-centre point stays within 1 CSS px at every step over 20 steps in and 20 back out, in each view, and the in-and-out round trip is reversible. **Browser, WebGPU, glide included:** trackpad Ctrl+wheel in drifted at most 1.45e-9 px over 185 frames and out 9e-10 px. Mouse wheel in drifted 4e-10 px and out 1.1e-9 px. A control wheel elsewhere moved the same point 396 px (trackpad) and 65 px (mouse). | Met |
| Orbit | **Tests:** the pivot stays within 1 CSS px, and the eye-to-pivot distance holds through a drag. There is no recentring on press, threshold or release. **Browser:** mouse right drag drifted at most 8e-10 px over 388 frames. Trackpad-mode right drag drifted 0.028 px over 398 frames, with heading 20°→44.7° and pitch 50°→44°. | Met |
| Centered compatibility | Each controller has an "as before anchors" test for a camera that picks nothing. A compass-target zoom keeps the legacy near-limit lowering of a raised target (anchoredCamera). Compass-centered preset test (app). A grab-the-globe left drag picks nothing. | Met in tests. Not repeated in the browser. |
| Coordinates | **Tests:** pick and project are reciprocal on an offset, scaled, DPR 2 or resized canvas, at any FOV (anchoredMotion). WebGPU and WebGL depth give the same ray and ground point (anchoredCamera). **Browser:** DPR 1, 1280×800 only. | Met in tests. Browser covers DPR 1 only. |
| Fallbacks | **Tests:** a surface hit wins over the ellipsoid, the ellipsoid is used on a surface miss, and the compass target is used on a sky miss or with no client point. A pin behind the eye or beyond the horizon falls back for that gesture, and a pin at the eye is refused. Non-finite requests and points behind the eye leave the camera unchanged. Antimeridian and near-pole views are covered. | Met in tests |
| Geometry changes | Acquired points and pins are copies with their surface revision recorded; nothing refreshes them. A new gesture raycasts the current surface. | Met by construction and service tests. Terrain arriving mid-gesture was not exercised in the browser. |
| Gesture lifetime | **Tests:** a right press keeps its pick past the threshold. A wheel keeps its anchor while the pointer stays and reanchors when it moves. A changed touch pair picks again. Cancellation and lost capture release without a click. A Safari gesture whose end never came is released before the next. | Met in tests |
| Simultaneous input | **Tests:** a touch pinch with a midpoint swipe orbits and zooms once each. Safari scale plus rotation turn and zoom about one shared point in one combined step. A pure pinch does not orbit and a parallel swipe does not zoom. | Met in tests. No touch or Safari hardware was used. |
| Glide | **Tests:** the anchor survives release, a reanchor keeps the glide's motion, there is one decay setting, and there is no anchor or motion at rest. The 1% / 0.0001 m/s / 0.000001 rad/s tolerances were not measured numerically. | Partly met. See the gaps below. |
| Collision/limits | **Tests:** zoom limits are measured to the point and reported. A point acquired nearer than the near limit may be left but not approached, and never snaps. Tilt is held at its limits. A step the target cannot take stops only that channel. | Met in tests. Panorama handback was not exercised. |
| Height regression | The compass-target height path is unchanged: the anchored commit puts the target back on the line of sight at its own height, and surface following continues from there. A raised target keeps its height and offset through an anchored zoom (test). | Partly met. The river-to-bluff manual run was not done. |
| Ownership | **Tests:** POI tracking overrides every choice, retires contexts and is shown in Controls. A lease suspends globe input and blocks picking. A held mouse press, a wheel gesture begun during the lease and a touch pair carry on at handback, and old momentum is ignored. | Met in tests |
| Pins | **Tests:** pick, replace, clear, ellipsoid pin, missed pick staying armed, Esc cancel, keyboard-focusable buttons, consumed click and double click, and taps suppressing the synthetic mouse events. A pin is never tracking. **Browser:** Pick point pinned a surface point at 1074.6 m that re-projected to the clicked pixel within 2e-10 px. Clear pin removed it. | Met |
| Settings | **Tests:** defaults, presets setting only the eight choices, registry live application, and Controls notes. | Met for defaults and presets. Export/import and URL overrides go through the existing registry and were not re-tested specifically. |
| Public consumers | UMN-VR `tour` typechecks clean against the changed engine. Old `orbitBy`/`zoomBy` callers compile unchanged. Snapshots stay version 1 (test). | Partly met. See the consumer list below. |
| Feedback/accessibility | **Tests:** markers take no pointer input, follow the glide's anchors, are hidden with the switch off, have accessible names, and mark occlusion. The pin section is a labelled group with a `role="status"` note. **Browser:** the marker is visible in `mouse-04-during-orbit.png`. | Met. No screen reader was used. |

### Test counts

| File | Tests |
| --- | --- |
| `engine/tests/anchoredCamera.test.ts` | 15 |
| `engine/tests/anchoredMotion.test.ts` | 8 |
| `engine/tests/navigationAnchorService.test.ts` | 33 |
| `engine/tests/navigationAnchorMarkers.test.ts` | 9 |
| `engine/tests/navigationAnchorPinSection.test.ts` | 14 |
| `engine/tests/inertialCameraController.test.ts` | 23 |
| `engine/tests/mouseController.test.ts` | 18 |
| `engine/tests/wheelController.test.ts` | 25 |
| `engine/tests/touchController.test.ts` | 15 |
| `engine/tests/safariGestures.test.ts` | 8 |
| `engine/tests/createInputController.test.ts` | 14 |
| `engine/tests/globeIntentMotion.test.ts` | 11 |
| `engine/tests/gamepadRest.test.ts` | 7 |
| `engine/tests/globeRuntime.test.ts` | 46 (11 for anchors) |
| `engine/tests/poiTracking.test.ts` | 4 |
| `engine/tests/navigationCamera.test.ts` | 2 |
| `app/src/settings/navigationAnchorPresets.test.ts` | 2 |
| 360 `globeCancelOnInput.test.ts` | 7 |

All counts include the tests that were already in those files. There are no expected-failure (`it.fails`) tests left.

### Browser run

- **Setup:** Chrome 154 (headless, WebGPU), driven through CDP with real input events.
- **Page:** the app dev server with `?bench=1`, on a 1280×800 canvas at DPR 1.
- **View:** the Grand Canyon (36.1°N, 112.14°W), heading 20°, tilt 50°, 6000 m, with USGS Imagery Topo.
- **Settings:** the default anchor choices, with markers on. It ran once with `input.mode` set to trackpad and once with it set to mouse.
- **Landmark:** each run first pinned the point under (320, 576) with Pick point and used it as the landmark, then measured its projection on every frame of each step.

The script, `report.json` and screenshots are in `app/build/nav-anchors-browser/` (gitignored).

## Owner and consumer checks

| Check | Result |
| --- | --- |
| Engine tests (94 files) | 912/912 pass, run through the app's installed toolchain because `engine/node_modules` is empty |
| Engine typecheck, build-config typecheck, lint | Clean. The build-config typecheck also shows a `sessionTrail` error from work outside this change. |
| `npm --prefix engine run check:implementation` | Could not run as written, because `engine/node_modules` is not installed. Its steps were run through the harness above. `test:consumer` was not run. |
| 360 tests | 106/106 pass. Typecheck is clean. |
| `npm --prefix app run check:implementation` | Typecheck, lint, browser assertions (12/12) and build pass. Tests are 175/176. The failure is a HUD bottom-clearance test from separate uncommitted work in `createGlobeApp.ts`. It fails the same with the pin section disabled. |
| `npm --prefix research run check:source` | Fails on two problems in already committed content: a missing `validation/evidence/weather/2026-10-08/source-manifest.json` that `link-routing.json` names, and a stale tool source receipt for `scripts/lib/communityDocuments.mjs`. `test:source` passes 14/14. |
| UMN-VR `tour` (`npm run typecheck`) | Clean |
| 0SFS `fly` | Fails on existing `flightPreset` errors unrelated to navigation |
| 0SFS `ground-contact`, UMN-VR `app` | Not checked: they build against a published or packed engine, not this source |

## Remaining limitations and coverage gaps

These were not exercised and are not claimed as verified:

- **Browsers and devices:**
  - Safari and Firefox were not run.
  - No real trackpad, touch screen, pen or game controller was used.
  - The Safari gesture events and touch pairs are covered only by DOM event tests.
  - Only DPR 1 ran in the browser.
- **Scenes:**
  - The flat map, a loaded 3D building away from the centre, a globe-edge view and the river-to-bluff case were not run.
  - Streamed terrain arriving during motion was not run.
  - Reduced motion was not run.
  - Entry and exit from a campus panorama (lease handback) were not run.
  - The browser used only the default choices, not Compass-centered or mixed pinned choices.
- **Presets in the UI:** the presets were tested as values, not applied through the settings panel in a browser.
- **Glide tolerances:** the numeric reanchor tolerances (1% plus 0.0001 m/s and 0.000001 rad/s) are not asserted. The tests check that the glide is rewritten about the new anchor and continues, not the measured rates.
- **Settings round trips:** export/import, URL overrides and host layers for the new keys rely on the generic registry tests.
- **Platform behaviour:**
  - Babylon 8.56.2's camera clamps tilt in its setters. Anchored moves avoid this by committing the whole pose at once.
  - Where the geodetic vertical cannot keep a look level, an orbit turns about the geocentric up instead. This is at most about 0.19° from the geodetic vertical.
  - Pinned and picked points are copied when acquired, so a point picked on coarse terrain keeps that height after finer terrain loads, as the spec requires.

Minor behaviours noted in review and left as they are:

- The glide is rewritten when only the channel that is not moving changes anchor. This is harmless.
- A sub-threshold velocity residue is older than this work.
- The Safari fallback pointer is not cleared on `pointerleave`, so a gesture that starts without coordinates after the pointer left uses its last place over the canvas.
