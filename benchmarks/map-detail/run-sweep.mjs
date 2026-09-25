// Map detail sweep against real providers in isolated headless Chromium on the
// real GPU. The page is served to the browser by request interception, not a
// server; tiles come from the providers over the network.
//   node benchmarks/map-detail/run-sweep.mjs [output-dir] [--backend=webgpu] [--views=city,mountain] [--quick]
import { build } from "vite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => args.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1]?.split(",");
const date = new Date().toISOString().slice(0, 10);
const output = path.resolve(args.find(arg => !arg.startsWith("--")) ?? path.join(root, "build/benchmarks/map-detail", `sweep-${date}`));
const backend = option("backend")?.[0] ?? "webgpu";
const quick = args.includes("--quick");
// --variants: only check that reviewed variants match their standard tiles.
const variantsOnly = args.includes("--variants");
const VARIANT_TILES = [
  // Manhattan, London and Tokyo at street, district and city scales.
  [15, 9649, 12315], [17, 38598, 49262], [12, 1206, 1539],
  [15, 16374, 10896], [17, 65496, 43586],
  [15, 29103, 12903], [13, 7276, 3225],
];

// Surface pitch is measured from the horizon: 90 looks straight down.
const VIEWS = {
  city: { latDeg: 40.758, lonDeg: -73.9855, zoomMeters: 2500, pitchDeg: 45, headingDeg: 30 },
  mountain: { latDeg: 46.853, lonDeg: -121.76, zoomMeters: 12000, pitchDeg: 30, headingDeg: 0 },
  // Semisopochnoi Island, Aleutians, seen from east of the dateline.
  "coast-dateline": { latDeg: 51.95, lonDeg: -179.97, zoomMeters: 30000, pitchDeg: 40, headingDeg: 270 },
  // A low flight looking north over Seattle, eight degrees below the horizon.
  "near-horizon": { latDeg: 47.6, lonDeg: -122.33, zoomMeters: 800, pitchDeg: 8, headingDeg: 0 },
};
const views = option("views") ?? Object.keys(VIEWS);

const cases = [];
for (const name of views) {
  const view = VIEWS[name];
  const add = (source, imagery, offset, quality, extra = {}) => cases.push({
    name: `${name}/${source}/${imagery}${imagery === "atlas" ? ` d=${offset}` : ` ${quality}`}${extra.suffix ?? ""}`,
    view, source, imagery, offset, quality, sequences: extra.sequences,
  });
  for (const quality of quick ? ["balanced"] : ["low", "balanced", "high"]) add("usgs-imagery", "legacy", 0, quality);
  for (const offset of quick ? [0] : [-2, 0, 1]) add("usgs-imagery", "atlas", offset, "balanced");
  if (!quick) {
    add("usgs-imagery-topo", "legacy", 0, "balanced");
    add("usgs-imagery-topo", "atlas", 0, "balanced");
    add("usgs-topo", "legacy", 0, "balanced");
    add("usgs-topo", "atlas", 0, "balanced");
    add("usgs-topo", "atlas", 1, "balanced");
  }
  // Warm cache: the same view again after everything above loaded it.
  add("usgs-imagery", "legacy", 0, "balanced", { suffix: " warm" });
  add("usgs-imagery", "atlas", 0, "balanced", { suffix: " warm", sequences: name === "city" || name === "mountain" ? ["drag", "switch-source", "elevation"] : undefined });
}

const cache = path.join(root, "build/benchmarks/map-detail/sweep");
await build({
  configFile: false, logLevel: "warn", publicDir: false, root, base: "./",
  define: { __BUILD_TIME__: "\"sweep\"", __SOURCE_VERSION__: "\"sweep\"", __REPOSITORY_SLUG__: "\"sweep\"" },
  build: { outDir: cache, emptyOutDir: true, minify: false, rollupOptions: { input: path.join(root, "benchmarks/map-detail/sweep.html") } },
});
const pageDir = path.join(cache, "benchmarks/map-detail");

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
const ORIGIN = "https://map-detail.sweep";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };
try {
  const session = await browser.newBrowserCDPSession();
  const gpu = (await session.send("SystemInfo.getInfo")).gpu;
  const devices = gpu.devices.map(device => `${device.vendorString} ${device.deviceString}`).join(" ");
  if (/swiftshader|llvmpipe|software/i.test(devices)) throw new Error(`Software GPU rejected: ${devices}`);
  console.log(`GPU: ${devices}`);
  const context = await browser.newContext({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1 });
  // Serve the built page from disk; everything else goes to the network.
  await context.route(`${ORIGIN}/**`, async (route) => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, "");
    const file = path.join(cache, relative);
    if (!file.startsWith(cache) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    await route.fulfill({ status: 200, body: readFileSync(file), headers: { "content-type": types[path.extname(file)] ?? "application/octet-stream" } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => console.error("page error:", error.message));
  const missing = new Map();
  page.on("response", response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    const key = `${response.status()} ${url.hostname}${url.pathname.replace(/\/\d+\/\d+\/\d+(\.\w+)?$/, "/{z}/{x}/{y}$1")}`;
    missing.set(key, (missing.get(key) ?? 0) + 1);
  });
  page.on("console", message => {
    if (message.text().startsWith("sweep:") || (message.type() === "error" && !message.text().startsWith("Failed to load resource"))) console.log(message.text());
  });
  await page.goto(`${ORIGIN}/benchmarks/map-detail/sweep.html`);
  await page.waitForFunction(() => typeof window.runMapDetailSweep === "function");
  if (variantsOnly) {
    // CARTO answers keyless requests with an "API KEY REQUIRED" placeholder
    // since August 2026, which would compare a watermark with itself.
    const key = process.env.CARTO_API_KEY;
    if (!key) throw new Error("--variants needs CARTO_API_KEY: CARTO basemaps require a key (https://carto.com/basemaps/apikey/).");
    const checks = [];
    for (const style of ["light_all", "dark_all"]) {
      for (const [z, x, y] of VARIANT_TILES) {
        const standard = `https://basemaps.cartocdn.com/${style}/${z}/${x}/${y}.png?key=${encodeURIComponent(key)}`;
        const variant = `https://basemaps.cartocdn.com/${style}/${z}/${x}/${y}@2x.png?key=${encodeURIComponent(key)}`;
        checks.push({ style, z, x, y, ...(await page.evaluate(([a, b]) => window.compareMapVariant(a, b), [standard, variant])) });
      }
    }
    writeFileSync(path.join(output, "variant-check.json"), `${JSON.stringify({ commit, chrome: browser.version(), checks }, null, 2)}\n`);
    console.table(checks.map(check => ({ style: check.style, tile: `${check.z}/${check.x}/${check.y}`, size: check.variant.join("×"), best: `${check.best.dx},${check.best.dy}`, zero: check.zero.meanAbsDiff.toFixed(2), nextBest: check.next[0].meanAbsDiff.toFixed(2) })));
    await browser.close();
    process.exit(0);
  }
  // One view at a time, saving after each, so an interrupted run keeps what it measured.
  const results = [];
  for (const name of views) {
    const list = cases.filter(entry => entry.name.startsWith(`${name}/`));
    const measured = await page.evaluate(([kind, subset]) => window.runMapDetailSweep(kind, subset), [backend, list]);
    for (const entry of measured) {
      if (entry.screenshot) {
        const file = `${entry.case.replace(/[^a-z0-9.=-]+/gi, "_")}.png`;
        writeFileSync(path.join(output, file), Buffer.from(entry.screenshot.split(",")[1], "base64"));
        entry.screenshot = file;
      }
      results.push(entry);
    }
    writeFileSync(path.join(output, `sweep-${backend}.json`), `${JSON.stringify({
      httpErrors: Object.fromEntries(missing),
      backend, commit, workingTreeMayBeDirty: true, chrome: browser.version(), gpu: { devices, auxAttributes: gpu.auxAttributes },
      note: "Headless Chromium; requestAnimationFrame intervals are the browser's, not a display's. Network speed varies between runs.",
      complete: results.length === cases.length,
      results,
    }, null, 2)}\n`);
  }
  console.log("HTTP errors by endpoint:", Object.fromEntries(missing));
  console.table(results.map(entry => ({
    case: entry.case, error: entry.error?.split("\n")[0],
    settleMs: entry.settle ? Math.round(entry.settle.ms) : "-",
    timedOut: entry.settle?.timedOut,
    requests: entry.requests ? Object.values(entry.requests).reduce((sum, host) => sum + host.requests, 0) : "-",
    kB: entry.downloadBytes ? Math.round(entry.downloadBytes / 1024) : 0,
    sharp: entry.sharpness?.toFixed(2),
    p50: entry.steady?.intervals.p50?.toFixed(1), p95: entry.steady?.intervals.p95?.toFixed(1), p99: entry.steady?.intervals.p99?.toFixed(1),
    cpu95: entry.steady?.cpu.p95?.toFixed(2),
    draws: entry.steady?.drawCalls.p50,
    limits: entry.feedback?.limits?.join(" "),
  })));
} finally {
  await browser.close();
}
console.log(`Evidence: ${output}`);
