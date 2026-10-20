// The runtime half of an audit (run.mjs --audit): after a warm visit has reached its moment, how the page's frames
// pace, how busy it keeps the main thread and the GPU process, and how much memory it holds.
//
// Frames are requestAnimationFrame intervals, so they say whether the page met the display's rate, not how long the
// GPU took; the GPU process's CPU time (command decoding and Metal submission) stands in for the GPU's side.
// Main-thread time is Chrome's thread ticks (Performance.getMetrics TaskDuration), so waiting for a core is left out.
// Memory is each V8 heap's use (Runtime.getHeapUsage, on the page and on each of its workers), with what its array
// buffers hold, WebAssembly memories among them, and each Chrome process's macOS footprint, whose graphics, IOSurface
// and IOAccelerator parts are the GPU memory the driver holds for the process.
// performance.measureUserAgentSpecificMemory() is not used: on these pages it did not resolve within 60 s.
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
const bytesOf = (value, unit) => Math.round(Number(value) * UNITS[unit]);

/**
 * Each process's footprint, its peak, and its graphics part (Metal's owned memory, IOSurface and IOAccelerator), from
 * macOS footprint. Only each process's own table counts, not what it shares with the next one.
 */
async function footprints(pids) {
  if (!pids.length) return {};
  const { stdout } = await run('footprint', pids.map(String), { maxBuffer: 16 * 1024 * 1024 }).catch(error => ({ stdout: error.stdout ?? '' }));
  const result = {};
  let current = null, own = false;
  for (const line of stdout.split('\n')) {
    const header = /\[(\d+)\]:.*Footprint: ([\d.]+) (B|KB|MB|GB)/.exec(line);
    if (header) { current = result[header[1]] = { footprint: bytesOf(header[2], header[3]), peak: null, gpu: 0 }; own = true; continue; }
    if (!current) continue;
    if (/^Shared with /.test(line)) { own = false; continue; }
    const peak = /phys_footprint_peak: ([\d.]+) (B|KB|MB|GB)/.exec(line);
    if (peak) { current.peak = bytesOf(peak[1], peak[2]); continue; }
    const category = /^\s*([\d.]+) (B|KB|MB|GB)\s+.*\s(\S.*)$/.exec(line);
    if (own && category && /\(graphics\)|IOAccelerator|IOSurface/.test(category[3])) current.gpu += bytesOf(category[1], category[2]);
  }
  return result;
}

const percentile = (sorted, rank) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * rank))] : null;
const round = (value, digits = 1) => value === null || value === undefined ? null : Number(value.toFixed(digits));

/** The page's metrics as a map. */
async function metrics(send) {
  const { metrics: list } = await send('Performance.getMetrics');
  return Object.fromEntries(list.map(({ name, value }) => [name, value]));
}

/** CPU seconds per Chrome process, by type. */
async function processCpu(chrome) {
  const { processInfo } = await chrome.send('SystemInfo.getProcessInfo');
  return processInfo;
}

const RECORDER = `(() => {
  const intervals = []; let last = null, on = true;
  const step = now => { if (last !== null) intervals.push(now - last); last = now; if (on) requestAnimationFrame(step); };
  requestAnimationFrame(step);
  window.__auditFrames = () => { on = false; return intervals; };
})()`;

/** A stretch of `ms`: still, or with a left-button drag swinging across the canvas, as a hand turning the view. */
async function stretch({ chrome, send, evaluate }, motion, ms) {
  const before = { metrics: await metrics(send), cpu: await processCpu(chrome), at: Date.now() };
  await evaluate(RECORDER);
  if (motion === 'drag') {
    const { width, height } = await evaluate('({ width: innerWidth, height: innerHeight })');
    const cx = width / 2, cy = height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
    const started = Date.now();
    while (Date.now() - started < ms) {
      const t = (Date.now() - started) / 1000;
      // Two seconds a swing, a fifth of the width each way, and a little up and down.
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + width * 0.2 * Math.sin(t * Math.PI), y: cy + height * 0.05 * Math.sin(t * Math.PI * 0.5), button: 'left', buttons: 1 });
      await sleep(16);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  } else {
    await sleep(ms);
  }
  const intervals = await evaluate('window.__auditFrames()');
  const after = { metrics: await metrics(send), cpu: await processCpu(chrome), at: Date.now() };
  const wall = (after.at - before.at) / 1000;
  const sorted = [...intervals].sort((a, b) => a - b);
  const used = process => process.cpuTime - (before.cpu.find(entry => entry.id === process.id)?.cpuTime ?? 0);
  const cpuOf = type => after.cpu.filter(entry => entry.type === type).reduce((total, process) => total + used(process), 0) / wall;
  // The page's own renderer is the busiest; the others hold its service worker, or wait spare.
  const busiest = type => Math.max(0, ...after.cpu.filter(entry => entry.type === type).map(used)) / wall;
  const delta = name => (after.metrics[name] ?? 0) - (before.metrics[name] ?? 0);
  return {
    motion, seconds: round(wall, 2), frames: intervals.length, fps: round(intervals.length / wall),
    intervalMs: { median: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), p99: round(percentile(sorted, 0.99)), max: round(sorted.at(-1) ?? null) },
    // Frames that took two display intervals or more at 60 Hz.
    slowFrames: intervals.filter(value => value > 25).length,
    // Fractions of one core over the stretch.
    mainThread: round(delta('TaskDuration') / wall, 3), script: round(delta('ScriptDuration') / wall, 3),
    rendererProcesses: round(cpuOf('renderer'), 3), pageRenderer: round(busiest('renderer'), 3), gpuProcess: round(cpuOf('GPU'), 3), browserProcess: round(cpuOf('browser'), 3),
  };
}

/** Memory at rest: the V8 heaps of the page and its workers, and Chrome's processes. */
async function memory({ chrome, send, attached }) {
  // A worker that has ended no longer answers; it is left out.
  const sessions = [{ type: 'page', url: null }, ...attached.filter(entry => entry.type !== 'page')];
  const heaps = (await Promise.all(sessions.map(async entry => {
    const usage = await (entry.session ? chrome.send('Runtime.getHeapUsage', {}, entry.session) : send('Runtime.getHeapUsage')).catch(() => null);
    return usage && { type: entry.type, url: entry.url, used: usage.usedSize, total: usage.totalSize,
      embedder: usage.embedderHeapUsedSize ?? null, arrayBuffers: usage.backingStorageSize ?? null };
  }))).filter(Boolean);
  const page = heaps.find(entry => entry.type === 'page') ?? null;
  const workers = heaps.filter(entry => entry.type === 'worker');
  const heap = await metrics(send);
  const processes = (await processCpu(chrome)).filter(entry => entry.id > 0);
  const prints = await footprints(processes.map(entry => entry.id));
  const byType = {};
  let pageRenderer = null;
  for (const process of processes) {
    const print = prints[process.id];
    if (!print) continue;
    const entry = byType[process.type] ??= { processes: 0, footprint: 0, peak: 0, gpu: 0 };
    entry.processes += 1; entry.footprint += print.footprint; entry.peak += print.peak ?? print.footprint; entry.gpu += print.gpu;
    // The page's own renderer holds the most.
    if (process.type === 'renderer' && print.footprint > (pageRenderer?.footprint ?? -1)) pageRenderer = { pid: process.id, ...print };
  }
  return {
    jsHeapUsed: heap.JSHeapUsedSize ?? null, jsHeapTotal: heap.JSHeapTotalSize ?? null, domNodes: heap.Nodes ?? null,
    // The page's array buffers include its WebAssembly memories. A shared memory is counted again by each worker that
    // holds it, so the workers' array buffers are not added to the page's.
    pageArrayBuffers: page?.arrayBuffers ?? null, workers: workers.length, workersHeapUsed: workers.reduce((total, entry) => total + entry.used, 0),
    heaps, pageRenderer, processes: byType,
  };
}

/**
 * The audit of a page that has reached its moment. `drags`: whether a drag turns its view (a flight flies by itself).
 * Each stretch runs at full speed, then under `slowdown`, and the page is left at `restore`.
 */
export async function auditRuntime(browser, { drags, seconds = 8, slowdown = 4, restore = slowdown }) {
  await browser.send('Performance.enable', { timeDomain: 'threadTicks' });
  const result = { memory: await memory(browser), stretches: [] };
  for (const rate of [1, slowdown]) {
    await browser.send('Emulation.setCPUThrottlingRate', { rate });
    for (const motion of drags ? ['still', 'drag'] : ['still']) {
      // A moment for the previous stretch's frames to finish.
      await sleep(1000);
      // The machine is shared: its load over the last minute is kept with each stretch.
      result.stretches.push({ cpuSlowdown: rate, loadAverage: round(os.loadavg()[0], 2), ...await stretch(browser, motion, seconds * 1000) });
    }
  }
  await browser.send('Emulation.setCPUThrottlingRate', { rate: restore });
  result.memoryAfter = await memory(browser);
  return result;
}
