# Sky shaders drawn by a software renderer, 2026-10-07

`report.json` is one run of `node scripts/validation/sky-render.mjs --software` at
the sources its `sources` field hashes: Chrome 154, headless, drawing with its own
software renderer (SwiftShader) through WebGL 2, WebGL 1 and WebGPU. No GPU, no
network and no server. What each check is of:
[docs/proposals/sky.md](../../../../docs/proposals/sky.md#drawn-pixels).

**This is not a GPU run.** `software` is `true` in the report. A software renderer
runs the same GLSL and WGSL and gives the pixels to compare with the model; it
says nothing of a GPU's drivers, precision or limits, and nothing here was judged
by eye. The same script without `--software` runs the checks on the machine's GPU
and refuses a software renderer; that has not been run.

Each of the three backends ran the same 33 checks and passed them all. A check
records the bytes the model expects, the bytes drawn and the tolerance.

The pictures are the WebGL 2 backend's, 512 × 384, one per case; the other two
backends' differ from them by no more than the checks' tolerances.

| Picture | Shows |
| --- | --- |
| `webgl2-afternoon.png` | Level ground under a high Sun: a 2D tile's material on the left, an unlit glTF material on the right, the same grey |
| `webgl2-dusk.png` | The Sun 2° down with a quarter Moon up |
| `webgl2-full-moon-night.png` | The ground under a full Moon 62° up |
| `webgl2-moonless-night.png` | The ground under the night sky alone |
| `webgl2-full-moon-night-with-a-beam-on-the-2d-tile.png` | A 1,000 cd beam from 30 m above the left tile |
| `webgl2-afternoon-as-at-the-viewpoint.png` | One factor for all imagery |
| `webgl2-afternoon-as-photographed.png`, `webgl2-sky-off.png` | The imagery at its own brightness |
| `webgl2-planet-afternoon-over-minneapolis.png` | The planet from 20,000 km, one grey all over, lit by each point's own Sun: day, the terminator and night |
| `webgl2-full-moon.png` | The full Moon's disc and the sky it lights |
| `webgl2-stars.png` | A bright star on a moonless night |
| `webgl2-stars-from-400-km-by-day.png` | The stars from 400 km up in the afternoon, at their own exposure, with the scene's still set for sunlight |
| `webgl2-light-point-at-night.png` | A 40 cd red lamp 20 m away, at night |

The ground in these pictures is a flat grey patch, and the planet a grey sphere:
no map tile was loaded. The dome is sampled at 16 rows by 12 columns, coarser than
the app's default, so its bands show.
