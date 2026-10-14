/**
 * Headless Chrome for the ai-framegen-upscale harness: launches Chrome through
 * scripts/lib/headlessChrome.mjs with the WebGPU flags this benchmark records,
 * opens the harness page on the isolated https://foss-earth.test origin
 * (served by lib/serve.mjs), captures the page's console, exceptions and log
 * entries, and runs page jobs through the start/poll API (every CDP command
 * times out after 15 s, so long page work never runs inside one command).
 *
 *   import { launchChrome, openHarnessPage } from "./lib/browser.mjs";
 *   const browser = await launchChrome(profileDirectory);
 *   try {
 *     const page = await openHarnessPage(browser, routes);
 *     const value = await page.job("init", {}, { timeoutMs: 60000 });
 *     await page.close();
 *   } finally { await browser.close(); }
 *
 * The page exposes `window.aiHarness.start(kind, params) -> jobId` (returns at
 * once) and `window.aiHarness.poll(jobId) -> { done, ok, value, error, progress }`.
 */
import { performance } from "node:perf_hooks";
import { evaluate, openHeadlessChrome } from "../../../lib/headlessChrome.mjs";
import { PAGE_URL, serveSession } from "./serve.mjs";

/** Unquantized GPU timestamps and adapter info (DESIGN.md section 4); recorded with every result. */
export const CHROME_FLAGS = ["--enable-webgpu-developer-features", "--enable-unsafe-webgpu"];
const SOFTWARE = /swiftshader|llvmpipe|software|basic render/i;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Starts Chrome on `profileDirectory` (inside research/build/). Returns
 * `{ chrome, flags, version, gpu, launchMs, close() }`; refuses a software GPU.
 * Always `await browser.close()` in a `finally`.
 */
export async function launchChrome(profileDirectory, { binary = process.env.CHROME_BIN, extraFlags = [] } = {}) {
  const flags = [...CHROME_FLAGS, ...extraFlags];
  const start = performance.now();
  const chrome = await openHeadlessChrome(profileDirectory, binary, flags);
  const launchMs = performance.now() - start;
  const browser = { chrome, flags, launchMs, version: null, gpu: null, close: () => chrome.close() };
  try {
    const version = await chrome.send("Browser.getVersion");
    browser.version = { product: version.product, revision: version.revision, protocolVersion: version.protocolVersion, userAgent: version.userAgent, jsVersion: version.jsVersion };
    try {
      const info = await chrome.send("SystemInfo.getInfo");
      browser.gpu = {
        devices: info.gpu.devices.map(device => ({ vendorId: device.vendorId, deviceId: device.deviceId, vendorString: device.vendorString, deviceString: device.deviceString, driverVendor: device.driverVendor, driverVersion: device.driverVersion, active: device.active })),
        featureStatus: Object.fromEntries(Object.entries(info.gpu.featureStatus ?? {}).filter(([key]) => /webgpu|gpu_compositing|rasterization/i.test(key))),
      };
    } catch (error) {
      browser.gpu = { error: error.message };
    }
    const names = (browser.gpu.devices ?? []).map(device => `${device.vendorString} ${device.deviceString}`).join("; ");
    if (SOFTWARE.test(names)) throw new Error(`software GPU refused: ${names}`);
  } catch (error) {
    await chrome.close();
    throw error;
  }
  return browser;
}

/** One console/exception/log line as text: `{ t, source, level, text }` (t = ms since the page was opened). */
function consoleText(args = []) {
  return args.map(arg => (arg.type === "string" ? arg.value : arg.value !== undefined ? JSON.stringify(arg.value) : arg.description ?? arg.type)).join(" ");
}

/**
 * A new tab on the harness page. `routes` from lib/serve.mjs harnessRoutes().
 * Returns `{ sessionId, console, requests, evaluate(expression), job(kind, params, options), close() }`.
 */
export async function openHarnessPage(browser, routes, { url = PAGE_URL, readyTimeoutMs = 30000, onConsole = null } = {}) {
  const { chrome } = browser;
  const opened = performance.now();
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const lines = [];
  const push = (source, level, text) => {
    const entry = { t: +(performance.now() - opened).toFixed(1), source, level, text };
    lines.push(entry);
    onConsole?.(entry);
  };
  let lost = null;
  const detachEvents = chrome.onEvent(message => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.consoleAPICalled") push("console", message.params.type, consoleText(message.params.args));
    else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      push("exception", "error", details.exception?.description ?? details.text);
    } else if (message.method === "Log.entryAdded") push(`log:${message.params.entry.source}`, message.params.entry.level, message.params.entry.text);
    else if (message.method === "Inspector.targetCrashed") { lost = "target crashed"; push("inspector", "error", lost); }
  });
  const server = await serveSession(chrome, sessionId, routes);
  const send = (method, params = {}) => chrome.send(method, params, sessionId);
  const page = {
    sessionId, targetId, console: lines, requests: server.requests, openedAt: new Date().toISOString(),
    evaluate: expression => evaluate(chrome, sessionId, expression),
    /** Starts a page job and polls it every `intervalMs` until done or `timeoutMs`. Throws on a failed job. */
    async job(kind, params = {}, { timeoutMs = 120000, intervalMs = 150, onProgress = null } = {}) {
      const start = performance.now();
      const jobId = await page.evaluate(`window.aiHarness.start(${JSON.stringify(kind)}, ${JSON.stringify(params)})`);
      let last = null;
      for (;;) {
        if (lost) throw new Error(`${kind}: ${lost}`);
        const state = await page.evaluate(`window.aiHarness.poll(${JSON.stringify(jobId)})`);
        if (state.done) {
          if (!state.ok) {
            const error = new Error(`page job ${kind} failed: ${state.error}`);
            error.pageError = state.error;
            error.partial = state.value ?? null;
            throw error;
          }
          return state.value;
        }
        if (onProgress && state.progress !== undefined && JSON.stringify(state.progress) !== last) {
          last = JSON.stringify(state.progress);
          onProgress(state.progress);
        }
        if (performance.now() - start > timeoutMs) throw new Error(`page job ${kind} did not finish within ${timeoutMs} ms (progress ${JSON.stringify(state.progress ?? null)})`);
        await pause(intervalMs);
      }
    },
    async close() {
      detachEvents();
      server.detach();
      await chrome.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Log.enable");
    await send("Inspector.enable").catch(() => {});
    const navigation = await send("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`navigation to ${url} failed: ${navigation.errorText}`);
    const deadline = performance.now() + readyTimeoutMs;
    while (!(await page.evaluate("window.aiHarness?.ready === true").catch(() => false))) {
      const failure = await page.evaluate("window.aiHarness?.loadError ?? null").catch(() => null);
      if (failure) throw new Error(`harness page failed to load: ${failure}`);
      if (performance.now() > deadline) throw new Error(`harness page not ready within ${readyTimeoutMs} ms; console: ${lines.slice(-5).map(line => line.text).join(" | ")}`);
      await pause(100);
    }
  } catch (error) {
    await page.close();
    throw error;
  }
  return page;
}
