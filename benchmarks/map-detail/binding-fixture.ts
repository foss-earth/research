/**
 * Map detail binding fixtures: the real raster runtime in atlas mode, with
 * synthetic colour-coded imagery on flat terrain, rendered by the real
 * engine on the current backend. Every tile image encodes its identity, so a
 * rendered pixel can be checked against the ground it shows.
 *
 * Solid mode: each image is one colour that names its tile. With gutters and
 * per-page mips, any pixel that is not exactly a known colour is bleed from
 * another page, an uninitialised slot, or a stale table entry.
 * Gradient mode: red and green are the texel's column and row inside the
 * tile, blue names the level. That checks orientation, placement and
 * high-zoom precision against the picked ground point.
 */

import {
  Color4,
  Engine,
  FreeCamera,
  Matrix,
  Quaternion,
  RenderTargetTexture,
  TransformNode,
  Vector3,
  GeospatialCamera,
  GeospatialClippingBehavior,
  VertexBuffer,
  type Scene,
} from "@babylonjs/core";
import { Scene as BabylonScene } from "@babylonjs/core";
import { CameraController } from "../../src/camera/cameraState";
import { ecefToGeodetic } from "../../src/camera/cameraMath";
import { createRendererMode, type RendererMode } from "../../src/engine/babylon/createRendererMode";
import { createRasterTilesRuntime } from "../../src/engine/babylon/createRasterTilesRuntime";
import type { RasterBaseMapSource } from "../../src/engine/babylon/rasterBaseMaps";
import { preparePages } from "../../src/engine/babylon/imagery/imageryPagePreparation";
import type { ImageryLoader, PreparedImage } from "../../src/engine/babylon/imagery/imageryResidency";
import { lonLatToTileXY } from "../../src/terrain/imagery/imageryGeometry";

type Mode = "solid" | "gradient";

interface FixtureView {
  latDeg: number;
  lonDeg: number;
  zoomMeters: number;
  pitchDeg: number;
  headingDeg: number;
}

interface Scenario {
  name: string;
  mode: Mode;
  kind: "photographic" | "cartographic";
  view: FixtureView;
  offset: number;
  variants?: boolean;
  churn?: boolean;
  /** Render under a floating-origin parent that moves and turns the world and the camera together. */
  floatingOrigin?: boolean;
}

const BACKGROUND = [255, 0, 255];
const PICK_OFFSET: [number, number] = [0.5, 0.5];
const WIDTH = 960;
const HEIGHT = 540;

const SCENARIOS: Scenario[] = [
  { name: "overhead", mode: "solid", kind: "photographic", offset: 0, view: { latDeg: 36.1, lonDeg: -112.1, zoomMeters: 3000, pitchDeg: 89, headingDeg: 0 } },
  { name: "oblique", mode: "solid", kind: "photographic", offset: 0, view: { latDeg: 47.6, lonDeg: -122.3, zoomMeters: 1500, pitchDeg: 30, headingDeg: 30 } },
  { name: "near-horizon", mode: "solid", kind: "photographic", offset: 0, view: { latDeg: 47.6, lonDeg: -122.3, zoomMeters: 600, pitchDeg: 7, headingDeg: 90 } },
  { name: "finer-offset", mode: "solid", kind: "photographic", offset: 1, view: { latDeg: 36.1, lonDeg: -112.1, zoomMeters: 3000, pitchDeg: 50, headingDeg: 0 } },
  { name: "cartographic-variant", mode: "solid", kind: "cartographic", variants: true, offset: 1, view: { latDeg: 51.5, lonDeg: -0.12, zoomMeters: 2500, pitchDeg: 60, headingDeg: 0 } },
  { name: "gradient-overhead", mode: "gradient", kind: "photographic", offset: 0, view: { latDeg: 36.1, lonDeg: -112.1, zoomMeters: 3000, pitchDeg: 85, headingDeg: 0 } },
  // 512-pixel variants split into four pages: a swapped quadrant would misplace texels.
  { name: "gradient-variant", mode: "gradient", kind: "cartographic", variants: true, offset: 1, view: { latDeg: 51.5, lonDeg: -0.12, zoomMeters: 2500, pitchDeg: 60, headingDeg: 0 } },
  { name: "gradient-high-zoom-dateline", mode: "gradient", kind: "photographic", offset: 1, view: { latDeg: 60, lonDeg: 179.9995, zoomMeters: 80, pitchDeg: 40, headingDeg: 90 } },
  { name: "churn", mode: "solid", kind: "photographic", offset: 0, churn: true, view: { latDeg: 40.7, lonDeg: -74, zoomMeters: 2000, pitchDeg: 35, headingDeg: 0 } },
  { name: "floating-origin", mode: "gradient", kind: "photographic", offset: 0, floatingOrigin: true, view: { latDeg: 47.6, lonDeg: -122.3, zoomMeters: 1500, pitchDeg: 30, headingDeg: 30 } },
];

/** Tile identities by colour index; each image gets a colour that names it. */
const registry: string[] = [];
const registryIndex = new Map<string, number>();
function colourIndex(key: string): number {
  let index = registryIndex.get(key);
  if (index === undefined) {
    index = registry.length;
    registry.push(key);
    registryIndex.set(key, index);
  }
  return index;
}
function colourFor(index: number): [number, number, number] {
  return [2 + 4 * (index & 63), 2 + 4 * ((index >> 6) & 63), 2 + 4 * ((index >> 12) & 63)];
}
function indexForColour(r: number, g: number, b: number): number | null {
  const channel = (value: number) => {
    const step = Math.round((value - 2) / 4);
    return step >= 0 && step < 64 && Math.abs(value - (2 + 4 * step)) <= 1 ? step : null;
  };
  const a = channel(r), c = channel(g), d = channel(b);
  if (a === null || c === null || d === null) return null;
  const index = a | (c << 6) | (d << 12);
  return index < registry.length ? index : null;
}

function descriptor(scenario: Scenario): RasterBaseMapSource {
  const base = `fixture://${scenario.mode}`;
  return {
    id: `fixture-${scenario.mode}-${scenario.kind}`,
    label: "Fixture",
    provider: "Fixture",
    protocol: "xyz",
    urlTemplate: `${base}/std/{z}/{x}/{y}`,
    attribution: "Synthetic fixture",
    kind: scenario.kind,
    version: "1",
    tileSize: { width: 256, height: 256 },
    variants: scenario.variants ? [{ id: "2x", width: 512, height: 512, urlTemplate: `${base}/2x/{z}/{x}/{y}`, preservesContent: true }] : [],
    minZoom: 0,
    maxZoom: 20,
  };
}

function fixtureLoader(delayMs: () => number): ImageryLoader & { requests: number } {
  const loader = {
    requests: 0,
    async load(url: string, expected: { width: number; height: number }): Promise<PreparedImage> {
      loader.requests += 1;
      const match = /^fixture:\/\/(solid|gradient)\/(std|2x)\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
      if (!match) throw new Error(`Unexpected fixture URL ${url}`);
      const [, mode, variant, zs, xs, ys] = match;
      const z = Number(zs), x = Number(xs), y = Number(ys);
      const { width, height } = expected;
      const data = new Uint8ClampedArray(width * height * 4);
      const solid = colourFor(colourIndex(`${z}/${x}/${y}`));
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const i = (row * width + col) * 4;
        if (mode === "solid") {
          data[i] = solid[0]; data[i + 1] = solid[1]; data[i + 2] = solid[2];
        } else {
          data[i] = Math.floor((col * 256) / width);
          data[i + 1] = Math.floor((row * 256) / height);
          data[i + 2] = 8 * z + 2 * (y & 1) + (x & 1);
        }
        data[i + 3] = 255;
      }
      void variant;
      const wait = delayMs();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      return { width, height, pages: preparePages(data, width, height), compressedBytes: null };
    },
  };
  return loader;
}

/**
 * Renders the camera into a single-sample target and reads it back top-down,
 * so no multisampling blends colours at mesh seams.
 */
async function capture(scene: Scene): Promise<Uint8Array> {
  const engine = scene.getEngine();
  const target = new RenderTargetTexture("fixture-capture", { width: WIDTH, height: HEIGHT }, scene, false);
  target.renderList = scene.meshes.slice();
  target.activeCamera = scene.activeCamera;
  target.clearColor = scene.clearColor;
  engine.beginFrame();
  target.render(true);
  engine.endFrame();
  const data = await target.readPixels();
  target.dispose();
  if (!data) throw new Error("No pixels were captured.");
  const source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // Render targets read back bottom-up on every backend Babylon supports.
  const flip = true;
  const out = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let row = 0; row < HEIGHT; row++) {
    const from = (flip ? HEIGHT - 1 - row : row) * WIDTH * 4;
    out.set(source.subarray(from, from + WIDTH * 4), row * WIDTH * 4);
  }
  return out;
}

function toPng(pixels: Uint8Array): string {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d")!;
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), WIDTH, HEIGHT), 0, 0);
  return canvas.toDataURL("image/png");
}

interface ImageCheck {
  terrainPixels: number;
  foreignPixels: number;
  foreignSamples: Array<{ x: number; y: number; rgb: number[] }>;
}

/** Every terrain pixel away from the silhouette must be exactly a tile colour. */
function checkSolid(pixels: Uint8Array): ImageCheck {
  const isBackground = (x: number, y: number) => {
    const i = (y * WIDTH + x) * 4;
    return Math.abs(pixels[i] - BACKGROUND[0]) + Math.abs(pixels[i + 1] - BACKGROUND[1]) + Math.abs(pixels[i + 2] - BACKGROUND[2]) < 24;
  };
  let terrainPixels = 0, foreignPixels = 0;
  const foreignSamples: ImageCheck["foreignSamples"] = [];
  for (let y = 1; y < HEIGHT - 1; y++) for (let x = 1; x < WIDTH - 1; x++) {
    if (isBackground(x, y) || isBackground(x - 1, y) || isBackground(x + 1, y) || isBackground(x, y - 1) || isBackground(x, y + 1)) continue;
    terrainPixels += 1;
    const i = (y * WIDTH + x) * 4;
    if (indexForColour(pixels[i], pixels[i + 1], pixels[i + 2]) === null) {
      foreignPixels += 1;
      if (foreignSamples.length < 8) foreignSamples.push({ x, y, rgb: [pixels[i], pixels[i + 1], pixels[i + 2]] });
    }
  }
  return { terrainPixels, foreignPixels, foreignSamples };
}

interface PlacementCheck {
  probes: number;
  misplaced: number;
  maxTexelError: number | null;
  /** Mean signed texel error (rendered minus expected), gradient mode. */
  meanError: [number, number] | null;
  samples: Array<Record<string, unknown>>;
}

/** Picks the ground under a grid of pixels and checks the tile or texel each shows. */
function checkPlacement(scene: Scene, pixels: Uint8Array, mode: Mode, worldToEcef: Matrix | null): PlacementCheck {
  let probes = 0, misplaced = 0;
  let maxTexelError: number | null = null;
  let sumU = 0, sumV = 0, counted = 0;
  const samples: Array<Record<string, unknown>> = [];
  for (let gy = 1; gy < 12; gy++) for (let gx = 1; gx < 20; gx++) {
    const x = Math.round((gx * WIDTH) / 20), y = Math.round((gy * HEIGHT) / 12);
    // Pick through the pixel's centre, where the capture sampled it.
    const hit = scene.pick(x + PICK_OFFSET[0], y + PICK_OFFSET[1], mesh => Boolean(mesh.metadata?.mapSurface) && mesh.isEnabled());
    if (!hit?.hit || !hit.pickedPoint) continue;
    const p = worldToEcef ? Vector3.TransformCoordinates(hit.pickedPoint, worldToEcef) : hit.pickedPoint;
    const geo = ecefToGeodetic(p.x, p.y, p.z);
    const latDeg = (geo.latRad * 180) / Math.PI, lonDeg = (geo.lonRad * 180) / Math.PI;
    const i = (y * WIDTH + x) * 4;
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (mode === "solid") {
      const index = indexForColour(r, g, b);
      if (index === null) continue;
      probes += 1;
      const [z, tx, ty] = registry[index].split("/").map(Number);
      const at = lonLatToTileXY(lonDeg, latDeg, z);
      // Allow the picked point to sit a texel and a half outside the tile.
      const slack = 1.5 / 256;
      const inside = at.x >= tx - slack && at.x <= tx + 1 + slack && at.y >= ty - slack && at.y <= ty + 1 + slack;
      if (!inside) {
        misplaced += 1;
        if (samples.length < 8) samples.push({ x, y, tile: registry[index], at: [at.x, at.y] });
      }
    } else {
      const z = b >> 3;
      const at = lonLatToTileXY(lonDeg, latDeg, z);
      const u = (at.x - Math.floor(at.x)) * 256, v = (at.y - Math.floor(at.y)) * 256;
      // Skip texels at tile edges where filtering wraps between 255 and 0.
      if (u < 3 || u > 253 || v < 3 || v > 253) continue;
      probes += 1;
      const parity = 2 * (Math.floor(at.y) & 1) + (Math.floor(at.x) & 1);
      // Texel i holds value i at its centre, so a sample at u reads u - 0.5.
      const du = r - (u - 0.5), dv = g - (v - 0.5);
      sumU += du; sumV += dv; counted += 1;
      const error = Math.max(Math.abs(du), Math.abs(dv));
      maxTexelError = Math.max(maxTexelError ?? 0, error);
      if (error > 3 || (b & 3) !== parity) {
        misplaced += 1;
        if (samples.length < 8) samples.push({ x, y, z, expected: [u, v, parity], got: [r, g, b & 3] });
      }
    }
  }
  return { probes, misplaced, maxTexelError, meanError: counted ? [sumU / counted, sumV / counted] : null, samples };
}

function positionsSignature(scene: Scene): string {
  let hash = 2166136261;
  for (const mesh of scene.meshes) {
    if (!mesh.metadata?.mapSurface) continue;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) continue;
    for (let i = 0; i < positions.length; i += 7) {
      hash ^= Math.round(positions[i] * 1000) | 0;
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${scene.meshes.length}:${hash >>> 0}`;
}

const log = (...parts: unknown[]) => console.log("fixture:", ...parts);

async function runScenario(backend: RendererMode, scenario: Scenario) {
  log(scenario.name, "start");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;display:block`;
  document.body.append(canvas);
  // The app reaches WebGL 1 only where WebGL 2 is missing; build that engine
  // directly, with the app's other options, to exercise the fallback here.
  const engine = backend === "webgl"
    ? new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, useLargeWorldRendering: true, disableWebGL2Support: true }, true)
    : (await createRendererMode(canvas, { force: backend })).engine;
  const actual = (engine as unknown as { isWebGPU?: boolean }).isWebGPU ? "webgpu" : (engine as Engine).webGLVersion === 1 ? "webgl" : "webgl2";
  log(scenario.name, "engine", actual);
  if (actual !== backend) throw new Error(`Asked for ${backend}, got ${actual}`);
  engine.setHardwareScalingLevel(1);
  const scene = new BabylonScene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(BACKGROUND[0] / 255, BACKGROUND[1] / 255, BACKGROUND[2] / 255, 1);
  const camera = new GeospatialCamera("fixture-camera", scene, { planetRadius: 6378137 });
  camera.addBehavior(new GeospatialClippingBehavior());
  const controller = new CameraController(camera);
  const view = { ...scenario.view };
  // A fresh camera clamps pitch against its initial radius on the first
  // application; the second one lands where asked. Surface pitch is measured
  // from the horizon: 90 looks straight down.
  controller.applyViewState(view);
  controller.applyViewState(view);
  let worldRoot: TransformNode | null = null;
  if (scenario.floatingOrigin) {
    // Like flight: world content hangs from a root whose parent recentres and
    // turns it. The camera moves with it, so the picture is unchanged while
    // every world coordinate is.
    const origin = new TransformNode("fixture-floating-origin", scene);
    origin.position.set(-4.1e6, 2.3e6, -1.7e6);
    origin.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.7, -0.3, 0.2);
    worldRoot = new TransformNode("fixture-world-root", scene);
    worldRoot.parent = origin;
    // A chase-style camera: an ordinary camera with the geospatial camera's
    // pose, hung from the same origin as the world.
    scene.render();
    const pose = camera.getWorldMatrix().clone();
    const scale = new Vector3(), rotation = new Quaternion(), translation = new Vector3();
    pose.decompose(scale, rotation, translation);
    const follower = new FreeCamera("fixture-follower", translation, scene);
    follower.rotationQuaternion = rotation;
    follower.fov = camera.fov;
    follower.minZ = camera.minZ;
    follower.maxZ = camera.maxZ;
    follower.parent = origin;
    scene.activeCamera = follower;
  }
  const delay = scenario.churn ? () => Math.random() * 40 : () => 0;
  const loader = fixtureLoader(delay);
  const runtime = createRasterTilesRuntime({
    scene,
    source: descriptor(scenario),
    getViewState: () => view,
    getSurfaceHeightMeters: () => 0,
    worldRoot: worldRoot ?? undefined,
    imagery: "atlas",
    imageryLoader: loader,
    detailOffset: scenario.offset,
    quality: "balanced",
  });
  const frame = async () => {
    const started = performance.now();
    runtime.update();
    const updated = performance.now();
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    await new Promise(resolve => setTimeout(resolve, 4));
    return { updateMs: updated - started };
  };
  const settle = async (limit = 900) => {
    let frames = 0;
    const updateMs: number[] = [];
    for (; frames < limit; frames++) {
      updateMs.push((await frame()).updateMs);
      const feedback = runtime.getDetailFeedback();
      if (frames > 5 && !feedback.pending) break;
    }
    return { frames, updateMs };
  };
  const intermediate: ImageCheck[] = [];
  let settled = await settle();
  log(scenario.name, "settled", settled.frames, JSON.stringify(runtime.getDetailFeedback()));
  log(scenario.name, "diagnostics", JSON.stringify({ ...runtime.getImageryDiagnostics().atlas, plan: { ...runtime.getImageryDiagnostics().atlas?.plan, regions: undefined } }));
  log(scenario.name, "deep", JSON.stringify(runtime.getImageryDiagnostics().atlas?.plan?.regions.filter(region => region.footprintPx > 4).slice(0, 12)));
  {
    const eye = camera.globalPosition;
    const geo = ecefToGeodetic(eye.x, eye.y, eye.z);
    const a = scene.pick(WIDTH / 2 - 50, HEIGHT / 2, mesh => Boolean(mesh.metadata?.mapSurface));
    const b = scene.pick(WIDTH / 2 + 50, HEIGHT / 2, mesh => Boolean(mesh.metadata?.mapSurface));
    const metresPerPixel = a?.pickedPoint && b?.pickedPoint ? a.pickedPoint.subtract(b.pickedPoint).length() / 100 : null;
    log(scenario.name, "camera", JSON.stringify({
      altitude: geo.altMeters, fov: camera.fov, minZ: camera.minZ, maxZ: camera.maxZ, metresPerPixel,
      render: [engine.getRenderWidth(), engine.getRenderHeight()], viewMatrix: Array.from(camera.getViewMatrix().m),
      projection: Array.from(camera.getProjectionMatrix().m), eye: [eye.x, eye.y, eye.z],
      halfZ: engine.isNDCHalfZRange, reverse: engine.useReverseDepthBuffer, canvas: [canvas.clientWidth, canvas.clientHeight],
    }));
  }
  if (scenario.churn) {
    // Move the camera and the slider while images arrive late and in any order.
    for (let step = 0; step < 90; step++) {
      runtime.setDetailTarget([-3, -1, 0, 1, 0.5, -2][step % 6]);
      view.headingDeg = (view.headingDeg + 7) % 360;
      view.zoomMeters = 2000 * (1 + 0.4 * Math.sin(step / 5));
      controller.applyViewState(view);
      await frame();
      if (step % 15 === 7) intermediate.push(checkSolid(await capture(scene)));
    }
    runtime.setDetailTarget(0);
    settled = await settle();
  }
  const pixels = await capture(scene);
  log(scenario.name, "captured");
  const image = scenario.mode === "solid" ? checkSolid(pixels) : null;
  const placement = checkPlacement(scene, pixels, scenario.mode, worldRoot ? worldRoot.computeWorldMatrix(true).clone().invert() : null);
  const diagnostics = runtime.getImageryDiagnostics().atlas;
  const feedback = runtime.getDetailFeedback();

  // Imagery-only changes at a settled view: terrain must not change at all.
  const before = { revision: runtime.getRevision(), positions: positionsSignature(scene) };
  runtime.setDetailTarget(scenario.offset === 0 ? 1 : 0);
  await settle(300);
  runtime.setDetailTarget(scenario.offset);
  await settle(300);
  const after = { revision: runtime.getRevision(), positions: positionsSignature(scene) };

  // Leaves refined for the finer target merge back only after the coarsening
  // delay and the pin (1.5 s at most), so the first window may still merge.
  // After that, a stationary settled scene does no selection, upload or table
  // work. Frames here are not display-paced, so the windows are timed.
  const quietWindow = async (ms: number) => {
    const start = runtime.getImageryDiagnostics().atlas!.counters;
    const started = performance.now();
    let frames = 0;
    for (; performance.now() - started < ms; frames++) await frame();
    const end = runtime.getImageryDiagnostics().atlas!.counters;
    return {
      ms,
      frames,
      selections: end.selections - start.selections,
      uploads: end.uploads - start.uploads,
      tableWrites: end.tableWrites - start.tableWrites,
      publishes: end.publishes - start.publishes,
    };
  };
  const afterChange = await quietWindow(2500);
  const stationary = await quietWindow(3000);

  const sortedUpdate = [...settled.updateMs].sort((a, b) => a - b);
  const result = {
    scenario: scenario.name,
    backend,
    settledFrames: settled.frames,
    updateCpuMs: { p50: sortedUpdate[Math.floor(sortedUpdate.length * 0.5)] ?? null, p95: sortedUpdate[Math.floor(sortedUpdate.length * 0.95)] ?? null, max: sortedUpdate.at(-1) ?? null },
    feedback,
    image,
    intermediate,
    placement,
    independence: { before, after, unchanged: before.revision === after.revision && before.positions === after.positions },
    afterChange,
    stationary,
    imageRequests: loader.requests,
    diagnostics,
    screenshot: toPng(pixels),
  };
  runtime.dispose();
  scene.dispose();
  engine.dispose();
  canvas.remove();
  return result;
}

declare global {
  interface Window {
    runMapDetailFixtures(backend: RendererMode, names?: string[]): Promise<unknown[]>;
    mapDetailFixtureNames: string[];
  }
}

window.mapDetailFixtureNames = SCENARIOS.map(scenario => scenario.name);
window.runMapDetailFixtures = async (backend, names) => {
  const results = [];
  for (const scenario of SCENARIOS) {
    if (names && !names.includes(scenario.name)) continue;
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Scenario timed out after 120 s")), 120_000));
      results.push(await Promise.race([runScenario(backend, scenario), timeout]));
    } catch (error) {
      results.push({ scenario: scenario.name, backend, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
    }
  }
  return results;
};
