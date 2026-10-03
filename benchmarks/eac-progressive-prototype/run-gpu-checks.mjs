#!/usr/bin/env node
/**
 * Correctness of what the GPU draws, on WebGL 1, WebGL 2 and WebGPU, by both
 * paths (ray lookup and mesh patches). The page is put into states chosen to
 * be hard (views centred on a face edge and a cube corner, the poles, mixed
 * levels side by side, the bootstrap beside the finest level) and read back.
 * Each picture is compared with:
 *
 * - the same state drawn on the CPU by lib/render-cpu.mjs, written apart from
 *   the shaders: they must agree, pixel for pixel, within rounding;
 * - for the diagnostic pattern, the closed-form truth (lib/pattern.mjs);
 * - the clear colour, magenta: no pixel may show it, since every direction
 *   has the bootstrap at least.
 *
 * Enlarged crops of the seams and corners are written to plots/screens/.
 *
 *   node benchmarks/eac-progressive-prototype/run-gpu-checks.mjs [--backends=webgl1,webgl2,webgpu] [--paths=ray,mesh] [--mesh-grid=32]
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { encodePng } from "../../scripts/lib/panoramaImage.mjs";
import { newOutputDirectory } from "../../scripts/lib/outputDirectory.mjs";
import { parseArguments } from "../spherical-image-representation/lib/environment.mjs";
import { meanSquaredError, psnrFromMse } from "../spherical-image-representation/lib/metrics.mjs";
import { CORPUS, loadSource } from "../spherical-image-representation/lib/source.mjs";
import { bundlePage, encodeSpec, openChrome, openPage, startServer } from "./lib/browser.mjs";
import { openDataset, referenceView, renderView, uniformTable } from "./lib/render-cpu.mjs";
import { patternColour } from "./lib/pattern.mjs";
import { planeExtents, viewBasis } from "./lib/selection.mjs";
import { defaultDataset, loadConfig, plotsDirectory, writeCsv, writeResults } from "./lib/paths.mjs";
import { viewportOf } from "./lib/config.mjs";

const options = parseArguments({ backends: ["webgl1", "webgl2", "webgpu"], paths: ["ray", "mesh"], "mesh-grid": 32 });
const config = loadConfig();
// The drawing buffer the page reports; the configuration's is only what was asked for.
let viewport = viewportOf(config);
const out = newOutputDirectory("benchmarks", "eac-progressive-prototype", "gpu-checks");
process.env.TMPDIR = out;
const screens = path.join(plotsDirectory, "screens");
mkdirSync(screens, { recursive: true });

/**
 * Pixels read back from the canvas → RGB rows top to bottom. WebGL reads the bottom row first; WebGPU's canvas
 * on this Mac is BGRA, so its bytes come back blue first. The comparison tries each and records which held.
 */
function toRgb(rgba, width, height, flip, swap = false) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const from = (flip ? height - 1 - y : y) * width * 4;
    for (let x = 0; x < width; x++) { rgb[(y * width + x) * 3] = rgba[from + x * 4 + (swap ? 2 : 0)]; rgb[(y * width + x) * 3 + 1] = rgba[from + x * 4 + 1]; rgb[(y * width + x) * 3 + 2] = rgba[from + x * 4 + (swap ? 0 : 2)]; }
  }
  return rgb;
}
function compare(a, b) {
  let largest = 0, over2 = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > largest) largest = d; if (d > 2) over2++; }
  return { psnr: psnrFromMse(meanSquaredError(a, b)), largestDifference: largest, shareOver2: over2 / a.length };
}
/** The pattern's truth for every pixel, four rays a pixel, averaged in the bytes as the GPU's bilinear filter does. */
function patternTruth(camera) {
  const { forward, right, up } = viewBasis(camera), { tanH, tanV } = planeExtents(viewport), rgb = new Uint8Array(viewport.width * viewport.height * 3), colour = [0, 0, 0];
  for (let py = 0; py < viewport.height; py++) for (let px = 0; px < viewport.width; px++) {
    const sum = [0, 0, 0];
    for (let s = 0; s < 4; s++) {
      const a = (2 * (px + ((s & 1) + 0.5) / 2) / viewport.width - 1) * tanH, b = (1 - 2 * (py + ((s >> 1) + 0.5) / 2) / viewport.height) * tanV;
      const x = forward[0] + a * right[0] + b * up[0], y = forward[1] + a * right[1] + b * up[1], z = forward[2] + a * right[2] + b * up[2], length = Math.hypot(x, y, z);
      patternColour(x / length, y / length, z / length, colour);
      for (let c = 0; c < 3; c++) sum[c] += colour[c];
    }
    for (let c = 0; c < 3; c++) rgb[(py * viewport.width + px) * 3 + c] = Math.round(sum[c] / 4);
  }
  return rgb;
}
/** An enlarged crop around the middle of the view, nearest-neighbour so texels stay visible. */
function writeCrop(rgb, name, size = 120, scale = 4) {
  const x0 = Math.floor(viewport.width / 2 - size / 2), y0 = Math.floor(viewport.height / 2 - size / 2), side = size * scale, crop = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const from = ((y0 + Math.floor(y / scale)) * viewport.width + x0 + Math.floor(x / scale)) * 3;
    crop[(y * side + x) * 3] = rgb[from]; crop[(y * side + x) * 3 + 1] = rgb[from + 1]; crop[(y * side + x) * 3 + 2] = rgb[from + 2];
  }
  writeFileSync(path.join(screens, `${name}.png`), encodePng({ width: side, height: side, rgb: crop }));
}

const datasets = { pattern: openDataset(path.join(defaultDataset, "pattern", "eac-t192")), patternCube: openDataset(path.join(defaultDataset, "pattern", "cube-t192")), real: openDataset(path.join(defaultDataset, "northrop-mall", "eac-t192")) };
const cameras = {
  "face centre": { yaw: 0, pitch: 0, roll: 0 }, "face edge": { yaw: 45, pitch: 0, roll: 0 }, "cube corner": { yaw: 45, pitch: 35.264, roll: 0 },
  zenith: { yaw: 20, pitch: 89.5, roll: 0 }, "rolled, off axis": { yaw: 17, pitch: -9, roll: 33 },
};
const checker = (tiling, a, b) => uniformTable(tiling, tiling.maxLevel).map((id, cell) => ((cell + Math.floor(cell / tiling.cells)) & 1 ? (a === "finest" ? id : -1) : b === "below" ? tiling.parent(id) : -1));
const states = [];
for (const [key, dataset] of Object.entries(datasets)) {
  const { tiling } = dataset;
  const tables = { "finest level": uniformTable(tiling, tiling.maxLevel), "finest beside the level below": checker(tiling, "finest", "below"), "finest beside the bootstrap": checker(tiling, "finest", "bootstrap"), "bootstrap only": uniformTable(tiling, -1) };
  for (const [tableName, table] of Object.entries(tables)) for (const [cameraName, camera] of Object.entries(cameras)) {
    if (key !== "pattern" && (cameraName === "rolled, off axis" || tableName === "bootstrap only")) continue;
    states.push({ dataset: key, table: tableName, camera: cameraName, payload: "replacement", tableValues: table, cameraValue: camera });
  }
  if (key === "real") for (const cameraName of ["face edge", "cube corner"]) states.push({ dataset: key, table: "finest level", camera: cameraName, payload: "residual", tableValues: tables["finest level"], cameraValue: cameras[cameraName] });
}
const source = loadSource(CORPUS.find(entry => entry.id === "northrop-mall"));
const truths = new Map();

const pageScript = await bundlePage(out);
const server = await startServer({ roots: { "/data/": defaultDataset }, pageScript, sinkDirectory: path.join(out, "sink") });
const { chrome, browser, gpu } = await openChrome(path.join(out, "chrome-profile"));
const rows = [], backends = [];
try {
  console.log(`${browser.product}; ${gpu.devices?.map(device => device.deviceString).join(", ")}`);
  for (const backend of options.backends) for (const renderPath of options.paths) {
    for (const [key, dataset] of Object.entries(datasets)) {
      const variant = path.relative(defaultDataset, dataset.directory);
      // Replayed tables may name every tile of every level, and the page keeps them all, so the atlas holds the whole pyramid.
      const replayConfig = { ...config, limits: { ...config.limits, gpuSlots: dataset.tiling.count } };
      const spec = { mode: "replay", backend, runId: `${backend}-${renderPath}-${key}`, sink: `${server.origin}/sink/`, data: `${server.origin}/data/${variant}/`, config: replayConfig, render: renderPath, meshGrid: options["mesh-grid"] };
      const page = await openPage(chrome, { url: `${server.origin}/?spec=${encodeSpec(spec)}`, viewport: config.viewport, network: null });
      try {
        await page.waitFor("window.eac?.ready === true || window.eac?.done === true", 60000);
        const ready = await page.evaluate("window.eac");
        if (ready.error) throw new Error(ready.error);
        if (key === "pattern") backends.push({ backend, path: renderPath, ...ready.result.backend });
        if (ready.result.viewport.width !== viewport.width || ready.result.viewport.height !== viewport.height) { console.log(`  drawing buffer ${ready.result.viewport.width} × ${ready.result.viewport.height}`); viewport = ready.result.viewport; truths.clear(); }
        for (const state of states.filter(item => item.dataset === key)) {
          const name = `${backend}-${renderPath}-${key}-${state.table}-${state.camera}-${state.payload}`.replaceAll(/[^a-z0-9-]+/gi, "_");
          await page.evaluate(`window.eac.show(${JSON.stringify({ camera: state.cameraValue, table: Array.from(state.tableValues), payload: state.payload, bootstrap: 48, name })})`);
          const rgba = readFileSync(path.join(out, "sink", `${name}.rgba`));
          const bootstrap = dataset.bootstrap(48);
          const cpu = renderView(dataset, state.tableValues, state.cameraValue, viewport, { bootstrap, payload: state.payload });
          const readings = [[false, false], [true, false], [false, true], [true, true]].map(([flip, swap]) => { const rgb = toRgb(rgba, viewport.width, viewport.height, flip, swap); return { flip, swap, rgb, ...compare(rgb, cpu) }; });
          const best = readings.reduce((a, b) => (b.psnr > a.psnr ? b : a)), flip = best.flip, shown = best.rgb, agreement = best;
          let magenta = 0;
          for (let i = 0; i < shown.length; i += 3) if (shown[i] === 255 && shown[i + 1] === 0 && shown[i + 2] === 255) magenta++;
          const row = { backend, path: renderPath, dataset: variant, table: state.table, camera: state.camera, payload: state.payload, readBackBottomUp: flip, readBackBlueFirst: best.swap, psnrAgainstCpu: agreement.psnr, largestDifferenceFromCpu: agreement.largestDifference, shareOfValuesOver2FromCpu: agreement.shareOver2, blankPixels: magenta };
          if (key === "pattern" && state.table === "finest level") {
            const truthKey = state.camera;
            if (!truths.has(truthKey)) truths.set(truthKey, patternTruth(state.cameraValue));
            row.psnrAgainstClosedForm = compare(shown, truths.get(truthKey)).psnr;
            row.cpuPsnrAgainstClosedForm = compare(cpu, truths.get(truthKey)).psnr;
          }
          if (key === "real" && state.table === "finest level") row.psnrAgainstSource = compare(shown, referenceView(source, state.cameraValue, viewport)).psnr;
          rows.push(row);
          if (renderPath === "ray" && backend === "webgl2" && ["face edge", "cube corner"].includes(state.camera) && state.table !== "bootstrap only" && state.payload === "replacement") writeCrop(shown, `${key}-${state.table}-${state.camera}`.replaceAll(/[^a-z0-9-]+/gi, "-"));
          console.log(`  ${name}: ${agreement.psnr.toFixed(1)} dB against the CPU, largest ${agreement.largestDifference}, ${magenta} blank${row.psnrAgainstClosedForm ? `, ${row.psnrAgainstClosedForm.toFixed(1)} dB against the closed form` : ""}`);
        }
      } finally { if (page.messages.length) console.log(page.messages.slice(0, 5).join("\n")); await page.close(); }
    }
  }
} finally {
  await chrome.close();
  await server.close();
}
console.log(writeResults("gpu-checks", import.meta.url, { viewport, meshGrid: options["mesh-grid"], browser: browser.product, gpu }, { backends }));
console.log(writeCsv("gpu-checks", rows));
console.log(`Scratch: ${out}`);
