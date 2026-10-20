// Where a page's main-thread time goes while it runs: the runtime audit's stretches (audit.mjs), with a V8 CPU profile
// of each, mapped back to source files and functions through the build's source maps.
//
//   node scripts/benchmarks/startup-audit/profile.mjs --target fly --root <dist built with --sourcemap>
//     [--motion still|drag] [--rates 1,4] [--seconds 8] [--query "set.renderer.profiling.enabled=1"] [--label name]
//
// The visit is the audit's: a cold visit on a new profile under Fast 4G and a 4x CPU slowdown, then a warm visit
// through the service worker it installed, which waits for boot:content (and boot:settled on a page that settles, or
// 15 s after the content on the flight). Then, for each rate in --rates, one stretch of --seconds with the CPU profiler
// on. Output goes to build/benchmarks/startup-audit/profile-<label>/<local time>/: each profile (.cpuprofile, which
// DevTools opens), and summary.md with each stretch's frames, main-thread share and the functions and files that took
// its time, self and inclusive.
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
const CHROME_ARGS = ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--window-size=1280,800'];
const AFTER_CONTENT_MS = 15000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = newOutputDirectory('benchmarks', 'startup-audit', `profile-${args.target}${args.label ? `-${args.label}` : ''}`);

const server = await serveStatic({ root, base: target.base, port: target.port, proxy: target.proxy });
const query = args.query ? `?${args.query.replace(/^\?/, '')}` : '';
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

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
  const startedAt = Date.now();
  await evaluate(RECORDER);
  await send('Profiler.start');
  if (motion === 'drag') {
    const { width, height } = await evaluate('({ width: innerWidth, height: innerHeight })');
    const cx = width / 2, cy = height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
    while (Date.now() - startedAt < SECONDS * 1000) {
      const t = (Date.now() - startedAt) / 1000;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + width * 0.2 * Math.sin(t * Math.PI), y: cy + height * 0.05 * Math.sin(t * Math.PI * 0.5), button: 'left', buttons: 1 });
      await sleep(16);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  } else {
    await sleep(SECONDS * 1000);
  }
  const { profile } = await send('Profiler.stop');
  const intervals = await evaluate('window.__auditFrames()');
  const after = await metrics();
  const wall = (Date.now() - startedAt) / 1000;
  const probeAfter = args.probe ? await evaluate(args.probe).catch(error => String(error)) : undefined;
  const sorted = [...intervals].sort((a, b) => a - b);
  const pct = rank => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * rank))] : null;
  const file = path.join(out, `${args.target}-${motion}-${rate}x.cpuprofile`);
  await writeFile(file, JSON.stringify(profile));
  stretches.push({ rate, motion, wall, loadAverage: os.loadavg()[0], frames: intervals.length, fps: intervals.length / wall,
    median: pct(0.5), p95: pct(0.95), p99: pct(0.99), slow: intervals.filter(value => value > 25).length,
    mainThread: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) / wall,
    script: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) / wall,
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
  const events = [];
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const stop = chrome.onEvent(message => {
    if (message.sessionId) return;
    if (message.method === 'Tracing.dataCollected') events.push(...message.params.value);
    if (message.method === 'Tracing.tracingComplete') complete();
  });
  await chrome.send('Tracing.start', { transferMode: 'ReportEvents',
    traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } } });
  const requested = await chrome.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
  await chrome.send('Tracing.end');
  await done;
  stop();
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
const lines = [`# CPU profile: ${args.target}, ${motion}`, '', `Page ${url}, root ${root}.`,
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
  lines.push(`## ${stretch.rate}x CPU, ${stretch.motion}, ${stretch.wall.toFixed(1)} s, load ${stretch.loadAverage.toFixed(2)}`, '',
    `Frames/s ${stretch.fps.toFixed(1)}, median ${stretch.median?.toFixed(1)} ms, p95 ${stretch.p95?.toFixed(1)} ms, p99 ${stretch.p99?.toFixed(1)} ms, over 25 ms ${(100 * stretch.slow / Math.max(1, stretch.frames)).toFixed(0)} %.`,
    `Main thread ${(100 * stretch.mainThread).toFixed(0)} % of a core, script ${(100 * stretch.script).toFixed(0)} %. Profiled ${(perSecond(busy)).toFixed(0)} ms/s busy of ${(perSecond(total)).toFixed(0)} ms/s sampled. JS heap ${(stretch.heapUsed / 1048576).toFixed(0)} MiB.`, '',
    ...(stretch.probe ? [`Probe before \`${JSON.stringify(stretch.probe.before)}\`, after \`${JSON.stringify(stretch.probe.after)}\`.`, ''] : []),
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
await writeFile(path.join(out, 'summary.md'), lines.join('\n'));
await writeFile(path.join(out, 'stretches.json'), JSON.stringify(stretches.map(({ profile, ...rest }) => rest), null, 2));
console.log(lines.slice(0, 6).join('\n'));
for (const stretch of stretches) console.log(`${stretch.rate}x: ${stretch.fps.toFixed(1)} fps, p95 ${stretch.p95?.toFixed(1)} ms, main ${(100 * stretch.mainThread).toFixed(0)} %, script ${(100 * stretch.script).toFixed(0)} %`);
console.log(out);
