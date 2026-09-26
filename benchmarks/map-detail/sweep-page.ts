/**
 * Map detail sweep: the real raster runtime against real providers and real
 * elevation, legacy per-tile imagery against projected atlas imagery at the
 * same views. It records what was asked for and delivered, what it cost, how
 * frames were paced, and a screenshot for comparing sharpness.
 */

import { Color4, EngineInstrumentation, GeospatialCamera, GeospatialClippingBehavior, RenderTargetTexture, Scene, SceneInstrumentation, type AbstractEngine } from "@babylonjs/core";
import { CameraController } from "../../src/camera/cameraState";
import { createRendererMode, type RendererMode } from "../../src/engine/babylon/createRendererMode";
import { createRasterTilesRuntime, type RasterTilesRuntime } from "../../src/engine/babylon/createRasterTilesRuntime";
import { resolveRasterBaseMapSource } from "../../src/engine/babylon/rasterBaseMaps";
import { AWS_TERRARIUM, MAPTERHORN } from "../../src/terrain/terrainTiles";
import { createTerrainPerformanceCapture } from "../../src/terrain/terrainPerformanceCapture";
import { getAppSettings } from "../../src/settings/appSettings";

interface SweepView { latDeg: number; lonDeg: number; zoomMeters: number; pitchDeg: number; headingDeg: number }

export interface SweepCase {
  name: string;
  view: SweepView;
  source: string;
  imagery: "legacy" | "atlas";
  offset: number;
  /** The retired profile the case was recorded with; set as the terrain values `?terrainQuality` maps it to. */
  quality: "auto" | "low" | "balanced" | "high";
  /** Extra sequences run after settling (atlas only). */
  sequences?: Array<"drag" | "switch-source" | "elevation">;
}

/** The terrain error, px, `?terrainQuality` sets for each retired profile. */
const TERRAIN_TARGET = { low: 8, balanced: 4, high: 2 } as const;

const WIDTH = 960;
const HEIGHT = 540;
const TILE_HOSTS = ["basemap.nationalmap.gov", "basemaps.cartocdn.com", "tile.openstreetmap.org", "tiles.mapterhorn.com", "s3.amazonaws.com"];

const log = (...parts: unknown[]) => console.log("sweep:", ...parts);

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function stats(values: number[]) {
  return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.length ? Math.max(...values) : null };
}

/**
 * Tile fetches the page made since a time, by host and level. Browser-cache
 * hits count: this is what the runtime asked for, not what crossed the network.
 */
function resourceCounts(since: number): Record<string, { requests: number; levels: Record<string, number> }> {
  const counts: Record<string, { requests: number; levels: Record<string, number> }> = {};
  for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    if (entry.startTime < since) continue;
    let url: URL;
    try { url = new URL(entry.name); } catch { continue; }
    if (!TILE_HOSTS.includes(url.hostname)) continue;
    // The National Map serves every USGS basemap from one host; keep them apart.
    const name = url.hostname === "basemap.nationalmap.gov" ? `${url.hostname}/${url.pathname.split("/")[4]}` : url.hostname;
    const host = (counts[name] ??= { requests: 0, levels: {} });
    host.requests += 1;
    const level = url.pathname.match(/\/(\d+)\/\d+\/\d+(?:@\dx)?(?:\.\w+)?$/)?.[1] ?? "?";
    host.levels[level] = (host.levels[level] ?? 0) + 1;
  }
  return counts;
}

async function capture(scene: Scene): Promise<Uint8Array> {
  const engine = scene.getEngine();
  const target = new RenderTargetTexture("sweep-capture", { width: WIDTH, height: HEIGHT }, scene, false);
  target.renderList = scene.meshes.slice();
  target.activeCamera = scene.activeCamera;
  target.clearColor = scene.clearColor;
  engine.beginFrame();
  target.render(true);
  engine.endFrame();
  const data = await target.readPixels();
  target.dispose();
  const source = new Uint8Array(data!.buffer, data!.byteOffset, data!.byteLength);
  const out = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let row = 0; row < HEIGHT; row++) out.set(source.subarray((HEIGHT - 1 - row) * WIDTH * 4, (HEIGHT - row) * WIDTH * 4), row * WIDTH * 4);
  return out;
}

/**
 * Detail in the rendered image: mean absolute Laplacian of luminance over the
 * central two thirds, where the fallback globe and sky do not reach.
 */
function sharpness(pixels: Uint8Array): number {
  const lum = (x: number, y: number) => {
    const i = (y * WIDTH + x) * 4;
    return 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
  };
  let sum = 0, count = 0;
  for (let y = Math.floor(HEIGHT / 6); y < Math.floor((HEIGHT * 5) / 6); y++) {
    for (let x = Math.floor(WIDTH / 6); x < Math.floor((WIDTH * 5) / 6); x++) {
      sum += Math.abs(4 * lum(x, y) - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1));
      count += 1;
    }
  }
  return sum / count;
}

function toPng(pixels: Uint8Array): string {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), WIDTH, HEIGHT), 0, 0);
  return canvas.toDataURL("image/png");
}

const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));

async function runCase(engine: AbstractEngine, backend: RendererMode, test: SweepCase) {
  log(test.name, "start");
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);
  const camera = new GeospatialCamera("sweep-camera", scene, { planetRadius: 6378137 });
  camera.addBehavior(new GeospatialClippingBehavior());
  const controller = new CameraController(camera);
  const view = { ...test.view };
  // A fresh camera clamps pitch against its initial radius on the first
  // application; the second lands where asked. 90 looks straight down.
  controller.applyViewState(view);
  controller.applyViewState(view);
  const capture0 = createTerrainPerformanceCapture(2048);
  const settings = getAppSettings();
  if (test.quality === "auto") settings.set("map.auto.terrainDetail", true);
  else settings.setMany({ "map.detail.terrain.default": TERRAIN_TARGET[test.quality], "map.auto.terrainDetail": false });
  let downloadBytes = 0, loadErrors = 0;
  const runtime: RasterTilesRuntime = createRasterTilesRuntime({
    scene, source: resolveRasterBaseMapSource(test.source), getViewState: () => view,
    terrainSource: MAPTERHORN, imagery: test.imagery, detailOffset: test.offset,
    performanceCapture: capture0,
    onDownloadBytes: bytes => { downloadBytes += bytes; },
    onLoadError: () => { loadErrors += 1; },
  });
  const sceneInstrumentation = new SceneInstrumentation(scene);
  sceneInstrumentation.captureFrameTime = true;
  const engineInstrumentation = new EngineInstrumentation(engine);
  engineInstrumentation.captureGPUFrameTime = true;

  const started = performance.now();
  const intervals: number[] = [];
  const cpu: number[] = [];
  let last = await nextFrame();
  const frame = async () => {
    const t0 = performance.now();
    capture0.beginFrame(t0);
    runtime.update();
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    capture0.endFrame();
    cpu.push(performance.now() - t0);
    const now = await nextFrame();
    intervals.push(now - last);
    last = now;
  };
  const idle = () => {
    const loading = runtime.getLoadingDiagnostics?.();
    const detail = runtime.getDetailFeedback();
    const legacyIdle = !loading || (loading.activeElevationRequests === 0 && loading.queuedElevationRequests === 0 && loading.pendingTiles === 0);
    return legacyIdle && (test.imagery === "legacy" || !detail.pending);
  };
  let settleFrames = 0;
  let stableFrames = 0;
  for (; settleFrames < 2700 && performance.now() - started < 60_000; settleFrames++) {
    await frame();
    stableFrames = idle() ? stableFrames + 1 : 0;
    if (settleFrames > 30 && stableFrames >= 20) break;
  }
  const settleMs = performance.now() - started;
  const settledRequests = resourceCounts(started);
  const settleIntervals = stats(intervals.splice(0));
  const settleCpu = stats(cpu.splice(0));

  // Steady, stationary frames.
  const drawCalls: number[] = [];
  const gpu: number[] = [];
  const writesBefore = runtime.getRevision();
  for (let i = 0; i < 180; i++) {
    await frame();
    drawCalls.push(sceneInstrumentation.drawCallsCounter.current);
    if (engineInstrumentation.gpuFrameTimeCounter.current > 0) gpu.push(engineInstrumentation.gpuFrameTimeCounter.current / 1e6);
  }
  const steady = { intervals: stats(intervals.splice(0)), cpu: stats(cpu.splice(0)), drawCalls: stats(drawCalls), gpuMs: gpu.length ? stats(gpu) : "unavailable", revisionChanges: runtime.getRevision() - writesBefore };

  const pixels = await capture(scene);
  const snapshot = capture0.snapshot();
  const result: Record<string, unknown> = {
    case: test.name, backend, source: test.source, imagery: test.imagery, offset: test.offset, quality: test.quality, view: test.view,
    settle: { frames: settleFrames, ms: settleMs, intervals: settleIntervals, cpu: settleCpu, timedOut: stableFrames < 20 },
    steady,
    requests: settledRequests,
    downloadBytes,
    loadErrors,
    feedback: runtime.getDetailFeedback(),
    metrics: runtime.getMetrics(),
    terrain: { revision: runtime.getRevision(), resources: snapshot.resources ?? null },
    imagery: runtime.getImageryDiagnostics(),
    sharpness: sharpness(pixels),
    screenshot: toPng(pixels),
  };

  for (const sequence of test.sequences ?? []) {
    const t0 = performance.now();
    const revision = runtime.getRevision();
    const bytes0 = downloadBytes;
    if (sequence === "drag") {
      // A quick slider drag: one new target per frame, then back to Normal.
      const offsets = [-0.25, -0.5, -1, -1.5, -2, -2.5, -3, -2, -1, 0, 0.25, 0.5, 0.75, 1, 0.5, 0];
      for (let i = 0; i < 90; i++) {
        runtime.setDetailTarget(offsets[i % offsets.length]);
        await frame();
      }
      runtime.setDetailTarget(test.offset);
    } else if (sequence === "switch-source") {
      runtime.setSource(resolveRasterBaseMapSource("usgs-topo"));
    } else {
      runtime.setTerrainSource(AWS_TERRARIUM);
    }
    let frames = 0, stable = 0;
    for (; frames < 2400 && performance.now() - t0 < 45_000; frames++) {
      await frame();
      stable = idle() && (sequence !== "switch-source" || runtime.getDisplayedSourceId() === "usgs-topo") ? stable + 1 : 0;
      if (frames > 10 && stable >= 20) break;
    }
    const requests = resourceCounts(t0);
    (result.sequences ??= {} as Record<string, unknown>);
    (result.sequences as Record<string, unknown>)[sequence] = {
      ms: performance.now() - t0,
      frames,
      intervals: stats(intervals.splice(0)),
      cpu: stats(cpu.splice(0)),
      requests,
      downloadBytes: downloadBytes - bytes0,
      revisionChanges: runtime.getRevision() - revision,
      displayedSource: runtime.getDisplayedSourceId(),
      imagery: runtime.getImageryDiagnostics().atlas?.counters ?? null,
    };
  }

  sceneInstrumentation.dispose();
  engineInstrumentation.dispose();
  runtime.dispose();
  scene.dispose();
  log(test.name, "done", Math.round(settleMs), "ms");
  return result;
}

declare global {
  interface Window {
    runMapDetailSweep(backend: RendererMode, cases: SweepCase[]): Promise<unknown[]>;
  }
}

window.runMapDetailSweep = async (backend, cases) => {
  // The default buffer keeps 250 entries; a sweep makes thousands of requests.
  performance.setResourceTimingBufferSize(200_000);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;display:block`;
  document.body.append(canvas);
  const renderer = await createRendererMode(canvas, { force: backend });
  if (renderer.mode !== backend) throw new Error(`Asked for ${backend}, got ${renderer.mode}`);
  renderer.engine.setHardwareScalingLevel(1);
  const results = [];
  for (const test of cases) {
    try {
      results.push(await runCase(renderer.engine, backend, test));
    } catch (error) {
      results.push({ case: test.name, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
    }
  }
  renderer.engine.dispose();
  canvas.remove();
  return results;
};

declare global {
  interface Window {
    compareMapVariant(standardUrl: string, variantUrl: string): Promise<unknown>;
  }
}

/**
 * Is a variant the standard tile's extent and content at a higher density?
 * Downsample the variant to the standard size and compare luminance at small
 * offsets: the same extent is best aligned at zero offset.
 */
window.compareMapVariant = async (standardUrl, variantUrl) => {
  const load = async (url: string) => {
    const bitmap = await createImageBitmap(await (await fetch(url, { mode: "cors" })).blob());
    return bitmap;
  };
  const [standard, variant] = await Promise.all([load(standardUrl), load(variantUrl)]);
  const size = standard.width;
  const pixels = (bitmap: ImageBitmap) => {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d")!;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size).data;
    const lum = new Float32Array(size * size);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    return lum;
  };
  const a = pixels(standard), b = pixels(variant);
  const offsets: Array<{ dx: number; dy: number; meanAbsDiff: number }> = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    let sum = 0, count = 0;
    for (let y = 8; y < size - 8; y++) for (let x = 8; x < size - 8; x++) {
      sum += Math.abs(a[y * size + x] - b[(y + dy) * size + x + dx]);
      count += 1;
    }
    offsets.push({ dx, dy, meanAbsDiff: sum / count });
  }
  offsets.sort((p, q) => p.meanAbsDiff - q.meanAbsDiff);
  return { standard: [standard.width, standard.height], variant: [variant.width, variant.height], best: offsets[0], zero: offsets.find(entry => entry.dx === 0 && entry.dy === 0), next: offsets.slice(1, 4) };
};
