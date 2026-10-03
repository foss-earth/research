#!/usr/bin/env node
/**
 * Pictures at equal times: what each candidate and the control showed at the
 * same moments of the same real-HTTP run, replayed on the GPU from the display
 * table the run recorded, and saved at a quarter of the phone's resolution in
 * plots/screens/ for looking at.
 *
 *   node benchmarks/eac-progressive-prototype/make-screens.mjs [--run=<build/…/http/<time>>] [--panorama=northrop-mall]
 *     [--profile=constrained-mobile] [--trace=quick-turn] [--times=1000,2000,3000,5000]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { encodePng } from "../../scripts/lib/panoramaImage.mjs";
import { newOutputDirectory } from "../../scripts/lib/outputDirectory.mjs";
import { parseArguments } from "../spherical-image-representation/lib/environment.mjs";
import { bundlePage, encodeSpec, openChrome, openPage, startServer } from "./lib/browser.mjs";
import { configWith } from "./lib/config.mjs";
import { defaultDataset, plotsDirectory, repositoryRoot, scratchDirectory } from "./lib/paths.mjs";

const runs = path.join(scratchDirectory, "http");
const options = parseArguments({ run: path.join(runs, readdirSync(runs).sort().at(-1)), panorama: "northrop-mall", profile: "constrained-mobile", trace: "quick-turn", start: "off-axis", times: ["1000", "2000", "3000", "5000"], tour: path.join(repositoryRoot, "../UMN-VR/UMN-VR.github.io/public/tour/twin-cities") });
const out = newOutputDirectory("benchmarks", "eac-progressive-prototype", "screens");
process.env.TMPDIR = out;
const screens = path.join(plotsDirectory, "screens");
mkdirSync(screens, { recursive: true });
const variants = { "eac-direct": {}, "eac-levels": { policy: { refinement: "levels" } }, "eac-residual": { policy: { payload: "residual" } }, "cube-direct": { dataset: { projection: "cube" } } };

const pageScript = await bundlePage(out);
const server = await startServer({ roots: { "/data/": defaultDataset }, pageScript, sinkDirectory: path.join(out, "sink") });
const { chrome } = await openChrome(path.join(out, "chrome-profile"));
try {
  for (const [variant, overrides] of Object.entries(variants)) {
    const runId = `main-${variant}-${options.panorama}-webgl2-${options.profile}-${options.trace}-${options.start}-r0`;
    const result = JSON.parse(readFileSync(path.join(options.run, "sink", `${runId}.json`), "utf8")), config = configWith(overrides);
    const variantDirectory = `${options.panorama}/${config.dataset.projection}-t${config.dataset.tile}`;
    const spec = { mode: "replay", backend: "webgl2", runId: `screens-${variant}`, sink: `${server.origin}/sink/`, data: `${server.origin}/data/${variantDirectory}/`, config: { ...config, limits: { ...config.limits, gpuSlots: 510 } }, render: "ray", meshGrid: 32 };
    const page = await openPage(chrome, { url: `${server.origin}/?spec=${encodeSpec(spec)}`, viewport: config.viewport, network: null });
    try {
      await page.waitFor("window.eac?.ready === true || window.eac?.done === true", 60000);
      for (const time of options.times.map(Number)) {
        const sample = result.samples.findLast(item => item.t <= time);
        const name = `${variant}-${options.panorama}-${options.profile}-${options.trace}-${time}ms`;
        if (!sample?.bootstrapShown) { console.log(`${name}: nothing on screen yet`); continue; }
        const shown = await page.evaluate(`window.eac.show(${JSON.stringify({ camera: sample.camera, table: sample.table, payload: config.policy.payload, bootstrap: config.dataset.bootstrap, name })})`);
        const rgba = readFileSync(path.join(out, "sink", `${name}.rgba`)), scale = 4, width = Math.floor(shown.width / scale), height = Math.floor(shown.height / scale), rgb = Buffer.alloc(width * height * 3);
        // A box filter over each 4 × 4 block; WebGL reads the bottom row first.
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) sum += rgba[((shown.height - 1 - (y * scale + dy)) * shown.width + x * scale + dx) * 4 + c];
          rgb[(y * width + x) * 3 + c] = Math.round(sum / scale / scale);
        }
        writeFileSync(path.join(screens, `${name}.png`), encodePng({ width, height, rgb }));
        console.log(`${name}: ${sample.bytes} bytes received`);
      }
    } finally { await page.close(); }
  }
} finally {
  await chrome.close();
  await server.close();
}
