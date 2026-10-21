// Where a page's main-thread time goes while it runs: the runtime audit's stretches (audit.mjs), with a V8 CPU profile
// of each, mapped back to source files and functions through the build's source maps.
//
//   node scripts/benchmarks/startup-audit/profile.mjs --target fly --root <dist built with --sourcemap>
//     [--motion still|drag|enter] [--rates 1,4] [--seconds 8] [--query "set.renderer.profiling.enabled=1"] [--label name]
//     [--phone] [--layout] [--reduced-motion] [--memory] [--heap] [--gpu]
//
// The visit is the audit's: a cold visit on a new profile under Fast 4G and a 4x CPU slowdown, then a warm visit
// through the service worker it installed, which waits for boot:content (and boot:settled on a page that settles, or
// 15 s after the content on the flight). Then, for each rate in --rates, one stretch of --seconds with the CPU profiler
// on. Output goes to build/benchmarks/startup-audit/profile-<label>/<local time>/: each profile (.cpuprofile, which
// DevTools opens), and summary.md with each stretch's frames, main-thread share, style recalculations and layouts per
// frame, and the functions and files that took its time, self and inclusive.
//
// --phone measures at a phone's viewport (412×915 CSS pixels at 2.625 device pixels each, touch), and drags with a
// finger. --motion enter flies into a 360 image and out again, 3 s each way, through the page's test hook.
//
// --layout also traces each stretch's style recalculations and layouts, and names the script that forced each one
// by reading layout while it was out of date. A CPU profile charges a forced layout to the script that read it. The
// trace's stacks slow forced work a little. The trace is saved beside the profile, for DevTools' Performance panel.
//
// --reduced-motion has the page ask for less motion (prefers-reduced-motion: reduce), which stops the CSS animations
// that honour it, to price them against a run without it.
//
// Build the page with source maps for names (vite build --sourcemap --outDir <somewhere in build/>). Without them the
// summary names the minified chunks.
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SourceMapConsumer } from 'source-map-js';
import { serveStatic } from './serve.mjs';
import { openHeadlessChrome } from '../../lib/headlessChrome.mjs';
import { newOutputDirectory } from '../../lib/outputDirectory.mjs';

const { values: args } = parseArgs({ options: {
  target: { type: 'string', default: 'fly' },
  root: { type: 'string' },
  label: { type: 'string', default: '' },
  motion: { type: 'string' },
  rates: { type: 'string', default: '1,4' },
  seconds: { type: 'string', default: '8' },
  // Extra query parameters for the page, such as set.renderer.profiling.enabled=1.
  query: { type: 'string', default: '' },
  // Sampling interval of the CPU profiler, in microseconds.
  interval: { type: 'string', default: '200' },
  binary: { type: 'string' },
  'no-throttle': { type: 'boolean', default: false },
  // Skip the cold visit: one visit on a new profile, measured once it has reached its moment.
  'cold-only': { type: 'boolean', default: false },
  top: { type: 'string', default: '45' },
  // A page expression read before and after each stretch, such as counters an instrumented build keeps on globalThis.
  probe: { type: 'string' },
  // After the stretches, where memory is: macOS footprint's categories for the page's renderer and the GPU process,
  // and a memory-infra dump of every Chrome process, by allocator.
  memory: { type: 'boolean', default: false },
  // After the stretches (and after --memory), one heap snapshot of the page: heap.heapsnapshot, which DevTools'
  // Memory panel opens, and heap.json, its self size by kind of node and by constructor.
  heap: { type: 'boolean', default: false },
  // After the stretches, the GPU memory the page holds through WebGPU: every texture and buffer its GPUDevice made
  // and has not destroyed, by kind (render target, sampled texture, buffer usage) and by Babylon's label with its
  // numbers and any name that could be an address masked. Wraps createTexture and createBuffer from the first script.
  gpu: { type: 'boolean', default: false },
  phone: { type: 'boolean', default: false },
  layout: { type: 'boolean', default: false },
  'reduced-motion': { type: 'boolean', default: false },
} });

const TARGETS = {
  tour: { base: '/tour/', port: 4183, page: 'minneapolis/', settles: true, proxy: { prefix: '/tour/twin-cities/media/', target: 'https://umn-vr.github.io' } },
  app: { base: '/app/', port: 4184, page: '', settles: true },
  fly: { base: '/', port: 4185, page: 'fly/', settles: false },
};
const target = TARGETS[args.target];
if (!target) throw new Error(`Unknown target ${args.target}`);
if (!args.root) throw new Error('--root <dist> is required');
const root = path.resolve(args.root);
const motion = args.motion ?? (target.settles ? 'drag' : 'still');
const SECONDS = Number(args.seconds);
const RATES = args.rates.split(',').filter(Boolean).map(Number);
const FAST_4G = { offline: false, latency: 60 * 2.75, downloadThroughput: 9 * 1000 * 1000 / 8 * 0.9, uploadThroughput: 1.5 * 1000 * 1000 / 8 * 0.9 };
const CPU_SLOWDOWN = 4;
const VIEWPORT = args.phone ? { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true } : { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
// Metal on macOS; elsewhere Chrome's default, with any flags a machine needs in CHROME_EXTRA_ARGS (a Linux VM's software WebGPU, say).
const CHROME_ARGS = ['--enable-unsafe-webgpu', '--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), '--ignore-gpu-blocklist',
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, ...(process.env.CHROME_EXTRA_ARGS?.split(' ').filter(Boolean) ?? [])];
const AFTER_CONTENT_MS = 15000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = newOutputDirectory('benchmarks', 'startup-audit', `profile-${args.target}${args.phone ? '-phone' : ''}${args.label ? `-${args.label}` : ''}`);

const server = await serveStatic({ root, base: target.base, port: target.port, proxy: target.proxy });
const queries = [args.query.replace(/^\?/, ''), motion === 'enter' ? 'panoramaTest=1' : ''].filter(Boolean);
const query = queries.length ? `?${queries.join('&')}` : '';
const url = `http://localhost:${target.port}${target.base}${target.page}${query}`;
const profileDir = path.join(out, 'chrome-profile');
const chrome = await openHeadlessChrome(profileDir, args.binary, CHROME_ARGS);
const throttle = !args['no-throttle'];
const attached = [];
chrome.onEvent(message => {
  if (message.method !== 'Target.attachedToTarget') return;
  const child = message.params.sessionId;
  const type = message.params.targetInfo.type;
  attached.push({ type, url: message.params.targetInfo.url, session: child });
  const worker = type === 'service_worker' || type === 'worker' || type === 'shared_worker';
  const sent = worker && throttle ? [
    chrome.send('Network.enable', {}, child).catch(() => {}),
    chrome.send('Network.emulateNetworkConditions', FAST_4G, child).catch(() => {}),
    chrome.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN }, child).catch(() => {}),
    chrome.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child).catch(() => {}),
  ] : worker ? [chrome.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child).catch(() => {})] : [];
  sent.push(chrome.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {}));
  void Promise.all(sent);
});
const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
const send = (method, params = {}) => chrome.send(method, params, sessionId);
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
await send('Page.enable');
await send('Runtime.enable');
if (throttle) {
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', FAST_4G);
  await send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
}
await send('Emulation.setDeviceMetricsOverride', VIEWPORT);
if (args.phone) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
if (args['reduced-motion']) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
// Bytes per texel of the formats a page may make; block-compressed formats by their 4x4 blocks.
const GPU_ACCOUNTING = `(() => {
  if (!self.GPUDevice) return;
  const texel = { r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1, stencil8: 1, r16float: 2, r16uint: 2, r16sint: 2, rg8unorm: 2, rg8snorm: 2,
    rg8uint: 2, rg8sint: 2, depth16unorm: 2, r32float: 4, r32uint: 4, r32sint: 4, rg16float: 4, rg16uint: 4, rg16sint: 4, rgba8unorm: 4,
    'rgba8unorm-srgb': 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4, rgb10a2unorm: 4, rgb10a2uint: 4,
    rg11b10ufloat: 4, rgb9e5ufloat: 4, depth24plus: 4, 'depth24plus-stencil8': 4, depth32float: 4, 'depth32float-stencil8': 8,
    rg32float: 8, rg32uint: 8, rg32sint: 8, rgba16float: 8, rgba16uint: 8, rgba16sint: 8, rgba32float: 16, rgba32uint: 16, rgba32sint: 16 };
  const blockBytes = format => /^(bc1|bc4|etc2-rgb8|etc2-rgb8a1|eac-r11)/.test(format) ? 8 : /^(bc|etc2|eac|astc-4x4)/.test(format) ? 16 : null;
  const bytesOf = d => {
    const size = Array.isArray(d.size) ? { width: d.size[0], height: d.size[1] ?? 1, depthOrArrayLayers: d.size[2] ?? 1 } : d.size;
    const width = size.width, height = size.height ?? 1, layers = size.depthOrArrayLayers ?? 1, block = blockBytes(d.format);
    let total = 0;
    for (let level = 0; level < (d.mipLevelCount ?? 1); level += 1) {
      const w = Math.max(1, width >> level), h = Math.max(1, height >> level), l = d.dimension === '3d' ? Math.max(1, layers >> level) : layers;
      total += block ? Math.ceil(w / 4) * Math.ceil(h / 4) * block * l : w * h * (texel[d.format] ?? 4) * l;
    }
    return total * (d.sampleCount ?? 1);
  };
  // A label names its kind: Babylon's own words (sizes, mips, format, samples), and its names with their numbers
  // as #. Where any part could be an address, every name is <name>, so no piece of a URI is kept.
  const structural = part => /^(Texture(2D|3D|Cube)?|\\d+x\\d+(x\\d+)?|w(o)?mips|samples\\d+|size\\d+|[A-Z]+|Buffer)$/.test(part)
    || part in texel || blockBytes(part) !== null;
  const kindOf = label => {
    const text = String(label ?? '').replace(/^BabylonWebGPUDevice\\d+_/, '').replace(/DataBufferUniqueId=\\d+-?/, '');
    const risky = /[/:?=%@.]/.test(text);
    return text.split('_').map(part => structural(part) ? part.replace(/^size\\d+$/, 'size#') : risky || part.length > 48 ? '<name>' : part.replace(/\\d+/g, '#'))
      .filter((part, at, parts) => part !== '<name>' || parts[at - 1] !== '<name>').join('_').slice(0, 120);
  };
  const live = new Map();
  const account = (object, record) => {
    live.set(object, record);
    const destroy = object.destroy;
    object.destroy = function () { live.delete(object); return destroy.call(this); };
  };
  const createTexture = GPUDevice.prototype.createTexture, createBuffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createTexture = function (d) {
    const texture = createTexture.call(this, d);
    account(texture, { what: (d.usage & 0x10) ? 'render target' : 'texture', format: d.format, bytes: bytesOf(d), kind: kindOf(d.label) });
    return texture;
  };
  GPUDevice.prototype.createBuffer = function (d) {
    const buffer = createBuffer.call(this, d);
    const usage = (d.usage & 0x20 ? 'vertex ' : '') + (d.usage & 0x10 ? 'index ' : '') + (d.usage & 0x40 ? 'uniform ' : '') + (d.usage & 0x80 ? 'storage ' : '') + (d.usage & 0x3 ? 'map ' : '');
    account(buffer, { what: \`buffer \${usage.trim() || 'copy'}\`, bytes: d.size, kind: kindOf(d.label) });
    return buffer;
  };
  const configure = GPUCanvasContext.prototype.configure;
  self.__gpuAccounting = { live, canvases: new Set() };
  GPUCanvasContext.prototype.configure = function (c) { self.__gpuAccounting.canvases.add(this); return configure.call(this, c); };
})()`;
if (args.gpu) await send('Page.addScriptToEvaluateOnNewDocument', { source: GPU_ACCOUNTING });

const marked = name => evaluate(`performance.getEntriesByName(${JSON.stringify(name)}, "mark").length > 0`).catch(() => false);
async function visit() {
  await send('Page.navigate', { url });
  const started = Date.now();
  let contentSeen = null;
  while (Date.now() - started < 240000) {
    await sleep(500);
    if (target.settles) { if (await marked('boot:settled')) break; }
    else {
      if (contentSeen === null && await marked('boot:content')) contentSeen = Date.now();
      if (contentSeen !== null && Date.now() - contentSeen >= AFTER_CONTENT_MS) break;
    }
  }
  return evaluate(`({ isolated: self.crossOriginIsolated === true, sharedMemory: typeof SharedArrayBuffer === "function",
    marks: Object.fromEntries(performance.getEntriesByType("mark").filter(m => m.name.startsWith("boot:")).map(m => [m.name, Math.round(m.startTime)])) })`);
}

const visits = [];
visits.push({ kind: 'cold', ...await visit() });
if (!args['cold-only']) {
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(1000);
  visits.push({ kind: 'warm', ...await visit() });
}

/** Starts a trace of every Chrome process; `stop` ends it and gives its events. */
async function startTrace(traceConfig) {
  const events = [];
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const stopListening = chrome.onEvent(message => {
    if (message.sessionId) return;
    if (message.method === 'Tracing.dataCollected') events.push(...message.params.value);
    if (message.method === 'Tracing.tracingComplete') complete();
  });
  await chrome.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig });
  return {
    async stop() {
      await chrome.send('Tracing.end');
      await done;
      stopListening();
      return events;
    },
  };
}
// Style recalculations and layouts, with the stack of the script that forced each one.
const LAYOUT_TRACE = { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack'], excludedCategories: ['*'] };
/**
 * Each style recalculation and layout on the page's main thread, with its duration and the stack that forced it, or null;
 * and each time style or layout went out of date, with the stack of the script that changed the page, or null.
 */
const LAYOUT_KINDS = { UpdateLayoutTree: 'style', Layout: 'layout', ScheduleStyleRecalculation: 'style', InvalidateLayout: 'layout' };
function layoutWork(events) {
  const main = new Set(events.filter(event => event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'CrRendererMain').map(event => `${event.pid}:${event.tid}`));
  const work = [], invalidations = [], open = new Map();
  const stackOf = each => each.args?.beginData?.stackTrace ?? each.args?.data?.stackTrace ?? null;
  for (const event of [...events].sort((a, b) => a.ts - b.ts)) {
    const kind = LAYOUT_KINDS[event.name];
    if (!kind || !main.has(`${event.pid}:${event.tid}`)) continue;
    if (event.name === 'ScheduleStyleRecalculation' || event.name === 'InvalidateLayout') { invalidations.push({ kind, stack: stackOf(event) }); continue; }
    const key = `${event.pid}:${event.tid}:${event.name}`;
    if (event.ph === 'X') work.push({ kind, ms: (event.dur ?? 0) / 1000, stack: stackOf(event) });
    else if (event.ph === 'B') { if (!open.has(key)) open.set(key, []); open.get(key).push(event); }
    else if (event.ph === 'E') {
      const begin = open.get(key)?.pop();
      if (begin) work.push({ kind, ms: (event.ts - begin.ts) / 1000, stack: stackOf(begin) });
    }
  }
  return { work, invalidations };
}

const RECORDER = `(() => {
  const intervals = []; let last = null, on = true;
  const step = now => { if (last !== null) intervals.push(now - last); last = now; if (on) requestAnimationFrame(step); };
  requestAnimationFrame(step);
  window.__auditFrames = () => { on = false; return intervals; };
})()`;
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
await send('Performance.enable', { timeDomain: 'threadTicks' });
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: Number(args.interval) });
const stretches = [];
for (const rate of RATES) {
  await send('Emulation.setCPUThrottlingRate', { rate });
  await sleep(1000);
  const before = await metrics();
  const probeBefore = args.probe ? await evaluate(args.probe).catch(error => String(error)) : undefined;
  const trace = args.layout ? await startTrace(LAYOUT_TRACE) : null;
  const startedAt = Date.now();
  await evaluate(RECORDER);
  await send('Profiler.start');
  if (motion === 'drag') {
    const { width, height } = await evaluate('({ width: innerWidth, height: innerHeight })');
    const cx = width / 2, cy = height / 2;
    const touch = (type, x, y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    if (args.phone) await touch('touchStart', cx, cy);
    else {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
    }
    while (Date.now() - startedAt < SECONDS * 1000) {
      const t = (Date.now() - startedAt) / 1000;
      const x = cx + width * 0.2 * Math.sin(t * Math.PI), y = cy + height * 0.05 * Math.sin(t * Math.PI * 0.5);
      if (args.phone) await touch('touchMove', x, y);
      else await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(16);
    }
    if (args.phone) await touch('touchEnd');
    else await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  } else if (motion === 'enter') {
    const scenes = 'window.__fossEarthPanoramaTest.scenes.handle()';
    const id = await evaluate(`${scenes}.status.entries.find(entry => entry.supported && entry.preview === 'ready')?.id ?? null`);
    if (!id) throw new Error('No 360 image is ready to enter.');
    while (Date.now() - startedAt < SECONDS * 1000) {
      await evaluate(`void ${scenes}.enter(${JSON.stringify(id)}); true`);
      await sleep(3000);
      await evaluate(`void ${scenes}.exit(); true`);
      await sleep(3000);
    }
  } else {
    await sleep(SECONDS * 1000);
  }
  const { profile } = await send('Profiler.stop');
  const intervals = await evaluate('window.__auditFrames()');
  const after = await metrics();
  const wall = (Date.now() - startedAt) / 1000;
  const traceEvents = trace ? await trace.stop() : null;
  const layout = traceEvents ? layoutWork(traceEvents) : null;
  // The whole trace, which DevTools' Performance panel opens.
  if (traceEvents) await writeFile(path.join(out, `${args.target}-${motion}-${rate}x.trace.json`), JSON.stringify({ traceEvents }));
  const probeAfter = args.probe ? await evaluate(args.probe).catch(error => String(error)) : undefined;
  const sorted = [...intervals].sort((a, b) => a - b);
  const pct = rank => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * rank))] : null;
  const file = path.join(out, `${args.target}-${motion}-${rate}x.cpuprofile`);
  await writeFile(file, JSON.stringify(profile));
  stretches.push({ rate, motion, wall, loadAverage: os.loadavg()[0], frames: intervals.length, fps: intervals.length / wall,
    median: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: sorted.at(-1) ?? null, slow: intervals.filter(value => value > 25).length,
    mainThread: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) / wall,
    script: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) / wall,
    styles: (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0), styleSeconds: (after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0),
    layouts: (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0), layoutSeconds: (after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0), layout,
    heapUsed: after.JSHeapUsedSize, probe: args.probe ? { before: probeBefore, after: probeAfter } : undefined, file, profile });
}
await send('Emulation.setCPUThrottlingRate', { rate: 1 });

const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
/** Each process's own footprint table from macOS footprint: category → bytes. */
async function footprintCategories(pids) {
  const { stdout } = await promisify(execFile)('footprint', pids.map(String), { maxBuffer: 16 * 1024 * 1024 }).catch(error => ({ stdout: error.stdout ?? '' }));
  const result = {};
  let current = null;
  for (const line of stdout.split('\n')) {
    const header = /\[(\d+)\]:.*Footprint: ([\d.]+) (B|KB|MB|GB)/.exec(line);
    if (header) { current = result[header[1]] = { footprint: Number(header[2]) * UNITS[header[3]], categories: {} }; continue; }
    if (!current) continue;
    if (/^Shared with /.test(line)) { current = null; continue; }
    const category = /^\s*([\d.]+) (B|KB|MB|GB)\s+([\d.]+) (B|KB|MB|GB)\s+([\d.]+) (B|KB|MB|GB)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (category) current.categories[category[8].trim()] = Number(category[1]) * UNITS[category[2]];
  }
  return result;
}
/** A memory-infra dump of every Chrome process: each allocator's size, by process. */
async function memoryInfra() {
  const trace = await startTrace({ includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } });
  const requested = await chrome.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
  const events = await trace.stop();
  const names = {};
  for (const event of events) if (event.ph === 'M' && event.name === 'process_name') names[event.pid] = event.args?.name;
  const processes = {};
  for (const event of events) {
    const allocators = event.ph === 'v' ? event.args?.dumps?.allocators : null;
    if (!allocators) continue;
    const entry = processes[event.pid] ??= { name: names[event.pid] ?? null, allocators: {} };
    for (const [name, dump] of Object.entries(allocators)) {
      const size = dump.attrs?.size;
      if (size?.units === 'bytes') entry.allocators[name] = parseInt(size.value, 16);
    }
  }
  return { success: requested.success, processes };
}
let memoryReport = null;
if (args.memory) {
  const { processInfo } = await chrome.send('SystemInfo.getProcessInfo');
  const live = processInfo.filter(entry => entry.id > 0);
  const prints = await footprintCategories(live.map(entry => entry.id));
  const renderer = live.filter(entry => entry.type === 'renderer').sort((a, b) => (prints[b.id]?.footprint ?? 0) - (prints[a.id]?.footprint ?? 0))[0];
  const gpu = live.find(entry => entry.type === 'GPU');
  memoryReport = { renderer: renderer && { pid: renderer.id, ...prints[renderer.id] }, gpu: gpu && { pid: gpu.id, ...prints[gpu.id] }, infra: await memoryInfra() };
  await writeFile(path.join(out, 'memory.json'), JSON.stringify(memoryReport, null, 2));
}
/** Self size by kind of node, and by constructor for objects and native nodes, from a V8 heap snapshot. */
function heapSummary(snapshot) {
  const { node_fields: fields, node_types: [types] } = snapshot.snapshot.meta;
  const typeAt = fields.indexOf('type'), nameAt = fields.indexOf('name'), sizeAt = fields.indexOf('self_size');
  const byType = {}, byName = new Map();
  let total = 0, count = 0;
  for (let at = 0; at < snapshot.nodes.length; at += fields.length) {
    const type = types[snapshot.nodes[at + typeAt]], size = snapshot.nodes[at + sizeAt];
    total += size; count += 1;
    byType[type] = (byType[type] ?? 0) + size;
    if (type === 'object' || type === 'native' || type === 'closure') {
      const key = `${type} ${snapshot.strings[snapshot.nodes[at + nameAt]]}`;
      const entry = byName.get(key) ?? { size: 0, count: 0 };
      entry.size += size; entry.count += 1; byName.set(key, entry);
    }
  }
  const top = [...byName].sort((a, b) => b[1].size - a[1].size).slice(0, 40).map(([name, entry]) => ({ name, ...entry }));
  return { total, count, byType, top };
}
let heapReport = null;
if (args.heap) {
  const chunks = [];
  const stopListening = chrome.onEvent(message => {
    if (message.sessionId === sessionId && message.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(message.params.chunk);
  });
  await send('HeapProfiler.enable');
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  stopListening();
  const text = chunks.join('');
  await writeFile(path.join(out, 'heap.heapsnapshot'), text);
  heapReport = heapSummary(JSON.parse(text));
  await writeFile(path.join(out, 'heap.json'), JSON.stringify(heapReport, null, 2));
}
let gpuReport = null;
if (args.gpu) {
  gpuReport = await evaluate(`(() => {
    const a = self.__gpuAccounting;
    if (!a) return null;
    const byWhat = {}, byKind = {};
    let total = 0;
    for (const r of a.live.values()) {
      total += r.bytes;
      byWhat[r.what] = (byWhat[r.what] ?? 0) + r.bytes;
      const key = r.what + ' ' + r.kind + (r.format ? ' ' + r.format : '');
      const entry = byKind[key] ??= { bytes: 0, count: 0 };
      entry.bytes += r.bytes; entry.count += 1;
    }
    const canvases = [...a.canvases].map(context => ({ width: context.canvas.width, height: context.canvas.height }));
    return { total, count: a.live.size, byWhat, byKind: Object.entries(byKind).sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 40), canvases };
  })()`).catch(error => ({ error: String(error) }));
  await writeFile(path.join(out, 'gpu.json'), JSON.stringify(gpuReport, null, 2));
}
await chrome.close();
await server.close();
await rm(profileDir, { recursive: true, force: true });

// Source maps: each script URL on the served page maps to a file under root; its .map sits beside it.
const consumers = new Map();
async function consumerFor(scriptUrl) {
  if (consumers.has(scriptUrl)) return consumers.get(scriptUrl);
  let consumer = null;
  try {
    const { pathname } = new URL(scriptUrl);
    if (pathname.startsWith(target.base)) {
      const file = path.join(root, decodeURIComponent(pathname.slice(target.base.length)));
      if (existsSync(`${file}.map`)) consumer = new SourceMapConsumer(JSON.parse(await readFile(`${file}.map`, 'utf8')));
    }
  } catch { /* Not a page script. */ }
  consumers.set(scriptUrl, consumer);
  return consumer;
}
/** A readable source path: node_modules/<package>/… or the checkout's path from ~/gh. */
const shortSource = source => {
  if (!source) return null;
  const clean = source.replace(/^(\.\.\/)+/, '').replace(/^webpack:\/\//, '');
  const modules = clean.lastIndexOf('node_modules/');
  if (modules >= 0) return clean.slice(modules + 'node_modules/'.length);
  const gh = clean.indexOf('gh/');
  return gh >= 0 ? clean.slice(gh + 3) : clean;
};
async function describe(frame) {
  if (!frame.url) return { key: `(${frame.functionName || 'native'})`, file: `(${frame.functionName || 'native'})` };
  const consumer = await consumerFor(frame.url);
  if (!consumer) return { key: `${frame.functionName || '(anonymous)'} ${frame.url.replace(/^https?:\/\/[^/]+/, '')}`, file: frame.url.replace(/^https?:\/\/[^/]+/, '') };
  const position = consumer.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
  const file = shortSource(position.source) ?? frame.url;
  const name = position.name ?? frame.functionName ?? '(anonymous)';
  return { key: `${name} ${file}:${position.line ?? '?'}`, file };
}

const ms = value => `${value.toFixed(1)}`;
const lines = [`# CPU profile: ${args.target}, ${motion}${args.phone ? ', phone viewport' : ''}${args['reduced-motion'] ? ', reduced motion' : ''}`, '', `Page ${url}, root ${root}.`,
  `Visits: ${visits.map(each => `${each.kind} (isolated ${each.isolated}, shared memory ${each.sharedMemory}, content ${each.marks['boot:content'] ?? '—'} ms)`).join('; ')}.`, ''];
const TOP = Number(args.top);
for (const stretch of stretches) {
  const { profile } = stretch;
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const described = new Map();
  for (const node of profile.nodes) described.set(node.id, await describe(node.callFrame));
  const self = new Map(), selfFile = new Map(), inclusive = new Map(), inclusiveFile = new Map();
  let total = 0, idle = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000;
    const id = profile.samples[index];
    const { key, file } = described.get(id);
    total += delta;
    if (key === '(idle)' || key === '(program)') { if (key === '(idle)') idle += delta; }
    self.set(key, (self.get(key) ?? 0) + delta);
    selfFile.set(file, (selfFile.get(file) ?? 0) + delta);
    const seenKeys = new Set(), seenFiles = new Set();
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const each = described.get(at);
      if (!seenKeys.has(each.key)) { seenKeys.add(each.key); inclusive.set(each.key, (inclusive.get(each.key) ?? 0) + delta); }
      if (!seenFiles.has(each.file)) { seenFiles.add(each.file); inclusiveFile.set(each.file, (inclusiveFile.get(each.file) ?? 0) + delta); }
    }
    void byId;
  }
  const busy = total - idle;
  const perSecond = value => value / stretch.wall;
  const table = (title, map, limit) => {
    const rows = [...map.entries()].filter(([key]) => key !== '(idle)' && key !== '(root)').sort((a, b) => b[1] - a[1]).slice(0, limit);
    return [`### ${title}`, '', '| ms/s | % of busy | Where |', '| ---: | ---: | --- |',
      ...rows.map(([key, value]) => `| ${ms(perSecond(value))} | ${(100 * value / busy).toFixed(1)} | \`${key}\` |`), ''];
  };
  const perFrame = count => (count / Math.max(1, stretch.frames)).toFixed(2);
  // The traced style recalculations and layouts, by the script that forced them, and what put them out of date, by the
  // script that changed the page: each a function and its caller.
  const forced = [];
  if (stretch.layout) {
    // A trace's stacks count lines and columns from 1, a CPU profile's from 0.
    const whereOf = async (stack, none) => {
      const frames = await Promise.all((stack ?? []).slice(0, 2).map(frame => describe({ ...frame, lineNumber: frame.lineNumber - 1, columnNumber: frame.columnNumber - 1 })));
      return frames.length ? `\`${frames.map(frame => frame.key).join(' ← ')}\`` : none;
    };
    const group = async (list, none) => {
      const rows = new Map();
      for (const each of list) {
        const where = await whereOf(each.stack, none);
        const row = rows.get(`${each.kind} ${where}`) ?? { kind: each.kind, where, count: 0, ms: 0 };
        row.count += 1;
        row.ms += each.ms ?? 0;
        rows.set(`${each.kind} ${where}`, row);
      }
      return [...rows.values()];
    };
    forced.push('### Style and layout, by the script that forced them', '', '| Per frame | ms/s | Kind | Forced by |', '| ---: | ---: | --- | --- |',
      ...(await group(stretch.layout.work, 'not forced')).sort((a, b) => b.ms - a.ms).slice(0, 25)
        .map(row => `| ${perFrame(row.count)} | ${ms(perSecond(row.ms))} | ${row.kind} | ${row.where} |`), '',
      '### Style and layout put out of date, by the script that changed the page', '', '| Per frame | Kind | Changed by |', '| ---: | --- | --- |',
      ...(await group(stretch.layout.invalidations, 'not script')).sort((a, b) => b.count - a.count).slice(0, 25)
        .map(row => `| ${perFrame(row.count)} | ${row.kind} | ${row.where} |`), '');
  }
  lines.push(`## ${stretch.rate}x CPU, ${stretch.motion}, ${stretch.wall.toFixed(1)} s, load ${stretch.loadAverage.toFixed(2)}`, '',
    `Frames/s ${stretch.fps.toFixed(1)}, median ${stretch.median?.toFixed(1)} ms, p95 ${stretch.p95?.toFixed(1)} ms, p99 ${stretch.p99?.toFixed(1)} ms, longest ${stretch.max?.toFixed(1)} ms, over 25 ms ${(100 * stretch.slow / Math.max(1, stretch.frames)).toFixed(0)} %.`,
    `Main thread ${(100 * stretch.mainThread).toFixed(0)} % of a core, script ${(100 * stretch.script).toFixed(0)} %. Profiled ${(perSecond(busy)).toFixed(0)} ms/s busy of ${(perSecond(total)).toFixed(0)} ms/s sampled. JS heap ${(stretch.heapUsed / 1048576).toFixed(0)} MiB.`,
    `Style recalculations ${perFrame(stretch.styles)} per frame, ${ms(1000 * stretch.styleSeconds / stretch.wall)} ms/s; layouts ${perFrame(stretch.layouts)} per frame, ${ms(1000 * stretch.layoutSeconds / stretch.wall)} ms/s.`, '',
    ...(stretch.probe ? [`Probe before \`${JSON.stringify(stretch.probe.before)}\`, after \`${JSON.stringify(stretch.probe.after)}\`.`, ''] : []),
    ...forced,
    ...table('Self time by function', self, TOP),
    ...table('Self time by file', selfFile, 30),
    ...table('Inclusive time by function', inclusive, TOP),
    ...table('Inclusive time by file', inclusiveFile, 30));
}
if (memoryReport) {
  const mib = value => (value / 1048576).toFixed(1);
  lines.push('## Memory', '');
  for (const [title, print] of [['Page renderer', memoryReport.renderer], ['GPU process', memoryReport.gpu]]) {
    if (!print) continue;
    lines.push(`### ${title} footprint, ${mib(print.footprint)} MiB (pid ${print.pid})`, '', '| MiB | Category |', '| ---: | --- |',
      ...Object.entries(print.categories).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, value]) => `| ${mib(value)} | ${name} |`), '');
  }
  for (const pid of [memoryReport.renderer?.pid, memoryReport.gpu?.pid]) {
    const dump = memoryReport.infra.processes[pid];
    if (!dump) continue;
    // Top-level allocators, and their children of 1 MiB or more.
    const rows = Object.entries(dump.allocators).filter(([name, value]) => name.split('/').length <= 2 && value >= 1048576)
      .sort((a, b) => a[0].split('/')[0] === b[0].split('/')[0] ? b[1] - a[1] : (dump.allocators[b[0].split('/')[0]] ?? 0) - (dump.allocators[a[0].split('/')[0]] ?? 0));
    lines.push(`### memory-infra, ${dump.name ?? 'process'} ${pid}`, '', '| MiB | Allocator |', '| ---: | --- |',
      ...rows.map(([name, value]) => `| ${mib(value)} | ${name.includes('/') ? '&nbsp;&nbsp;' : ''}${name} |`), '');
  }
}
if (gpuReport) {
  const mib = value => (value / 1048576).toFixed(1);
  if (gpuReport.error) lines.push('## GPU memory', '', gpuReport.error, '');
  else lines.push(`## GPU memory through WebGPU, ${mib(gpuReport.total)} MiB in ${gpuReport.count} live textures and buffers`, '',
    `Canvases configured: ${gpuReport.canvases.map(c => `${c.width}x${c.height}`).join(', ') || 'none'} (their swap-chain textures are not counted). The page only, not workers; MSAA and mips counted.`, '',
    '| MiB | Kind |', '| ---: | --- |', ...Object.entries(gpuReport.byWhat).sort((x, y) => y[1] - x[1]).map(([name, value]) => `| ${mib(value)} | ${name} |`), '',
    '| MiB | Count | Label |', '| ---: | ---: | --- |', ...gpuReport.byKind.slice(0, 30).map(([name, entry]) => `| ${mib(entry.bytes)} | ${entry.count} | \`${name}\` |`), '');
}
if (heapReport) {
  const mib = value => (value / 1048576).toFixed(1);
  lines.push(`## Page heap snapshot, ${mib(heapReport.total)} MiB in ${heapReport.count} nodes`, '', 'Self sizes after the snapshot\'s garbage collection; workers are not included.', '',
    '| MiB | Kind |', '| ---: | --- |', ...Object.entries(heapReport.byType).sort((x, y) => y[1] - x[1]).map(([name, value]) => `| ${mib(value)} | ${name} |`), '',
    '| MiB | Count | Constructor |', '| ---: | ---: | --- |', ...heapReport.top.slice(0, 25).map(entry => `| ${mib(entry.size)} | ${entry.count} | \`${entry.name}\` |`), '');
}
await writeFile(path.join(out, 'summary.md'), lines.join('\n'));
await writeFile(path.join(out, 'stretches.json'), JSON.stringify(stretches.map(({ profile, layout, ...rest }) => rest), null, 2));
console.log(lines.slice(0, 6).join('\n'));
for (const stretch of stretches) console.log(`${stretch.rate}x: ${stretch.fps.toFixed(1)} fps, p95 ${stretch.p95?.toFixed(1)} ms, main ${(100 * stretch.mainThread).toFixed(0)} %, script ${(100 * stretch.script).toFixed(0)} %`);
console.log(out);
