/**
 * The prototype's page: the client of lib/client.mjs on a real network and a
 * real GPU, with Babylon on WebGL 1, WebGL 2 or WebGPU. Isolated from the app:
 * it imports the app's panorama uploader for the control and nothing else.
 *
 * Modes, from `?spec=` (base64url JSON, see `Spec`):
 *
 * - `run`: plays a camera trace by elapsed time and records every frame,
 *   request, decode, upload and a snapshot of the display table every
 *   `quality.sampleMs`. Nothing is read back while it runs. With `control`
 *   set it runs the current whole-image path instead of tiles.
 * - `replay`: draws a given display table (or control state) from a given
 *   camera and returns the pixels, for judging against the source.
 * - `interactive`: drag to look; `debug` shows the level of every tile and an
 *   unfolded map of tile states. For trying it on a phone.
 *
 * Results go to `spec.sink` by PUT when the page has one, else are offered as
 * a download.
 */
import {
  Color4, Constants, Engine, EngineInstrumentation, FreeCamera, Matrix, Mesh, RawTexture, Scene, ShaderLanguage, ShaderMaterial, Vector3, Vector4, VertexData, WebGPUEngine,
  type AbstractEngine, type BaseTexture, type InternalTexture,
} from "@babylonjs/core";
import { createPanoramaUploader, type PanoramaGpuTexture } from "../../../src/engine/babylon/panorama/panoramaTextures";
import { CUBE_FACE_NAMES, type CubeFaceName } from "../../../src/scenes/panoramaMath";
import { tilingFromManifest } from "../lib/tiling.mjs";
import { createSelector, planeExtents, viewBasis } from "../lib/selection.mjs";
import { createClient, STATE_NAMES } from "../lib/client.mjs";
import { addDifference, predictChild } from "../lib/residual.mjs";
import { cameraPath } from "../lib/traces.mjs";
import { controlShader, meshShader, rayShader } from "./shaders";

type Backend = "webgl1" | "webgl2" | "webgpu";
interface Camera { yaw: number; pitch: number; roll: number }
interface Viewport { width: number; height: number; verticalFovDeg: number }
interface BootEntry { faceSize: number; gutter: number; width: number; height: number; url: string }
interface Manifest { bootstrap: BootEntry[]; [key: string]: unknown }
interface Config {
  viewport: { verticalFovDeg: number }; dataset: { projection: string; tile: number; bootstrap: number };
  selection: Record<string, number>; policy: { payload: string; [key: string]: unknown };
  limits: { gpuSlots: number; useTileBytes?: boolean; [key: string]: unknown }; quality: { sampleMs: number };
}
interface Spec {
  mode: "run" | "replay" | "interactive";
  backend: Backend; runId: string; sink: string | null;
  data: string; config: Config;
  trace?: string; start?: string; tailSeconds?: number; laps?: number;
  render: "ray" | "mesh"; meshGrid: number; debug?: boolean; log?: boolean;
  cache?: RequestCache;
  /** Wait for `window.eac.start()` before fetching anything: the driver throttles the network after the page has loaded. */
  gate?: boolean;
  control?: { previewFaces: Record<CubeFaceName, string>; whole: string; width: number; height: number; previewBytes: number; wholeBytes: number };
}
interface Tiling {
  projection: string; tile: number; gutter: number; stored: number; maxLevel: number; roots: number; cells: number; count: number;
  level(id: number): number; address(id: number): { face: number; level: number; x: number; y: number }; parent(id: number): number; path(id: number, kind: string): string;
  direction(face: number, u: number, v: number, out: number[]): number[];
}

const RAD = Math.PI / 180;
const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const spec = JSON.parse(atob((new URLSearchParams(location.search).get("spec") ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as Spec;
declare global { interface Window { eac: { done: boolean; error?: string; ready?: boolean; waiting?: boolean; start?: () => void; result?: unknown; show?: (state: unknown) => Promise<unknown> } } }
window.eac = { done: false };
// Chrome keeps 250 resource timings unless asked for more; a long run makes several hundred requests.
performance.setResourceTimingBufferSize(20000);

// ─── Engine ────────────────────────────────────────────────────────────

async function createEngine(backend: Backend, canvas: HTMLCanvasElement): Promise<AbstractEngine> {
  if (backend === "webgpu") {
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: true, deviceDescriptor: { requiredFeatures: ["timestamp-query"] } });
    await engine.initAsync();
    return engine;
  }
  // The drawing buffer is the CSS size times the device pixel ratio: the pixels a phone actually has.
  return new Engine(canvas, false, { disableWebGL2Support: backend === "webgl1", preserveDrawingBuffer: true, antialias: false, adaptToDeviceRatio: true });
}

function backendInfo(engine: AbstractEngine) {
  const gl = (engine as unknown as { _gl?: WebGLRenderingContext })._gl;
  const debug = gl?.getExtension("WEBGL_debug_renderer_info");
  const high = gl?.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  return {
    requested: spec.backend, description: engine.description, isWebGPU: engine.isWebGPU, webGLVersion: (engine as Engine).webGLVersion ?? null,
    renderer: gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
    fragmentHighFloatPrecisionBits: high ? high.precision : null, maxTextureSize: engine.getCaps().maxTextureSize, timerQuery: Boolean(engine.getCaps().timerQuery),
    drawingBuffer: { width: engine.getRenderWidth(), height: engine.getRenderHeight() }, devicePixelRatio, crossOriginIsolated: self.crossOriginIsolated, userAgent: navigator.userAgent,
  };
}

/** GPU time per frame where the backend can measure it: WebGL's disjoint timer query, WebGPU's render-pass timestamps. */
function gpuTimer(engine: AbstractEngine) {
  const webGpu = engine as unknown as { enableGPUTimingMeasurements: boolean; gpuTimeInFrameForMainPass?: { counter: { total: number; count: number } } };
  const instrumentation = engine.isWebGPU ? null : new EngineInstrumentation(engine);
  if (instrumentation) instrumentation.captureGPUFrameTime = true;
  else webGpu.enableGPUTimingMeasurements = true;
  const readings: number[] = [];
  let start: { total: number; count: number } | null = null;
  return {
    begin() { const counter = webGpu.gpuTimeInFrameForMainPass?.counter; start = counter ? { total: counter.total, count: counter.count } : null; },
    frame() { if (instrumentation && instrumentation.gpuFrameTimeCounter.current > 0) readings.push(instrumentation.gpuFrameTimeCounter.current / 1e6); },
    result() {
      const counter = webGpu.gpuTimeInFrameForMainPass?.counter;
      if (engine.isWebGPU) return counter && start && counter.count > start.count ? { source: "WebGPU render-pass timestamps", frames: counter.count - start.count, meanMs: (counter.total - start.total) / (counter.count - start.count) / 1e6 } : { source: "WebGPU timestamps unavailable", frames: 0, meanMs: null };
      // A timer that repeats one value is not measuring (Babylon's WebGL 1 reading does this): reported as invalid.
      const distinct = new Set(readings).size, stale = readings.length > 10 && distinct <= 1;
      return { source: "WebGL disjoint timer query, whole frames", frames: readings.length, distinct, valid: !stale, meanMs: stale || !readings.length ? null : readings.reduce((a, b) => a + b, 0) / readings.length, readings: stale ? [] : readings };
    },
  };
}

// ─── The tile renderer ─────────────────────────────────────────────────

/**
 * One atlas of `gpuSlots` tile slots, allocated once, filled tile by tile; the
 * bootstrap in its own texture; the display table as a small texture. A tile
 * arriving costs one sub-image upload of its stored texels; the table, a few
 * kilobytes, is uploaded whole when it changes, and that is counted apart.
 */
function createTileRenderer(scene: Scene, engine: AbstractEngine, tiling: Tiling, slots: number, path: "ray" | "mesh", meshGrid: number) {
  const perRow = Math.ceil(Math.sqrt(slots)), side = perRow * tiling.stored, C = tiling.cells, webGpu = engine.isWebGPU;
  if (side > engine.getCaps().maxTextureSize) throw new Error(`a ${side}-texel atlas is over this device's ${engine.getCaps().maxTextureSize}`);
  const atlas = new RawTexture(null, side, side, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  atlas.wrapU = atlas.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  const tableBytes = new Uint8Array(tiling.roots * C * C * 4);
  const table = new RawTexture(tableBytes, tiling.roots * C, C, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  table.wrapU = table.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  let boot: RawTexture | null = null;
  const stats = { atlasBytes: side * side * 4, atlasSide: side, tileUploads: 0, tileUploadBytes: 0, tileUploadMs: [] as number[], tableUploads: 0, tableUploadBytes: 0, bootstrapUploads: 0, allocationsAfterStart: 0 };
  const material = new ShaderMaterial(`tiles-${path}`, scene, path === "ray" ? rayShader(webGpu) : meshShader(webGpu), {
    attributes: path === "ray" ? ["position"] : ["position", "uv", "uv2"], uniforms: ["camRight", "camUp", "camForward", "viewRotProj", "tileLayout", "atlasInfo", "bootInfo", "warp", "debugLevels"],
    samplers: ["tileAtlas", "bootAtlas", "displayTable"], shaderLanguage: webGpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  });
  material.backFaceCulling = false; material.depthFunction = Constants.ALWAYS; material.disableDepthWrite = true;
  material.setTexture("tileAtlas", atlas); material.setTexture("displayTable", table); material.setTexture("bootAtlas", atlas);
  const mesh = new Mesh(`tiles-${path}`, scene), data = new VertexData();
  if (path === "ray") { data.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0]; data.indices = [0, 1, 2]; }
  else {
    // Each face a grid of `meshGrid` × `meshGrid` quads, its vertices placed on the sphere by the projection's own map.
    const positions: number[] = [], uvs: number[] = [], faces: number[] = [], indices: number[] = [], at = [0, 0, 0];
    for (let face = 0; face < tiling.roots; face++) {
      const base = positions.length / 3;
      for (let j = 0; j <= meshGrid; j++) for (let i = 0; i <= meshGrid; i++) {
        tiling.direction(face, i / meshGrid, j / meshGrid, at);
        positions.push(at[0], at[1], at[2]); uvs.push(i / meshGrid, j / meshGrid); faces.push(face, 0);
      }
      for (let j = 0; j < meshGrid; j++) for (let i = 0; i < meshGrid; i++) {
        const p = base + j * (meshGrid + 1) + i;
        indices.push(p, p + 1, p + meshGrid + 1, p + 1, p + meshGrid + 2, p + meshGrid + 1);
      }
    }
    data.positions = positions; data.uvs = uvs; data.uvs2 = faces; data.indices = indices;
  }
  data.applyToMesh(mesh);
  mesh.material = material; mesh.alwaysSelectAsActiveMesh = true;
  const internal = () => atlas.getInternalTexture() as InternalTexture;
  return {
    material, mesh, stats, perRow, triangles: (data.indices as number[]).length / 3,
    setUniforms(camera: Camera, viewport: Viewport, debugLevels: boolean) {
      const { forward, right, up } = viewBasis(camera), { tanH, tanV } = planeExtents(viewport);
      material.setVector3("camForward", Vector3.FromArray(forward)); material.setVector3("camRight", Vector3.FromArray(right).scale(tanH)); material.setVector3("camUp", Vector3.FromArray(up).scale(tanV));
      const view = Matrix.LookAtRH(Vector3.Zero(), Vector3.FromArray(forward), Vector3.FromArray(up));
      material.setMatrix("viewRotProj", view.multiply(Matrix.PerspectiveFovRH(viewport.verticalFovDeg * RAD, viewport.width / viewport.height, 0.01, 10, engine.isNDCHalfZRange)));
      material.setFloat("debugLevels", debugLevels ? 1 : 0);
    },
    configure(bootSize: { faceSize: number; gutter: number; width: number; height: number }) {
      material.setFloat("warp", tiling.projection === "eac" ? 1 : 0);
      material.setVector4("tileLayout", new Vector4(C, tiling.tile, tiling.gutter, tiling.stored));
      material.setVector4("atlasInfo", new Vector4(side, side, perRow, tiling.roots));
      material.setVector4("bootInfo", new Vector4(bootSize.faceSize, bootSize.gutter, bootSize.width, bootSize.height));
    },
    uploadTile(slot: number, rgba: Uint8Array) {
      if (slot < 0 || slot >= slots) throw new Error(`slot ${slot} is outside the atlas's ${slots}`);
      const started = performance.now();
      engine.updateTextureData(internal(), rgba, (slot % perRow) * tiling.stored, Math.floor(slot / perRow) * tiling.stored, tiling.stored, tiling.stored);
      stats.tileUploadMs.push(performance.now() - started); stats.tileUploads++; stats.tileUploadBytes += rgba.length;
    },
    uploadBootstrap(rgba: Uint8Array, width: number, height: number) {
      boot?.dispose();
      boot = new RawTexture(rgba, width, height, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
      boot.wrapU = boot.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
      material.setTexture("bootAtlas", boot); stats.bootstrapUploads++;
    },
    setTable(cells: Int32Array, slotOf: (tile: number) => number) {
      for (let cell = 0; cell < cells.length; cell++) {
        const face = Math.floor(cell / (C * C)), cx = cell % C, cy = Math.floor(cell / C) % C, at = (cy * tiling.roots * C + face * C + cx) * 4, tile = cells[cell];
        const slot = tile >= 0 ? slotOf(tile) : -1;
        tableBytes[at] = slot >= 0 ? slot % perRow : 0; tableBytes[at + 1] = slot >= 0 ? Math.floor(slot / perRow) : 0; tableBytes[at + 2] = slot >= 0 ? tiling.level(tile) + 1 : 0; tableBytes[at + 3] = 255;
      }
      table.update(tableBytes); stats.tableUploads++; stats.tableUploadBytes += tableBytes.length;
    },
    dispose() { mesh.dispose(); material.dispose(); atlas.dispose(); table.dispose(); boot?.dispose(); },
  };
}

// ─── Decoding and fetching ─────────────────────────────────────────────

const readers = new Map<string, OffscreenCanvasRenderingContext2D>();
/** JPEG bytes → RGBA bytes: the browser's decoder off the main thread, then one read back. Each part is timed. */
async function decodeJpeg(bytes: Uint8Array) {
  const started = performance.now();
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const decoded = performance.now(), key = `${bitmap.width}x${bitmap.height}`;
  let context = readers.get(key);
  if (!context) { context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true })!; readers.set(key, context); }
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const width = bitmap.width, height = bitmap.height;
  bitmap.close();
  return { rgba: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height, decodeMs: decoded - started, readMs: performance.now() - decoded };
}

/** `fetch` as the client's transport: bytes are counted as they arrive, so an aborted request still reports what it cost. */
function fetchTransport(cache: RequestCache, log: { requests: Record<string, unknown>[] }) {
  return {
    start({ url, done }: { url: string; done(result: { ok: boolean; received: number; payload: Uint8Array | null }): void }) {
      const controller = new AbortController(), entry = { url, startedAt: performance.now(), firstByteAt: null as number | null, endedAt: null as number | null, received: 0, status: 0, outcome: "pending" };
      log.requests.push(entry);
      let aborted = false;
      void (async () => {
        try {
          const response = await fetch(url, { signal: controller.signal, cache });
          entry.status = response.status; entry.firstByteAt = performance.now();
          if (!response.ok || !response.body) { entry.outcome = "failed"; entry.endedAt = performance.now(); done({ ok: false, received: 0, payload: null }); return; }
          const reader = response.body.getReader(), chunks: Uint8Array[] = [];
          for (;;) { const { done: finished, value } = await reader.read(); if (finished) break; chunks.push(value); entry.received += value.byteLength; }
          const payload = new Uint8Array(entry.received);
          let at = 0;
          for (const chunk of chunks) { payload.set(chunk, at); at += chunk.byteLength; }
          entry.outcome = "complete"; entry.endedAt = performance.now();
          done({ ok: true, received: entry.received, payload });
        } catch (error) {
          entry.endedAt = performance.now();
          if (aborted) { entry.outcome = "cancelled"; return; }
          entry.outcome = `error: ${String(error)}`;
          done({ ok: false, received: entry.received, payload: null });
        }
      })();
      return { abort() { aborted = true; controller.abort(); return entry.received; } };
    },
  };
}

// ─── Running ───────────────────────────────────────────────────────────

function viewportOf(engine: AbstractEngine): Viewport {
  return { width: engine.getRenderWidth(), height: engine.getRenderHeight(), verticalFovDeg: spec.config.viewport.verticalFovDeg };
}

async function sendResult(name: string, body: BodyInit, type: string) {
  if (spec.sink) {
    const response = await fetch(`${spec.sink}${name}`, { method: "PUT", body, headers: { "Content-Type": type } });
    if (!response.ok) throw new Error(`the sink refused ${name}: ${response.status}`);
    return;
  }
  // No sink, as on a static host: offer the file.
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([body as BlobPart], { type })); link.download = name.replaceAll("/", "-"); link.textContent = `Save ${name}`;
  link.style.cssText = "position:fixed;left:16px;bottom:16px;padding:12px;background:#fff;color:#000;font:16px system-ui";
  document.body.append(link);
}

async function main() {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;touch-action:none";
  document.body.style.cssText = "margin:0;background:#000;overflow:hidden";
  document.body.append(canvas);
  const engine = await createEngine(spec.backend, canvas);
  engine.resize();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true; scene.clearColor = new Color4(1, 0, 1, 1); scene.skipFrustumClipping = true;
  scene.activeCamera = new FreeCamera("camera", Vector3.Zero(), scene);
  const viewport = viewportOf(engine), info = backendInfo(engine), errors: string[] = [];
  const renderFrame = () => { engine.beginFrame(); scene.render(); engine.endFrame(); };
  const capture = async () => {
    await scene.whenReadyAsync();
    renderFrame(); await nextFrame();
    // Read inside the frame, before it is presented: WebGPU's canvas texture is gone afterwards.
    engine.beginFrame(); scene.render();
    const reading = engine.readPixels(0, 0, viewport.width, viewport.height);
    engine.endFrame();
    const pixels = await reading;
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength).slice();
  };

  if (spec.gate) await new Promise<void>(resolve => { window.eac.start = resolve; window.eac.waiting = true; });
  if (spec.control) { await runControl(engine, scene, viewport, info, renderFrame, capture); return; }

  const manifest = await (await fetch(`${spec.data}manifest.json`, { cache: spec.cache ?? "default" })).json() as Manifest;
  const tiling = tilingFromManifest(manifest) as Tiling;
  const config = spec.config;
  const renderer = createTileRenderer(scene, engine, tiling, config.limits.gpuSlots, spec.render, spec.meshGrid);
  renderer.material.onError = (_effect, message) => { errors.push(message); };
  const bootEntry = manifest.bootstrap.find(item => item.faceSize === config.dataset.bootstrap)!;
  renderer.configure(bootEntry);
  const log = { requests: [] as Record<string, unknown>[], decodes: [] as number[][], frames: [] as number[][], samples: [] as Record<string, unknown>[] };

  /** Decodes for the client: a residual tile is added to its parent's prediction here, on the CPU. */
  const stages = {
    decode(job: { tile: number; kind: string; payload: Uint8Array; parent: Uint8Array | null; quadrantX: number; quadrantY: number }, done: (pixels: Uint8Array) => void) {
      void decodeJpeg(job.payload).then(image => {
        let pixels = image.rgba, reconstructMs = 0;
        if (job.kind === "r") {
          const started = performance.now();
          pixels = addDifference(predictChild(job.parent!, 4, tiling.tile, tiling.gutter, job.quadrantX, job.quadrantY, new Uint8Array(image.rgba.length), 4), 4, image.rgba, 4) as Uint8Array;
          reconstructMs = performance.now() - started;
        }
        if (job.kind === "bootstrap") bootPixels = image;
        log.decodes.push([performance.now(), job.tile, image.decodeMs, image.readMs, reconstructMs]);
        done(pixels);
      }).catch(error => { errors.push(`decode ${job.tile}: ${String(error)}`); });
    },
    upload: (slot: number, _tile: number, pixels: Uint8Array) => renderer.uploadTile(slot, pixels),
    uploadBootstrap: () => { renderer.uploadBootstrap(bootPixels!.rgba, bootPixels!.width, bootPixels!.height); },
    setTable: (cells: Int32Array, slotOf: Int16Array) => renderer.setTable(cells, tile => slotOf[tile]),
  };
  let bootPixels: { rgba: Uint8Array; width: number; height: number } | null = null;

  if (spec.mode === "replay") { await replay(engine, scene, tiling, renderer, manifest, viewport, info, capture); return; }

  const selector = createSelector(tiling, config.selection);
  const tileBytes = config.limits.useTileBytes ? await (await fetch(`${spec.data}tiles.json`)).json() : null;
  const client = createClient({ tiling, manifest, tileBytes, bootstrapSize: config.dataset.bootstrap, selector, policy: config.policy, limits: config.limits, transport: fetchTransport(spec.cache ?? "default", log), stages, baseUrl: spec.data, log: spec.log ?? true });
  const trace = spec.trace ? cameraPath(spec.trace, spec.start ?? "face-centre") : null;
  const timer = gpuTimer(engine);
  const interactive = { yaw: 0, pitch: 0 };
  if (spec.mode === "interactive") attachDrag(canvas, interactive);
  const overlay = spec.debug ? createOverlay(tiling, client) : null;
  await scene.whenReadyAsync();
  const laps = spec.laps ?? 1, duration = trace ? (trace.duration * laps + (spec.tailSeconds ?? 0)) * 1000 : Infinity;
  timer.begin();
  const began = performance.now();
  let previous = began, nextSample = 0, lastUploads = 0;
  for (;;) {
    const frameStart = performance.now(), elapsed = frameStart - began;
    if (elapsed > duration) break;
    // Elapsed time, not frame count, drives the camera, so a slow page does not get an easier trace.
    const camera: Camera = trace ? trace.at(laps > 1 ? (elapsed / 1000) % trace.duration : Math.min(elapsed / 1000, trace.duration)) : { yaw: interactive.yaw, pitch: interactive.pitch, roll: 0 };
    client.tick(elapsed, camera, viewport);
    const ticked = performance.now();
    renderer.setUniforms(camera, viewport, Boolean(spec.debug));
    renderFrame();
    const rendered = performance.now();
    timer.frame();
    const uploads = renderer.stats.tileUploads - lastUploads; lastUploads = renderer.stats.tileUploads;
    log.frames.push([Number(elapsed.toFixed(2)), Number((frameStart - previous).toFixed(3)), Number((ticked - frameStart).toFixed(3)), Number((rendered - ticked).toFixed(3)), uploads]);
    previous = frameStart;
    if (elapsed >= nextSample) {
      // What is on screen now: the display table and the camera it is seen from. Judged later, off the clock.
      log.samples.push({ t: Number(elapsed.toFixed(1)), camera, table: Array.from(client.table), bytes: client.counters.bytesReceived, requests: client.counters.requests, bootstrapShown: client.bootstrapDisplayedAt !== null, viewComplete: client.viewComplete(), ...client.resources() });
      nextSample += config.quality.sampleMs;
    }
    overlay?.draw(elapsed);
    await nextFrame();
  }
  client.dispose();
  const result = {
    runId: spec.runId, spec: { ...spec, config: undefined }, config, backend: info, viewport, errors,
    counters: client.counters, bytesNeverShown: client.bytesNeverShown(), bootstrapDisplayedAt: client.bootstrapDisplayedAt,
    renderer: { ...renderer.stats, tileUploadMs: undefined, uploadMs: summary(renderer.stats.tileUploadMs), triangles: renderer.triangles, path: spec.render, meshGrid: spec.render === "mesh" ? spec.meshGrid : null },
    gpu: timer.result(), events: client.events, ...log,
    resources: performance.getEntriesByType("resource").map(entry => { const item = entry as PerformanceResourceTiming; return { name: item.name.replace(location.origin, ""), startTime: item.startTime, responseEnd: item.responseEnd, transferSize: item.transferSize, encodedBodySize: item.encodedBodySize, protocol: item.nextHopProtocol }; }),
  };
  await sendResult(`${spec.runId}.json`, JSON.stringify(result), "application/json");
  window.eac = { done: true, result: { runId: spec.runId, frames: log.frames.length } };
}

function summary(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, median: at(0.5), p95: at(0.95), p99: sorted.length >= 100 ? at(0.99) : null, max: sorted.at(-1) };
}

/** Replay: the driver hands a display table and a camera; the page loads exactly those tiles, draws and returns the pixels. */
async function replay(engine: AbstractEngine, scene: Scene, tiling: Tiling, renderer: ReturnType<typeof createTileRenderer>, manifest: Manifest, viewport: Viewport, info: unknown, capture: () => Promise<Uint8Array>) {
  const reconstructed = new Map<number, Uint8Array>();
  async function texels(tile: number, payload: string): Promise<Uint8Array> {
    const kind = payload === "residual" && tiling.level(tile) > 0 ? "r" : "t";
    const bytes = new Uint8Array(await (await fetch(spec.data + tiling.path(tile, kind))).arrayBuffer());
    const image = await decodeJpeg(bytes);
    if (kind === "t") return image.rgba.slice();
    if (!reconstructed.has(tile)) {
      const { x, y } = tiling.address(tile);
      reconstructed.set(tile, addDifference(predictChild(await texels(tiling.parent(tile), payload), 4, tiling.tile, tiling.gutter, x & 1, y & 1, new Uint8Array(image.rgba.length), 4), 4, image.rgba, 4) as Uint8Array);
    }
    return reconstructed.get(tile)!;
  }
  const bootCache = new Map<number, { rgba: Uint8Array; width: number; height: number }>(), slotOf = new Map<number, number>();
  let shownPayload = "";
  window.eac.show = async (state: unknown) => {
    const { camera, table, payload, bootstrap, name, debug } = state as { camera: Camera; table: number[]; payload: string; bootstrap: number; name: string; debug?: boolean };
    const entry = manifest.bootstrap.find(item => item.faceSize === bootstrap)!;
    if (!bootCache.has(bootstrap)) bootCache.set(bootstrap, await decodeJpeg(new Uint8Array(await (await fetch(spec.data + entry.url)).arrayBuffer())));
    const boot = bootCache.get(bootstrap)!;
    renderer.configure(entry); renderer.uploadBootstrap(boot.rgba, boot.width, boot.height);
    // Tiles stay in their slots from one state to the next; only tiles not yet uploaded, for this payload, are sent.
    if (payload !== shownPayload) { slotOf.clear(); shownPayload = payload; }
    for (const tile of new Set(table.filter(tile => tile >= 0))) {
      if (slotOf.has(tile)) continue;
      slotOf.set(tile, slotOf.size);
      renderer.uploadTile(slotOf.get(tile)!, await texels(tile, payload));
    }
    renderer.setTable(Int32Array.from(table), tile => slotOf.get(tile) ?? -1);
    renderer.setUniforms(camera, viewport, Boolean(debug));
    const pixels = await capture();
    await sendResult(`${name}.rgba`, pixels as BlobPart as BodyInit, "application/octet-stream");
    return { width: viewport.width, height: viewport.height, tiles: slotOf.size };
  };
  window.eac.ready = true;
  window.eac.result = { backend: info, viewport };
  void engine; void scene;
}

// ─── The current whole-image path, as a control ────────────────────────

/**
 * What the current viewer does on entering a panorama, without the app: the
 * smallest cube preview first, then one whole equirectangular image of the
 * size the app opens by default, decoded whole and uploaded by the app's own
 * uploader (src/engine/babylon/panorama/panoramaTextures.ts) at its default
 * allowance of 4 MiB a frame. Nothing about it is tuned here.
 */
async function runControl(engine: AbstractEngine, scene: Scene, viewport: Viewport, info: ReturnType<typeof backendInfo>, renderFrame: () => void, capture: () => Promise<Uint8Array>) {
  const control = spec.control!, errors: string[] = [], webGpu = engine.isWebGPU;
  const uploader = createPanoramaUploader(scene, { bytesPerFrame: 4 * 2 ** 20, outstandingBytes: 16 * 2 ** 20 }, () => {});
  const material = new ShaderMaterial("control", scene, controlShader(webGpu), { attributes: ["position"], uniforms: ["camRight", "camUp", "camForward", "useWhole", "srgbTexture"], samplers: ["previewCube", "wholeImage"], shaderLanguage: webGpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL });
  material.backFaceCulling = false; material.depthFunction = Constants.ALWAYS; material.disableDepthWrite = true;
  material.onError = (_effect, message) => { errors.push(message); };
  material.setFloat("srgbTexture", webGpu ? 1 : 0); material.setFloat("useWhole", 0);
  const mesh = new Mesh("control", scene), data = new VertexData();
  data.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0]; data.indices = [0, 1, 2]; data.applyToMesh(mesh);
  mesh.material = material; mesh.alwaysSelectAsActiveMesh = true;
  const placeholder = new RawTexture(new Uint8Array(4), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false);
  material.setTexture("wholeImage", placeholder);
  const aim = (camera: Camera) => {
    const { forward, right, up } = viewBasis(camera), { tanH, tanV } = planeExtents(viewport);
    material.setVector3("camForward", Vector3.FromArray(forward)); material.setVector3("camRight", Vector3.FromArray(right).scale(tanH)); material.setVector3("camUp", Vector3.FromArray(up).scale(tanV));
  };
  const timings: Record<string, number | null> = { previewRequested: null, previewArrived: null, previewShown: null, wholeRequested: null, wholeArrived: null, wholeDecoded: null, wholeShown: null };
  const fetchAll = async (urls: string[]) => Promise.all(urls.map(async url => new Uint8Array(await (await fetch(url, { cache: spec.cache ?? "default" })).arrayBuffer())));
  const bitmap = (bytes: Uint8Array) => createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  let state: "none" | "preview" | "whole" = "none", preview: PanoramaGpuTexture | null = null, whole: PanoramaGpuTexture | null = null;
  const began = performance.now(), at = () => performance.now() - began;

  const load = async () => {
    timings.previewRequested = at();
    const faces = await fetchAll(CUBE_FACE_NAMES.map(name => spec.data + control.previewFaces[name]));
    timings.previewArrived = at();
    const bitmaps = await Promise.all(faces.map(bitmap));
    preview = await uploader.uploadCube(Object.fromEntries(CUBE_FACE_NAMES.map((name, k) => [name, bitmaps[k]])) as Record<CubeFaceName, ImageBitmap>, "preview");
    material.setTexture("previewCube", preview.texture as BaseTexture); state = "preview"; timings.previewShown = at();
    timings.wholeRequested = at();
    const [bytes] = await fetchAll([spec.data + control.whole]);
    timings.wholeArrived = at();
    const image = await bitmap(bytes);
    timings.wholeDecoded = at();
    whole = await uploader.uploadEquirect(image, "whole");
    material.setTexture("wholeImage", whole.texture as BaseTexture); material.setFloat("useWhole", 1); state = "whole"; timings.wholeShown = at();
  };

  if (spec.mode === "replay") {
    // The uploads complete only while the uploader is pumped, a frame at a time, so load and pump together.
    let loaded = false;
    void load().catch(error => errors.push(String(error))).finally(() => { loaded = true; });
    // Nothing is drawn until both textures exist: WebGPU cannot bind a texture that is not there yet.
    mesh.setEnabled(false);
    while (!loaded || uploader.busy()) { uploader.pump(); renderFrame(); await nextFrame(); }
    mesh.setEnabled(true);
    window.eac.show = async (shown: unknown) => {
      const { camera, which, name } = shown as { camera: Camera; which: "preview" | "whole"; name: string };
      material.setFloat("useWhole", which === "whole" ? 1 : 0); aim(camera);
      const pixels = await capture();
      await sendResult(`${name}.rgba`, pixels as BlobPart as BodyInit, "application/octet-stream");
      return { width: viewport.width, height: viewport.height };
    };
    window.eac.ready = true; window.eac.result = { backend: info, viewport, errors };
    return;
  }

  const trace = cameraPath(spec.trace ?? "stationary", spec.start ?? "face-centre"), timer = gpuTimer(engine);
  const frames: number[][] = [], samples: Record<string, unknown>[] = [];
  void load().catch(error => errors.push(String(error)));
  await scene.whenReadyAsync();
  timer.begin();
  let previous = performance.now(), nextSample = 0;
  for (;;) {
    const frameStart = performance.now(), elapsed = at();
    if (elapsed > (trace.duration + (spec.tailSeconds ?? 0)) * 1000) break;
    const camera = trace.at(elapsed / 1000);
    const uploadStart = performance.now(), uploaded = uploader.pump(), pumped = performance.now();
    aim(camera);
    // Nothing to draw until the preview is up; the frame is still timed.
    mesh.setEnabled(state !== "none");
    renderFrame();
    const rendered = performance.now();
    timer.frame();
    frames.push([Number(elapsed.toFixed(2)), Number((frameStart - previous).toFixed(3)), Number((pumped - uploadStart).toFixed(3)), Number((rendered - pumped).toFixed(3)), uploaded]);
    previous = frameStart;
    if (elapsed >= nextSample) { samples.push({ t: Number(elapsed.toFixed(1)), camera, state }); nextSample += spec.config.quality.sampleMs; }
    await nextFrame();
  }
  const result = {
    runId: spec.runId, spec: { ...spec, config: undefined }, config: spec.config, backend: info, viewport, errors, control: { ...control, timings, uploaderStats: uploader.stats(), previewGpuBytes: (preview as PanoramaGpuTexture | null)?.gpuBytes ?? null, wholeGpuBytes: (whole as PanoramaGpuTexture | null)?.gpuBytes ?? null, wholeLevels: (whole as PanoramaGpuTexture | null)?.levels ?? null },
    gpu: timer.result(), frames, samples,
    resources: performance.getEntriesByType("resource").map(entry => { const item = entry as PerformanceResourceTiming; return { name: item.name.replace(location.origin, ""), startTime: item.startTime, responseEnd: item.responseEnd, transferSize: item.transferSize, encodedBodySize: item.encodedBodySize, protocol: item.nextHopProtocol }; }),
  };
  await sendResult(`${spec.runId}.json`, JSON.stringify(result), "application/json");
  window.eac = { done: true, result: { runId: spec.runId, frames: frames.length } };
}

// ─── Interactive use and the debug overlay ─────────────────────────────

function attachDrag(canvas: HTMLCanvasElement, camera: { yaw: number; pitch: number }) {
  let last: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", event => { last = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointerup", () => { last = null; });
  canvas.addEventListener("pointermove", event => {
    if (!last) return;
    const degreesPerPixel = spec.config.viewport.verticalFovDeg / innerHeight;
    camera.yaw -= (event.clientX - last.x) * degreesPerPixel; camera.pitch = Math.max(-89, Math.min(89, camera.pitch + (event.clientY - last.y) * degreesPerPixel));
    last = { x: event.clientX, y: event.clientY };
  });
}

/** The six faces unfolded, every finest cell coloured by the state of the tile it wants, labelled with its level. */
function createOverlay(tiling: Tiling, client: ReturnType<typeof createClient>) {
  const size = 18, C = tiling.cells, canvas = document.createElement("canvas");
  canvas.width = 3 * C * size; canvas.height = 2 * C * size + 18;
  canvas.style.cssText = "position:fixed;left:0;right:0;bottom:0;margin:auto;max-width:100%;opacity:0.85;pointer-events:none";
  document.body.append(canvas);
  const context = canvas.getContext("2d")!, colours: Record<string, string> = { absent: "#333", loading: "#36c", fetched: "#69f", decoding: "#c6f", decoded: "#f9c", resident: "#2a2" };
  let drawnAt = -Infinity;
  return {
    draw(now: number) {
      if (now - drawnAt < 250) return;
      drawnAt = now;
      const selection = client.selection;
      context.fillStyle = "#000"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.font = "10px system-ui"; context.textAlign = "center"; context.textBaseline = "middle";
      for (let cell = 0; cell < tiling.roots * C * C; cell++) {
        const face = Math.floor(cell / (C * C)), cx = cell % C, cy = Math.floor(cell / C) % C, x = ((face % 3) * C + cx) * size, y = (Math.floor(face / 3) * C + cy) * size;
        const level = selection?.cells[cell] ?? -1, shown = client.table[cell];
        if (level >= 0) {
          const shift = tiling.maxLevel - level, wanted = (tiling as unknown as { id(f: number, l: number, x: number, y: number): number }).id(face, level, cx >> shift, cy >> shift);
          context.fillStyle = colours[STATE_NAMES[client.stateOf(wanted)]];
        } else context.fillStyle = "#111";
        context.fillRect(x + 1, y + 1, size - 2, size - 2);
        context.fillStyle = selection?.inView[cell] ? "#fff" : "#888";
        context.fillText(shown < 0 ? "b" : String(tiling.level(shown)), x + size / 2, y + size / 2);
      }
      context.fillStyle = "#fff"; context.textAlign = "left";
      const { counters } = client;
      context.fillText(`requests ${counters.requests}  KiB ${Math.round(counters.bytesReceived / 1024)}  cancelled ${counters.cancelled}  evicted ${counters.evictions}  shown: level, b = bootstrap`, 4, 2 * C * size + 9);
    },
  };
}

main().catch(error => { window.eac = { done: true, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }; });
