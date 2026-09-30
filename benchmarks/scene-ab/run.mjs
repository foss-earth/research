#!/usr/bin/env node
/**
 * A/B benchmark of a built FOSS Earth app with a scene, such as the UMN
 * campus tour, in headless Chrome on this machine's GPU, with no server.
 *
 * It serves the build (and, behind it, a content folder such as the tour's
 * public/) through request interception. Map tiles and other outside requests
 * are fetched once, identified as foss-earth-check/1.0, and replayed from
 * build/benchmarks/scene-ab/tile-cache/ afterwards, so every run sees the same
 * bytes. It opens the page with `?panoramaTest=1`, waits for the scene, then:
 *
 *  1. Equivalence: in each workload, holds the view still and reads the canvas
 *     back under each condition, against the baseline read twice (the noise
 *     floor). Differences are counted per pixel and saved as heat maps.
 *  2. Timing: rounds of every condition, and the baseline a second time as an
 *     A/A control, in a new random order each round, switched live in the
 *     same page, each a stretch of touch drags with frames held continuous.
 *     Per stretch it keeps the frame profiler's CPU sections, the GPU's frame
 *     where the renderer can time it, the main thread's CPU time as Chrome
 *     counts it (thread ticks, so time spent waiting for a core is left out),
 *     and counts that do not depend on load: the meshes Babylon examined and
 *     the draw calls of a frame. Results are paired with the same round's
 *     baseline.
 *
 * The machine may be in use. Each stretch starts only after --idle-seconds
 * without keyboard, mouse or trackpad input (macOS), and is run again, up to
 * --retries times, when there was input during it or the machine had more
 * than --max-extra-cores busier than usual. A stretch still disturbed after
 * that is kept in the report and left out of the comparison.
 *
 * Conditions are registry values, so the same build is A and B. Frame
 * intervals here say little: this machine meets the display rate either way.
 * The CPU and GPU milliseconds per frame are the result. Chrome's CPU
 * throttling is not used: it made the profiler's sections shorter, not longer.
 *
 * Usage: node benchmarks/scene-ab/run.mjs --dist=<built app> [--content=<folder>] --page=/path/
 *   [--stops=id,id] [--workloads=look,overview] [--conditions=baseline,...,all] [--rounds=5]
 *   [--seconds=6] [--viewport=412x915] [--dpr=2.625] [--renderer=webgl2|webgl|webgpu|auto]
 *   [--webgl1] [--tiles=cache|live] [--skip-equivalence] [--skip-timing] [--save-frames]
 *   [--idle-seconds=10] [--max-extra-cores=1.5] [--retries=3] [--query=extra&query=text] [--out=dir]
 *   node benchmarks/scene-ab/run.mjs --summarize=<report.json>   (rewrites that run's summary.md)
 * Output: build/benchmarks/scene-ab/<local time>/ with report.json, summary.md and heatmaps/.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { evaluate, openHeadlessChrome } from "../../scripts/lib/headlessChrome.mjs";
import { newOutputDirectory } from "../../scripts/lib/outputDirectory.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const list = text => text.split(",").map(item => item.trim()).filter(Boolean);

const EXPERIMENTS = {
  panoramaBookkeeping: "renderer.experiments.panoramaBookkeeping",
  opaqueImmersion: "renderer.experiments.opaqueImmersion",
  panoramaShaders: "renderer.experiments.panoramaShaders",
  presentationCandidates: "renderer.experiments.presentationCandidates",
};
const GROUP = "renderer.experiments.all";
/** Every condition as the complete set of experiment values, so none inherits the last one's. */
/** The baseline measured a second time each round: its difference from the baseline is the noise. */
const AGAIN = "baseline-again";
function conditionValues(name) {
  const values = { [GROUP]: false };
  for (const id of Object.values(EXPERIMENTS)) values[id] = false;
  if (name === "all") values[GROUP] = true;
  else if (name !== "baseline" && name !== AGAIN) {
    if (!EXPERIMENTS[name]) throw new Error(`Unknown condition ${name}: baseline, all or one of ${Object.keys(EXPERIMENTS).join(", ")}`);
    values[EXPERIMENTS[name]] = true;
  }
  return values;
}

const [vw, vh] = arg("viewport", "412x915").split("x").map(Number);
const config = {
  dist: path.resolve(arg("dist", "")),
  content: arg("content") ? path.resolve(arg("content")) : null,
  page: arg("page", "/"),
  stops: arg("stops") ? list(arg("stops")) : null,
  workloads: list(arg("workloads", "look,overview")),
  conditions: list(arg("conditions", ["baseline", ...Object.keys(EXPERIMENTS), "all"].join(","))),
  rounds: Number(arg("rounds", "5")),
  seconds: Number(arg("seconds", "6")),
  viewport: { width: vw, height: vh },
  dpr: Number(arg("dpr", "2.625")),
  renderer: arg("renderer", "webgl2"),
  webgl1: flag("webgl1"),
  idleSeconds: Number(arg("idle-seconds", "10")),
  maxExtraCores: Number(arg("max-extra-cores", "1.5")),
  retries: Number(arg("retries", "3")),
  tiles: arg("tiles", "cache"),
  query: arg("query", ""),
  equivalence: !flag("skip-equivalence"),
  saveFrames: flag("save-frames"),
  timing: !flag("skip-timing"),
  userAgentSuffix: "foss-earth-check/1.0",
};
if (arg("summarize")) {
  // Rewrites a run's summary from its report.json, as this version of the summary reads it.
  const file = path.resolve(arg("summarize"));
  const saved = JSON.parse(await readFile(file, "utf8"));
  await writeFile(path.join(path.dirname(file), "summary.md"), summarize(saved));
  console.log(`Summary: ${path.join(path.dirname(file), "summary.md")}`);
  process.exit(0);
}
if (!arg("dist")) throw new Error("--dist=<built app folder> is required.");
if (!config.conditions.includes("baseline")) throw new Error("The conditions need a baseline to pair with.");
for (const name of config.conditions) conditionValues(name);

const out = arg("out") ? path.resolve(arg("out")) : newOutputDirectory("benchmarks", "scene-ab");
await mkdir(path.join(out, "heatmaps"), { recursive: true });
// Chrome and its crash handler otherwise write to the system's temporary directory.
process.env.TMPDIR = out;
const tileCache = path.join(root, "build", "benchmarks", "scene-ab", "tile-cache");
await mkdir(tileCache, { recursive: true });
if (process.platform === "darwin") {
  // An idle-sleeping machine stops the page's clocks mid-run.
  const awake = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  awake.on("error", () => {});
  awake.unref();
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const ORIGIN = "https://foss-earth.test";
/**
 * Every response is served cross-origin isolated. Chrome otherwise coarsens
 * performance.now() to 100 µs, which rounds the profiler's sub-millisecond
 * sections away; isolated, it keeps 5 µs. Nothing the app draws depends on it.
 */
const ISOLATION_HEADERS = [
  { name: "Access-Control-Allow-Origin", value: "*" },
  { name: "Cross-Origin-Resource-Policy", value: "cross-origin" },
  { name: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { name: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".txt": "text/plain",
};

// ─── Browser ──────────────────────────────────────────────────────────
const chromeArgs = ["--enable-webgpu-developer-features", ...(config.webgl1 ? ["--disable-webgl2"] : [])];
const chrome = await openHeadlessChrome(path.join(out, "chrome-profile"), arg("chrome") ?? process.env.CHROME_BIN, chromeArgs);
const browserVersion = await chrome.send("Browser.getVersion");
let systemInfo = null;
try { systemInfo = await chrome.send("SystemInfo.getInfo"); } catch (error) { systemInfo = { error: error.message }; }
const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
const send = (method, params = {}) => chrome.send(method, params, sessionId);
const exceptions = [];
const consoleErrors = [];
const traffic = { own: 0, content: 0, cacheHits: 0, fetched: 0, failed: 0, hosts: {} };

async function localFile(pathname) {
  for (const base of [config.dist, config.content].filter(Boolean)) {
    let file = path.join(base, decodeURIComponent(pathname));
    if (pathname.endsWith("/")) file = path.join(file, "index.html");
    if (!file.startsWith(base)) continue;
    try { if ((await stat(file)).isFile()) return { file, base }; } catch { /* next base */ }
  }
  return null;
}

async function outside(request) {
  const key = sha256(`${request.method} ${request.url}`);
  const host = new URL(request.url).host;
  traffic.hosts[host] = (traffic.hosts[host] ?? 0) + 1;
  const bodyFile = path.join(tileCache, `${key}.bin`), metaFile = path.join(tileCache, `${key}.json`);
  if (config.tiles === "cache") {
    try {
      const meta = JSON.parse(await readFile(metaFile, "utf8"));
      traffic.cacheHits++;
      return { status: meta.status, contentType: meta.contentType, body: await readFile(bodyFile) };
    } catch { /* not cached yet */ }
  }
  const response = await fetch(request.url, { method: request.method, headers: { "User-Agent": config.userAgentSuffix, Accept: request.headers?.Accept ?? "*/*" } });
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  traffic.fetched++;
  if (response.ok || response.status === 404) {
    await writeFile(bodyFile, body);
    await writeFile(metaFile, JSON.stringify({ url: request.url, status: response.status, contentType, fetchedAt: new Date().toISOString() }));
  }
  return { status: response.status, contentType, body };
}

chrome.onEvent(message => {
  if (message.sessionId !== sessionId) return;
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") consoleErrors.push(message.params.args.map(value => value.value ?? value.description).join(" ").slice(0, 400));
  if (message.method !== "Fetch.requestPaused") return;
  void (async () => {
    const { requestId, request } = message.params;
    const url = new URL(request.url);
    let reply;
    if (url.origin === ORIGIN) {
      const found = await localFile(url.pathname);
      if (found) {
        if (found.base === config.dist) traffic.own++; else traffic.content++;
        reply = { status: 200, contentType: MIME[path.extname(found.file).toLowerCase()] ?? "application/octet-stream", body: await readFile(found.file) };
      } else reply = { status: 404, contentType: "text/plain", body: Buffer.alloc(0) };
    } else if (request.method === "GET") {
      try { reply = await outside(request); } catch (error) {
        traffic.failed++;
        await chrome.send("Fetch.failRequest", { requestId, errorReason: "Failed" }, sessionId);
        consoleErrors.push(`outside request ${request.url}: ${error.message}`);
        return;
      }
    } else {
      await chrome.send("Fetch.continueRequest", { requestId }, sessionId);
      return;
    }
    await chrome.send("Fetch.fulfillRequest", {
      requestId, responseCode: reply.status,
      responseHeaders: [{ name: "Content-Type", value: reply.contentType }, ...ISOLATION_HEADERS],
      body: reply.body.toString("base64"),
    }, sessionId);
  })().catch(error => exceptions.push(`interception: ${error.message}`));
});

await send("Runtime.enable");
await send("Page.enable");
// Durations in the main thread's CPU time, which leaves out time it waited for a core.
await send("Performance.enable", { timeDomain: "threadTicks" });
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
await send("Emulation.setUserAgentOverride", { userAgent: `${browserVersion.userAgent} ${config.userAgentSuffix}` });
await send("Emulation.setDeviceMetricsOverride", { ...config.viewport, deviceScaleFactor: config.dpr, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

const page = expression => evaluate(chrome, sessionId, expression);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A long page task, polled so no protocol call stays open for its length. */
async function job(expression, timeoutMs = 300_000) {
  await page(`window.__abResult = undefined; (async () => ${expression})().then(value => { window.__abResult = { ok: true, value }; }, error => { window.__abResult = { ok: false, error: String(error && error.stack || error) }; }); true`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    if (await page("window.__abResult !== undefined")) {
      const result = await page("window.__abResult");
      if (!result.ok) throw new Error(result.error);
      return result.value;
    }
  }
  throw new Error(`Timed out: ${expression.slice(0, 120)}`);
}

/** A job that says how long it took when that was more than a few seconds, and whether it settled. */
async function step(label, expression, timeoutMs) {
  const started = Date.now();
  const value = await job(expression, timeoutMs);
  const seconds = (Date.now() - started) / 1000;
  const unsettled = value && typeof value === "object" && "settledMs" in value && value.settledMs === null;
  if (seconds > 5 || unsettled) console.log(`  (${label}: ${seconds.toFixed(1)} s${unsettled ? `, did not settle: ${JSON.stringify(value)}` : ""})`);
  return value;
}

/** One finger dragging side to side across the middle of the view, about 60 moves a second. */
async function drag(seconds) {
  const cx = config.viewport.width / 2, cy = config.viewport.height / 2;
  const amplitude = config.viewport.width * 0.3, periodS = 2;
  const point = t => [{ x: cx + amplitude * Math.sin((2 * Math.PI * t) / periodS), y: cy + 20 * Math.sin((2 * Math.PI * t) / (periodS * 1.7)) }];
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(0) });
  const start = performance.now();
  while (performance.now() - start < seconds * 1000) {
    await sleep(16);
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point((performance.now() - start) / 1000) });
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const execFileAsync = promisify(execFile);
/** Seconds since the keyboard, mouse or trackpad was last used (macOS), or null where that cannot be read. */
async function secondsSinceInput() {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { maxBuffer: 16 * 1024 * 1024 });
    const match = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return match ? Number(match[1]) / 1e9 : null;
  } catch { return null; }
}

/** Waits until nobody has used the machine for --idle-seconds, saying so once. */
async function waitForIdle() {
  if (config.idleSeconds <= 0) return 0;
  const started = Date.now();
  let said = false;
  for (;;) {
    const idle = await secondsSinceInput();
    if (idle === null || idle >= config.idleSeconds) return (Date.now() - started) / 1000;
    if (!said) console.log(`  (waiting for ${config.idleSeconds} s without keyboard or mouse input)`);
    said = true;
    await sleep(1000);
  }
}

/** Cores busy between two readings of os.cpus(), every process on the machine counted. */
function busyCores(before, after) {
  let busy = 0;
  after.forEach((cpu, index) => {
    const a = cpu.times, b = before[index].times;
    const total = (a.user + a.nice + a.sys + a.idle + a.irq) - (b.user + b.nice + b.sys + b.idle + b.irq);
    if (total > 0) busy += 1 - (a.idle - b.idle) / total;
  });
  return busy;
}

async function chromeMetrics() {
  const { metrics } = await send("Performance.getMetrics");
  return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}
function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function stretchStats(framesList) {
  // The first frames after switching carry the switch; the drag's own frames follow.
  const frames = framesList.slice(3);
  const column = name => frames.map(frame => frame[name]);
  const gpu = column("gpu").filter(value => value > 0);
  return {
    frames: frames.length,
    renderP50: quantile(column("render"), 0.5), renderMean: mean(column("render")), renderP95: quantile(column("render"), 0.95),
    activeMeshesP50: quantile(column("activeMeshes"), 0.5), drawP50: quantile(column("draw"), 0.5), uniformsP50: quantile(column("uniforms"), 0.5),
    measuredP50: quantile(column("measured"), 0.5),
    gpuMean: mean(gpu), gpuP50: quantile(gpu, 0.5), gpuSamples: gpu.length, gpuDistinct: new Set(gpu).size,
    intervalP50: quantile(column("interval"), 0.5), intervalP95: quantile(column("interval"), 0.95),
  };
}

/** What was measured: each repository's commit and uncommitted files, and hashes of the build's pages and scripts. */
async function provenance() {
  const git = (cwd, ...args) => { try { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); } catch { return null; } };
  const repository = cwd => ({ commit: git(cwd, "rev-parse", "HEAD"), uncommitted: (git(cwd, "status", "--porcelain") ?? "").split("\n").filter(Boolean) });
  const build = {};
  for (const entry of await readdir(config.dist, { recursive: true })) {
    if (!/\.(html|js)$/.test(entry)) continue;
    build[entry] = sha256(await readFile(path.join(config.dist, entry)));
  }
  return { fossEarth: repository(root), app: repository(config.dist), build };
}

const report = {
  generatedAt: new Date().toISOString(),
  provenance: await provenance(),
  config: { ...config, dist: path.relative(root, config.dist), content: config.content && path.relative(root, config.content) },
  browser: { product: browserVersion.product, gpu: systemInfo?.gpu?.devices ?? systemInfo, args: chromeArgs },
  info: {}, equivalence: [], timing: [], exceptions, consoleErrors, traffic,
};

try {
  const query = [`panoramaTest=1`, `renderer=${config.renderer}`, "set.renderer.profiling.enabled=true", "set.renderer.profiling.traceFrames=6000", "set.renderer.profiling.windowFrames=6000", config.query].filter(Boolean).join("&");
  await send("Page.navigate", { url: `${ORIGIN}${config.page}?${query}` });
  console.log("Loading the app and scene…");
  const hookDeadline = Date.now() + 120_000;
  while (!(await page("Boolean(window.__fossEarthPanoramaTest?.scenes?.handle())").catch(() => false))) {
    if (Date.now() > hookDeadline) throw new Error(`The app never exposed its scene: ${exceptions.join(" | ")}`);
    await sleep(250);
  }
  await page(await readFile(path.join(root, "benchmarks/scene-ab/agent.js"), "utf8"));
  const loadStarted = Date.now();
  await job("window.__sceneAb.sceneReady()", 240_000);
  report.info.sceneReadyMs = Date.now() - loadStarted;
  const available = await page("window.__sceneAb.stops()");
  const stops = config.stops ?? [available.entries[0], available.entries[Math.floor(available.entries.length / 2)]];
  report.info.stops = stops;
  report.info.atLoad = await page("window.__sceneAb.info()");
  console.log(`  ${report.info.atLoad.rendererMode} WebGL ${report.info.atLoad.webGLVersion} on ${report.info.atLoad.glRenderer}, ${report.info.atLoad.renderSize.join("×")} px, ${report.info.atLoad.meshes} meshes, GPU timing ${report.info.atLoad.gpuTimed ? "available" : "unavailable"}`);
  if (/swiftshader|llvmpipe|software/i.test(report.info.atLoad.glRenderer ?? "")) throw new Error(`Software renderer: ${report.info.atLoad.glRenderer}`);
  if (!report.info.atLoad.crossOriginIsolated) console.log("  Not cross-origin isolated: timings are rounded to 100 µs.");

  const workloads = [];
  for (const name of config.workloads) {
    if (name === "look") for (const stop of stops) workloads.push({ name: `look:${stop}`, go: `window.__sceneAb.enter(${JSON.stringify(stop)})` });
    else if (name === "overview") workloads.push({ name: "overview", go: "window.__sceneAb.overview()" });
    else throw new Error(`Unknown workload ${name}: look or overview`);
  }

  // Warm everything once: each place visited, dragged in and every shader variant compiled.
  console.log("Warming up…");
  for (const workload of workloads) {
    await step(`warm ${workload.name}: arrive`, workload.go);
    for (const condition of config.conditions) await step(`warm ${workload.name}: ${condition}`, `window.__sceneAb.apply(${JSON.stringify(conditionValues(condition))})`);
    await job(`window.__sceneAb.apply(${JSON.stringify(conditionValues("baseline"))})`);
    await drag(2);
    await step(`warm ${workload.name}: settle`, "window.__sceneAb.settle(30000)");
  }

  for (const workload of workloads) {
    const arrived = await step(`${workload.name}: arrive`, workload.go);
    const where = await page("window.__sceneAb.info()");
    report.info[workload.name] = { arrived, ...where };
    console.log(`${workload.name}: ${where.meshes} meshes, ${where.activeMeshes} active${where.immersionDetail ? `, showing ${where.immersionDetail.representation}` : ""}`);

    if (config.equivalence) {
      await job(`window.__sceneAb.apply(${JSON.stringify(conditionValues("baseline"))})`);
      const file = (kind, condition) => path.join(out, kind, `${workload.name.replace(/[^a-z0-9-]+/gi, "_")}-${condition}.png`);
      if (config.saveFrames) await mkdir(path.join(out, "frames"), { recursive: true });
      const base = await job(`window.__sceneAb.capture(${JSON.stringify(`${workload.name}/baseline`)}, null, ${config.saveFrames})`);
      if (base.image) await writeFile(file("frames", "baseline"), Buffer.from(base.image, "base64"));
      const noise = await job(`window.__sceneAb.capture("again", ${JSON.stringify(`${workload.name}/baseline`)})`);
      const rows = [{ condition: "baseline (again)", ...noise, heatmap: undefined, image: undefined }];
      for (const condition of config.conditions.filter(name => name !== "baseline" && name !== AGAIN)) {
        await job(`window.__sceneAb.apply(${JSON.stringify(conditionValues(condition))})`);
        const result = await job(`window.__sceneAb.capture(${JSON.stringify(condition)}, ${JSON.stringify(`${workload.name}/baseline`)}, ${config.saveFrames})`);
        if (result.heatmap) await writeFile(file("heatmaps", condition), Buffer.from(result.heatmap, "base64"));
        if (result.image) await writeFile(file("frames", condition), Buffer.from(result.image, "base64"));
        rows.push({ condition, ...result, heatmap: undefined, image: undefined });
        console.log(`  ${condition}: ${result.differing} of ${result.pixels} pixels differ, largest ${result.maxDiff}/255, ${result.over2} by more than 2`);
      }
      await job(`window.__sceneAb.apply(${JSON.stringify(conditionValues("baseline"))})`);
      report.equivalence.push({ workload: workload.name, rows });
    }

    if (config.timing) {
      const conditions = [...config.conditions, ...(config.conditions.includes(AGAIN) ? [] : [AGAIN])];
      // Cores busy during undisturbed stretches, for telling when something else loaded the machine.
      const usual = [];
      for (let round = 0; round < config.rounds; round++) {
        for (const condition of shuffle(conditions)) {
          let row = null;
          for (let attempt = 0; attempt <= config.retries; attempt++) {
            const waitedS = await waitForIdle();
            await job(`window.__sceneAb.apply(${JSON.stringify(conditionValues(condition))})`);
            // Map loading left over from the last stretch is waited out, up to a limit, and noted when it was not.
            const settled = await step(`${condition} settle`, "window.__sceneAb.settle(15000, 500)");
            const metricsBefore = await chromeMetrics();
            const cpusBefore = os.cpus();
            const started = Date.now();
            await page("window.__sceneAb.begin()");
            await drag(config.seconds);
            const { frames, counters } = await page("window.__sceneAb.end()");
            const elapsedS = (Date.now() - started) / 1000;
            const cpusAfter = os.cpus();
            const metricsAfter = await chromeMetrics();
            const idleS = await secondsSinceInput();
            const busy = busyCores(cpusBefore, cpusAfter);
            const typical = usual.length >= 5 ? quantile(usual, 0.5) : null;
            const interference = idleS !== null && idleS < elapsedS ? "input" : typical !== null && busy > typical + config.maxExtraCores ? "load" : null;
            const perFrame = name => (metricsAfter[name] != null && metricsBefore[name] != null && frames.length ? ((metricsAfter[name] - metricsBefore[name]) * 1000) / frames.length : null);
            row = {
              workload: workload.name, round, condition, attempt, interference, settled: settled.settledMs !== null, waitedForIdleS: waitedS,
              busyCores: busy, secondsSinceInput: idleS, ...stretchStats(frames), ...counters,
              mainThreadMs: perFrame("ThreadTime"), taskMs: perFrame("TaskDuration"), scriptMs: perFrame("ScriptDuration"),
              layoutMs: perFrame("LayoutDuration"), styleMs: perFrame("RecalcStyleDuration"), processMs: perFrame("ProcessTime"),
            };
            if (!interference) {
              usual.push(busy);
              break;
            }
            const why = interference === "input" ? "keyboard or mouse used" : `other load, ${busy.toFixed(1)} busy cores against a usual ${typical.toFixed(1)}`;
            console.log(`  (round ${round + 1} ${condition}: ${why}; ${attempt < config.retries ? "running it again" : "kept, left out of the comparison"})`);
          }
          report.timing.push(row);
          const f = value => (value == null ? "–" : value.toFixed(3));
          console.log(`  round ${round + 1} ${condition}: render p50 ${f(row.renderP50)} ms, main thread ${f(row.mainThreadMs)} ms, gpu ${f(row.gpuMean)} ms, ${row.meshesExamined} meshes examined, ${row.frames} frames`);
        }
      }
      await job(`window.__sceneAb.apply(${JSON.stringify(conditionValues("baseline"))})`);
    }
  }
  report.info.atEnd = await page("window.__sceneAb.info()");
} finally {
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, "summary.md"), summarize(report));
  await chrome.close();
  console.log(`Report: ${out}`);
}

/** Pairs each condition with the same round's baseline, per workload, leaving out disturbed stretches. */
function paired(report) {
  const rows = [];
  for (const workload of new Set(report.timing.map(row => row.workload))) {
    const runs = report.timing.filter(row => row.workload === workload && !row.interference);
    // A timer that never gives a new reading repeats one value in every stretch: it measured nothing.
    const gpuStale = runs.length > 1 && new Set(runs.map(row => row.gpuP50)).size === 1;
    const conditions = [...new Set(report.timing.filter(row => row.workload === workload).map(row => row.condition))];
    for (const condition of ["baseline", AGAIN, ...conditions.filter(name => name !== "baseline" && name !== AGAIN)]) {
      if (!conditions.includes(condition)) continue;
      const mine = runs.filter(row => row.condition === condition);
      const pairs = mine.map(row => ({ row, base: runs.find(other => other.condition === "baseline" && other.round === row.round) })).filter(pair => pair.base);
      const change = metric => {
        const deltas = pairs.map(({ row, base }) => (row[metric] != null && base[metric] != null ? row[metric] - base[metric] : null)).filter(value => value !== null);
        const median = quantile(deltas, 0.5);
        const baseMedian = quantile(pairs.map(({ base }) => base[metric]).filter(value => value != null), 0.5);
        return {
          value: quantile(mine.map(row => row[metric]).filter(value => value != null), 0.5),
          delta: median, share: median != null && baseMedian ? median / baseMedian : null,
          lower: deltas.filter(value => value < 0).length, pairs: deltas.length,
        };
      };
      rows.push({
        workload, condition,
        render: change("renderP50"), mainThread: change("mainThreadMs"), activeMeshes: change("activeMeshesP50"), gpu: gpuStale ? null : change("gpuMean"),
        meshesExamined: quantile(mine.map(row => row.meshesExamined).filter(value => value != null), 0.5),
        drawCalls: quantile(mine.map(row => row.drawCalls).filter(value => value != null), 0.5),
        kept: mine.length, disturbed: report.timing.filter(row => row.workload === workload && row.condition === condition && row.interference).length,
      });
    }
  }
  return rows;
}

function summarize(report) {
  const f = (value, digits = 3) => (value == null ? "–" : value.toFixed(digits));
  const pct = value => (value == null ? "–" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`);
  const cell = (change, isBaseline) => (isBaseline || !change.pairs ? f(change.value) : `${f(change.value)} (${pct(change.share)}, ${change.lower}/${change.pairs} lower)`);
  const retried = report.timing.filter(row => row.attempt > 0).length;
  const lines = [
    "# Scene A/B benchmark",
    "",
    `Generated ${report.generatedAt}. ${report.browser.product}; ${report.info.atLoad?.rendererMode ?? "?"} WebGL ${report.info.atLoad?.webGLVersion ?? "?"} on ${report.info.atLoad?.glRenderer ?? "?"}.`,
    `Page ${report.config.page} from ${report.config.dist}${report.config.content ? ` and ${report.config.content}` : ""}; viewport ${report.config.viewport.width}×${report.config.viewport.height} CSS px at DPR ${report.config.dpr} (${report.info.atLoad?.renderSize?.join("×") ?? "?"} px drawn); tiles ${report.config.tiles}; cross-origin isolated: ${report.info.atLoad?.crossOriginIsolated ?? "?"}.`,
    `Stops ${report.info.stops?.join(", ") ?? "–"}; ${report.config.rounds} rounds of ${report.config.seconds} s per condition, in a new random order each round.`,
    `Each stretch waited for ${report.config.idleSeconds} s without keyboard or mouse input; ${retried} were run again after input or other load during them, and ${report.timing.filter(row => row.interference).length} stayed disturbed and are left out.`,
    "",
    "This is one Mac, not a phone. Milliseconds are per frame. `Render` is Babylon's scene render on the main thread, by the clock; `main thread` is Chrome's count of the main thread's CPU time, everything in the frame included (input, the HUD, garbage collection), without time spent waiting for a core; `GPU` is the GPU's frame from the timer query. Meshes examined and draw calls do not depend on load. `baseline-again` is the baseline measured a second time each round: changes no larger than its own are noise.",
    "",
  ];
  if (report.equivalence.length) {
    lines.push("## Equivalence", "", "| Workload | Condition | Pixels differing | Largest difference (0–255) | Differing by more than 2 |", "| --- | --- | ---: | ---: | ---: |");
    for (const block of report.equivalence) for (const row of block.rows) lines.push(`| ${block.workload} | ${row.condition} | ${row.differing} (${(row.differingShare * 100).toFixed(4)}%) | ${row.maxDiff} | ${row.over2} |`);
    lines.push("");
  }
  if (report.timing.length) {
    lines.push("## Timing", "", "Median per condition; in brackets, the median change from the same round's baseline as a share of it, and in how many rounds it was lower.", "",
      "| Workload | Condition | Render ms | Main thread ms | Active meshes ms | GPU ms | Meshes examined | Draw calls | Stretches kept (disturbed) |", "| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |");
    for (const row of paired(report)) {
      const base = row.condition === "baseline";
      lines.push(`| ${row.workload} | ${row.condition} | ${cell(row.render, base)} | ${cell(row.mainThread, base)} | ${cell(row.activeMeshes, base)} | ${row.gpu ? cell(row.gpu, base) : "stale"} | ${row.meshesExamined ?? "–"} | ${row.drawCalls ?? "–"} | ${row.kept} (${row.disturbed}) |`);
    }
    lines.push("");
    if (paired(report).some(row => !row.gpu)) lines.push("`stale`: the GPU timer gave one reading and never another, so the same value stood for every stretch; the GPU was not measured there.", "");
  }
  lines.push("## Run", "", `Requests: ${JSON.stringify(report.traffic)}.`, `Exceptions: ${report.exceptions.length ? report.exceptions.join(" | ") : "none"}. Console errors: ${report.consoleErrors.length}.`, "");
  return lines.join("\n");
}
