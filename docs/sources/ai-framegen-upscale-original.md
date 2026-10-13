# Integrating FidelityFX Super Resolution and WebGPU Rendering Pipelines in the 0SFS Babylon.js Architecture

**Executive Summary**
*   **Spatial Upscaling is Natively Supported:** Babylon.js natively supports AMD's FidelityFX Super Resolution 1.0 (FSR 1) through the `FSR1RenderingPipeline`, allowing for immediate spatial upscaling in the browser using WebGPU or WebGL2. 
*   **True Frame Generation is API-Restricted:** Implementing "Lossless Scaling-like" or FSR 3 frame generation (synthesizing and injecting intermediate frames) is currently unfeasible in standard browser environments. WebGPU lacks the necessary low-level access to swapchain-level frame pacing required to present generated frames asynchronously without stutter.
*   **Dynamic Implementation is Required for 0SFS:** Because the `0SFS` flight simulator dynamically creates and destroys cameras (e.g., geospatial, cockpit, third-person), the FSR pipeline must be attached programmatically using Babylon.js's `onNewCameraAddedObservable` rather than a static camera array.
*   **Abstracted Engine Lifecycle:** The `0SFS` architecture abstracts engine initialization through the `@foss-earth/runtime` wrapper. Intercepting the rendering pipeline must occur at the specific promise resolution phase within the `src/flight/createFlightSimApp.ts` entry point.
*   **Frontend UI Integration:** To expose this feature to users, the injected pipeline must be linked to the simulation's React-based user interface, specifically through the multi-tabbed `src/flight/hud/FlightControlPanel.tsx` component.

The pursuit of high-fidelity graphics within browser-based environments represents one of the most complex frontiers in contemporary computer science. With the advent of the `0SFS` open-source flight simulator—a sophisticated application merging JSBSim (an open-source flight dynamics engine often compiled to WebAssembly for web use) [cite: 1, 2] physics with Babylon.js rendering and high-resolution geospatial data—the demand on graphical processing units (GPUs) is immense [cite: 3]. Specifically, web applications must fit into strict hardware limits; for instance, a single uncompressed 4096x4096 texture consumes 64MB of VRAM, meaning that on budget mobile devices with only 2GB of shared memory, loading as few as ten high-resolution textures or pushing 100 to 300 draw calls (compared to a desktop browser's budget of 500 to 1000) can completely crash the WebGL/WebGPU context or severely throttle performance [cite: 4]. 

To mitigate performance bottlenecks, modern rendering paradigms rely heavily on upscaling algorithms and frame generation technologies. While the user's premise regarding the underlying framework is correct—`0SFS` operates on Babylon.js—the implementation of advanced algorithms like AMD's FidelityFX Super Resolution (FSR) and frame generation requires a highly nuanced understanding of both the Babylon.js API and the stringent security and architectural constraints of the WebGPU standard [cite: 5]. This report provides an exhaustive, academic analysis of implementing FSR and exploring the theoretical boundaries of frame generation within the specific architectural constraints of the `0SFS` repository.

## Theoretical Framework: Upscaling and Frame Generation in the Browser

To successfully integrate performance-enhancing rendering technologies into a WebGPU-driven Babylon.js application, one must first decouple the underlying methodologies of upscaling from true frame generation. These terms are frequently conflated in consumer-facing discourse, yet they operate on entirely different computational and architectural paradigms, especially within the sandboxed environment of a web browser.

### The Evolution of FidelityFX Super Resolution (FSR)

AMD's FidelityFX Super Resolution is an open-source suite of image upscaling algorithms designed to boost frame rates by rendering scenes at a lower internal resolution and applying advanced mathematical transformations to output a higher-resolution image [cite: 6, 7]. Rendering at 0.5x resolution typically yields a 40-60% FPS increase depending on fragment shader complexity, making it an invaluable tool for browser environments [cite: 8].

The evolution of FSR dictates its viability within WebGPU:

1.  **FSR 1.0 (Spatial Upscaling):** FSR 1 relies strictly on spatial data—meaning it evaluates only the current frame. It utilizes a two-pass algorithm. The first pass is Edge-Adaptive Spatial Upsampling (EASU), which analyzes gradients and edges within the low-resolution image to perform high-quality interpolation without the ringing artifacts typical of standard Lanczos filters (a traditional mathematical formula used to smoothly interpolate pixels during image scaling) [cite: 9]. The second pass is Robust Contrast-Adaptive Sharpening (RCAS), which restores high-frequency detail lost during the upsampling process [cite: 9]. Because FSR 1 requires no historical frame data, no motion vectors, and no complex temporal accumulation buffers, it is perfectly suited for immediate implementation in web environments.
2.  **FSR 2.0 (Temporal Upscaling):** FSR 2 transitions from a spatial to a temporal algorithm. It requires the engine to provide motion vectors, depth buffers, and a history of previous frames to reconstruct a high-resolution image, substituting the engine's native Temporal Anti-Aliasing (TAA) [cite: 9]. While more computationally expensive, it provides vastly superior image quality. Implementing this in the browser requires extensive modifications to the engine's rendering pipeline to expose and preserve these buffers.
3.  **FSR 3.0 (Frame Generation):** FSR 3 introduces Optical Flow (a computer vision technique that calculates the motion of pixels between two consecutive frames) and frame interpolation. It analyzes consecutive rendered frames, generates an intermediate "synthetic" frame, and injects it into the render queue, effectively doubling the perceived frame rate [cite: 10, 11].

### The Swapchain Barrier: Why "Lossless Scaling" Fails in the Browser

The user specifically queries the possibility of running "lossless scaling-like frame gen" alongside upscaling. While spatial and temporal upscaling (FSR 1 and FSR 2 concepts) are viable in WebGPU, true frame generation is fundamentally restricted by the architecture of web browsers [cite: 12].

To understand this limitation, we must examine the concept of frame pacing and the swapchain. In native desktop applications (using DirectX 12 or Vulkan), the graphics engine has direct control over the swapchain—the queue of frames waiting to be displayed on the monitor [cite: 10, 11]. When FSR 3 or Nvidia's DLSS 3 generates a synthetic frame, it relies on an asynchronous compute queue to slip this frame into the presentation swapchain precisely halfway between the display times of two real frames [cite: 10, 11]. 

Browsers utilizing WebGPU or WebGL do not expose swapchain-level frame pacing to JavaScript or WebAssembly [cite: 12]. Web rendering is fundamentally tied to the `requestAnimationFrame` (rAF) loop, which syncs the execution of JavaScript to the browser's own internal compositing schedule (typically matching the monitor's refresh rate, resulting in a strict frame budget of 16.67ms per frame at 60Hz) [cite: 13, 14]. If a WebGPU compute shader successfully synthesizes an intermediate frame, the browser lacks the API to present that frame independently of the main `requestAnimationFrame` cadence. The engine cannot say, "Display frame A now, display synthetic frame B in 8.3 milliseconds, and display frame C in 16.6 milliseconds." The browser forces all presentation through its unified compositing pipeline.

Because browsers do not expose swapchain pacing, real-time frame generation natively within a Babylon.js application is virtually impossible without external browser modifications [cite: 12]. Consequently, any attempt at pseudo-frame generation—rendering at 30 FPS and manually injecting synthetic frames to hit a 60 FPS `requestAnimationFrame` loop—introduces intolerable input latency. Benchmark data reveals that achieving a 120 FPS output natively yields high responsiveness at just 24ms of latency; conversely, achieving that same 120 FPS output using frame generation (while the game natively renders at 60 FPS) more than doubles the latency to a sluggish 48ms [cite: 15]. Therefore, for the `0SFS` project, development must focus strictly on spatial upscaling (FSR 1), which provides the closest viable alternative to achieving massive performance gains without relying on unavailable presentation APIs.



## The Babylon.js WebGPU Architecture

Babylon.js is engineered with a profound abstraction layer designed to future-proof applications against shifting web standards. Understanding this architecture is critical for integrating advanced rendering pipelines like FSR.

### The Engine Abstraction

Babylon.js does not force the developer to write raw WebGL or WebGPU calls. Instead, it utilizes an overarching `Engine` class that extends to specialized implementations: `WebGPUEngine` and `Engine` (for WebGL) [cite: 16]. The transition to WebGPU in Babylon.js 5.0 introduced asynchronous engine initialization (`await engine.initAsync()`) and a translation layer that converts standard GLSL shaders into SpirV (an intermediate language for representing graphical shaders and compute kernels), and subsequently into WGSL (WebGPU Shading Language, the native shader language for WebGPU) via TintWASM (a WebAssembly compilation of Google's Tint compiler, used to translate shaders into WGSL) [cite: 5]. 

WebGPU brings substantial benefits to Babylon.js, including compute shaders and improved CPU-GPU synchronization [cite: 5]. For post-processing pipelines, WebGPU utilizes two primary command encoders: `upload` (for moving data into textures) and `render` (for processing render targets and the final swapchain texture) [cite: 16].

### The FSR1RenderingPipeline & Case Study Benchmark

Recognizing the need for high-performance rendering on varied hardware, Babylon.js natively implemented the `FSR1RenderingPipeline` (introduced via pull request #18723) [cite: 8]. This is an opt-in post-process pipeline that intercepts the final rendered scene, executes it at a lower internal resolution, and applies the EASU and RCAS algorithms before presenting it to the canvas [cite: 8, 17].

A real-world case study of the `FSR1RenderingPipeline` integrated into Babylon.js demonstrates remarkable efficacy. When testing the FSR 1 pipeline on a complex photographic source against a naive bilinear upscale of the exact same half-resolution source, the EASU and RCAS passes actively repositioned and clarified 12.21% of the total rendered pixels (compared to the engine harness's baseline 1.1% gate) [cite: 8]. This proves that the pipeline is not merely blurring the image, but mathematically reconstructing high-frequency details.

The implementation details of this pipeline reveal its robustness:
*   **Cross-Backend Support:** Originally conceptualized for WebGPU because the EASU algorithm heavily relies on `textureGather` (a shader function that fetches four texels simultaneously to accelerate filtering operations), Babylon.js developers successfully implemented a fallback [cite: 8]. By rewriting `textureGather` calls into four explicit `texelFetch` commands (a shader function that retrieves a single, specific pixel from a texture without filtering), the `FSR1RenderingPipeline` operates flawlessly on WebGPU, WebGL2, and Babylon Native (D3D11) [cite: 8].
*   **Uniform Buffer Management:** To maximize compatibility, the pipeline eschews complex Uniform Buffer Objects (UBOs) in favor of plain uniforms set during the `onApplyObservable` event, ensuring stability across different graphics backends [cite: 8].
*   **Scale Factor Handling:** Crucially, the developer does not need to manually manipulate the engine's base resolution. The pipeline manages internal rendering buffers via a `scaleFactor` property. For example, setting the scale factor to `BABYLON.FSR1RenderingPipeline.SCALE_PERFORMANCE` automatically downsizes the internal render targets and executes the upscaling math prior to canvas presentation [cite: 17, 18].

## Architectural Analysis of the 0SFS Repository

To inject the FSR pipeline into the `0SFS` project, one must understand how the application initializes its rendering context. `0SFS` is not a simple, single-file Babylon.js playground; it is a complex, modular TypeScript application using a sophisticated geospatial streaming engine. The computation demands are particularly constrained because the underlying flight physics engine (JSBSim) is compiled to WebAssembly (WASM). While WASM significantly outperforms JavaScript for CPU-bound simulations—achieving speeds 8.22x to 26.99x faster than standard JS for small-input physics calculations [cite: 19, 20]—it heavily saturates the CPU [cite: 21]. This leaves precious little overhead in the strict 16.67ms frame budget for GPU instruction dispatch, making FSR's ability to lower rendering overhead utterly critical for `0SFS` [cite: 13, 14].

### The Application Entry Point

The primary logic for the 3D simulation resides in `src/flight/createFlightSimApp.ts` [cite: 3, 22, 23]. Unlike standard Babylon.js tutorials that immediately instantiate a `new BABYLON.Engine()`, `0SFS` delegates engine creation to an external dependency wrapper called `createBabylonRuntime`, imported from `@foss-earth/runtime` [cite: 22, 24]. 

The configuration in the `0SFS` repository utilizes a local file reference (`"foss-earth": "file:../foss-earth"`) inside its `package.json`, indicating a closely coupled monorepo or dual-repo development structure [cite: 25]. 

### Intercepting the Runtime Lifecycle

At approximately line 545 of `src/flight/createFlightSimApp.ts`, the application calls the engine initialization wrapper:

```typescript
const runtimePromise = createBabylonRuntime(canvas, {
    googleApiKey: mapConfig.googleApiKey,
    preferGoogleTiles: mapConfig.preferGoogleTiles,
    rasterBaseMap: mapConfig.rasterBaseMap,
    terrainSource: mapConfig.terrainSource,
    rasterImagery: mapConfig.rasterImagery,
    simMode: true
}).then(runtime => {
    // Post-initialization logic
    return runtime;
});
```
[cite: 22, 24]

This asynchronous promise block is the critical junction. Once the promise resolves, the `runtime` object is populated with the instantiated `engine` (which will be a `WebGPUEngine` if the browser supports it and the `foss-earth` wrapper successfully requested the GPU adapter [cite: 22, 25]), the `scene`, and the default `geospatialCamera` [cite: 22, 24].

### The Camera Management Conundrum

A standard Babylon.js post-processing pipeline is typically attached to a specific camera using an array: `new BABYLON.FSR1RenderingPipeline('fsr', scene, [camera])` [cite: 18]. However, `0SFS` features a highly dynamic camera lifecycle.

When the application boots, the `foss-earth` runtime provides a default `geospatialCamera`. As the flight simulation initializes via the `mountFlightWorld` function, this default camera is explicitly disabled (`runtime.geospatialCamera.detachControl(); runtime.geospatialCamera.setEnabled(false);`) [cite: 22]. The application then delegates view control to newly instantiated cameras tied to the `floatingOrigin` and the `placeholderAircraft` model [cite: 22]. These include a `firstPersonCamera` (cockpit view) and a third-person chase camera [cite: 22, 24].

If the FSR pipeline is rigidly attached only to the initial camera during engine boot, the upscaling effect will break or fail to render the moment the user spawns an aircraft and the active camera switches. Therefore, the implementation must be dynamic, tracking the creation and activation of cameras throughout the application's lifecycle.

## Step-by-Step Implementation Guide for 0SFS

Implementing FSR 1 into the `0SFS` repository requires modifying `src/flight/createFlightSimApp.ts` and updating the React-based HUD. The implementation relies on the "Sandwich Method" of intercepting the engine, configuring the pipeline, binding it dynamically to the scene's event observers, and finally connecting it to the frontend.

### Phase 1: Pipeline Instantiation

The FSR pipeline must be created immediately after the `runtime` is established, but before the simulation tick begins. We intercept the code inside the `.then()` block resolving `createBabylonRuntime`.

**Implementation Strategy:**
We initialize the `FSR1RenderingPipeline` without passing an initial camera array. This creates the pipeline in a dormant state. We then define the desired upscaling aggression. Babylon.js offers several constants, ranging from `SCALE_ULTRA_QUALITY` to `SCALE_PERFORMANCE` [cite: 6]. 

```typescript
// Inside src/flight/createFlightSimApp.ts
// Locate the runtimePromise resolution block around line 545

const runtimePromise = createBabylonRuntime(canvas, {
    // ... config options
}).then(runtime => {
    
    // --- BEGIN FSR INTEGRATION ---
    
    // 1. Check if the engine supports WebGL2 or WebGPU (Required for FSR1)
    const isSupported = runtime.engine.version >= 2 || runtime.renderer.mode === 'webgpu';
    
    if (isSupported) {
        // 2. Instantiate the FSR1 Pipeline with an empty camera array
        const fsrPipeline = new BABYLON.FSR1RenderingPipeline(
            "fsr1-pipeline", 
            runtime.scene, 
            [] // Empty array, we will attach cameras dynamically
        );

        // 3. Set the scaling factor. 
        // SCALE_PERFORMANCE renders the engine at ~50% resolution and upscales.
        // SCALE_QUALITY renders at ~66% resolution.
        fsrPipeline.scaleFactor = BABYLON.FSR1RenderingPipeline.SCALE_PERFORMANCE;

        // 4. Expose the pipeline to the global scope or a settings manager
        // to allow users to toggle FSR from the React UI (See Phase 4).
        (window as any).flightSimFSR = fsrPipeline;
    } else {
        console.warn("FSR 1 is not supported on this graphics backend.");
    }
    
    // --- END FSR INTEGRATION ---

    bootResources.runtime = runtime;
    return runtime;
});
```

**Synthesis of Phase 1:**
By instantiating the pipeline here, we guarantee that the WebGPU (or WebGL2 fallback) device context is fully ready [cite: 8, 16]. By leaving the camera array empty, we prevent the engine from throwing errors when the default geospatial camera is subsequently destroyed or disabled by the `mountFlightWorld` logic [cite: 22].

### Phase 2: Dynamic Camera Attachment via Observables

Because `0SFS` spawns aircraft with encapsulated `firstPersonCamera` and third-person entities at runtime, the FSR pipeline must automatically hook into any new camera added to the scene. 

Babylon.js provides a robust event-driven architecture. The `Scene` object contains the `onNewCameraAddedObservable`, which fires an event payload containing a reference to the newly created camera [cite: 26].

**Implementation Strategy:**
Immediately following the instantiation of the pipeline, we subscribe to the camera creation observable. We then utilize the `PostProcessRenderPipelineManager` to bind the FSR effect to the camera dynamically [cite: 27, 28].

```typescript
        // ... continuing from Phase 1 inside the isSupported block

        // 5. Attach pipeline to any camera currently in the scene (e.g., geospatialCamera)
        runtime.scene.cameras.forEach(camera => {
            runtime.scene.postProcessRenderPipelineManager.attachCamerasToRenderPipeline("fsr1-pipeline", camera);
        });

        // 6. Subscribe to the observable to catch aircraft cameras created later
        runtime.scene.onNewCameraAddedObservable.add((newCamera) => {
            // Ensure we don't attach FSR to UI cameras or hidden utility cameras
            // (You may need to add conditional logic here based on camera names in 0SFS)
            if (newCamera.name !== "uiCamera") {
                runtime.scene.postProcessRenderPipelineManager.attachCamerasToRenderPipeline("fsr1-pipeline", newCamera);
            }
        });
```

**Synthesis of Phase 2:**
This approach guarantees total coverage. Whether the user is viewing the simulation from the `geospatialCamera` during initialization, or jumping into the `firstPersonCamera` of the `placeholderAircraft`, the `FSR1RenderingPipeline` will automatically down-sample the rendering viewport and apply the EASU and RCAS passes [cite: 22, 27]. This completely isolates the FSR logic from the deeply nested aircraft spawning code, adhering to clean architecture principles.

### Phase 3: Handling UI and Overlays

A critical edge case in applying spatial upscaling is the treatment of User Interfaces. If UI elements (such as the aircraft HUD or the React-based DOM overlays) are rendered within the 3D scene graph and processed by the FSR pipeline, text and crisp lines will become distorted and blurry.

In `0SFS`, visual effects such as G-force vision (blackout/redout) are intelligently implemented as custom DOM-based overlays rather than Babylon.js post-processes [cite: 24]. Because DOM elements sit outside the WebGPU canvas context, they are immune to the FSR down-sampling. 

However, if `0SFS` uses Babylon.js AdvancedDynamicTextures for cockpit instruments, those *will* be down-sampled. To mitigate this, standard practice in Babylon.js is to utilize a multi-camera setup with layer masks. The primary camera renders the 3D world (with FSR attached), while a secondary orthographic camera renders the UI layer on top (without FSR attached). 

```typescript
// Conceptual implementation for UI decoupling in 0SFS
uiCamera.layerMask = 0x10000000; // Only see UI objects
worldCamera.layerMask = 0x0FFFFFFF; // Only see World objects

// Ensure FSR is ONLY attached to the worldCamera, not the uiCamera
```

### Phase 4: Integrating with the React Frontend (HUD)

To make FSR functional for end-users, it must be accessible via the simulation's React-based graphical interface. The `0SFS` repository manages its complex UI through `src/flight/hud/FlightControlPanel.tsx`, a multi-tabbed component overseeing Systems, Weather, Controls, and Engines [cite: 29, 30].

**Implementation Strategy:**
We will inject a toggle control into the UI that accesses the globally scoped `(window as any).flightSimFSR` variable established in Phase 1. When toggled, the React component will mutate the pipeline's scale factor. Note that `0SFS` also utilizes `src/flight/settings/registerFlightSettings.ts` to manage overarching host defaults, making it a prime candidate for persisting the user's FSR preference [cite: 30].

```tsx
// Inside src/flight/hud/FlightControlPanel.tsx or a dedicated graphics sub-panel

import React, { useState, useEffect } from 'react';

export const GraphicsSettingsPanel: React.FC = () => {
    const [fsrEnabled, setFsrEnabled] = useState(false);

    const toggleFSR = (enable: boolean) => {
        const fsrPipeline = (window as any).flightSimFSR;
        if (fsrPipeline) {
            // SCALE_PERFORMANCE enables FSR (lowers resolution), 1.0 disables it (native resolution)
            fsrPipeline.scaleFactor = enable ? 0.5 : 1.0; 
            setFsrEnabled(enable);
        } else {
            console.warn("FSR Pipeline not initialized.");
        }
    };

    return (
        <div className="settings-section">
            <h3>WebGPU Upscaling</h3>
            <label>
                <input 
                    type="checkbox" 
                    checked={fsrEnabled} 
                    onChange={(e) => toggleFSR(e.target.checked)} 
                />
                Enable AMD FSR 1.0 (Performance Mode)
            </label>
            <p className="help-text">
                Renders the world at 50% resolution and mathematically upscales it to improve FPS.
            </p>
        </div>
    );
};
```

**Synthesis of Phase 4:**
By creating a direct bridge between the React frontend (`FlightControlPanel.tsx`) and the underlying WebGPU `FSR1RenderingPipeline`, users can dynamically engage FSR without requiring a hard reload of the engine, instantly reclaiming framerate when flying over highly dense geospatial areas [cite: 30].

## Advanced Trajectories: Pushing Toward Frame Generation

While true FSR 3 frame generation is locked behind browser API limitations [cite: 12], the ambition to achieve higher framerates beyond spatial upscaling is highly relevant to a demanding application like `0SFS`.

### Temporal Anti-Aliasing and Upscaling (TAA)

If the graphical fidelity of FSR 1 (spatial) is insufficient, the next architectural leap for `0SFS` would be integrating a temporal upscaler. While Babylon.js has a built-in `TAARenderingPipeline` [cite: 31, 32], temporal *upscaling* (reconstructing missing pixels across frames, akin to FSR 2) requires specialized implementations.

Community projects, such as `@pmndrs/upscaler`, have successfully ported the temporal architecture of FSR 2 and FSR 3 to WebGPU [cite: 12]. This library functions by taking a reduced-resolution input and rebuilding the full-resolution frame using a history buffer, utilizing custom WGSL compute passes dispatched directly to the `GPUDevice` [cite: 12]. 

To implement a temporal upscaler in `0SFS`, the developers would need to intercept the WebGPU device context directly. Fortunately, `0SFS` already exposes this via the runtime wrapper:

```typescript
const gpuDevice = runtime.renderer.mode === 'webgpu' 
    ? (runtime.renderer.engine as WebGPUEngine)._device 
    : null;
```
[cite: 22]

With access to the raw `GPUDevice`, advanced compute shaders required for temporal accumulation, motion vector analysis, and disocclusion detection can be executed manually. However, this dramatically increases codebase complexity compared to the localized, object-oriented simplicity of the `FSR1RenderingPipeline`. 

### The Illusion of Frame Generation

As explicitly noted in the documentation for advanced WebGPU upscalers, features like frame generation (the other half of "FSR3") are "deliberately not planned" because they require "swapchain-level frame pacing, which browsers don't expose" [cite: 12]. 

If the developers of `0SFS` are absolutely determined to implement a frame-generation-like experience, the only theoretically viable (though highly experimental and generally discouraged) path within the browser is to render the simulation engine at half the monitor's refresh rate (e.g., 30 FPS on a 60Hz display), manually execute an Optical Flow compute shader to generate an intermediate frame, and rapidly alternate drawing the real and synthetic frames to the canvas within a 60 FPS `requestAnimationFrame` loop. 

This pseudo-frame generation approach introduces immense input latency and suffers from pacing jitters because the browser's garbage collector and main thread can arbitrarily delay the rAF loop, breaking the perfect timing required for smooth interpolation [cite: 10, 33]. Consequently, the industry consensus remains that browser-based applications should rely exclusively on spatial (FSR 1) or temporal (FSR 2/TAA) upscaling to achieve performance metrics, relegating true frame interpolation to local, native hardware extensions like DLSS 3 or native AMD FSR 3.

**Sources:**
1. [libx.dev](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGTaZWG02Vb3RNY_o91H2M98Dx8-tIyDh_uHh5WdIZpG2G0O_Rvwcid1WzWym-SrIQfQmdYI2xIAT5bLTjjxaGy71aXBm06w-pUfVtvR6DfytgKvGzwmYuVeWsEwoE3rUnG_sc6aTWbl1Se7BK0YvlV-StYVAIYI2IT0ppn9NyGp949UtdwG2qyMg8=)
2. [wikipedia.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFblSJnTI6DtVzAZ0Hxzgj8ZIueFNqNeMfsfSYMMLUwadFVnpdTbvGoUvLJ5ajVV_Ip-UmC_Q0iHXzF8qrnv3WMLoR9x1bGV6MVPjrvNK_fRY-tM57XQx1EhgqnqrCOjJfWQzkYZyj1f23kBtUIdxw4M4dGUgPedMmONkEMRkMLofE8)
3. [Link](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFtHs1lJakdBp5F1nHUEkYLsfey2g2TJkUd8OSCu6926HINE4ig6pX-O3PldalExiyYSHPn5b-LTGPDquaWbmTbncrzg70tZcFLdrByl9rPdfhi0VVnIOPoB1lI8g==)
4. [dev.to](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHhp-30NIdevlBlVtWF7DMXzLCo-jrIEFNNvXzYhBDaUUiJRNzH2ARW_uPoPmT3LaXo3NQic1qFMeciCB3J4Zwv3xuDMdqCTDz5drBojXefufSkjOrCUBgqWhPfJ7TG0FxzETRNTRR_7Z45guFwSLsaJTV2kRmNmnsdfAm3U9HANaEkKQANN3VQpgk=)
5. [babylonjs.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF-rJijXvLxjl38cOymgLQJHJiPJsyaRkRHOEz3ppJJhQherYqOeIlw_fIoMgN6UWR8MQywBRh6ACCuFj9wAmlUek5LfbBTgRFumuuiyNZmjaaQvlJyS5kMW-FvE0d-WH29e3xE)
6. [amd.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFQKNbPv4LJYhcp8ZJ34ivW6W3AzpYEjflnaMuHZvhOmAFHR4BLy4_QmtuCE7KclMmd0dCxyvsUlhf6tSvoNj0Dxhkck6emuJ_Zd9Y6lroeDnPqJytWPn205mGFNV1bvfwL5B5ZvDkJNWTk6_kE_gYUvMnULym2T42UK_9ursw6LBpwbxLSv_ZiOUBHXPubQbw=)
7. [gpuopen.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHfNmeRckaJfm7D87xwN3Ohk8DWGbU9W7n_K4MolEDXGDzqhBl-yEq4V8zEdljK_j-mJu6MTXtr24JFN51Kn-nSPHnh0I7Ay_qcKZGwvXlDXKGQ8dH18vDNawDWErxB5I4GTmg4og==)
8. [babylonjs.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHDvBRZK3SmJxPa8s-yj0YEC5kvQ5_Lo5V1KihR2fWKgc3MUgLKRHXkdCsqrLJvoizJexcSVeTSiEW8YD06ztZCBM6h8D4m7Iyp_tRa0kHWnGt_jxcoiJxT6wgPAdTIB4EC9lLAhC7uyH084DhgXvXWApjLrI9dlQ==)
9. [corsair.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHJaQ_oWgl8bLFcyFzYleC_tRCKnZF6HR9MRxsP1KkgjCa5RhJw5RfbV-o7cadSOwEl8_ertmhlBq7QN-H98xcbU_gljeNhZKIuD3L9GsoHMyiG4nXtoelKxk9A0pfe9V06qY24uga21KYhDBg95S_Z1d0irug6exU=)
10. [gpuopen.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGhQ0v2kdUysTJGjASAsB3Im4TlEpjl4_zl1iVyq9U8yuwunc5UQJ7MK6AyRZis_vZJU4KNEHl1hLHAYWP4ZixO-p7n_uVfgvDMeGAy0jGdAVAVPH1H4o-DYt5yr1vc1LNnRLpjawZNCw==)
11. [youtube.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEUFQy8pHqLgWAru-5oJj1a8Cf34K3RWL6gmfQ3ICKRAmc0M-_bW9lNG2MNIqfStaEtouSD8x1wjsvliOMke-noeVkx1cFTn5M_XawHATmL2u394asfdzPoi3iY55QiyFN_)
12. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEemr8gWJh43vr0zFxqGp3TIUY_mgMnE-HsNGIyXyRYlKLKW1ZKLSvDS3DSvfk0OfwtaiOaNc31CWLBxDPJsceSu4kHjI9jr4GTFd7R3tzJU1VmSUCBfDmJ)
13. [mozilla.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFlIM0FJZ6gh0mEfKBH15ljlagVdJxbJcSgNdV884yOFFA0TkqYJCeh1z_JuX8fe_XYK76Dl1kA9uimeYo7ezAaw3WnHkudmfMnqDaT8T9wgjVx7FL8qMk4cVRxHfQWmNoLYuuP2SRap5it4UQnPe4H9MoV_gI34xY3pLzgB-4vewICRg==)
14. [web.dev](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFPD1ia06sT5PqRmWz_FbxxkT055R9S-856onl1-33rqcixfpKjrYWneMghTWbipBsTt7G1TJ_UHmz7_VpUD7JwjYBxfblCzHA3A-sPdlbvtMPPc6EzGiixsEYjrM6J)
15. [techspot.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE6OBC1exjoTuhl4Z5oWGZI9xrwGzAubdJYxqFyKxBxRglAwp3fKdCiy6elQva8KJxy4Y4ek97x7v1h_o3jD-gadPfK3phF68TwrU7Nx4dM38tTuzqAMu5o0L7xacsnbDM1o6tvzpAZxI2sWtHGpUSpQKTS33rPqNY6Sc8=)
16. [babylonjs.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHRd8xNTEDR09nBk8J1TtIyncXpOtvkjjhqWhP_FljAhEo8tOYu_dPgxLCCPoTYVdh1-voGrZI9VwYDx9eXOGZ019BDPeAoFUbgkTVUfugZVww_YGQgqhTZSOwRlzCHZCWbH2AZLtiNWyGySyT0R-9G67pgSUO_yxcaF-zOKnHrCdnE5a8=)
17. [Link](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHE4IKuMx-DwHp2-d2MKEyTlhqs0axA3jt9K6GNhtcDRhCIOVvwRuIU7k56fgcu4J6cgh78w3OcdgNyC9V2_eXeTZsr06BQ0oaMIKzesP-UwW2o62x9JhD6mDu-zToZ0175JHxZuk6eNPVj4cqNA16mnJ8m68MtlYBHRL7Itw==)
18. [Link](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE-wohTYuu6qT5M6lTs-ssY_XtQpC46PduNSz3WrXrhf8uOXf_jfZNiEVtbUFpSssgJ4vwBP0HNyCjTLcWm1sFkON7QORCrj876VWbaUuDV8cldC94hSZeczvTg2bFJCj4yByA4pGSN0FmWdPKpSrtZn2LVQFu9Ob3MOdAE4DCm)
19. [github.io](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFkUn4bvEeVshQI_9cYlGpQc7RsS1gzd3Pq45ZHwcWa3mGHbPwAN9ZvZFjoAOubW2UGed6vmqs7AqHQlsB-wZM-dDwlb-JWwo-kOzGQ9ORWdtFeALSJu8aGTW51hmcS3xbKbzZvYBrZb-3jHEAyS7tE2Q==)
20. [medium.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGM_14S0oHYFLlbIM9_juB7V3IAUuIaQvMruVp4gdehJ0FcpCaxBswjq-YiqzQ5BZakhJhYze19fbajT0xEmmbHtRul3g6WCwLk33fiaSXm23Q234XeulBd3jMkkjMzUIAiSJpqry9xeK805JAXFv62cGR_C0YLuhcOYCT0vpuXxXI-YPs=)
21. [medium.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFyuWk3CkFGkZIOnd5bWXcuYNref3P-BICz2rG6alUUjpSfSpbg_nmM_676MuOZJ6WQUK5_yjdExLhv4Wg7WLNM4mc_3jiZp2lqf4DSiJcwciwoMsRmeJNVd64gpiHCxqwZsPz4w4k7YW9RRhjniMxMiQCaT2_kbNElpXU1NfbOCOOqXhVkswwF0JJjEfMYSi1CIjPMoy8XoMPjAXy91DqBSXwUkzW1nP-0Wmq3Nri_IA==)
22. [Link](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE01EFFvUwSkkJkVHkT79yVS3xHKizml2guVSA11-VJvwq0EO8ZhmU4z2a4aYiRZtShXi-4UenSHYE9XrbdUzaGELpdJaAA50opYnASzoeJSqIrcHKU1fl1ZFsxnK_y-4ohcj6TYwOAYX6WfOZuBAUxJ8NtIUVWUzgiEleva1pKp9ydJCb2NTY=)
23. [Link](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGQuZ-S_EElkxMf0DaDpVQMH3_ceCPgBl8l2ysO_ntS129sfTSH9z1zRhuRHGWVdFONvu681sw0E7BPM0fuyZQPx65DBQp0C4J2cNbbvxbN0FIkZGi-Hwt6FT2X5s8iG2P7HwrTucDwHoOD3ixuWDTRsA==)
24. [Link](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHOngXcp2NAk5769NwADFoQsKo92p8Nnsel1LeGHGmrloR00_EsAJE9OuOsDcgIxss34YVFScM_tFjHmPHHHOA-4L_TSsb0X--8JqDI21-I24F2KNFMNE29MBYx6eNuOa3HdGk-Yem3o3poOEBLx9wBdmTqdu4CB5rTs2zxmEd7rMv8Cr5yXTxL4JiF1oz3_q5LawR8ybKxmmDQlO_liQZwGxOCv3ocwNLWT50=)
25. [Link](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH2CPM8DQO_m46PaE4AFCEvzZ7ZsGHA13lBN3IcUvGQ1hsS6xHFjelQ8bFaT1wliiVbhDf-VXKNAeO-eOfGv4IiWmsFuwRrTvUxppjagNa3hOWhPW974ChkQgjVeUo2CkroeaLZs37V4gM1-6DzPdNzBNWU)
26. [babylonjs.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHBYE4jl_gTStYnaMeupd4GrYST8wdNbltVXc8mpz5jDYQacE_R7sipFkvswU4eoIuCf3V1Zd0UCl8dZ_wRGA7rxm7lPjkqPtkYdyVV59TR0gW6FuCCXBOl5n8wUZQsD_8gMYHv4IKItvDOnkLq)
27. [babylonjs.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEOIDD34GIsBhl6lw_5JJDFw3l1FuaAwvsFQGr8CsfWg-PjSwyxrMtsLlIsXqpDukxrruEPaTTwPy-LY8ZWhlGaMVios7BR1mMc0aH2uXfwAvlxctw4z98-1DBsoC-DOvEGdoMDm0Ikv8Yza_OBb37PvF5vTBpt6dXAzPl_QqhywgrY0_W1EZ9JTMJVwQ2AGmoK)
28. [babylonjs.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFbhZKyyzaAuh9ndbarGfmmc9vJKgPhvNoYeDHwYPkUE1B2hHP8Uk4mGvwGC9iJkfXCbFzrR0qCItVLss1ZhkBX3IG7N981RAZ-O0ahw1SHkGvJkFQwxIg943nyDRQMJCdTXlO_0j1Rvz3gkVGy2Urb1CS-j_KXgif-mSQGHY53xFYjwF1jShgLGVA=)
29. [Link](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFRGnOzmdWvNCT57WEq3_0volEmGZ3IMA9bs4SE4LOAuZDux-k5ei3Vthnebmw1AtyfxK6abw-4wZzceX4CT1FJQ8nTfXpUi5oM-3qz3dEWENaO_bd1kN5G7vNqNxbF9luxY0cQBtMe4dMuFannNb3yWlJI09lVFD0ckw==)
30. [Link](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQENSGlk4NtNmvKHAH-qtJNIfpMV1f9xrLJL1L9N5yuW31xhmiA4RKBpj8B-Ei6uWP0-5XfbrkUoBqMZjZaXSeN8OHRJUZhhxDFRFtrSiqQZncODk_4oW-LYnfuZq37vtCSbXDdnSGhJSDtQvns3kobbEqPxEfdgcmtana6PZbDZKqPBpEX4GAoMu_zON5NgZfYiGD-c)
31. [babylonjs.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFMe5oXHP9ZMfWtcVxm3zqcXOkakSiZ-ifrRi4UHsaJG3vFrsNVjDjGGKXqxCPHJf3FlMYFotgJGaqn4qIopwsZvHdcwx7XRoSe1bfCeJzu-7A8IBkO1DWD1OhyoVGJ-Yq-P1dMtOPyniHw_837Ib4Ctf-35ujJ8tM=)
32. [babylonjs.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGgPqwirwnU8z1LR7z0w3Eny3-UFUF_96Awu8ksTxdDqhBI9nOLhauIPQV6iiGfAnOJc9GnYUEro70vD3o_UCm-Pdk6eo_lBvpPIW0pGgiEuwOVcGFFaMR2O_Yl1YUrifE0jEjHRHx6LEhGpMTzRtzMFQ4sg_1mD6KtlmwdR3vWK2rxVhFrSJqWcI2OM_FCWnQ=)
33. [jamesdrandall.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH_iNQ99u7iPDYCbbjDJs7_NbGO5PvpPxetKEPArZVy27UT19RZZlTa0T5bXz9g9LCkKpaIeP_qnlcvsRMS24upHNccuzSvB0W98EbIdtJ1sBcdnaUBFWEGIVWpAhGYEZ5oRO7k25Ko72nJ82ebZpBPxoN15EpZ7GXZFnUPQV6jBNqhQXxE)
