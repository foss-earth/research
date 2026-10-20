// The startup and runtime audit of the three apps (foss-earth/docs: performance-audit.md and
// proposals/startup-loading.md, Acceptance). See benchmarks/startup-audit/README.md.
//
//   node scripts/benchmarks/startup-audit/run.mjs --serve --tour-root <tour dist> --app-site <foss-earth.github.io dist>
//     --fly-root <0sfs.github.io dist> [--runs 3] [--targets tour,app,fly] [--label baseline] [--filmstrip] [--audit]
//
// Each run opens headless Chrome on a new, empty profile (cold), waits for the scene to settle, then
// opens the page again in the same profile, with its service worker and HTTP cache (warm). Both
// visits run under the Chrome DevTools "Fast 4G" network preset and a 4x CPU slowdown, applied to
// the page and to every worker and service worker it starts. Results land in
// build/benchmarks/startup-audit/<label>/<local time>/.
//
// A visit whose page reloads (a first visit does, to become cross-origin isolated) is timed from its first navigation:
// the HTML, the terminal and the first paint are the first load's, the rest the last load's; "Reloads" counts them.
// Read from the page: the boot:* performance marks (boot:html, boot:terminal, boot:modules,
// boot:renderer, boot:first-frame, boot:globe, boot:content, boot:settled) and the paint entries. Counted over the
// DevTools protocol: the bytes received over the network (encodedDataLength) by requests that
// finished before the first 3D frame, and in all until settled.
// Chrome refuses both throttles inside dedicated workers ("Not supported", "only supported for
// pages"): their requests still show the page's latency, but their CPU runs at full speed.
// --serve serves each target's dist/ for the run (serve.mjs), like GitHub Pages; without it the
// pages must already be served at the targets' URLs. --filmstrip also records what the screen
// showed, about every 100 ms, during each cold visit (screencast frames, in <name>-film/).
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { serveStatic } from './serve.mjs';
import { auditRuntime } from './audit.mjs';
import { openHeadlessChrome } from '../../lib/headlessChrome.mjs';
import { newOutputDirectory } from '../../lib/outputDirectory.mjs';

const { values: args } = parseArgs({ options: {
  runs: { type: 'string', default: '3' },
  targets: { type: 'string', default: 'tour,app,fly' },
  label: { type: 'string', default: 'baseline' },
  serve: { type: 'boolean', default: false },
  filmstrip: { type: 'boolean', default: false },
  // An installed Chrome; without it, CHROME_BIN or Google Chrome's usual place.
  binary: { type: 'string' },
  'settle-timeout': { type: 'string', default: '240' },
  // settled: each visit waits for boot:settled (0sfs: content + 15 s); content: only for boot:content.
  until: { type: 'string', default: 'settled' },
  // The builds --serve serves: the tour's dist/ (served at /tour/), the app's dist/ (at /app/) and the 0sfs site's
  // dist/, with the flight at /fly/.
  'tour-root': { type: 'string' },
  'app-root': { type: 'string' },
  'fly-root': { type: 'string' },
  // The published pages, over HTTP/2 from GitHub Pages, instead of a local build (no --serve).
  live: { type: 'boolean', default: false },
  // The app as its site serves it, at /app/ under the landing page at / (foss-earth.github.io/dist).
  'app-site': { type: 'string' },
  // A page on the target's server that links to it, as the landing page /: each cold visit opens it first, waits there
  // until the target's worker is active (as a visitor reads it before following the link), then opens the target.
  via: { type: 'string' },
  // After each warm visit, the runtime audit (audit.mjs): frames, CPU and memory, for --audit-seconds a stretch.
  audit: { type: 'boolean', default: false },
  'audit-seconds': { type: 'string', default: '8' },
} });
const RUNS = Number(args.runs);
const SETTLE_TIMEOUT_MS = Number(args['settle-timeout']) * 1000;
/**
 * The pages measured. A flight never stops drawing, so 0sfs has no settled moment: its visit
 * ends a while after the first frame instead.
 */
const TARGETS = {
  // The photographs come from the published site, as on the dev server without a local scene build.
  tour: { title: '`/tour/minneapolis/`', root: args['tour-root'], option: 'tour-root', base: '/tour/', port: 4173, page: 'minneapolis/', settles: true, live: 'https://umn-vr.github.io/tour/minneapolis/',
    proxy: { prefix: '/tour/twin-cities/media/', target: 'https://umn-vr.github.io' } },
  app: { title: 'FOSS Earth app `/app/`', root: args['app-root'], option: 'app-root or --app-site', base: '/app/', port: 4174, page: '', settles: true, live: 'https://foss-earth.github.io/app/' },
  fly: { title: '0sfs `/fly/`', root: args['fly-root'], option: 'fly-root', base: '/', port: 4175, page: 'fly/', settles: false, live: 'https://0sfs.github.io/fly/' },
};
if (args['app-site']) Object.assign(TARGETS.app, { root: args['app-site'], base: '/', page: 'app/', scope: '/app/' });
const AFTER_CONTENT_MS = 15000;
const targets = args.targets.split(',').map(name => name.trim()).filter(Boolean);
for (const name of targets) {
  if (!TARGETS[name]) throw new Error(`Unknown target ${name}`);
  if (args.serve && !TARGETS[name].root) throw new Error(`--serve needs --${TARGETS[name].option} for ${name}`);
  if (TARGETS[name].root) TARGETS[name].root = path.resolve(TARGETS[name].root);
}
const servers = [];
const urls = {};
for (const name of targets) {
  const target = TARGETS[name];
  if (args.serve) servers.push({ name, ...await serveStatic({ root: target.root, base: target.base, port: target.port, proxy: target.proxy }) });
  urls[name] = args.live ? target.live : `http://localhost:${target.port}${target.base}${target.page}`;
}

// Chrome DevTools' "Fast 4G" preset (front_end/core/sdk/NetworkManager.ts): 9 Mbps down and
// 1.5 Mbps up, each scaled by 0.9, and 60 ms latency scaled by 2.75.
const FAST_4G = { offline: false, latency: 60 * 2.75, downloadThroughput: 9 * 1000 * 1000 / 8 * 0.9, uploadThroughput: 1.5 * 1000 * 1000 / 8 * 0.9 };
const CPU_SLOWDOWN = 4;
const BOOT_MARKS = ['boot:html', 'boot:terminal', 'boot:modules', 'boot:renderer', 'boot:first-frame', 'boot:globe', 'boot:content', 'boot:settled'];
const CHROME_ARGS = ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--window-size=1280,800'];

const out = newOutputDirectory('benchmarks', 'startup-audit', args.label);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Runs first in every document of the visit and reports each load, boot mark and paint through a binding, so that a
// visit whose page reloads (as a first visit does to become cross-origin isolated) is timed from its first navigation.
const REPORTER = `(() => {
  if (!location.protocol.startsWith("http")) return;
  const report = (kind, entry) => { try { globalThis.__measureReport(JSON.stringify({ kind, name: entry ? entry.name : null,
    origin: performance.timeOrigin, at: entry ? entry.startTime : 0, duration: entry ? entry.duration : 0, detail: entry && typeof entry.detail === "string" ? entry.detail : null })); } catch {} };
  report("load", null);
  new PerformanceObserver(list => { for (const entry of list.getEntries()) {
    if (entry.entryType === "paint" || entry.name.startsWith("boot:")) report(entry.entryType, entry);
  } }).observe({ entryTypes: ["mark", "paint"] });
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) report("longtask", entry); }).observe({ type: "longtask", buffered: true }); } catch {}
})();`;

/** One browser, one profile; throttles every page, worker and service worker it attaches to. */
async function openThrottledBrowser(profile) {
  await rm(profile, { recursive: true, force: true });
  const chrome = await openHeadlessChrome(profile, args.binary, CHROME_ARGS);
  /** requestId → { session, url, finished (protocol seconds), bytes, fromServiceWorker } */
  let requests = new Map();
  const documentStarts = [];
  /** Every worker and service worker the page started, and whether it could be throttled. */
  const attached = [];
  const throttle = async sessionId => {
    await chrome.send('Network.enable', {}, sessionId).catch(() => {});
    await chrome.send('Network.emulateNetworkConditions', FAST_4G, sessionId);
  };
  let onScreencast = null;
  /** What REPORTER sent: each load's time origin and its boot marks and paints. */
  const reports = [];
  chrome.onEvent(message => {
    const { method, params, sessionId } = message;
    if (method === 'Runtime.bindingCalled' && params.name === '__measureReport') {
      try { reports.push(JSON.parse(params.payload)); } catch { /* Not a report. */ }
      return;
    }
    if (method === 'Page.screencastFrame') {
      onScreencast?.(params);
      void chrome.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      return;
    }
    if (method === 'Target.attachedToTarget') {
      const child = params.sessionId;
      const type = params.targetInfo.type;
      void (async () => {
        // Chrome answers "Not supported" to network emulation in a dedicated worker; its requests
        // are then counted but not slowed, which the results record.
        const entry = { type, url: params.targetInfo.url, session: child, network: null, cpu: null };
        attached.push(entry);
        // A paused service worker answers Network.enable only once it runs, so every command goes
        // out before the resume, in order on its session, and none waits for another.
        const outcome = promise => promise.then(() => 'throttled', error => error.message);
        const worker = type === 'service_worker' || type === 'worker' || type === 'shared_worker';
        const sent = worker ? [
          chrome.send('Network.enable', {}, child).catch(() => {}),
          outcome(chrome.send('Network.emulateNetworkConditions', FAST_4G, child)).then(value => { entry.network = value; }),
          outcome(chrome.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN }, child)).then(value => { entry.cpu = value; }),
          chrome.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child).catch(() => {}),
        ] : [];
        sent.push(chrome.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {}));
        await Promise.all(sent);
      })();
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      if (params.type === 'Document' && params.request.url.startsWith('http')) documentStarts.push({ url: params.request.url, timestamp: params.timestamp });
      requests.set(`${sessionId}:${params.requestId}`, { session: sessionId, url: params.request.url, sent: params.timestamp, bytes: 0, finished: null, priority: params.request.initialPriority });
    }
    if (method === 'Network.responseReceived') {
      const entry = requests.get(`${sessionId}:${params.requestId}`);
      if (entry) { entry.fromServiceWorker = params.response.fromServiceWorker === true; entry.fromCache = params.response.fromDiskCache === true; entry.status = params.response.status; entry.protocol = params.response.protocol; }
    }
    if (method === 'Network.loadingFinished') {
      const entry = requests.get(`${sessionId}:${params.requestId}`);
      if (entry) { entry.bytes = params.encodedDataLength; entry.finished = params.timestamp; }
    }
  });
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => chrome.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Runtime.addBinding', { name: '__measureReport' });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: REPORTER });
  await throttle(sessionId);
  await send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // Workers and the service worker start paused until they are throttled too.
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  return {
    chrome, send, evaluate, attached,
    onScreencast(listener) { onScreencast = listener; },
    resetRequests() { requests = new Map(); documentStarts.length = 0; attached.length = 0; reports.length = 0; },
    reports: () => [...reports],
    requests: () => [...requests.values()],
    documentStart: url => documentStarts.find(entry => entry.url === url) ?? documentStarts[0] ?? null,
    close: () => chrome.close(),
  };
}

/** Opens the page and waits for boot:settled; returns the marks and what the network carried. */
async function visit(browser, url, name, target, film) {
  browser.resetRequests();
  const frames = [];
  if (film) {
    browser.onScreencast(frame => frames.push(frame));
    await browser.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 640, maxHeight: 400, everyNthFrame: 1 });
  }
  await browser.send('Page.navigate', { url });
  const started = Date.now();
  let settled = false;
  let contentSeen = null;
  const marked = name => browser.evaluate(`performance.getEntriesByName(${JSON.stringify(name)}, "mark").length > 0`).catch(() => false);
  while (Date.now() - started < SETTLE_TIMEOUT_MS) {
    await sleep(500);
    if (args.until === 'content' || args.until === 'globe') {
      if (await marked(`boot:${args.until}`)) break;
    } else if (target.settles) {
      settled = await marked('boot:settled');
      if (settled) break;
    } else {
      if (contentSeen === null && await marked('boot:content')) contentSeen = Date.now();
      if (contentSeen !== null && Date.now() - contentSeen >= AFTER_CONTENT_MS) break;
    }
  }
  if (film) { await browser.send('Page.stopScreencast').catch(() => {}); browser.onScreencast(null); }
  const page = await browser.evaluate(`(() => {
    const marks = {};
    for (const name of ${JSON.stringify(BOOT_MARKS)}) {
      const mark = performance.getEntriesByName(name, "mark")[0];
      marks[name] = mark ? { at: mark.startTime, detail: mark.detail ?? null } : null;
    }
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map(entry => [entry.name, entry.startTime]));
    const timeOrigin = performance.timeOrigin;
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource").map(entry => ({ name: entry.name, end: entry.responseEnd,
      transfer: entry.transferSize, encoded: entry.encodedBodySize, type: entry.initiatorType }));
    return { marks, paint, resources, timeOrigin, controlled: !!navigator.serviceWorker?.controller,
      isolated: self.crossOriginIsolated === true, sharedMemory: typeof SharedArrayBuffer === "function", isolation: self.__fossEarthIsolation?.state ?? null,
      navigation: navigation && { responseEnd: navigation.responseEnd, domContentLoaded: navigation.domContentLoadedEventEnd,
        load: navigation.loadEventEnd, transfer: navigation.transferSize, encoded: navigation.encodedBodySize },
      renderer: document.querySelector("#rendererModePill")?.textContent?.trim() ?? null };
  })()`);
  const start = browser.documentStart(url);
  // Each load's marks, in ms from the first load's time origin. The page that stays is the last load.
  const loads = [];
  /** Every load's tasks over 50 ms, in ms from the first load's time origin. */
  const longTasks = [];
  for (const report of browser.reports()) {
    if (report.kind === 'load') { if (!loads.some(load => load.origin === report.origin)) loads.push({ origin: report.origin, marks: {}, paint: {} }); continue; }
    const load = loads.find(candidate => candidate.origin === report.origin);
    if (!load) continue;
    const at = report.origin + report.at - loads[0].origin;
    if (report.kind === 'longtask') { longTasks.push({ at, duration: report.duration }); continue; }
    if (report.kind === 'paint') load.paint[report.name] ??= at;
    else load.marks[report.name] ??= { at, detail: report.detail };
  }
  const reloads = Math.max(0, loads.length - 1);
  if (reloads) {
    // The marks and paints that count are the last load's, from the first navigation; the first paint is the first load's.
    const last = loads[loads.length - 1];
    // The HTML and the terminal the visitor first sees are the first load's.
    page.marks = Object.fromEntries(BOOT_MARKS.map(name => [name,
      (name === 'boot:html' || name === 'boot:terminal' ? loads[0].marks[name] : null) ?? last.marks[name] ?? null]));
    page.paint = { ...last.paint, ...loads[0].paint };
  }
  const firstFrame = page.marks['boot:first-frame']?.at ?? null;
  const settledAt = page.marks['boot:settled']?.at ?? null;
  const requests = browser.requests().filter(entry => entry.finished !== null && start);
  // Protocol timestamps are seconds on the browser's clock; the page's marks count from the
  // document request, which started at start.timestamp.
  const before = ms => requests.filter(entry => (entry.finished - start.timestamp) * 1000 <= ms);
  const sum = list => list.reduce((total, entry) => total + entry.bytes, 0);
  // Total blocking time: what each long task that began before `ms` held the main thread past 50 ms.
  const blocking = ms => ms === null ? null : Math.round(longTasks.filter(task => task.at < ms).reduce((total, task) => total + Math.max(0, task.duration - 50), 0));
  const result = {
    name, url, settled, renderer: page.renderer, controlledByServiceWorker: page.controlled, reloads,
    isolated: page.isolated, sharedMemory: page.sharedMemory, isolation: page.isolation,
    loads: loads.map(load => ({ at: Math.round(load.origin - loads[0].origin),
      marks: Object.fromEntries(Object.entries(load.marks).map(([key, value]) => [key, Math.round(value.at)])) })),
    marks: Object.fromEntries(Object.entries(page.marks).map(([key, value]) => [key, value && Math.round(value.at)])),
    rendererMode: page.marks['boot:renderer']?.detail ?? null,
    firstPaint: page.paint['first-paint'] ?? null,
    firstContentfulPaint: page.paint['first-contentful-paint'] ?? null,
    htmlBytes: page.navigation?.encoded ?? null,
    bytesBeforeFirstFrame: firstFrame === null || !start ? null : sum(before(firstFrame)),
    requestsBeforeFirstFrame: firstFrame === null || !start ? null : before(firstFrame).length,
    bytesUntilSettled: settledAt === null || !start ? null : sum(before(settledAt)),
    blockingBeforeFirstFrame: blocking(firstFrame), blockingBeforeGlobe: blocking(page.marks['boot:globe']?.at ?? null),
    longTasks: longTasks.length, longestTask: longTasks.length ? Math.round(Math.max(...longTasks.map(task => task.duration))) : null,
    requests: requests.length,
    workers: Object.entries(Object.groupBy(browser.attached.filter(entry => entry.type !== 'page'), entry => `${entry.type}: network ${entry.network}, cpu ${entry.cpu}`)).map(([key, list]) => `${list.length} ${key}`),
  };
  await writeFile(path.join(out, `${name}.json`), JSON.stringify({ ...result, page, requests: browser.requests() }, null, 2));
  if (film && frames.length) {
    // Screencast timestamps are wall-clock seconds; the page's clock starts at timeOrigin.
    const dir = path.join(out, `${name}-film`);
    await mkdir(dir, { recursive: true });
    // One frame per 100 ms, up to 2 s after the content (or the first 3D frame), is enough to see what showed when.
    const until = (page.marks['boot:content']?.at ?? firstFrame ?? Infinity) + 2000;
    const film = [];
    for (const frame of frames) {
      const at = Math.round(frame.metadata.timestamp * 1000 - page.timeOrigin);
      if (at > until) break;
      if (film.length && at - film[film.length - 1].at < 100) continue;
      film.push({ at, data: frame.data });
    }
    for (const frame of film) await writeFile(path.join(dir, `${String(frame.at).padStart(6, '0')}.jpg`), Buffer.from(frame.data, 'base64'));
    result.filmFrames = film.map(frame => frame.at);
  }
  const shot = await browser.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) await writeFile(path.join(out, `${name}.png`), Buffer.from(shot.data, 'base64'));
  return result;
}

const results = [];
for (const target of targets) {
  for (let run = 1; run <= RUNS; run += 1) {
    const browser = await openThrottledBrowser(path.join(out, `profile-${target}-${run}`));
    try {
      if (args.via) {
        const scope = new URL(TARGETS[target].scope ?? TARGETS[target].base, urls[target]).href;
        await browser.send('Page.navigate', { url: new URL(args.via, urls[target]).href });
        const opened = Date.now();
        let ready = false;
        while (!ready && Date.now() - opened < 15000) {
          await sleep(100);
          ready = await browser.evaluate(`navigator.serviceWorker.getRegistration(${JSON.stringify(scope)}).then(r => r?.active?.state === "activated")`).catch(() => false);
        }
        console.log(`${target} ${run}: ${args.via} ${ready ? `had the worker active after about ${Date.now() - opened} ms` : "had no active worker after 15 s"}`);
      }
      const cold = await visit(browser, urls[target], `${target}-${run}-cold`, TARGETS[target], args.filmstrip);
      await browser.send('Page.navigate', { url: 'about:blank' });
      await sleep(1000);
      const warm = await visit(browser, urls[target], `${target}-${run}-warm`, TARGETS[target], false);
      if (args.audit) {
        warm.audit = await auditRuntime(browser, { drags: TARGETS[target].settles, seconds: Number(args['audit-seconds']), slowdown: CPU_SLOWDOWN });
        await writeFile(path.join(out, `${target}-${run}-audit.json`), JSON.stringify(warm.audit, null, 2));
      }
      for (const result of [cold, warm]) {
        results.push({ target, run, visit: result.name.endsWith('cold') ? 'cold' : 'warm', ...result });
        console.log(JSON.stringify({ name: result.name, settled: result.settled, renderer: result.rendererMode, reloads: result.reloads, loads: result.reloads ? result.loads : undefined, marks: result.marks,
          fp: result.firstPaint && Math.round(result.firstPaint), fcp: result.firstContentfulPaint && Math.round(result.firstContentfulPaint), bytesBeforeFirstFrame: result.bytesBeforeFirstFrame,
          bytesUntilSettled: result.bytesUntilSettled, workers: result.workers }));
      }
    } finally {
      await browser.close();
      await rm(path.join(out, `profile-${target}-${run}`), { recursive: true, force: true });
    }
  }
}

const median = values => {
  const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const seconds = ms => ms === null ? '—' : `${(ms / 1000).toFixed(2)} s`;
const mib = bytes => bytes === null ? '—' : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const rows = [];
for (const target of targets) for (const visitKind of ['cold', 'warm']) {
  const group = results.filter(result => result.target === target && result.visit === visitKind);
  const at = pick => seconds(median(group.map(pick)));
  const settles = TARGETS[target].settles && args.until !== 'content' && args.until !== 'globe';
  rows.push(`| ${TARGETS[target].title} | ${visitKind} | ${at(r => r.firstPaint)} | ${at(r => r.firstContentfulPaint)} | ${at(r => r.marks['boot:terminal'])} | `
    + `${at(r => r.marks['boot:modules'])} | ${at(r => r.marks['boot:renderer'])} | ${at(r => r.marks['boot:first-frame'])} | `
    + `${at(r => r.marks['boot:globe'])} | ${at(r => r.marks['boot:content'])} | `
    + `${mib(median(group.map(r => r.bytesBeforeFirstFrame)))} | ${settles ? at(r => r.marks['boot:settled']) : 'n/a'} | `
    + `${settles ? `${group.filter(r => r.settled).length}/${group.length}` : 'n/a'} | ${group.map(r => r.reloads).join(', ')} |`);
}
const table = [
  `Medians of ${RUNS} run(s); Fast 4G, ${CPU_SLOWDOWN}x CPU slowdown, ${new Date().toISOString().slice(0, 10)}.`,
  '',
  '| Page | Visit | First paint | First contentful paint | `boot:terminal` | Modules run | Renderer | First 3D frame | Globe | Content | Bytes before first frame | Settled | Settled runs | Reloads |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
].join('\n');
const auditRows = [], frameRows = [];
if (args.audit) for (const target of targets) {
  const group = results.filter(result => result.target === target && result.visit === 'warm' && result.audit);
  const cold = results.filter(result => result.target === target && result.visit === 'cold');
  const ms = value => value === null ? '—' : `${Math.round(value)} ms`;
  const of = (list, pick) => median(list.map(pick));
  const memory = pick => mib(of(group, r => pick(r.audit.memoryAfter) ?? null));
  auditRows.push(`| ${TARGETS[target].title} | ${ms(of(cold, r => r.blockingBeforeGlobe))} | ${ms(of(group, r => r.blockingBeforeGlobe))} | `
    + `${memory(m => m.jsHeapUsed)} | ${memory(m => m.workersHeapUsed)} (${of(group, r => r.audit.memoryAfter.workers) ?? '—'}) | ${memory(m => m.pageArrayBuffers)} | `
    + `${memory(m => m.pageRenderer?.footprint)} | ${memory(m => m.processes.GPU?.footprint)} | ${memory(m => m.processes.GPU?.gpu)} | ${memory(m => m.processes.GPU?.peak)} | `
    + `${group.map(r => r.isolated ? 'yes' : 'no').join(', ')} |`);
  const kinds = [...new Set(group.flatMap(r => r.audit.stretches.map(each => `${each.cpuSlowdown}x ${each.motion}`)))];
  for (const kind of kinds) {
    const list = group.map(r => r.audit.stretches.find(each => `${each.cpuSlowdown}x ${each.motion}` === kind)).filter(Boolean);
    const pct = value => value === null ? '—' : `${Math.round(value * 100)} %`;
    frameRows.push(`| ${TARGETS[target].title} | ${kind} | ${of(list, e => e.fps)?.toFixed(1) ?? '—'} | ${of(list, e => e.intervalMs.median)} ms | ${of(list, e => e.intervalMs.p95)} ms | ${of(list, e => e.intervalMs.p99)} ms | `
      + `${of(list, e => e.slowFrames / Math.max(1, e.frames)) === null ? '—' : pct(of(list, e => e.slowFrames / Math.max(1, e.frames)))} | ${pct(of(list, e => e.mainThread))} | ${pct(of(list, e => e.pageRenderer))} | ${pct(of(list, e => e.gpuProcess))} |`);
  }
}
const auditTable = args.audit ? [
  '', `Runtime, medians of ${RUNS} warm visit(s) at their moment, ${args['audit-seconds']} s a stretch; memory after the stretches.`, '',
  '| Page | Blocking before globe, cold | Blocking before globe, warm | Main-thread JS heap | Workers\' JS heaps (workers) | Page array buffers | Page renderer footprint | GPU process footprint | Of it, graphics | GPU process peak | Isolated |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...auditRows, '',
  '| Page | Stretch | Frames/s | Median interval | p95 | p99 | Frames over 25 ms | Main thread busy | Page renderer CPU | GPU process CPU |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...frameRows,
].join('\n') : '';
await writeFile(path.join(out, 'summary.md'), table + auditTable + '\n');
await writeFile(path.join(out, 'results.json'), JSON.stringify({ fast4g: FAST_4G, cpuSlowdown: CPU_SLOWDOWN, urls, results }, null, 2));
for (const server of servers) {
  if (server.log.length) console.log(`${server.name} server: ${server.log.length} not found, e.g. ${server.log.slice(0, 5).map(entry => entry[1]).join(', ')}`);
  await server.close();
}
console.log('\n' + table + auditTable + '\n\n' + out);
