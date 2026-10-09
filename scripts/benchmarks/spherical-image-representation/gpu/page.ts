/**
 * The GPU microbenchmark's page: the smallest Babylon scene that draws the
 * same panorama view from each candidate representation, two ways (ray lookup
 * and mesh patches; see shaders.ts), on WebGL 1, WebGL 2 or WebGPU. Driven by
 * ../run-gpu.mjs in headless Chrome on the machine's own GPU; no server.
 *
 * It measures, per variant: CPU time of the render call, GPU time where the
 * backend can time it, draw calls, triangles, texture memory, and what
 * uploading new detail does to frame times. Separately it times the browser's
 * own image decoding, which Node cannot.
 */
import {
  Color4, Constants, Engine, EngineInstrumentation, FreeCamera, Matrix, Mesh, RawCubeTexture, RawTexture, Scene, SceneInstrumentation,
  ShaderLanguage, ShaderMaterial, Vector2, Vector3, VertexData, WebGPUEngine, type AbstractEngine, type BaseTexture,
} from "@babylonjs/core";
import { representation } from "../lib/representations.mjs";
import { inverseHaarEqual, unpackIntegers, yccToRgba } from "../lib/decodeKernel.mjs";
import { lookupComplexity, patchShader, rayLookupShader, type LookupKind } from "./shaders";

interface AtlasInfo { url: string; width: number; height: number; chart: [number, number]; columns: number; rows: number; pitch: number }
interface Manifest {
  canvas: { width: number; height: number };
  fovDeg: number; frames: number; warmup: number; repeat: number; patchGrid: Record<string, number>;
  atlases: Record<string, AtlasInfo>;
  cubes: Record<string, { size: number; faces: string[] }>;
  tiles: { size: number; jpeg: string[]; webp: string[]; residual: string[]; parents: string; steps: number[]; whole: string; source: string | null };
  wasm: string | null;
}
interface Representation {
  id: string; charts: number;
  toDir(chart: number, u: number, v: number, out: number[]): void;
  fromDir(x: number, y: number, z: number, out: number[]): void;
}
type Backend = "webgl1" | "webgl2" | "webgpu";

const RAD = Math.PI / 180;
const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
function statistics(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, median: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1)!, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length };
}

// ─── Loading ───────────────────────────────────────────────────────────

async function fetchBytes(url: string) { return new Uint8Array(await (await fetch(url)).arrayBuffer()); }

/** The browser's own decoder: bytes → ImageBitmap, timed. */
async function decodeImage(bytes: Uint8Array, type: string) {
  const blob = new Blob([bytes as BlobPart], { type });
  const started = performance.now();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  return { bitmap, decodeMs: performance.now() - started };
}

/** ImageBitmap → RGBA bytes, the form every backend can upload, timed. */
function readBitmap(bitmap: ImageBitmap) {
  const started = performance.now();
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return { rgba: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), readMs: performance.now() - started };
}

async function loadRgba(url: string) {
  const bytes = await fetchBytes(url);
  const { bitmap, decodeMs } = await decodeImage(bytes, url.endsWith(".webp") ? "image/webp" : url.endsWith(".png") ? "image/png" : "image/jpeg");
  const { rgba, readMs } = readBitmap(bitmap);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { rgba, ...size, decodeMs, readMs, encodedBytes: bytes.length };
}

// ─── Scene ─────────────────────────────────────────────────────────────

async function createEngine(backend: Backend, canvas: HTMLCanvasElement): Promise<AbstractEngine> {
  if (backend === "webgpu") {
    const engine = new WebGPUEngine(canvas, { antialias: false, deviceDescriptor: { requiredFeatures: ["timestamp-query"] } });
    await engine.initAsync();
    return engine;
  }
  return new Engine(canvas, false, { disableWebGL2Support: backend === "webgl1", preserveDrawingBuffer: true, antialias: false });
}

/** Waits until the GPU has finished what was submitted, as far as the backend lets a page know. */
async function gpuIdle(engine: AbstractEngine) {
  const internals = engine as unknown as { _device?: { queue: { onSubmittedWorkDone(): Promise<void> } }; _gl?: { finish(): void } };
  if (internals._device) await internals._device.queue.onSubmittedWorkDone();
  else internals._gl?.finish();
}

function viewBasis(yawDeg: number, pitchDeg: number) {
  const cy = Math.cos(yawDeg * RAD), sy = Math.sin(yawDeg * RAD), cp = Math.cos(pitchDeg * RAD), sp = Math.sin(pitchDeg * RAD);
  return { forward: new Vector3(cp * sy, cp * cy, sp), right: new Vector3(cy, -sy, 0), up: new Vector3(-sy * sp, -cy * sp, cp) };
}

interface Variant {
  name: string; architecture: "ray lookup" | "mesh patches"; representation: string;
  textures: BaseTexture[]; textureBytes: number; meshes: Mesh[]; materials: ShaderMaterial[]; triangles: number;
  complexity: ReturnType<typeof lookupComplexity>; mappingError: { worstPitches: number; meanPitches: number } | null;
  dispose(): void;
}

export async function runGpuBenchmark(backend: Backend, manifest: Manifest, sections: string[]) {
  const canvas = document.createElement("canvas");
  canvas.width = manifest.canvas.width; canvas.height = manifest.canvas.height;
  canvas.style.cssText = `width:${manifest.canvas.width}px;height:${manifest.canvas.height}px`;
  document.body.append(canvas);
  const engine = await createEngine(backend, canvas);
  const webGpu = backend === "webgpu";
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0, 0, 0, 1);
  scene.skipFrustumClipping = true;
  scene.activeCamera = new FreeCamera("camera", Vector3.Zero(), scene);
  const sceneInstrumentation = new SceneInstrumentation(scene);
  const aspect = canvas.width / canvas.height, tanHalf = Math.tan(manifest.fovDeg * RAD / 2);
  const shaderLanguage = webGpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL;
  const errors: string[] = [];

  const glInfo = (() => {
    const gl = (engine as unknown as { _gl?: WebGLRenderingContext })._gl;
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    return { version: engine.description, webGLVersion: (engine as Engine).webGLVersion ?? null, renderer: gl && extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : null, caps: { timerQuery: Boolean(engine.getCaps().timerQuery), maxTextureSize: engine.getCaps().maxTextureSize } };
  })();

  // ── Textures ──
  const uploads: Record<string, unknown>[] = [];
  const flat = (rgba: Uint8Array, width: number, height: number) => {
    const texture = new RawTexture(rgba, width, height, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
    texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    return texture;
  };
  async function atlasTexture(id: string) {
    const info = manifest.atlases[id], image = await loadRgba(info.url);
    await gpuIdle(engine);
    const started = performance.now();
    const texture = flat(image.rgba, image.width, image.height);
    const callMs = performance.now() - started;
    await gpuIdle(engine);
    uploads.push({ texture: `${id} atlas`, width: image.width, height: image.height, bytes: image.rgba.length, encodedBytes: image.encodedBytes, decodeMs: image.decodeMs, readMs: image.readMs, uploadCallMs: callMs, uploadUntilIdleMs: performance.now() - started });
    return { texture, info, rgba: image.rgba };
  }
  async function cubeFaces(id: string) { return Promise.all(manifest.cubes[id].faces.map(loadRgba)); }
  async function cubeTexture(id: string) {
    const faces = await cubeFaces(id), size = manifest.cubes[id].size;
    await gpuIdle(engine);
    const started = performance.now();
    const texture = new RawCubeTexture(scene, faces.map(face => face.rgba), size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
    const callMs = performance.now() - started;
    await gpuIdle(engine);
    uploads.push({ texture: `${id} cube`, width: size, height: size, layers: 6, bytes: size * size * 24, encodedBytes: faces.reduce((sum, face) => sum + face.encodedBytes, 0), decodeMs: faces.reduce((sum, face) => sum + face.decodeMs, 0), readMs: faces.reduce((sum, face) => sum + face.readMs, 0), uploadCallMs: callMs, uploadUntilIdleMs: performance.now() - started });
    return texture;
  }

  // ── Geometry ──
  function triangleMesh() {
    const mesh = new Mesh("view-triangle", scene), data = new VertexData();
    data.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0]; data.indices = [0, 1, 2];
    data.applyToMesh(mesh);
    return mesh;
  }
  /**
   * The charts as a sphere of triangles: `grid` × `grid` quads per chart (twice as many across an
   * equirectangular chart). Each quad is split along the diagonal whose middle is nearer the map's
   * own centre of the quad, so a fold in the map becomes an edge. `only` builds one chart, with
   * texture coordinates over the whole of its own texture.
   *
   * `mappingError` is how far flat triangles put the image from where the map puts it: the
   * largest and mean angle, at seven points in every triangle, in units of the mean sample pitch.
   */
  function patchMesh(rep: Representation, info: AtlasInfo, grid: number, only = -1) {
    const [W, H] = info.chart, gx = Math.round(grid * W / H), gy = grid;
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [], out = [0, 0, 0], centre = [0, 0, 0];
    const inner = [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]];
    let worst = 0, sum = 0, points = 0;
    for (let chart = 0; chart < rep.charts; chart++) {
      if (only >= 0 && chart !== only) continue;
      const base = positions.length / 3, column = chart % info.columns, row = Math.floor(chart / info.columns);
      for (let j = 0; j <= gy; j++) for (let i = 0; i <= gx; i++) {
        rep.toDir(chart, i / gx, j / gy, out);
        positions.push(out[0], out[1], out[2]);
        if (only >= 0) uvs.push(i / gx, j / gy);
        else uvs.push((column * (W + 2) + 1 + i / gx * W) / info.width, (row * (H + 2) + 1 + j / gy * H) / info.height);
      }
      const at = (i: number, j: number) => base + j * (gx + 1) + i;
      const offCentre = (a: number, b: number) => {
        const x = positions[a * 3] + positions[b * 3], y = positions[a * 3 + 1] + positions[b * 3 + 1], z = positions[a * 3 + 2] + positions[b * 3 + 2], length = Math.hypot(x, y, z);
        return Math.hypot(x / length - centre[0], y / length - centre[1], z / length - centre[2]);
      };
      for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
        const corners = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]];
        const [p00, p10, p01, p11] = corners.map(([ci, cj]) => at(ci, cj));
        rep.toDir(chart, (i + 0.5) / gx, (j + 0.5) / gy, centre);
        const triangles = offCentre(p10, p01) <= offCentre(p00, p11) ? [[0, 1, 2], [3, 2, 1]] : [[0, 1, 3], [0, 3, 2]];
        for (const triangle of triangles) {
          const [a, b, c] = triangle.map(k => at(corners[k][0], corners[k][1]));
          indices.push(a, b, c);
          for (const [wa, wb, wc] of inner) {
            const x = wa * positions[a * 3] + wb * positions[b * 3] + wc * positions[c * 3], y = wa * positions[a * 3 + 1] + wb * positions[b * 3 + 1] + wc * positions[c * 3 + 1], z = wa * positions[a * 3 + 2] + wb * positions[b * 3 + 2] + wc * positions[c * 3 + 2];
            const length = Math.hypot(x, y, z);
            rep.toDir(chart, (wa * corners[triangle[0]][0] + wb * corners[triangle[1]][0] + wc * corners[triangle[2]][0]) / gx, (wa * corners[triangle[0]][1] + wb * corners[triangle[1]][1] + wc * corners[triangle[2]][1]) / gy, out);
            const error = 2 * Math.asin(Math.min(1, Math.hypot(x / length - out[0], y / length - out[1], z / length - out[2]) / 2)) / info.pitch;
            worst = Math.max(worst, error); sum += error; points++;
          }
        }
      }
    }
    const mesh = new Mesh(`${rep.id}-patches`, scene), data = new VertexData();
    data.positions = positions; data.uvs = uvs; data.indices = indices;
    data.applyToMesh(mesh);
    return { mesh, triangles: indices.length / 3, mappingError: only >= 0 ? null : { worstPitches: worst, meanPitches: sum / points } };
  }

  /**
   * Every draw blends, as the production panorama does unless its opaque experiment is on. It
   * also makes the repeated copies cost what they should: a tile-based GPU shades an opaque pixel
   * once however many opaque triangles cover it, but must shade every blended layer.
   */
  function prepare(material: ShaderMaterial, mesh: Mesh) {
    material.backFaceCulling = false;
    material.depthFunction = Constants.ALWAYS;
    material.disableDepthWrite = true;
    material.onError = (_effect, message) => { errors.push(`${material.name}: ${message}`); };
    mesh.material = material;
    mesh.alwaysSelectAsActiveMesh = true;
  }

  async function rayVariant(kind: LookupKind): Promise<Variant> {
    const material = new ShaderMaterial(`ray-${kind}`, scene, rayLookupShader(kind, webGpu), {
      attributes: ["position"], uniforms: ["camRight", "camUp", "camForward", "chartSize", "atlasSize"], samplers: ["panoTexture", "panoCube"], shaderLanguage, needAlphaBlending: true,
    });
    let texture: BaseTexture, bytes: number;
    if (kind === "cube" || kind === "eac") {
      texture = await cubeTexture(kind);
      bytes = manifest.cubes[kind].size ** 2 * 24;
      material.setTexture("panoCube", texture);
    } else {
      const atlas = await atlasTexture(kind);
      texture = atlas.texture; bytes = atlas.rgba.length;
      material.setTexture("panoTexture", texture);
      material.setVector2("chartSize", new Vector2(atlas.info.chart[0], atlas.info.chart[1]));
      material.setVector2("atlasSize", new Vector2(atlas.info.width, atlas.info.height));
    }
    const mesh = triangleMesh();
    prepare(material, mesh);
    return { name: `ray lookup, ${kind}`, architecture: "ray lookup", representation: kind, textures: [texture], textureBytes: bytes, meshes: [mesh], materials: [material], triangles: 1, complexity: lookupComplexity(kind), mappingError: null, dispose() { mesh.dispose(); material.dispose(); texture.dispose(); } };
  }

  async function patchVariant(id: string): Promise<Variant> {
    const atlas = await atlasTexture(id);
    const material = new ShaderMaterial(`patch-${id}`, scene, patchShader(webGpu), { attributes: ["position", "uv"], uniforms: ["viewRotProj"], samplers: ["panoTexture"], shaderLanguage, needAlphaBlending: true });
    material.setTexture("panoTexture", atlas.texture);
    const built = patchMesh(representation(id) as Representation, atlas.info, manifest.patchGrid[id]);
    prepare(material, built.mesh);
    return { name: `mesh patches, ${id}`, architecture: "mesh patches", representation: id, textures: [atlas.texture], textureBytes: atlas.rgba.length, meshes: [built.mesh], materials: [material], triangles: built.triangles, complexity: lookupComplexity("patch"), mappingError: built.mappingError, dispose() { built.mesh.dispose(); material.dispose(); atlas.texture.dispose(); } };
  }

  /** The cube with one texture and one draw per face: what a cell-per-draw design would cost in draw calls. */
  async function perFaceVariant(): Promise<Variant> {
    const faces = await cubeFaces("cube"), size = manifest.cubes.cube.size, rep = representation("cube") as Representation;
    // Faces arrive in the GPU's cube order; the representation's charts are px, nx, py, ny, pz, nz.
    const chartOfLayer = [0, 1, 4, 5, 2, 3];
    const info: AtlasInfo = { url: "", width: size, height: size, chart: [size, size], columns: 1, rows: 1, pitch: 1 };
    const variant: Variant = { name: "mesh patches, cube, one texture per face", architecture: "mesh patches", representation: "cube", textures: [], textureBytes: size * size * 24, meshes: [], materials: [], triangles: 0, complexity: lookupComplexity("patch"), mappingError: null, dispose() { for (const item of [...this.meshes, ...this.materials, ...this.textures]) item.dispose(); } };
    faces.forEach((face, layer) => {
      const texture = flat(face.rgba, size, size);
      const material = new ShaderMaterial(`face-${layer}`, scene, patchShader(webGpu), { attributes: ["position", "uv"], uniforms: ["viewRotProj"], samplers: ["panoTexture"], shaderLanguage, needAlphaBlending: true });
      material.setTexture("panoTexture", texture);
      const built = patchMesh(rep, info, manifest.patchGrid.cube, chartOfLayer[layer]);
      prepare(material, built.mesh);
      variant.textures.push(texture); variant.materials.push(material); variant.meshes.push(built.mesh); variant.triangles += built.triangles;
    });
    return variant;
  }

  function aim(variant: Variant, yaw: number, pitch: number) {
    const { forward, right, up } = viewBasis(yaw, pitch);
    const view = Matrix.LookAtRH(Vector3.Zero(), forward, up);
    const projection = Matrix.PerspectiveFovRH(manifest.fovDeg * RAD, aspect, 0.01, 10, engine.isNDCHalfZRange);
    const viewRotProj = view.multiply(projection);
    for (const material of variant.materials) {
      material.setVector3("camRight", right.scale(tanHalf * aspect));
      material.setVector3("camUp", up.scale(tanHalf));
      material.setVector3("camForward", forward);
      material.setMatrix("viewRotProj", viewRotProj);
    }
  }

  /** One frame, bracketed as Babylon's render loop brackets it: the GPU timers and WebGPU's presentation depend on it. */
  function renderFrame() {
    engine.beginFrame();
    scene.render();
    engine.endFrame();
  }

  // ── GPU time ──
  const engineInstrumentation = webGpu ? null : new EngineInstrumentation(engine);
  if (engineInstrumentation) engineInstrumentation.captureGPUFrameTime = true;
  const webGpuEngine = engine as unknown as { enableGPUTimingMeasurements: boolean; gpuTimeInFrameForMainPass?: { counter: { total: number; count: number } } };
  if (webGpu) webGpuEngine.enableGPUTimingMeasurements = true;
  function gpuProbe() {
    const counter = webGpu ? webGpuEngine.gpuTimeInFrameForMainPass?.counter : null;
    const start = counter ? { total: counter.total, count: counter.count } : null;
    const readings: number[] = [];
    return {
      frame() { if (engineInstrumentation && engineInstrumentation.gpuFrameTimeCounter.current > 0) readings.push(engineInstrumentation.gpuFrameTimeCounter.current / 1e6); },
      result() {
        if (counter && start) {
          const frames = counter.count - start.count;
          return frames > 0 ? { meanMs: (counter.total - start.total) / frames / 1e6, readings: frames, distinctReadings: frames, source: "WebGPU render-pass timestamps" } : { meanMs: null, readings: 0, distinctReadings: 0, source: "WebGPU render-pass timestamps unavailable" };
        }
        const distinct = new Set(readings).size;
        return { meanMs: readings.length ? readings.reduce((sum, value) => sum + value, 0) / readings.length : null, readings: readings.length, distinctReadings: distinct, source: "WebGL disjoint timer query, whole frames" };
      },
    };
  }

  /** Frames of a slow pan, with the variant drawn `copies` times over, so GPU time rises above the timer's floor. */
  async function timeFrames(variant: Variant, copies: number, frames: number, perFrame?: (frame: number) => void | Promise<void>) {
    const clones = variant.meshes.flatMap(mesh => Array.from({ length: copies - 1 }, (_, k) => { const clone = mesh.clone(`${mesh.name}-${k}`); clone.alwaysSelectAsActiveMesh = true; return clone; }));
    aim(variant, 0, 0);
    renderFrame();
    await scene.whenReadyAsync();
    for (let i = 0; i < manifest.warmup; i++) { aim(variant, i, 0); renderFrame(); await nextFrame(); }
    const cpu: number[] = [], work: number[] = [], intervals: number[] = [], draws: number[] = [];
    const probe = gpuProbe();
    // Intervals are between the moments the frame callbacks ran, on the page's own clock. The time
    // requestAnimationFrame hands over is the frame the compositor scheduled, which stays on
    // its 16.67 ms grid even when the callback ran late.
    await nextFrame();
    let last = performance.now();
    for (let frame = 0; frame < frames; frame++) {
      const started = performance.now();
      if (perFrame) await perFrame(frame);
      aim(variant, frame * 1.5, 12 * Math.sin(frame / 20));
      const renderStarted = performance.now();
      renderFrame();
      const finished = performance.now();
      cpu.push(finished - renderStarted); work.push(finished - started); draws.push(sceneInstrumentation.drawCallsCounter.current);
      probe.frame();
      await nextFrame();
      const now = performance.now();
      intervals.push(now - last); last = now;
    }
    for (const clone of clones) clone.dispose();
    return { cpuRenderMs: statistics(cpu), cpuFrameWorkMs: statistics(work), frameIntervalMs: statistics(intervals), framesOver20Ms: intervals.filter(value => value > 20).length, drawCalls: statistics(draws)?.median ?? null, gpu: probe.result() };
  }

  async function readback(variant: Variant) {
    aim(variant, 20, 5);
    renderFrame();
    await scene.whenReadyAsync();
    await nextFrame();
    const size = 512, x = Math.floor((canvas.width - size) / 2), y = Math.floor((canvas.height - size) / 2);
    // Read inside the frame, before it is presented: WebGPU's canvas texture is gone afterwards.
    engine.beginFrame();
    scene.render();
    const reading = engine.readPixels(x, y, size, size);
    engine.endFrame();
    const pixels = await reading;
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength).slice();
  }
  function difference(a: Uint8Array, b: Uint8Array) {
    let squared = 0, absolute = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; squared += d * d; absolute += Math.abs(d); n++; }
    return { psnr: squared ? 10 * Math.log10(255 * 255 * n / squared) : 100, meanAbsolute: absolute / n };
  }

  const result: Record<string, unknown> = { backend, info: glInfo, crossOriginIsolated: self.crossOriginIsolated, canvas: manifest.canvas, errors };

  // ── Rendering: every variant ──
  if (sections.includes("render")) {
    const builders: (() => Promise<Variant>)[] = [
      ...(["equirect", "cube", "eac", "oct-ea", "healpix"] as LookupKind[]).map(kind => () => rayVariant(kind)),
      ...["equirect", "cube", "eac", "oct-ea", "toast", "healpix", "ico-rhombus"].map(id => () => patchVariant(id)),
      perFaceVariant,
    ];
    const rows: Record<string, unknown>[] = [];
    let reference: Uint8Array | null = null;
    const byRepresentation = new Map<string, Uint8Array>();
    for (const build of builders) {
      const variant = await build();
      try {
        const pixels = await readback(variant);
        reference ??= pixels;
        const sameRepresentation = byRepresentation.get(variant.representation);
        if (!sameRepresentation) byRepresentation.set(variant.representation, pixels);
        const once = await timeFrames(variant, 1, manifest.frames), many = await timeFrames(variant, manifest.repeat, manifest.frames);
        const perCopy = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : (b - a) / (manifest.repeat - 1));
        rows.push({
          variant: variant.name, architecture: variant.architecture, representation: variant.representation,
          triangles: variant.triangles, textures: variant.textures.length, textureBytes: variant.textureBytes,
          mappingError: variant.mappingError, shader: variant.complexity,
          once, repeated: { copies: manifest.repeat, ...many },
          // One more copy of the panorama per frame costs this much: the part of the frame that is the panorama.
          gpuMsPerCopy: perCopy(once.gpu.meanMs, many.gpu.meanMs), cpuRenderMsPerCopy: perCopy(once.cpuRenderMs?.median, many.cpuRenderMs?.median),
          againstFirstVariant: difference(pixels, reference),
          againstSameRepresentation: sameRepresentation ? difference(pixels, sameRepresentation) : null,
        });
      } catch (error) {
        rows.push({ variant: variant.name, error: String(error) });
      }
      variant.dispose();
      await gpuIdle(engine);
    }
    result.render = rows;
    result.uploads = uploads;
  }

  // ── Refinement: new detail arriving while the view moves ──
  if (sections.includes("refine")) {
    const variant = await patchVariant("healpix");
    const atlas = manifest.atlases.healpix, tile = manifest.tiles.size, internal = variant.textures[0].getInternalTexture()!;
    const tileRgba = (await loadRgba(manifest.tiles.jpeg[0])).rgba;
    const jpegTiles = await Promise.all(manifest.tiles.jpeg.map(fetchBytes));
    const residualTiles = await Promise.all(manifest.tiles.residual.map(fetchBytes));
    const parents = new Float32Array((await fetchBytes(manifest.tiles.parents)).buffer);
    const half = tile / 2, steps = Float32Array.from(manifest.tiles.steps);
    const integers = new Int32Array(half * half * 9), children = new Float32Array(tile * tile * 3), decoded = new Uint8Array(tile * tile * 4);
    const whole = await loadRgba(manifest.atlases.healpix.url);
    const slot = (k: number) => [1 + (k % 7) * tile, 1 + (Math.floor(k / 7) % 5) * tile] as const;
    const put = (rgba: Uint8Array, k: number) => { const [x, y] = slot(k); engine.updateTextureData(internal, rgba, x, y, tile, tile); };
    async function inflate(bytes: Uint8Array) {
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const packed = await Promise.all(residualTiles.map(inflate));
    const scenarios: Record<string, unknown> = {};
    const frames = manifest.frames;
    scenarios["no uploads"] = await timeFrames(variant, 1, frames);
    scenarios["one decoded tile uploaded per frame"] = await timeFrames(variant, 1, frames, frame => put(tileRgba, frame));
    scenarios["four decoded tiles uploaded per frame"] = await timeFrames(variant, 1, frames, frame => { for (let k = 0; k < 4; k++) put(tileRgba, frame * 4 + k); });
    scenarios["one residual tile decoded in JavaScript and uploaded per frame"] = await timeFrames(variant, 1, frames, frame => {
      const k = frame % packed.length;
      unpackIntegers(packed[k], integers);
      inverseHaarEqual(parents.subarray(k * half * half * 3, (k + 1) * half * half * 3), integers, half, half, steps, children);
      yccToRgba(children, tile * tile, decoded);
      put(decoded, frame);
    });
    scenarios["one JPEG tile decoded by the browser and uploaded per frame"] = await timeFrames(variant, 1, frames, async frame => {
      const { bitmap } = await decodeImage(jpegTiles[frame % jpegTiles.length], "image/jpeg");
      put(readBitmap(bitmap).rgba, frame);
      bitmap.close();
    });
    scenarios[`the whole ${atlas.width} × ${atlas.height} atlas uploaded at once, every 60th frame`] = await timeFrames(variant, 1, frames, frame => {
      if (frame % 60 === 30) engine.updateTextureData(internal, whole.rgba, 0, 0, atlas.width, atlas.height);
    });
    if (manifest.tiles.source) {
      // The size the tour's current whole-image path uploads: a new texture, filled at once, twice.
      const big = await loadRgba(manifest.tiles.source);
      const made: RawTexture[] = [];
      scenarios[`a new ${big.width} × ${big.height} texture filled at once, twice`] = await timeFrames(variant, 1, frames, frame => {
        if (frame === 30 || frame === Math.floor(frames / 2) + 30) made.push(flat(big.rgba, big.width, big.height));
      });
      for (const texture of made) texture.dispose();
    }
    result.refine = { texture: `${atlas.width} × ${atlas.height} RGBA8`, tile, scenarios };
    variant.dispose();
  }

  // ── Decoding: what the browser does natively, and the same kernel as run-cpu.mjs ──
  if (sections.includes("decode")) {
    const rows: Record<string, unknown>[] = [];
    async function decodeSet(label: string, urls: string[], type: string) {
      const files = await Promise.all(urls.map(fetchBytes));
      for (const file of files.slice(0, 8)) (await decodeImage(file, type)).bitmap.close();
      const decode: number[] = [], read: number[] = [];
      let pixels = 0;
      for (let round = 0; round < Math.max(1, Math.ceil(60 / files.length)); round++) for (const file of files) {
        const { bitmap, decodeMs } = await decodeImage(file, type);
        decode.push(decodeMs); read.push(readBitmap(bitmap).readMs); pixels = bitmap.width * bitmap.height;
        bitmap.close();
      }
      const d = statistics(decode)!, r = statistics(read)!;
      rows.push({ operation: `${label}: createImageBitmap`, runsIn: "browser native", samples: pixels, encodedBytes: files.reduce((sum, file) => sum + file.length, 0) / files.length, ...d, megasamplesPerSecond: pixels / 1e6 / (d.median / 1000) });
      rows.push({ operation: `${label}: ImageBitmap to RGBA bytes`, runsIn: "browser native", samples: pixels, ...r, megasamplesPerSecond: pixels / 1e6 / (r.median / 1000) });
    }
    const tile = manifest.tiles.size;
    await decodeSet(`JPEG tile ${tile}²`, manifest.tiles.jpeg, "image/jpeg");
    await decodeSet(`WebP tile ${tile}²`, manifest.tiles.webp, "image/webp");
    await decodeSet("JPEG, whole equirectangular 2560 × 1280", [manifest.tiles.whole], "image/jpeg");
    if (manifest.tiles.source) await decodeSet("JPEG, the source 6144 × 3072", [manifest.tiles.source], "image/jpeg");

    const residual = await Promise.all(manifest.tiles.residual.map(fetchBytes));
    const parents = new Float32Array((await fetchBytes(manifest.tiles.parents)).buffer);
    const half = tile / 2, steps = Float32Array.from(manifest.tiles.steps);
    const integers = new Int32Array(half * half * 9), children = new Float32Array(tile * tile * 3), rgba = new Uint8Array(tile * tile * 4);
    const inflate = async (bytes: Uint8Array) => new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    const packed = await Promise.all(residual.map(inflate));
    async function time(operation: string, runsIn: string, run: (k: number) => void | Promise<void>) {
      for (let i = 0; i < 100; i++) await run(i % residual.length);
      const times: number[] = [];
      for (let i = 0; i < 300; i++) { const started = performance.now(); await run(i % residual.length); times.push(performance.now() - started); }
      const s = statistics(times)!;
      rows.push({ operation, runsIn, samples: tile * tile, ...s, megasamplesPerSecond: tile * tile / 1e6 / (s.median / 1000) });
    }
    await time("inflate one residual tile: DecompressionStream", "browser native", async k => { await inflate(residual[k]); });
    await time("unpack integers", "JavaScript", k => { unpackIntegers(packed[k], integers); });
    await time("inverse transform, equal areas", "JavaScript", k => { inverseHaarEqual(parents.subarray(k * half * half * 3, (k + 1) * half * half * 3), integers, half, half, steps, children); });
    await time("Y′CbCr to RGBA", "JavaScript", () => { yccToRgba(children, tile * tile, rgba); });
    await time("residual tile, whole decode", "JavaScript + native inflate", async k => {
      unpackIntegers(await inflate(residual[k]), integers);
      inverseHaarEqual(parents.subarray(k * half * half * 3, (k + 1) * half * half * 3), integers, half, half, steps, children);
      yccToRgba(children, tile * tile, rgba);
    });
    if (manifest.wasm) {
      const { instance } = await WebAssembly.instantiate(await fetchBytes(manifest.wasm), {});
      const e = instance.exports as unknown as { memory: WebAssembly.Memory; malloc(bytes: number): number; _initialize?(): void; unpack_integers(bytes: number, values: number, count: number): number; inverse_haar_equal(parent: number, details: number, width: number, height: number, steps: number, out: number): void; ycc_to_rgba(planes: number, count: number, rgba: number): void };
      e._initialize?.();
      const p = { bytes: e.malloc(half * half * 45), integers: e.malloc(half * half * 36), parent: e.malloc(half * half * 12), steps: e.malloc(36), children: e.malloc(tile * tile * 12), rgba: e.malloc(tile * tile * 4) };
      new Float32Array(e.memory.buffer, p.steps, 9).set(steps);
      const load = (k: number) => { new Uint8Array(e.memory.buffer, p.bytes, packed[k].length).set(packed[k]); new Float32Array(e.memory.buffer, p.parent, half * half * 3).set(parents.subarray(k * half * half * 3, (k + 1) * half * half * 3)); };
      load(0);
      await time("unpack integers", "WebAssembly", () => { e.unpack_integers(p.bytes, p.integers, half * half * 9); });
      await time("inverse transform, equal areas", "WebAssembly", () => { e.inverse_haar_equal(p.parent, p.integers, half, half, p.steps, p.children); });
      await time("Y′CbCr to RGBA", "WebAssembly", () => { e.ycc_to_rgba(p.children, tile * tile, p.rgba); });
      await time("residual tile, whole decode", "WebAssembly + native inflate", async k => {
        const bytes = await inflate(residual[k]);
        new Uint8Array(e.memory.buffer, p.bytes, bytes.length).set(bytes);
        new Float32Array(e.memory.buffer, p.parent, half * half * 3).set(parents.subarray(k * half * half * 3, (k + 1) * half * half * 3));
        e.unpack_integers(p.bytes, p.integers, half * half * 9);
        e.inverse_haar_equal(p.parent, p.integers, half, half, p.steps, p.children);
        e.ycc_to_rgba(p.children, tile * tile, p.rgba);
        rgba.set(new Uint8Array(e.memory.buffer, p.rgba, tile * tile * 4));
      });
    }
    result.decode = rows;
  }

  engine.dispose();
  return result;
}

declare global { interface Window { gpuBenchmark?: { done: boolean; result?: unknown; error?: string } } }
const parameters = new URLSearchParams(location.search);
window.gpuBenchmark = { done: false };
fetch("/data/manifest.json").then(response => response.json() as Promise<Manifest>)
  .then(manifest => runGpuBenchmark((parameters.get("backend") ?? "webgl2") as Backend, manifest, (parameters.get("sections") ?? "render,refine,decode").split(",")))
  .then(result => { window.gpuBenchmark = { done: true, result }; })
  .catch(error => { window.gpuBenchmark = { done: true, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }; });
