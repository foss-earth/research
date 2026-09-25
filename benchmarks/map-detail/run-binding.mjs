// Runs the map detail binding fixtures in isolated headless Chromium on the
// real GPU: WebGPU, WebGL 2 and WebGL 1. No dev server, visible browser or
// user profile. Usage:
//   node benchmarks/map-detail/run-binding.mjs [output-dir] [--backend=webgpu,webgl2,webgl] [--scenario=a,b]
import { build } from "vite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => args.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1]?.split(",");
const date = new Date().toISOString().slice(0, 10);
const output = path.resolve(args.find(arg => !arg.startsWith("--")) ?? path.join(root, "build/benchmarks/map-detail", `binding-${date}`));
const backends = option("backend") ?? ["webgpu", "webgl2", "webgl"];
const scenarios = option("scenario");

const cache = path.join(root, "build/benchmarks/map-detail");
mkdirSync(cache, { recursive: true });
const result = await build({
  configFile: false, logLevel: "warn", publicDir: false, root,
  define: { __BUILD_TIME__: "\"fixture\"", __SOURCE_VERSION__: "\"fixture\"", __REPOSITORY_SLUG__: "\"fixture\"" },
  worker: { format: "iife" },
  build: { write: false, minify: false, lib: { entry: path.join(root, "benchmarks/map-detail/binding-fixture.ts"), formats: ["iife"], name: "MapDetailFixture" } },
});
const bundle = (Array.isArray(result) ? result[0].output : result.output).find(item => item.type === "chunk").code;
const page = path.join(cache, "binding-fixture.html");
writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>Map detail binding fixtures</title><body style="margin:0;background:#222">
<script>${bundle.replaceAll("</script", "<\\/script")}</script>`);

const installed = path.join(root, "build/tools/playwright/node_modules/playwright/index.mjs");
const moduleName = process.env.PLAYWRIGHT_MODULE ?? (existsSync(installed) ? installed : undefined);
const { chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : "playwright");
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.CHROME_PATH || (existsSync(macChrome) ? macChrome : undefined);
const chromeArgs = ["--enable-unsafe-webgpu", "--enable-gpu", "--disable-software-rasterizer", "--ignore-gpu-blocklist"];
if (process.platform === "darwin") chromeArgs.push("--use-angle=metal");
const browser = await chromium.launch({ headless: true, executablePath, args: chromeArgs });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
mkdirSync(output, { recursive: true });
const summary = [];
try {
  const session = await browser.newBrowserCDPSession();
  const gpu = (await session.send("SystemInfo.getInfo")).gpu;
  const devices = gpu.devices.map(device => `${device.vendorString} ${device.deviceString}`).join(" ");
  if (/swiftshader|llvmpipe|software/i.test(devices)) throw new Error(`Software GPU rejected: ${devices}`);
  console.log(`GPU: ${devices}`);
  for (const backend of backends) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1 });
    const tab = await context.newPage();
    tab.on("pageerror", error => console.error(`[${backend}] page error:`, error.message));
    tab.on("console", message => {
      if (message.type() === "error" || message.type() === "warning" || message.text().startsWith("fixture:")) console.log(`[${backend}] ${message.type()}: ${message.text()}`);
    });
    await tab.goto(pathToFileURL(page).href);
    const results = await tab.evaluate(([name, only]) => window.runMapDetailFixtures(name, only ?? undefined), [backend, scenarios ?? null]);
    for (const entry of results) {
      if (entry.screenshot) {
        const file = `${backend}-${entry.scenario}.png`;
        writeFileSync(path.join(output, file), Buffer.from(entry.screenshot.split(",")[1], "base64"));
        entry.screenshot = file;
      }
      summary.push({
        backend, scenario: entry.scenario, error: entry.error?.split("\n")[0],
        foreign: entry.image ? `${entry.image.foreignPixels}/${entry.image.terrainPixels}` : "-",
        churnForeign: entry.intermediate?.map(check => check.foreignPixels).join(",") || "-",
        misplaced: entry.placement ? `${entry.placement.misplaced}/${entry.placement.probes}` : "-",
        texelErr: entry.placement?.maxTexelError ?? "-",
        independent: entry.independence?.unchanged,
        afterChange: entry.afterChange ? `${entry.afterChange.selections}/${entry.afterChange.uploads}/${entry.afterChange.tableWrites}` : "-",
        stationary: entry.stationary ? `${entry.stationary.selections}/${entry.stationary.uploads}/${entry.stationary.tableWrites}` : "-",
        limits: entry.feedback?.limits?.join(" ") || "",
        levels: entry.diagnostics?.plan ? Object.keys(entry.diagnostics.plan.levels).join(",") : "-",
      });
    }
    writeFileSync(path.join(output, `binding-${backend}.json`), `${JSON.stringify({
      backend, commit, workingTreeMayBeDirty: true, chrome: browser.version(), executablePath: executablePath ?? "Playwright Chromium",
      gpu: { devices, auxAttributes: gpu.auxAttributes }, results,
    }, null, 2)}\n`);
    await context.close();
  }
} finally {
  await browser.close();
}
console.table(summary);
writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`Evidence: ${output}`);
