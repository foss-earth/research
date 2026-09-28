# Work prompt: the orbit pivot keeps a stale height, and zoom toward the pointer

Execute this task when the user starts a fresh conversation with this file.
Work in `/Users/felg/gh/foss-earth`. Read the current `AGENTS.md`,
[docs/ui-layout.md](ui-layout.md) and [docs/proposals/settings.md](proposals/settings.md)
first.

There are two parts: a bug to fix first, then a feature that touches the same code.

## Bug: after a pan, orbiting can take the camera underground

The user's report, while testing the UMN campus tour beside the Mississippi:

> if i center the camera on the missisipi (which is low) then move the camera (lat/lon) so it
> is centered on the higher terrain on the side of the missiipi (by umn, that is where im doing
> this testing) which is higher AND i do NOT change the zoom level, but then try to orbit
> (change p or h) im able to bring the camera underground, however as soon as i zoom in/out the
> camera height changes, and that makes it so the camera does not go underground
>
> what i think happens is that the 'height' we are orbiting from is only updated when i zoom
> in/out

The code agrees with them. In [src/camera/cameraState.ts](../src/camera/cameraState.ts), as of
commit `b9a8db6`:

- `panBy` and the anchor pan's `applyViewState` call pass `getCurrentCenterHeightMeters()` as
  the target height. The pivot keeps the height it had, wherever the centre moves.
- `orbitBy` does the same.
- `zoomBy` goes through `setViewState`, which calls `applyViewState` with no override, so only
  a zoom runs `resolveOrbitTargetHeightMeters` and samples the surface under the centre.

A pan from the river to the bluff therefore leaves the pivot at river height, under the bluff's
surface, and orbiting swings the camera through the ground until the next zoom.

What to do:

1. **Reproduce it in a unit test** in `src/camera/cameraState.test.ts`: a height resolver
   with a step in it, a pan across the step, then an orbit. Before changing anything, the test
   should fail on the current code.
2. **Find out why the pan and orbit keep the old height.** Use `git log -S
   getCurrentCenterHeightMeters`. It may have been deliberate, for example to keep the grabbed
   point under the cursor during an anchor pan ([src/camera/anchorPan.ts](../src/camera/anchorPan.ts)),
   or to stop the pivot jumping mid-drag. Fix it in a way that keeps whatever that protected.
   One option is resolving the height once the pan ends, through the existing smoothing in
   `smoothSurfaceHeightMeters`.
3. **Check what keeps the camera above ground after a zoom,** since the user sees it stop going
   under then. Confirm that the same thing now holds after a pan. If nothing keeps the camera
   itself above the terrain between it and the pivot, say so in your report rather than
   quietly widening the task.

## Feature: zoom toward the pointer

The user's words:

> the center of zoom is always locked to the center of the compass, which i asked for, but now
> find anoying, do not get me wrong there should be a setting to make the center of zoom in/out
> be how it works now, but also we should have the option to zoom into wherever the mouse is
> at, like on google earth, for touch gesture zoom it would probably be the center of the
> gesture

- **Add a setting for where zoom goes:** toward the view's centre (today's behaviour), or toward
  the ground under the pointer. For a pinch, that is the ground under the gesture's centre.
  - Keyboard and gamepad zoom have no pointer, so they keep zooming toward the centre.
  - The setting's home is the tab and section where the mouse and touch settings already live;
    see `src/settings/catalogue/controls.ts` and `src/input/orbitInvertSettings.ts`.
- **Ask the user which choice is the default.** Their words suggest the pointer, but they didn't
  say.
- **How to implement it:** after `zoomBy`, keep the picked ground point under the pointer, the
  way the anchor pan keeps a grabbed point under the cursor. The centre moves, so the pivot
  height must be resolved again. This is the bug above, so fix that first.
- **Inputs:** the mouse wheel is in `src/input/mouseController.ts`, and the pinch in
  `src/input/touchController.ts`.

## Checks and report

- **Checks:** after each edit, `npx tsc -b`, `npx vitest related --run <changed files>` and
  `npm run lint`. Then run `npm run ci` once at the end.
- **Other repositories:** 0SFS (`../0sfs`) and the tour (`../UMN-VR/UMN-VR.github.io`) consume
  this camera. Run `npx tsc -b` in each afterwards.
- **Servers:** don't start one. Give the user the steps to try it: `npm run dev` here, then
  their river-to-bluff pan, and a wheel zoom and a pinch with each setting.
- **Commit:** commit to `main` and push.
