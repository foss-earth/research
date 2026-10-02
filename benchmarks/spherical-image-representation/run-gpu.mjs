#!/usr/bin/env node
/**
 * Experiment 9: what each representation costs to draw, and what arriving
 * detail does to frame times, on WebGL 1, WebGL 2 and WebGPU.
 *
 * Runs gpu/page.ts in headless Chrome on this machine's own GPU through
 * scripts/lib/headlessChrome.mjs: no server, no visible browser, the page's
 * files served by request interception, cross-origin isolated so the clock is
 * fine-grained. A software renderer is refused.
 *
 *   node benchmarks/spherical-image-representation/run-gpu.mjs
 *     [--backends=webgl1,webgl2,webgpu] [--panorama=northrop-mall] [--frames=240] [--idle-seconds=10] [--retries=3]
 *     [--keep-busy=0] [--name=gpu]
 *
 * A backend's run is repeated if the keyboard or mouse was used during it, if
 * other processes were busy, or if the machine was short of memory.
 *
 * `--keep-busy=N` runs N processes that do nothing but spin while the page is
 * measured. A frame's work is a short burst after 16 ms of idleness, and on a
 * machine with nothing else to do the processor has dropped to a low-power
 * state by the time it starts: the same work then takes several times longer
 * than it does in a loop. With another core busy the processor stays awake.
 * The report gives both, the first as `gpu` and the second as `gpu-busy`.
 *
 * Writes results/<name>.json, <name>-render.csv, <name>-refine.csv and
 * <name>-decode.csv. The bundle, the prepared textures and Chrome's
 * profile go to a dated folder under build/benchmarks/spherical-image-representation/gpu/.
 *
 * Everything here is a desktop GPU. It says which designs do more work, not
 * what a phone will manage.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { build } from "vite";
import { openHeadlessChrome, evaluate } from "../../scripts/lib/headlessChrome.mjs";
import { newOutputDirectory } from "../../scripts/lib/outputDirectory.mjs";
import { representation } from "./lib/representations.mjs";
import { CORPUS, defaultCorpusRoot, loadSource } from "./lib/source.mjs";
import { buildGutter, padField, resample } from "./lib/field.mjs";
import { DELIVERY_RESOLUTION, analyze, makeHierarchy, packDetailBlock, quantizeAndDecode } from "./lib/hierarchy.mjs";
import { encodeJpeg, encodePngFast, encodeWebp } from "./lib/codecs.mjs";
import { benchmarkRoot, parseArguments, repositoryRoot, scratchDirectory, writeCsv, writeResults } from "./lib/environment.mjs";
import { quietRound } from "./lib/quiet.mjs";

const options = parseArguments({ backends: ["webgl1", "webgl2", "webgpu"], panorama: "northrop-mall", frames: 240, warmup: 40, repeat: 8, "idle-seconds": 10, retries: 3, width: 1080, height: 2400, fov: 75, "corpus-root": defaultCorpusRoot, "keep-busy": 0, name: "gpu" });
const out = newOutputDirectory("benchmarks", "spherical-image-representation", "gpu");
process.env.TMPDIR = out;

// ─── The page ──────────────────────────────────────────────────────────

await build({
  configFile: false, root: repositoryRoot, logLevel: "warn",
  build: { outDir: path.join(out, "bundle"), emptyOutDir: false, lib: { entry: path.join(benchmarkRoot, "gpu/page.ts"), formats: ["iife"], name: "SphericalGpuBenchmark", fileName: () => "page.js" } },
});
const files = new Map([
  ["/", { type: "text/html", body: Buffer.from('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><script src="/page.js"></script>') }],
  ["/page.js", { type: "text/javascript", body: readFileSync(path.join(out, "bundle/page.js")) }],
]);

// ─── Its data: one real panorama in each representation ───────────────

const source = loadSource(CORPUS.find(entry => entry.id === options.panorama), options["corpus-root"]);
const COLUMNS = { equirect: 1, cube: 3, eac: 3, "oct-ea": 1, toast: 1, healpix: 4, "ico-rhombus": 5 };
// Quads per chart side in the mesh-patch variants (an equirectangular chart gets twice as many across),
// chosen so flat triangles stay within about a third of a sample of the map where that is possible: the
// recursive maps need very few, and the maps with a singular point at each pole never get there.
const PATCH_GRID = { equirect: 96, cube: 32, eac: 32, "oct-ea": 128, toast: 32, healpix: 64, "ico-rhombus": 16 };
const manifest = {
  canvas: { width: options.width, height: options.height }, fovDeg: options.fov, frames: options.frames, warmup: options.warmup, repeat: options.repeat,
  patchGrid: PATCH_GRID, atlases: {}, cubes: {}, tiles: null, wasm: null,
};
// Textures are sent lossless, so the two ways of drawing one representation start from identical samples.
const pngFile = (name, image) => { files.set(name, { type: "image/png", body: encodePngFast(image) }); return name; };

const fields = {};
for (const id of Object.keys(COLUMNS)) fields[id] = resample(representation(id), DELIVERY_RESOLUTION[id], [source])[0];
for (const [id, columns] of Object.entries(COLUMNS)) {
  // Every chart with its one-cell border, side by side: bilinear filtering never reads another chart.
  const field = fields[id], { W, H, charts } = field, rows = Math.ceil(charts / columns);
  const padded = padField(field, buildGutter(representation(id), DELIVERY_RESOLUTION[id]));
  const width = columns * (W + 2), height = rows * (H + 2), rgb = new Uint8Array(width * height * 3);
  for (let chart = 0; chart < charts; chart++) for (let y = 0; y < H + 2; y++) {
    const from = (chart * (H + 2) + y) * (W + 2) * 3;
    rgb.set(padded.subarray(from, from + (W + 2) * 3), ((Math.floor(chart / columns) * (H + 2) + y) * width + (chart % columns) * (W + 2)) * 3);
  }
  manifest.atlases[id] = { url: pngFile(`/data/${id}.png`, { width, height, rgb }), width, height, chart: [W, H], columns, rows, pitch: Math.sqrt(4 * Math.PI / field.count) };
}
for (const id of ["cube", "eac"]) {
  // The GPU's cube layers +X, −X, +Y, −Y, +Z, −Z are this format's px, nx, pz, nz, py, ny, looked up with (x, z, y).
  const field = fields[id], size = field.W, bytes = size * size * 3;
  manifest.cubes[id] = { size, faces: [0, 1, 4, 5, 2, 3].map((chart, layer) => pngFile(`/data/${id}-${layer}.png`, { width: size, height: size, rgb: field.rgb.subarray(chart * bytes, (chart + 1) * bytes) })) };
}
{
  // Tiles of the finest level of the equal-area hierarchy: as JPEG, as WebP, and as Haar residuals.
  const rep = representation("healpix"), N = DELIVERY_RESOLUTION.healpix, hierarchy = makeHierarchy(rep, N), { levels, finest } = hierarchy;
  const coded = quantizeAndDecode(hierarchy, analyze(hierarchy, fields.healpix.rgb), 12);
  const TILE = 256, HALF = 128, child = levels[finest], parent = levels[finest - 1];
  const tiles = { size: TILE, jpeg: [], webp: [], residual: [], parents: "/data/parents.bin", steps: coded.steps[finest - 1].flat(), whole: null, source: null };
  const parents = [];
  for (let chart = 0; chart < 6; chart++) for (let y0 = 0; y0 < child.H; y0 += TILE) for (let x0 = 0; x0 < child.W; x0 += TILE) {
    const k = tiles.jpeg.length, rgb = new Uint8Array(TILE * TILE * 3);
    for (let y = 0; y < TILE; y++) rgb.set(fields.healpix.rgb.subarray(((chart * child.H + y0 + y) * child.W + x0) * 3, ((chart * child.H + y0 + y) * child.W + x0 + TILE) * 3), y * TILE * 3);
    files.set(`/data/tiles/${k}.jpg`, { type: "image/jpeg", body: encodeJpeg({ width: TILE, height: TILE, rgb }, 80) }); tiles.jpeg.push(`/data/tiles/${k}.jpg`);
    files.set(`/data/tiles/${k}.webp`, { type: "image/webp", body: encodeWebp({ width: TILE, height: TILE, rgb }, 80) }); tiles.webp.push(`/data/tiles/${k}.webp`);
    const packed = packDetailBlock(coded.quantized[finest - 1], parent, chart, x0 / 2, y0 / 2, x0 / 2 + HALF, y0 / 2 + HALF);
    files.set(`/data/tiles/${k}.bin`, { type: "application/octet-stream", body: zlib.deflateRawSync(packed, { level: 9 }) }); tiles.residual.push(`/data/tiles/${k}.bin`);
    const planes = new Float32Array(HALF * HALF * 3);
    for (let plane = 0; plane < 3; plane++) for (let y = 0; y < HALF; y++) for (let x = 0; x < HALF; x++) planes[plane * HALF * HALF + y * HALF + x] = coded.decoded[finest - 1][plane * parent.count + (chart * parent.H + y0 / 2 + y) * parent.W + x0 / 2 + x];
    parents.push(Buffer.from(planes.buffer));
  }
  files.set(tiles.parents, { type: "application/octet-stream", body: Buffer.concat(parents) });
  const equirect = fields.equirect;
  tiles.whole = "/data/whole.jpg";
  files.set(tiles.whole, { type: "image/jpeg", body: encodeJpeg({ width: equirect.W, height: equirect.H, rgb: equirect.rgb }, 80) });
  tiles.source = "/data/source.jpg";
  files.set(tiles.source, { type: "image/jpeg", body: readFileSync(source.file) });
  manifest.tiles = tiles;
}
const wasmFile = path.join(scratchDirectory, "wasm/decode_kernel.wasm");
if (existsSync(wasmFile)) { manifest.wasm = "/kernel.wasm"; files.set("/kernel.wasm", { type: "application/wasm", body: readFileSync(wasmFile) }); }
files.set("/data/manifest.json", { type: "application/json", body: Buffer.from(JSON.stringify(manifest)) });
console.log(`prepared ${files.size} files, ${(Array.from(files.values()).reduce((sum, file) => sum + file.body.length, 0) / 2 ** 20).toFixed(1)} MiB`);

// ─── Chrome ────────────────────────────────────────────────────────────

const ISOLATED = [
  { name: "Cross-Origin-Resource-Policy", value: "cross-origin" },
  { name: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { name: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];
const chrome = await openHeadlessChrome(path.join(out, "chrome-profile"), process.env.CHROME_BIN, ["--enable-webgpu-developer-features"]);
const runs = [];
// Each spins until this process is gone, so none outlives a run that was stopped part way.
const spinners = Array.from({ length: options["keep-busy"] }, () => spawn(process.execPath, ["-e", "for (;;) { const end = Date.now() + 200; while (Date.now() < end); if (process.ppid === 1) process.exit(); }"], { stdio: "ignore" }));
let browser = null, gpu = null;
try {
  browser = await chrome.send("Browser.getVersion");
  try { gpu = (await chrome.send("SystemInfo.getInfo")).gpu; } catch (error) { gpu = { error: error.message }; }
  const devices = gpu.devices?.map(device => `${device.vendorString} ${device.deviceString}`.trim()).join("; ") ?? "";
  console.log(`${browser.product}; GPU: ${devices || "unknown"}`);
  if (/swiftshader|llvmpipe|software/i.test(devices)) throw new Error(`Software GPU rejected: ${devices}`);

  async function runPage(backend, sections) {
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params = {}) => chrome.send(method, params, sessionId);
    const messages = [];
    const off = chrome.onEvent(message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.exceptionThrown") messages.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) messages.push(message.params.args.map(value => value.value ?? value.description).join(" "));
      if (message.method !== "Fetch.requestPaused") return;
      const file = files.get(new URL(message.params.request.url).pathname);
      void send("Fetch.fulfillRequest", file
        ? { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: file.type }, ...ISOLATED], body: file.body.toString("base64") }
        : { requestId: message.params.requestId, responseCode: 404, responseHeaders: ISOLATED, body: "" }).catch(error => messages.push(String(error)));
    });
    try {
      await send("Runtime.enable");
      await send("Page.enable");
      await send("Emulation.setUserAgentOverride", { userAgent: "foss-earth-check/1.0" });
      await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await send("Page.navigate", { url: `https://foss-earth.test/?backend=${backend}&sections=${sections.join(",")}` });
      const deadline = Date.now() + 15 * 60 * 1000;
      while (!(await evaluate(chrome, sessionId, "window.gpuBenchmark?.done === true"))) {
        if (Date.now() > deadline) throw new Error(`${backend}: the page did not finish in 15 minutes`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const outcome = await evaluate(chrome, sessionId, "window.gpuBenchmark");
      return { ...outcome, messages };
    } finally {
      off();
      await chrome.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  for (const backend of options.backends) {
    // Decoding does not depend on the graphics backend: it is measured once, with the first one.
    const sections = ["render", "refine", ...(backend === options.backends[0] ? ["decode"] : [])];
    console.log(`${backend}: ${sections.join(", ")}`);
    const round = await quietRound(() => runPage(backend, sections), { idleSeconds: options["idle-seconds"], ownCores: 3 + options["keep-busy"], retries: options.retries });
    const outcome = round.value;
    if (outcome.error) console.log(`  failed: ${outcome.error.split("\n")[0]}`);
    else if (/swiftshader|llvmpipe|software/i.test(outcome.result.info?.renderer ?? "")) throw new Error(`Software renderer: ${outcome.result.info.renderer}`);
    for (const message of outcome.messages.slice(0, 10)) console.log(`  page: ${message.split("\n")[0].slice(0, 200)}`);
    runs.push({ backend, disturbed: round.disturbed, attempts: round.attempts, busyCores: round.busyCores, memory: round.memory, ...outcome });
    console.log(`  ${round.disturbed ? `disturbed by ${round.disturbed}` : "undisturbed"}, ${round.busyCores.toFixed(1)} cores busy${round.memory ? `, ${round.memory.compressedMiB.toFixed(0)} MiB compressed, ${round.memory.swappedOutMiB.toFixed(0)} MiB swapped out` : ""}`);
  }
} finally {
  for (const spinner of spinners) spinner.kill();
  writeFileSync(path.join(out, "runs.json"), JSON.stringify(runs, null, 1));
  await chrome.close();
}

// ─── Results ───────────────────────────────────────────────────────────

const renderRows = [], refineRows = [];
const stale = gpu => gpu.readings > 10 && gpu.distinctReadings <= 1;
for (const run of runs) {
  for (const row of run.result?.render ?? []) {
    if (row.error) { renderRows.push({ backend: run.backend, variant: row.variant, error: row.error }); continue; }
    renderRows.push({
      backend: run.backend, variant: row.variant, architecture: row.architecture, representation: row.representation,
      drawCalls: row.once.drawCalls, triangles: row.triangles, textures: row.textures, textureMiB: row.textureBytes / 2 ** 20,
      cpuRenderMsMedian: row.once.cpuRenderMs?.median, cpuRenderMsP95: row.once.cpuRenderMs?.p95, cpuRenderMsP99: row.once.cpuRenderMs?.p99,
      // A timer that gave one value for every frame is not measuring: Babylon's WebGL 1 timer query does that here.
      gpuTimer: stale(row.once.gpu) || stale(row.repeated.gpu) ? "stale" : row.once.gpu.source,
      gpuMs: stale(row.once.gpu) ? null : row.once.gpu.meanMs, gpuReadings: row.once.gpu.readings, gpuDistinctReadings: row.once.gpu.distinctReadings,
      [`gpuMsWith${options.repeat}Copies`]: stale(row.repeated.gpu) ? null : row.repeated.gpu.meanMs,
      gpuMsPerCopy: stale(row.once.gpu) || stale(row.repeated.gpu) ? null : row.gpuMsPerCopy, cpuRenderMsPerCopy: row.cpuRenderMsPerCopy,
      frameIntervalMsMedian: row.once.frameIntervalMs?.median, frameIntervalMsP99: row.once.frameIntervalMs?.p99,
      shaderTextureFetches: row.shader.textureFetches, shaderInverseTrigonometric: row.shader.inverseTrigonometric, shaderSquareRoots: row.shader.squareRoots, shaderBranches: row.shader.branches,
      mappingErrorWorstPitches: row.mappingError?.worstPitches ?? null, mappingErrorMeanPitches: row.mappingError?.meanPitches ?? null, psnrAgainstFirstVariant: row.againstFirstVariant.psnr, psnrAgainstSameRepresentation: row.againstSameRepresentation?.psnr ?? null,
    });
  }
  for (const [scenario, value] of Object.entries(run.result?.refine?.scenarios ?? {})) {
    refineRows.push({
      backend: run.backend, scenario, cpuFrameWorkMsMedian: value.cpuFrameWorkMs?.median, cpuFrameWorkMsP95: value.cpuFrameWorkMs?.p95, cpuFrameWorkMsP99: value.cpuFrameWorkMs?.p99, cpuFrameWorkMsMax: value.cpuFrameWorkMs?.max,
      frameIntervalMsMedian: value.frameIntervalMs?.median, frameIntervalMsP95: value.frameIntervalMs?.p95, frameIntervalMsP99: value.frameIntervalMs?.p99, frameIntervalMsMax: value.frameIntervalMs?.max,
      framesOver20Ms: value.framesOver20Ms, frames: value.frameIntervalMs?.count, gpuMs: stale(value.gpu) ? null : value.gpu.meanMs,
    });
  }
}
const decodeRows = runs.flatMap(run => (run.result?.decode ?? []).map(row => ({ measuredWith: run.backend, ...row })));
console.table(renderRows.map(row => ({ backend: row.backend, variant: row.variant, draws: row.drawCalls, triangles: row.triangles, "CPU ms": row.cpuRenderMsMedian?.toFixed(3), "GPU ms": row.gpuMs?.toFixed(3), "GPU ms/copy": row.gpuMsPerCopy?.toFixed(3), "PSNR vs first": row.psnrAgainstFirstVariant?.toFixed(1), error: row.error })));
console.log(writeResults(options.name, import.meta.url, {
  otherCoresKeptBusy: options["keep-busy"], panorama: options.panorama, canvas: manifest.canvas, verticalFovDeg: options.fov, frames: options.frames, warmup: options.warmup, copiesForPerCopyCost: options.repeat, patchGrid: PATCH_GRID,
  textures: "RGBA8, bilinear, no mipmaps, sent as lossless PNG; atlases hold each chart with a one-cell border", blending: "on for every draw",
  browser, gpu: { devices: gpu?.devices, driverBugWorkarounds: undefined, auxAttributes: gpu?.auxAttributes },
  caveat: "A desktop GPU in headless Chrome (ANGLE on Metal for WebGL). Phones were not measured.",
}, { runs: runs.map(run => ({ backend: run.backend, disturbed: run.disturbed, attempts: run.attempts, busyCores: run.busyCores, memory: run.memory, error: run.error ?? null, messages: run.messages, ...run.result })) }));
console.log(writeCsv(`${options.name}-render`, renderRows));
console.log(writeCsv(`${options.name}-refine`, refineRows));
console.log(writeCsv(`${options.name}-decode`, decodeRows));
console.log(`Scratch: ${out}`);
if (runs.some(run => run.error)) process.exitCode = 1;
