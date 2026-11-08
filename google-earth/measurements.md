# Numbers

Part of [Google Earth runtime](README.md). Labels are defined there.

A figure appears here only with the population it was taken on. A graph whose axes were not printed is described, and the missing values stay missing.

## Figures Google has published

| Figure | Population | Date of the statement | Source |
| --- | --- | --- | --- |
| Under 3 frames a second, then an out-of-memory crash | The 2013 asm.js experiment | Slide, January 2023, about 2013 | Anderson |
| 7 to 14 percent smaller | Large web application files after brotli, "various files" | Slide about 2018 | Anderson |
| Higher average frame rate, and fewer dropped frames, with threads | A stripped-down Earth that flew a scripted path. Chrome 72.0.3602.2 dev, 64-bit, on Linux 4.17, an Intel Core i7-6600U at 2.6 GHz with two cores, 15.6 GiB of memory, and Intel HD Graphics 520. Repeated runs, the first few of each kind discarded so the network cache was warm, the rest averaged. Presented in some form at Chrome Dev Summit 2018. | Post, 22 May 2019 | Mears, Medium |
| The axis values of those two graphs | The same test | The post embeds the charts and does not print the scale | [U] as a number |
| Clear improvement from doing streaming and decompression on a background thread | Earth in the browser, stated qualitatively | The 2019 WebAssembly beta write-up | Mears, web.dev |
| +2 fps on average, and a 15 percent reduction in 60 fps jank | A large sample of Earth Web sessions, multi-threaded build, for the change from label readback-and-upload to a direct canvas-to-texture copy | Slide about 2021, shown January 2023 | Anderson |

[I] The +2 fps line is the label-upload change. The Medium graphs are the thread change, on one laptop class of 2019, on a build that only flies a route. The two results answer different questions. Adding them, or treating either as the gap between Earth and FOSS Earth, invents a third result.

[G] The case study also states failures of the 2019 beta that are performance facts of a negative kind: the threaded Chrome build could fail to start when memory could not grow, including on 32-bit machines; Firefox ran single-threaded; Safari did not run the beta because WebGL2 support was incomplete, and some shaders required GLSL 1.2, in the case study's words.

## Figures we have

| Figure | What was measured | Date | Where it is written |
| --- | --- | --- | --- |
| glb profile: unlit glTF, JPEG, float32 positions and UVs, no Draco, no normals, one or two primitives, gzip, private cache for 14400 seconds | Live Photorealistic 3D Tiles from `tile.googleapis.com` | 16 October 2026 | [WebAssembly plan, step 7](https://github.com/foss-earth/docs/blob/main/docs/proposals/webassembly.md#7-google-tiles-off-the-main-thread) |
| One depth-3 tile, geometric error 263 km, mesh 6.5 to 6.8 km above a Minneapolis camera; eye height 276 m rising to 435 m in 14 pushes | Our renderer, walking that tileset, before engine `5d1b132` | 20 October 2026 | [Performance audit](https://github.com/foss-earth/docs/blob/main/docs/performance-audit.md) |
| W0 table, every view, both power states | Signed-out Google Earth against published and local FOSS Earth | The harness exists. The table is pending. | [Earth comparison](../benchmarks/earth-compare/README.md) |

[O] The globe comparison of 23 September 2026 flew FOSS Earth, CesiumJS, MapLibre, and WorldWind. It did not open Google Earth. The run is discarded in any case, because the machine was busy. It supplies no ranking that belongs in this note.

[O] W0's method, once a review qualifies a capture, is three alternating repeats, headed Chrome, 1280×720 CSS pixels at the screen's pixel ratio, a fresh profile for each cold run. It records time to a visually stable frame, bytes, display-presentation intervals, main-thread task time, CPU and resident memory per process, and, on battery, watts over an idle baseline. Google Earth is only watched. Nothing of it is intercepted, cached, replayed, or committed. Until those reviews exist, every raw capture stays `qualified: false`.

## Figures this record refuses

[U] Each of these has been said, in our older notes or in passing, and has no measurement and no Google sentence behind it:

- Earth web's frame time, power, memory, or downloaded bytes on any view we fly.
- Earth's thread count, SIMD use, or graphics API on the public site in 2026.
- A motion policy that coarsens the whole view for the duration of a pan and restores it at rest.
- A confirmation that the draw loop issues no frames while the camera and the tiles are idle.
- A GPU-memory ratio between an Earth client node and one of our glTF tiles, on the same view.
- The quadtree's tile count. Mears said he did not know the math, and offered "millions if not billions" at ground level and "maybe only 4, or 16" from space as magnitudes, not as a count.

[I] The honest comparison, when W0 is qualified, is a paired median and a range per view, with the mask, the field of view, and the loaded detail written beside the times. A faster clock on a coarser model is a different result, and the harness already says matching the camera leaves the two providers' tiles unequal.
