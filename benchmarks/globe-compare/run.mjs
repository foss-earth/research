import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import playwright from "../../build/tools/playwright/node_modules/playwright/index.js";

const { chromium } = playwright;

const ROOT = new URL("./pages/", import.meta.url).pathname;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWPORT = { width: 1280, height: 720 };
const FLIGHT_MS = 8000;
const WARMUP_MS = 6000;
const LAT = 36.1;
const LON = -112.14;
const ALT = 1200;
const PITCH = 55;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function pageServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const file = join(ROOT, (req.url ?? "/").split("?")[0].replace(/^\//, "") || "index.html");
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("missing");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

async function sampleFlight(page) {
  await page.evaluate(() => { window.__rafCosts.length = 0; });
  await page.evaluate(({ lat, lon, alt, pitch, flightMs }) => {
    window.__done = false;
    window.__samples = [];
    const started = performance.now();
    let last = started;
    const step = (now) => {
      const dt = now - last;
      last = now;
      if (dt > 0 && dt < 1000) window.__samples.push(dt);
      const t = (now - started) / flightMs;
      window.__setView({
        latDeg: lat,
        lonDeg: lon + t * 0.08,
        zoomMeters: alt,
        pitchDeg: pitch,
        headingDeg: t * 360,
      });
      if (now - started < flightMs) requestAnimationFrame(step);
      else window.__done = true;
    };
    requestAnimationFrame(step);
  }, { lat: LAT, lon: LON, alt: ALT, pitch: PITCH, flightMs: FLIGHT_MS });
  await page.waitForFunction(() => window.__done, null, { timeout: FLIGHT_MS + 15000 });
  const deltas = await page.evaluate(() => window.__samples.slice());
  const costs = await page.evaluate(() => window.__rafCosts.filter((cost) => cost >= 0.5));
  const slow = deltas.filter((dt) => dt > 33.4).length;
  return {
    frames: deltas.length,
    fps: deltas.length > 0 ? 1000 / (deltas.reduce((sum, dt) => sum + dt, 0) / deltas.length) : 0,
    medianFrameMs: percentile(deltas, 0.5),
    p95FrameMs: percentile(deltas, 0.95),
    framesOver33ms: slow,
    mainThreadMedianMs: percentile(costs, 0.5),
    mainThreadP95Ms: percentile(costs, 0.95),
    heavyCallbacks: costs.length,
  };
}

async function gpuInfo(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
    let webgpu = null;
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      webgpu = adapter ? "adapter" : "no-adapter";
    }
    return { renderer, webgpu };
  });
}

async function runTarget(browser, target) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.addInitScript(() => {
    const costs = [];
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => native((time) => {
      const started = performance.now();
      try {
        return callback(time);
      } finally {
        costs.push(performance.now() - started);
      }
    });
    window.__rafCosts = costs;
  });
  const errors = [];
  const failed = [];
  page.on("response", (response) => {
    if (response.status() >= 400 && failed.length < 5) failed.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (target.kind === "foss") {
    await page.waitForFunction(() => window.__fossEarthBench?.getViewState(), null, { timeout: 30000 });
    await page.evaluate(() => {
      window.__setView = (state) => window.__fossEarthBench.setViewState(state);
    });
  } else {
    await page.waitForFunction(() => window.__benchReady === true || window.__setView, null, { timeout: 30000 });
    if (target.kind === "cesium") {
      await page.waitForFunction(() => window.__benchReady, null, { timeout: 30000 });
    }
  }
  await page.evaluate(({ lat, lon, alt, pitch }) => {
    window.__setView({ latDeg: lat, lonDeg: lon, zoomMeters: alt, pitchDeg: pitch, headingDeg: 0 });
  }, { lat: LAT, lon: LON, alt: ALT, pitch: PITCH });
  await page.waitForTimeout(WARMUP_MS);
  const flight = await sampleFlight(page);
  const gpu = await gpuInfo(page);
  const rendererMode = target.kind === "foss"
    ? await page.evaluate(() => window.__fossEarthBench.runtime.renderer.mode)
    : target.renderer;
  await page.close();
  return { name: target.name, rendererMode, gpu, ...flight, failed, errors: errors.slice(0, 3) };
}

const args = process.argv.slice(2).filter((arg) => !arg.startsWith("http"));
const fossBase = process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:4174";
const headless = args.includes("--headless");
const runs = Number(args.find((arg) => arg.startsWith("--runs="))?.slice("--runs=".length) ?? "1");
const { server, port } = await pageServer();
const targets = [
  { name: "FOSS Earth", kind: "foss", renderer: "webgpu", url: `${fossBase}/?bench=1&renderer=webgpu&mapSource=usgs-imagery` },
  { name: "FOSS Earth (WebGL2)", kind: "foss", renderer: "webgl2", url: `${fossBase}/?bench=1&renderer=webgl2&mapSource=usgs-imagery` },
  { name: "CesiumJS", kind: "cesium", renderer: "webgl", url: `http://127.0.0.1:${port}/cesium.html` },
  { name: "MapLibre GL", kind: "maplibre", renderer: "webgl", url: `http://127.0.0.1:${port}/maplibre.html` },
  { name: "Web WorldWind", kind: "worldwind", renderer: "webgl", url: `http://127.0.0.1:${port}/worldwind.html` },
];

const browser = await chromium.launch({
  executablePath: CHROME,
  headless,
  args: [
    "--use-angle=metal",
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPU,Vulkan",
    "--ignore-gpu-blocklist",
    "--disable-gpu-sandbox",
  ],
});

const runsOut = [];
for (let run = 1; run <= runs; run += 1) {
  const results = [];
  for (const target of targets) {
    process.stderr.write(`run ${run}/${runs} ${target.name}\n`);
    try {
      results.push(await runTarget(browser, target));
    } catch (error) {
      results.push({ name: target.name, error: String(error) });
    }
    process.stderr.write(`${JSON.stringify(results.at(-1))}\n`);
  }
  runsOut.push({ run, results });
}

await browser.close();
server.close();
process.stdout.write(`${JSON.stringify({
  validOnlyWhenMachineIsIdle: true,
  headless,
  runs,
  gpuCheckNote: "unmasked renderer recorded per target",
  viewport: VIEWPORT,
  flightMs: FLIGHT_MS,
  warmupMs: WARMUP_MS,
  place: { lat: LAT, lon: LON, alt: ALT },
  runsOut,
}, null, 2)}\n`);
