/**
 * The page's surroundings for the browser runs: a static HTTPS server on the
 * loopback address, the bundled page, and headless Chrome on this machine's
 * GPU through scripts/lib/headlessChrome.mjs.
 *
 * **The server is a static file server.** It serves the dataset, the tour's
 * published files (for the control) and the page, with the headers GitHub
 * Pages sends (`Cache-Control: max-age=600`) and the cross-origin isolation
 * headers that give the page a fine clock, which GitHub Pages cannot send. It
 * speaks HTTP/2 over TLS, as GitHub Pages does, with a certificate made for
 * 127.0.0.1 in the gitignored scratch folder. Its one route that is not a file
 * is `PUT /sink/…`, where the page leaves its results; a dataset never needs
 * it. It logs every response: path, bytes sent, and whether it finished.
 * It listens on 127.0.0.1 only, on a port the system picks, and is closed when
 * the run ends.
 *
 * **Faults** can be switched on per run: every n-th tile request answered 503,
 * or every tile response held back by a delay.
 *
 * **The network.** Chrome's own emulation (`Network.emulateNetworkConditions`)
 * shapes the page's requests: a latency added to each request and a download
 * rate shared by the requests in flight. It is not a real network and not
 * Phase 1's model either; `calibrate` measures what it does.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import path from "node:path";
import { build } from "vite";
import { evaluate, openHeadlessChrome } from "../../../scripts/lib/headlessChrome.mjs";
import { benchmarkRoot, repositoryRoot, scratchDirectory } from "./paths.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".bin": "application/octet-stream" };
const ISOLATED = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "cross-origin" };

/** Bundles viewer/page.ts into one script. */
export async function bundlePage(out) {
  await build({
    configFile: false, root: repositoryRoot, logLevel: "warn",
    build: { outDir: path.join(out, "bundle"), emptyOutDir: false, minify: true, lib: { entry: path.join(benchmarkRoot, "viewer/page.ts"), formats: ["iife"], name: "EacPrototype", fileName: () => "page.js" } },
  });
  return path.join(out, "bundle/page.js");
}

function certificate() {
  const directory = path.join(scratchDirectory, "tls"), key = path.join(directory, "key.pem"), cert = path.join(directory, "cert.pem");
  if (!existsSync(cert)) {
    mkdirSync(directory, { recursive: true });
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "30", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/**
 * Starts the server. `roots` maps a URL prefix to a folder; `pageScript` is the
 * bundle; `sinkDirectory` receives the page's PUTs. Returns `{ origin, log,
 * faults, close() }`.
 */
export async function startServer({ roots, pageScript, sinkDirectory, plain = false }) {
  const log = [], faults = { failEvery: 0, delayMs: 0, tileRequests: 0 }, started = performance.now();
  const page = Buffer.from('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EAC prototype</title><body><script src="/page.js"></script>');
  // Plain HTTP/1.1 when asked: Chrome keeps nothing in its HTTP cache from a connection with a certificate
  // error, even one it was told to ignore, so a warm-cache run needs a connection without one.
  const server = plain ? http.createServer() : http2.createSecureServer({ ...certificate(), allowHTTP1: true }), sessions = new Set();
  server.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
  server.on("request", (request, response) => {
    const url = new URL(request.url, "https://127.0.0.1"), pathname = decodeURIComponent(url.pathname);
    const entry = { t: performance.now() - started, path: pathname, method: request.method, version: request.httpVersion, status: 0, bytes: 0, finished: false };
    log.push(entry);
    const send = (status, body, type, extra = {}) => {
      entry.status = status; entry.bytes = body.length;
      response.writeHead(status, { "content-type": type, "content-length": body.length, "cache-control": "max-age=600", ...ISOLATED, ...extra });
      response.end(body);
    };
    response.on("finish", () => { entry.finished = true; });
    response.on("close", () => { if (!entry.finished) entry.aborted = true; });
    if (request.method === "PUT" && pathname.startsWith("/sink/")) {
      const target = path.join(sinkDirectory, path.normalize(pathname.slice("/sink/".length)).replace(/^(\.\.[/\\])+/, ""));
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, Buffer.concat(chunks)); send(204, Buffer.alloc(0), "text/plain"); });
      return;
    }
    if (pathname === "/") return send(200, page, TYPES[".html"]);
    if (pathname === "/page.js") return send(200, readFileSync(pageScript), TYPES[".js"]);
    const prefix = Object.keys(roots).find(item => pathname.startsWith(item));
    const relative = prefix ? path.normalize(pathname.slice(prefix.length) || "index.html").replace(/^(\.\.[/\\])+/, "") : null;
    const file = prefix ? path.join(roots[prefix], relative.endsWith("/") ? `${relative}index.html` : relative) : null;
    if (!file || !existsSync(file) || !statSync(file).isFile()) return send(404, Buffer.from("not found"), "text/plain");
    const isTile = /\/[tr]\/[pn][xyz]\//.test(pathname);
    if (isTile) faults.tileRequests++;
    if (isTile && faults.failEvery > 0 && faults.tileRequests % faults.failEvery === 0) return send(503, Buffer.from("injected failure"), "text/plain");
    const body = readFileSync(file), respond = () => send(200, body, TYPES[path.extname(file)] ?? "application/octet-stream");
    if (isTile && faults.delayMs > 0) setTimeout(respond, faults.delayMs); else respond();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `${plain ? "http" : "https"}://127.0.0.1:${server.address().port}`, log, faults,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); for (const session of sessions) session.destroy(); }),
  };
}

/** Headless Chrome for these runs: the real GPU, WebGPU's timestamps, the loopback certificate accepted. */
export async function openChrome(profileDirectory) {
  const chrome = await openHeadlessChrome(profileDirectory, process.env.CHROME_BIN, ["--enable-webgpu-developer-features", "--ignore-certificate-errors"]);
  const browser = await chrome.send("Browser.getVersion");
  let gpu = null;
  try { gpu = (await chrome.send("SystemInfo.getInfo")).gpu; } catch (error) { gpu = { error: error.message }; }
  const devices = gpu.devices?.map(device => `${device.vendorString} ${device.deviceString}`.trim()).join("; ") ?? "";
  if (/swiftshader|llvmpipe|software/i.test(devices)) { await chrome.close(); throw new Error(`Software GPU rejected: ${devices}`); }
  return { chrome, browser, gpu: { devices: gpu.devices, auxAttributes: gpu.auxAttributes } };
}

export const encodeSpec = spec => Buffer.from(JSON.stringify(spec)).toString("base64url");

/**
 * Opens a page in a fresh browser context (its own HTTP cache), with a phone's
 * metrics and the given network, and returns `{ send, evaluate, close }`.
 * `network` is a profile (`megabitsPerSecond`, `roundTripMs`) or null for none.
 */
export async function openPage(chrome, { url, viewport, network, context = null, clearCache = true, gated = false }) {
  const browserContextId = context ?? (await chrome.send("Target.createBrowserContext", { disposeOnDetach: false })).browserContextId;
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params = {}) => chrome.send(method, params, sessionId);
  const messages = [];
  const off = chrome.onEvent(message => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") messages.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) messages.push(message.params.args.map(value => value.value ?? value.description).join(" "));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Emulation.setUserAgentOverride", { userAgent: "foss-earth-check/1.0" });
  await send("Emulation.setDeviceMetricsOverride", { width: viewport.cssWidth, height: viewport.cssHeight, deviceScaleFactor: viewport.devicePixelRatio, mobile: true });
  if (clearCache) await send("Network.clearBrowserCache");
  await send("Network.setCacheDisabled", { cacheDisabled: false });
  const throttle = () => (network ? send("Network.emulateNetworkConditions", { offline: false, latency: network.roundTripMs, downloadThroughput: network.megabitsPerSecond * 1e6 / 8, uploadThroughput: network.megabitsPerSecond * 1e6 / 8 }) : null);
  // A gated page loads its script at full speed and waits; the network is shaped only for what comes after.
  if (!gated) await throttle();
  await send("Page.navigate", { url });
  if (gated) {
    const deadline = Date.now() + 60000;
    while (!(await evaluate(chrome, sessionId, "window.eac?.waiting === true").catch(() => false))) {
      if (Date.now() > deadline) throw new Error("the page did not reach its start gate");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await throttle();
    await evaluate(chrome, sessionId, "window.eac.start(), true");
  }
  return {
    sessionId, browserContextId, messages, send,
    evaluate: expression => evaluate(chrome, sessionId, expression),
    async waitFor(expression, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // The page may still be loading, or navigating, when it is asked.
        if (await evaluate(chrome, sessionId, expression).catch(() => false)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    },
    async close({ keepContext = false } = {}) {
      off();
      await chrome.send("Target.closeTarget", { targetId }).catch(() => {});
      if (!keepContext) await chrome.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    },
  };
}

/**
 * What Chrome's emulation actually does to a request: one small file several
 * times (latency), one large file alone (rate), and six at once (sharing).
 * Measured inside the page with its own clock.
 */
export async function calibrate(chrome, origin, network, viewport) {
  const page = await openPage(chrome, { url: `${origin}/cal/`, viewport, network });
  try {
    await page.waitFor("document.readyState === 'complete'", 30000);
    // Started in the page and polled: on the slowest profile it takes longer than one DevTools call may.
    await page.evaluate(`window.calibration = null; (async () => {
      const time = async (urls) => { const started = performance.now(); const sizes = await Promise.all(urls.map(async url => (await (await fetch(url + '?' + Math.random(), { cache: 'no-store' })).arrayBuffer()).byteLength)); return { ms: performance.now() - started, bytes: sizes.reduce((a, b) => a + b, 0) }; };
      const small = []; for (let k = 0; k < 5; k++) small.push((await time(['/cal/1.bin'])).ms);
      const one = await time(['/cal/1048576.bin']);
      const six = await time(Array.from({ length: 6 }, () => '/cal/262144.bin'));
      window.calibration = { smallRequestMs: small, oneMiB: one, sixQuarterMiB: six, protocol: performance.getEntriesByType('resource').at(-1)?.nextHopProtocol ?? null };
    })(); true`);
    await page.waitFor("window.calibration !== null", 180000);
    return await page.evaluate("window.calibration");
  } finally { await page.close(); }
}

/** Files for `calibrate`, made once in the scratch folder. */
export function calibrationFiles() {
  const directory = path.join(scratchDirectory, "cal");
  mkdirSync(directory, { recursive: true });
  for (const size of [1, 262144, 1048576]) { const file = path.join(directory, `${size}.bin`); if (!existsSync(file)) writeFileSync(file, Buffer.alloc(size, 7)); }
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>calibration</title>");
  return directory;
}
