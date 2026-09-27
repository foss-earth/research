# Panorama input check, 2026-09-27

The changes after the first user trial of [panorama scenes](../../../../docs/proposals/panorama-scenes.md),
checked with real mouse, wheel and key events from headless Chrome, through the
app's own listeners, on this machine's GPU. [`summary.md`](summary.md) is the
run's own summary, and [`report.json`](report.json) holds every number.

**Result: passed.**

## Configuration

- **Code:** FOSS Earth commit `98e2274`, with no uncommitted files.
- **Browser and GPU:** Chrome 153.0.8010.53, headless, WebGPU, on an Apple M5
  (metal-3 architecture, not a fallback adapter).
- **View:** 1440×900 at DPR 1, input mode Trackpad.
- **Scene:** `campus-pair`, the two linked panoramas. Its `markerStyle` gives
  every orb a 2 px white outline and 1.25 times growth under the pointer; the
  grid orb's own style overrides the outline with a 3 px yellow one.
- **Map:** the default keyless sources, fetched live, with requests carrying
  `foss-earth-check/1.0` and nothing about the person running it.

## Results

| Check | Result |
| --- | --- |
| Outline, against each orb's projected silhouette | the ring's whole pixels are the style's colour: 45 of 45 white, 147 of 147 yellow; none past the ring; none of the same ring without the style |
| Hover | the orb under the pointer grew from 2.775 m to 3.469 m, 1.25 times, with a pointer cursor; it shrank back when the pointer left |
| Click to enter | entered |
| The bar while entered | the map's detail rail and basemap chip hidden; the credit ends 16 px from the right edge, with the close button, "Exit panorama", left of it on its row |
| Mouse drag | the view turned with every move while the button was held, 3° per 20 px move, and did not turn when the pointer moved after the release |
| Trackpad mode | a swipe right and down looked right 9° and down 6°, without zooming; a pinch out narrowed the view from 60° to 50.6° |
| Mouse mode | a wheel notch zoomed from 50.6° to 46.3°, without turning |
| Arrow key | held for 504 ms, it turned the view 44.0° at 90°/s, and stopped when released |
| Close button | back to the overview, with the map's group restored |

Before these changes the drag failed at its first move: the view stayed still
until the release, then followed the pointer. A unit test,
`src/input/createInputController.test.ts`, reproduces that on the old code. A held
arrow key turned the view 0°.

## Files

- `report.json`, `summary.md`: the run's report and summary.
- `screenshots/overview-styled.png`: both orbs with their outlines.
- `screenshots/overview-hovered.png`: the photograph's orb grown under the pointer.
- `screenshots/immersive-hud.png`: inside the panorama, with the close button and
  credit at the bottom right.

## Running it again

From the FOSS Earth root, with Chrome installed and the network available:

```sh
node scripts/validation/panorama-input.mjs
```

It builds the app, serves the build to headless Chrome through request
interception with no server, and takes about a minute. It writes to
`build/validation/panorama-input/<local time>/`.

## Not covered

Real trackpad hardware: Chrome received the wheel events a trackpad sends, not
events from a trackpad. Momentum after the fingers lift comes from the operating
system and was not exercised. Safari's gesture events, touch, and gamepad look
are covered by unit tests only.
