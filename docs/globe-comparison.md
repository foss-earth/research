# Globe comparison

How FOSS Earth compares with the other open-source browser globes when each flies the same camera path.

> **Discarded run.** The only flight so far ran while the machine was busy with other work. The numbers below show what the comparison measures. They do not rank the globes, so do not cite them. The repeatable procedure and the first optimization pass are in [Performance pass](performance-pass.md).

## Results

| Implementation | Renderer | Terrain | Imagery | fps | Main thread, median | Main thread, p95 | Frames over 33 ms |
|---|---|---|---|---:|---:|---:|---:|
| FOSS Earth | WebGPU | Mapterhorn terrarium mesh | USGS Imagery | 59 | 2.0 ms | 4.6 ms | 2 |
| FOSS Earth | WebGL2 | Mapterhorn terrarium mesh | USGS Imagery | 60 | 1.2 ms | 4.5 ms | 0 |
| [CesiumJS](https://github.com/CesiumGS/cesium) 1.131 | WebGL | Re:Earth quantized-mesh | Esri World Imagery | 58 | 2.1 ms | 3.1 ms | 2 |
| [MapLibre GL JS](https://maplibre.org/projects/gl-js/) 5.6 | WebGL | Mapterhorn raster-dem | Esri World Imagery | 60 | 1.7 ms | 2.4 ms | 0 |
| [WorldWindJS](https://github.com/WorldWindEarth/worldwindjs) 1.9 | WebGL | Default elevation model | Blue Marble / Landsat | 57 | 5.0 ms | 12.1 ms | 4 |

Raw numbers: [`benchmarks/globe-compare/results.json`](../benchmarks/globe-compare/results.json).

## Setup

- **Date and machine:** 23 September 2026, Apple M5 with 8 GPU cores, macOS.
- **Browser:** headless Google Chrome. It reported `ANGLE Metal Renderer: Apple M5`, so the run used the real GPU, not a software renderer.
- **Viewport:** 1280 × 720.
- **Flight:** over the Grand Canyon (36.1° N, 112.14° W) at about 1200 m and 55° pitch. The camera turns a full 360° and drifts 0.08° east over 8 seconds, after 6 seconds of warmup.
- **Script:** [`benchmarks/globe-compare/run.mjs`](../benchmarks/globe-compare/run.mjs). The competitor pages it loads are in [`benchmarks/globe-compare/pages/`](../benchmarks/globe-compare/pages/).

## Reading the numbers

- **The meshes differ.** Cesium draws quantized-mesh tiles. MapLibre drapes a raster DEM. FOSS Earth builds a mesh from terrarium tiles. WorldWind draws a coarser globe. A cheaper frame on a lighter mesh is not a win.
- **60 fps is the ceiling.** The display refresh caps the frame rate, so a globe at 60 fps kept up with the flight. The frame rate does not show how much time it had to spare. The main-thread times show that.
- **On this machine the three modern renderers all finished inside the frame.** WebGL2 was slightly cheaper than WebGPU for this particular flight.
- **WorldWind was the only one that looked slow**, even in this invalid run. It does more of each frame's work on the CPU.

## Not yet measured

[Giro3D](https://giro3d.org/) and [iTowns](https://www.itowns-project.org/) are the other WebGL geospatial globes in this category. Neither was in this flight.

## Measuring again

Use an idle machine and close other GPU apps. The script opens a visible Chrome window unless you pass `--headless`, so you can watch the flight.

```sh
npm run dev -- --host 127.0.0.1 --port 4174
node benchmarks/globe-compare/run.mjs --runs=3 http://127.0.0.1:4174
```

A single run is not a result. Make at least three idle runs and compare their spread before you treat a difference as real. [Performance pass](performance-pass.md#how-to-measure-again) has the full procedure.
