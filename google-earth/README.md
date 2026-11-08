# Google Earth runtime

Research date: 2026-11-07. Owner: FOSS Earth.

This is the record of how the Google Earth web client gets its runtime performance, and of which neighbouring Google products that explanation must stay separate from. It is research. It is the source the [optimization backlog](https://github.com/foss-earth/docs/blob/main/docs/optimization-backlog.md#why-google-earth-is-still-faster) and the [WebAssembly plan](https://github.com/foss-earth/docs/blob/main/docs/proposals/webassembly.md#where-google-earths-lead-comes-from) point at.

Pages, posts, and the Khronos slide text were read on 4 and 7 November 2026. No request was sent to `kh.google.com`, `earth.google.com`, or `tile.googleapis.com` for this note. The live comparison harness has no qualified baseline.

Labels:

- **[G]** A Google page, post, or slide deck.
- **[R]** A third-party description of a client. Google did not publish it.
- **[O]** A dated observation already written in this organization's repositories.
- **[I]** A conclusion drawn from the labeled items in this record.
- **[U]** Looked for in those sources, and absent.

## Read this first

[G] The program people mean by the fast Google Earth in a browser is Earth 9 on the web, at `earth.google.com`. John Anderson's January 2023 Khronos slides describe it as one C++ engine shared with Earth 9 on Android and iOS, compiled to WebAssembly, loading that module and the assets for the first draw while the opening screen is up.

[G] [O] The meshes FOSS Earth draws when Google 3D Tiles is the basemap are [Photorealistic 3D Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles) from the Map Tiles API. A sample of those files on 16 October 2026 is glTF, with JPEG images and no Draco. That sample is a different delivery from the Earth client's own nodes. A technique documented for one is evidence about the other only after someone samples the other.

[I] The speed we have a published account of comes from the client, in this order:

1. The draw loop's job is to draw. Fetching, decompressing, and preparing data are background jobs when the browser gives that WebAssembly build threads.
2. The world is stored already split into resolutions. Camera altitude selects a level. The client requests what the camera can see and where it is flying, and cancels the rest. Imagery, 3D geometry, and map vectors (lines and labels) are separate streams.
3. Metadata travels as protocol buffers. The imagery and mesh bytes use a native compressed form, and that form can differ between the phone, the web app, and the desktop app.
4. Labels are rasterized by the browser and handed to WebGL by a canvas-to-texture copy.
5. The renderer, the model, and the presenter are one C++ codebase. The web UI is a thin platform layer.

The chapters are [the client and the engine](client.md), [what it streams](data.md), and [numbers](measurements.md).

## What a later change may copy

These are the published mechanisms that already have a counterpart in our backlog. Each one still has to earn its place on a qualified [W0](https://github.com/foss-earth/research/blob/main/benchmarks/earth-compare/README.md) run.

| Published mechanism | Our item | Limit on the copying |
| --- | --- | --- |
| Background fetch, decompress, and prepare, with the draw loop left to draw | R3, C1, C3, T13, C7 | Thread coverage was incomplete in the 2019 beta and was still listed as increasing in January 2023. The 2026 site's isolation mode is [U]. |
| Packed meshes, and textures that can remain block-compressed on the GPU, in the client format a third party read | B3, T7, X6 | The tiles we sampled are JPEG inside glTF. B3 and T7 act on those files. They do not reproduce an Earth client node. |
| One engine owning selection, cache, and draw | T2, T6, R1, B7 | The shared C++ engine is [G]. A single traversal is [I]. |
| Request the level the camera's altitude calls for, and cancel work outside the view and the flight path | T1, T3, T5, P5 | Altitude-to-level and cancel-on-the-way are [G]. A temporary drop of the whole view's resolution while the camera moves is [U]. |
| Idle frames | C6, render on demand | Whether Earth stops issuing frames when the camera is still is [U]. Our idle audit can still measure us. |

## Products kept apart

| Name | What it is | In this record |
| --- | --- | --- |
| Earth 9, web | `earth.google.com`. C++ engine, WebAssembly since 2020. | The runtime under study. |
| Earth 9, Android and iOS | The same engine, compiled natively. | Same selection and prepare code, a different graphics API and, per the 2019 interview, a tile encoding that can differ. |
| Earth Pro 7.x | Desktop client on Windows, Mac, and Linux. | Anderson still names it in 2023. Mears in 2019 described its lineage as the older Keyhole renderer. Its frame time is a separate question. |
| Earth Studio | A web product Anderson also ships. | Named. Its internals are absent here. |
| Photorealistic 3D Tiles | Map Tiles API. glTF tiles, billed per root session. | What our renderer loads. Billing is [How Google bills Photorealistic 3D Tiles](../3D_tiles/google-side-billing.md). |
| Immersive Maps | Maps 3D SDK and the JavaScript 3D map. | A different SKU. See the billing note. |
| Google Earth Engine | Analysis and tile export. | Anderson's slides say a 2018 export path into Earth. Engine is not the globe client. |

## Sources

Read for this note:

- Jordon Mears, [How we're bringing Google Earth to the web](https://web.dev/case-studies/earth-webassembly), web.dev. The page itself has no dateline. It describes the WebAssembly beta that the [Chromium blog](https://blog.chromium.org/2019/06/webassembly-brings-google-earth-to-more.html) announced in June 2019.
- Jordon Mears, [Performance of WebAssembly: a thread on threading](https://medium.com/google-earth/performance-of-web-assembly-a-thread-on-threading-54f62fd50cf7), Google Earth on Medium, 22 May 2019.
- Jordon Mears, interview, Software Engineering Daily episode 864, transcript PDF dated July 2019: [SED864-Google-Earth-WebAssembly.pdf](https://softwareengineeringdaily.com/wp-content/uploads/2019/07/SED864-Google-Earth-WebAssembly.pdf).
- John C. Anderson, [A technical journey through 5 years of Google Earth on the Web](https://www.khronos.org/assets/uploads/developers/presentations/A_technical_journey_through_5_years_of_Google_Earth_on_the_Web.pdf), Khronos WebGL + WebGPU meetup, 31 January 2023. Text taken from the PDF on 7 November 2026.
- Omar Shehata, [WebGL / WebGPU Jan 2023 meetup highlights](https://omar-shehata.medium.com/webgl-webgpu-jan-2023-meetup-highlights-d29f9e0d0bdc), 1 February 2023. A report of Anderson's talk. Numbers below are taken from the slides, and the canvas steps from this report.
- [earth-reverse-engineering](https://github.com/retroplasma/earth-reverse-engineering) README, read 4 November 2026. Undated captures. We did not repeat them.
- Our format survey, 16 October 2026, written up in [WebAssembly builds, step 7](https://github.com/foss-earth/docs/blob/main/docs/proposals/webassembly.md#7-google-tiles-off-the-main-thread).
- Our coarse-tile observation, 20 October 2026, in the [performance audit](https://github.com/foss-earth/docs/blob/main/docs/performance-audit.md).
- W0 status, in [Earth comparison](../benchmarks/earth-compare/README.md).

A YouTube auto-caption of Mears's history talk was opened and then set aside. The caption text mangles figures, so this record takes dates and architecture from the slides and the SED transcript.
