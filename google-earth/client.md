# The Earth client and its engine

Part of [Google Earth runtime](README.md). Labels are defined there.

## Two clients

[G] Anderson, January 2023, lists three products he works on: Earth 9.x on web, Android, and iOS; Earth Pro 7.x on Windows, Mac, and Linux; and Earth Studio on the web. Earth has a technical history of nearly two decades. The talk then restricts itself to the previous five years of Earth on the web.

[G] Mears, July 2019, describes the installed desktop client as the original Keyhole application: C++, the Intrinsic Alchemy renderer that had been used for games of that era, and Qt for the UI. That client was still the desktop application at the time of the interview. About six years before the interview the team stopped and rebuilt the engine. The rebuilt engine is C++, and it is the one that ships as Earth on the web, Android, and iOS.

[I] A frame-time anecdote about "Google Earth" has to name which of those two programs, and which year. Earth Pro's renderer and Earth 9's renderer were both living products in 2019, and Anderson still names both in 2023.

## One C++ engine for Earth 9

[G] Anderson's slides: "Google Earth for the Web is built from a C++ engine, shared between Web, Android, and iOS. Basically a video game engine for the planet." The 2017 launch of Earth 9 is the slide that marks that shared renderer. While the opening screen is showing, the page is loading the WebAssembly module and the key assets needed to draw the world.

[G] Mears, in the same 2019 interview, puts 80 to 90 percent of the application logic in C++, with a platform surface of about 10 to 20 percent. The shape is model-view-presenter. The model and the presenter are C++. The view is the platform: the Android SDK, the iOS SDK, and, on the web in 2019, JavaScript with Polymer. The shared C++ is what keeps the renderer from being written once per platform, and the platform view is what lets the UI use that platform's own toolkit.

[G] The web compile target changed under that engine:

| When | What the slides or the case study say |
| --- | --- |
| 2013 | First attempt to run the 3D renderer as asm.js through Emscripten. Anderson quotes a crash from running out of memory, and the slide marks the rate as under 3 frames a second. The 2019 case study says that internal demo was kept and extended for about six years. |
| 2017 | Earth on the web launches on Portable Native Client, Chrome only, multi-threaded. `earth.google.com` is a marketing page with a launch button. |
| 2018 | Brotli on large web application files. The slide's figure is a 7 to 14 percent smaller size across various files. Those are application files. The slide does not apply the percentage to map tiles. |
| 2019 | WebAssembly beta, with a build that has threads and a build that does not. The case study's author tells readers the beta may be less smooth than "regular Earth for web," which at that date is the Native Client build. |
| 2020 | Full switch to WebAssembly. |
| 2021 | `earth.google.com` is the application. The marketing page and the launch button are gone. |

[G] Mears describes the compile target as a thin edge. Native Client, WebAssembly, and the Android NDK are architectures the same C++ is aimed at. For WebAssembly, that edge is written to Emscripten's API. Network calls and input events are translated there into the types the common code already uses. Someone working on Earth, in his account, spends their time on the event and the response, and meets the platform only when they are the person maintaining that edge.

[G] In 2019 the WebAssembly they could ship was produced by compiling to asm.js and then converting. The LLVM backend did not build Earth. He names what that blocked: SIMD, and source-map debugging. The case study says the same thing as a hope: moving to the LLVM backend would enable future SIMD and stronger debugging. SIMD in the Earth web client is a stated wish in 2019. It is [U] as a shipped feature in any later source in this record.

[G] He also names Ion, an open-source Google project, as the layer over OpenGL that let the renderer target Windows, Linux, Mac, Android, iOS, Native Client, and WebAssembly. At the time of the interview they were porting that layer to Metal, because Apple was leaving OpenGL, and he expected the client code above Ion to stay put. The graphics API of `earth.google.com` in 2026 is [U]. Anderson's 2023 "future" slide lists WebGPU as a possible gain in performance and visual fidelity, especially if WebGPU supports threads. That sentence is a look ahead, and it sits beside "increasing support of multi-threaded WebAssembly."

## The draw loop

[G] Mears, on what threading is for: the client is a 3D application with a loop on the main thread whose aim is to draw as many frames as it can, doing as little else as possible. Fetching and decompressing on that thread freezes the view while a 3D model is decoded. The codebase has a job system. A camera flight becomes jobs: request the data, decompress it, prepare it for rendering, on background threads, and deliver it to the main loop when it is ready. The main thread then has to put it on the screen.

[G] He corrects the idea that the main thread never blocks. Some work stays there. What can leave the main thread differs by platform. On some platforms the rendering thread and the application main thread are the same thread, and on some they differ. He declines to assign that split to a named platform.

[G] WebAssembly threads, in his account, are web workers. They can fetch, store, and compute. They cannot touch the DOM, and they cannot write the graphics context. He says a JavaScript engine would reach for workers for the same jobs, and that he has no measurement of a full Earth engine written in JavaScript.

[G] The May 2019 Medium post states the same split in one sentence: fetching and decompressing on background threads lets the main rendering loop run faster. The test behind the graphs is in [numbers](measurements.md). The case study adds the browser constraint. Multi-threaded WebAssembly needed `SharedArrayBuffer`. After Spectre and Meltdown, Chrome re-enabled it on desktop once Site Isolation confined each renderer process to a single site, and Earth used threads there. Other browsers, in that beta, ran Earth on one thread. Firefox had dynamic memory growth and no threads. Chrome's threaded build lacked dynamic memory growth, and the case study says Earth may fail to start on machines with little memory, including 32-bit machines.

[G] The January 2023 future slide still says "increasing support of multi-threaded WebAssembly" and "nearly universal support for single-threaded WebAssembly." Wider thread coverage was unfinished business at that date. COOP, COEP, and credentialless isolation appear on the same slide, under content and web security, as developments that could affect Earth. The 2019 mechanism Google names for Chrome's threads is Site Isolation. Which isolation mode the 2026 site uses is [U].

[I] The result we can copy without a new measurement is the job split: decode and prepare off the thread that submits the frame, and keep the draw submission small. The result we cannot copy from these pages is a 2026 thread count, a SIMD speedup, or a COOP/COEP configuration for `earth.google.com`.

## What the client asks the network for

[G] Mears, on the client-server relationship for imagery, 3D, and map data: as the camera moves, the client looks at what the camera can see and where it is flying. It both sends and cancels requests from that. A percentage spinner at the bottom right is how resolved the scene is, meaning the data has arrived, been decompressed, been processed, and been drawn.

[G] The store behind that is precomputed. He believes the tiles sit on disk, and that the on-the-fly work is format conversion, because a phone, the web app, and the desktop app can hold a tile in different formats. He does not work on the serving pipeline, and he marks that sentence as his understanding. Historical imagery back to the early twentieth century, in some places, was a desktop feature in 2019 and was absent from the web app then.

[G] The structure he names for that store is a quadtree: a pyramid subdivided by four at each step, so a view from far away is a few coarse tiles and a view on the ground is a small area at a fine level. The camera keeps an altitude, the altitude maps to a numerical zoom level, and that level is the set of tiles requested. His aside "16 becomes 32" does not follow from subdivision by four. The definition he gives is the subdivision. The arithmetic in the aside is discarded.

[G] Transport: ordinary HTTP, no socket, for the traffic he is describing. Protocol buffers for metadata, search, and other content. The imagery bytes are a separate native compression, decompressed on the client. Asked for the name, he says he thinks it is DXT, then "Don't quote me on that," then that he does not work on that code and is unsure. DXT is [G] only as a hedged guess from the client tech lead in 2019.

[I] Two behaviours follow directly, and one does not. The client can show a coarse level first because that level already exists, and it can drop in-flight requests when the camera turns away. A policy that lowers the resolution of a view for the duration of a gesture, and restores it after the camera rests, is a further policy. No sentence in these sources states that further policy.

[U] The screen-space-error function, fog culling, horizon culling, the cache's byte budget, and whether the draw loop sleeps when the camera is still. Cesium publishes those for Cesium. They are not in the Google sources gathered here. Watching the product is a suspicion until W0 records it.

## Labels

[G] Anderson, 2021 slide: labeling performance was improved by a direct canvas-to-texture copy, in place of readback plus upload. Across a large sample of Earth Web sessions, on the multi-threaded build, the slide reports +2 fps on average and a 15 percent reduction in 60 fps jank.

[R] Shehata's notes of that talk fill in the path. Text is drawn with the browser's own text, into a canvas, because carrying a font engine inside the WebAssembly module was judged too large. The earlier path read the canvas back to bytes, passed the bytes into the module, and uploaded a WebGL texture. The later path copies the canvas into a WebGL texture and gives the module a reference to that texture.

[I] The published, measured gain on the draw path is this copy. It is two frames a second and a jank percentage on their session sample, on the threaded build. It is a label-upload cost. It is silent on terrain, meshes, and shading.

## Startup, in their words

[G] Mears, 2019, Native Client era: the progress bar covers download of the Native Client binary and its translation into the runtime. The bar freezes about two thirds of the way, which is process startup, a stretch they could not instrument, and then disappears. He calls the web binary unusually large, and names threads and memory that have to be reserved before the first interaction. He says they record frame rate, dropped frames, and which graphics chips behave worst, and that a machine from that decade was enough for most people, with a bad time on low-end hardware. No RAM floor and no GPU allow-list are stated.

[G] Anderson, 2023: the opening screen is the WASM download and the first assets. The 2013 asm.js attempt is the only startup rate they print, and it is under 3 fps before it runs out of memory.

[U] Cold and warm time to a complete view, byte counts, and heap size, for any Earth build we can put next to FOSS Earth. That is the empty half of the W0 table.
