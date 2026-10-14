/**
 * Machine-state telemetry around each timed block of the ai-framegen-upscale
 * screen (DESIGN.md section 9, acceptance rule I): unprivileged macOS signals
 * only, aggregated, never naming other processes.
 *
 * One sample() reads, in parallel:
 *   memory    kern.memorystatus_vm_pressure_level and vm_stat running counts
 *             (Compressions, Swapouts, Swapins; quiet.mjs memoryState()), plus
 *             vm.compressor_bytes_used and vm.swapusage as diagnostics
 *   thermal   <work>/bin/thermal (lib/thermal.swift): ProcessInfo.thermalState,
 *             the OS thermal pressure level, Low Power Mode
 *   processes `ps -A -o pid=,ppid=,time=`: cumulative CPU time per pid (no names)
 *   gpu       `ioreg -r -d 1 -w 0 -c IOAccelerator`: Device/Renderer/Tiler Utilization %
 *   power     `pmset -g` (Low Power Mode) and `pmset -g batt` (source, battery %)
 *   input     seconds since keyboard/pointer input (quiet.mjs secondsSinceInput(); diagnostic only)
 *   cpus      os.cpus() tick counters (quiet.mjs busyCores(): all processes, diagnostic only)
 * A signal that cannot be read is null (missing is not zero; blocks.mjs
 * evaluateBlock() treats a missing required signal as a disturbance).
 *
 * Use, per block:
 *   const helper = await ensureThermalHelper(workDirectory());   // once per run
 *   const chromePids = pidsFromProcessInfo(await chrome.send("SystemInfo.getProcessInfo"));
 *   const before = await sample({ thermalHelper: helper.path }); // page idle, its GPU work completed
 *   ...run the block in the page...
 *   const after = await sample({ thermalHelper: helper.path });
 *   const record = blockTelemetry(before, after, { excludePids: chromePids });
 *   const verdict = evaluateBlock(record);                       // blocks.mjs, rule I
 * `record` is compact and JSON-ready; sampleRecord(sample) drops the per-pid
 * table from a raw sample before it is stored. `excludePids` are this run's
 * Chrome processes (CDP SystemInfo.getProcessInfo ids); this node process and
 * every descendant of an excluded pid (Chrome's helpers, the telemetry
 * commands themselves) are excluded too.
 *
 * Limits: ps cannot see pid 0 (kernel_task), so kernel work is not "other
 * process" CPU; a process that exits between the two samples takes its CPU
 * time with it (counted in `exited`, its time unobserved); ps times have 10 ms
 * resolution per process. GPU utilization is the driver's reading at the
 * moment of the ioreg call, not a measurement over the block: on this machine
 * (Apple M5, 2026-10-13) it read 100 % during a 1 s Metal compute load and 0 %
 * at the first poll 0-8 ms after the load process exited (3 repeats; probe in
 * build/ai-framegen-upscale/node-libs/gpu-decay.mjs). So the "idle sample
 * before the block" must be taken after the page's previous GPU work has
 * completed (queue.onSubmittedWorkDone()), or it reads this run's own work;
 * no further settling time was needed.
 *
 * Cost (same machine, 2026-10-13, other agents active): one sample() takes
 * 12.4-16.7 ms wall (median 12.8 ms in run 1, 15.1 ms in run 2; the readers run
 * in parallel, ioreg's IOAccelerator query is the slowest at 11-13 ms), and
 * 32-33 ms for the first sample after 1 s of idling in run 1. Record
 * measureSampleCost() with every timing run.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { busyCores, memoryState, secondsSinceInput } from "../../spherical-image-representation/lib/quiet.mjs";
import { formatJson, insideBuild, readPower, repositoryRoot, scratchEnvironment, scriptReceipt, sha256File } from "./environment.mjs";
import { median } from "./stats.mjs";

const execFileAsync = promisify(execFile);
export const thermalSource = fileURLToPath(new URL("./thermal.swift", import.meta.url));

/**
 * Compiles lib/thermal.swift into <work>/bin/thermal unless a binary built from
 * the same source (sha256) is already there; swiftc's module caches and
 * temporary files go under <work>/cache. A binary from another source is moved
 * to <work>/superseded/bin/<stamp>/, never deleted. Returns the receipt
 * `{ path, source: { path, sha256 }, binarySha256, compiler, command, compiledAt, compiledNow, firstReading }`.
 */
export async function ensureThermalHelper(workDir) {
  const work = insideBuild(workDir), bin = insideBuild(path.join(work, "bin"));
  const binary = path.join(bin, "thermal"), receiptFile = path.join(bin, "thermal.receipt.json");
  const source = scriptReceipt(thermalSource);
  let receipt = null;
  try { receipt = JSON.parse(readFileSync(receiptFile, "utf8")); } catch { receipt = null; }
  if (receipt && existsSync(binary) && receipt.source?.sha256 === source.sha256 && receipt.binarySha256 === sha256File(binary)) {
    return { ...receipt, path: binary, compiledNow: false };
  }
  if (existsSync(binary) || existsSync(receiptFile)) {
    const stamp = new Date().toISOString().replaceAll(":", "").replace(/\..*/, "");
    const superseded = insideBuild(path.join(work, "superseded", "bin", `${stamp}-${process.pid}`));
    for (const file of [binary, receiptFile]) if (existsSync(file)) renameSync(file, path.join(superseded, path.basename(file)));
  }
  const scratch = scratchEnvironment(work);
  for (const key of ["TMPDIR", "CLANG_MODULE_CACHE_PATH", "SWIFT_MODULE_CACHE_PATH"]) insideBuild(scratch[key]);
  const env = { ...process.env, ...scratch };
  const temporary = path.join(bin, `.thermal.${process.pid}.tmp`);
  const args = ["-O", "-module-cache-path", scratch.SWIFT_MODULE_CACHE_PATH, "-o", temporary, thermalSource];
  const version = await execFileAsync("swiftc", ["--version"], { env });
  await execFileAsync("swiftc", args, { env, maxBuffer: 16 * 1024 * 1024 });
  renameSync(temporary, binary);
  const firstReading = await readThermal(binary);
  if (!firstReading) throw new Error(`${binary} was built but did not print a thermal reading`);
  const relative = file => path.relative(repositoryRoot, file);
  receipt = {
    schema: 1, source, binary: relative(binary), binarySha256: sha256File(binary),
    compiler: `${version.stdout}${version.stderr}`.trim().split("\n").filter(Boolean),
    command: ["swiftc", "-O", "-module-cache-path", relative(scratch.SWIFT_MODULE_CACHE_PATH), "-o", relative(binary), relative(thermalSource)],
    compiledAt: new Date().toISOString(), firstReading,
  };
  writeFileSync(receiptFile, formatJson(receipt));
  return { ...receipt, path: binary, compiledNow: true };
}

/** One reading of the thermal helper (its JSON line), or null. */
export async function readThermal(helperPath) {
  if (!helperPath) return null;
  try {
    const { stdout } = await execFileAsync(helperPath, [], { timeout: 5000 });
    const reading = JSON.parse(stdout.trim().split("\n").at(-1));
    return Number.isInteger(reading.thermalState) ? reading : null;
  } catch { return null; }
}

/**
 * GPU statistics from `ioreg -r -d 1 -w 0 -c IOAccelerator` text: the
 * utilization percentages of each accelerator's "PerformanceStatistics"
 * (the busiest one if there are several) and its system-memory figures.
 * null when no statistics are present.
 */
export function parseGpuStatistics(text) {
  const blocks = [...(text ?? "").matchAll(/"PerformanceStatistics"\s*=\s*\{([^}]*)\}/g)].map(match => match[1]);
  if (blocks.length === 0) return null;
  const number = (block, key) => {
    const match = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=\\s*(\\d+)`).exec(block);
    return match ? Number(match[1]) : null;
  };
  const readings = blocks.map(block => ({
    deviceUtilization: number(block, "Device Utilization %"), rendererUtilization: number(block, "Renderer Utilization %"),
    tilerUtilization: number(block, "Tiler Utilization %"), inUseSystemMemoryBytes: number(block, "In use system memory"),
    allocSystemMemoryBytes: number(block, "Alloc system memory"),
  })).filter(reading => reading.deviceUtilization !== null);
  if (readings.length === 0) return null;
  readings.sort((a, b) => b.deviceUtilization - a.deviceUtilization);
  return { ...readings[0], accelerators: readings.length };
}

export async function readGpu() {
  try {
    const { stdout } = await execFileAsync("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], { maxBuffer: 16 * 1024 * 1024, timeout: 5000 });
    return parseGpuStatistics(stdout);
  } catch { return null; }
}

/** ps cputime "[[dd-]hh:]mm:ss.cc" (minutes may exceed 59, e.g. "402:25.26") in integer milliseconds, or null. */
export function parseCpuTime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(String(text).trim());
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return Math.round(((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60000 + Number(seconds.replace(",", ".")) * 1000);
}

/** ps pid/ppid/time[/rss] -> Map; RSS is KiB, no process names are read. */
export function parseProcessTable(text) {
  const table = new Map();
  for (const line of (text ?? "").split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 && fields.length !== 4) continue;
    const pid = Number(fields[0]), ppid = Number(fields[1]), cpuMs = parseCpuTime(fields[2]);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && cpuMs !== null) table.set(pid, {
      ppid, cpuMs, ...(fields.length === 4 ? { rssBytes: Number(fields[3]) * 1024 } : {}),
    });
  }
  return table;
}

/** Cumulative CPU time of every visible process, at the midpoint of the ps call (performance.now() ms). */
export async function readProcesses() {
  try {
    const start = performance.now();
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,time=,rss="], { maxBuffer: 16 * 1024 * 1024, timeout: 5000 });
    const end = performance.now(), table = parseProcessTable(stdout);
    return table.size ? { atMs: (start + end) / 2, spanMs: end - start, count: table.size, table } : null;
  } catch { return null; }
}

/**
 * Other processes' CPU between two process tables. A pid is "own" when it, or
 * an ancestor through the ppid links of either table, is in `excludePids`.
 * A pid in both tables contributes its CPU-time increase; a new pid (or a
 * reused pid whose time went down) its whole CPU time; a pid that exited is
 * counted and its time is unobserved. Returns cores = CPU ms / interval ms.
 */
export function processCpuDelta(before, after, excludePids) {
  const excluded = new Set([...excludePids].map(Number));
  const parent = new Map();
  for (const table of [before.table, after.table]) for (const [pid, entry] of table) parent.set(pid, entry.ppid);
  const own = new Map();
  const isOwn = pid => {
    if (own.has(pid)) return own.get(pid);
    const chain = [];
    let current = pid, result = false;
    for (let depth = 0; depth < 256; depth++) {
      if (excluded.has(current)) { result = true; break; }
      if (own.has(current)) { result = own.get(current); break; }
      chain.push(current);
      const next = parent.get(current);
      if (next === undefined || next === current || next <= 0) break;
      current = next;
    }
    for (const link of chain) own.set(link, result);
    return result;
  };
  let otherMs = 0, ownMs = 0;
  const started = { own: 0, other: 0 }, exited = { own: 0, other: 0 }, reused = { own: 0, other: 0 };
  for (const [pid, entry] of after.table) {
    const earlier = before.table.get(pid), side = isOwn(pid) ? "own" : "other";
    let delta;
    if (!earlier) { delta = entry.cpuMs; started[side]++; } else if (entry.cpuMs < earlier.cpuMs) { delta = entry.cpuMs; reused[side]++; } else delta = entry.cpuMs - earlier.cpuMs;
    if (side === "own") ownMs += delta; else otherMs += delta;
  }
  for (const pid of before.table.keys()) if (!after.table.has(pid)) exited[isOwn(pid) ? "own" : "other"]++;
  const intervalMs = after.atMs - before.atMs;
  const ownRss = table => {
    const entries = [...table].filter(([pid]) => isOwn(pid));
    return entries.length && entries.every(([, entry]) => Number.isFinite(entry.rssBytes))
      ? entries.reduce((total, [, entry]) => total + entry.rssBytes, 0) : null;
  };
  return {
    intervalMs, otherCpuMs: otherMs, ownCpuMs: ownMs,
    otherCores: intervalMs > 0 ? otherMs / intervalMs : null, ownCores: intervalMs > 0 ? ownMs / intervalMs : null,
    processes: after.table.size, started, exited, reused, excludedPids: [...excluded].sort((a, b) => a - b),
    ownRssBytesBefore: ownRss(before.table), ownRssBytesAfter: ownRss(after.table),
  };
}

/**
 * The pids of a CDP `SystemInfo.getProcessInfo` result
 * (`{ processInfo: [{ type, id, cpuTime }] }`): Chrome's browser, GPU,
 * renderer and utility processes, for blockTelemetry's `excludePids`.
 */
export const pidsFromProcessInfo = result => [...new Set((result?.processInfo ?? []).map(entry => entry.id).filter(Number.isInteger))].sort((a, b) => a - b);

/** "total = 2048.00M  used = 384.50M  free = 1663.50M  (encrypted)" -> bytes used, or null. */
export function parseSwapUsage(text) {
  const match = /used\s*=\s*([\d.]+)([KMGT])/.exec(text ?? "");
  return match ? Math.round(Number(match[1]) * 1024 ** (" KMGT".indexOf(match[2]))) : null;
}

/** quiet.mjs memoryState() plus the compressor's current size and swap in use (diagnostics). */
export async function readMemory() {
  const [state, extra] = await Promise.all([
    memoryState(),
    execFileAsync("sysctl", ["-n", "vm.compressor_bytes_used", "vm.swapusage"], { timeout: 5000 }).then(result => result.stdout, () => null),
  ]);
  if (!state || ![state.pressure, state.pageBytes, state.compressions, state.swapouts].every(Number.isFinite)) return null;
  const [compressor, swap] = (extra ?? "").split("\n");
  return { ...state, compressorBytesUsed: Number.isFinite(Number.parseInt(compressor, 10)) ? Number.parseInt(compressor, 10) : null, swapUsedBytes: parseSwapUsage(swap) };
}

async function timed(read) {
  const start = performance.now();
  let value = null;
  try { value = await read(); } catch { value = null; }
  return { value, ms: performance.now() - start };
}

/**
 * One sample of every signal (see the header). Options: `thermalHelper`
 * (path from ensureThermalHelper; without it thermal is missing), and `gpu`,
 * `power`, `input` (default true) to skip those readings. The result holds the
 * per-pid table (a Map) and os.cpus(); store sampleRecord(sample), not the sample.
 */
export async function sample({ thermalHelper = null, gpu = true, power = true, input = true } = {}) {
  const wallClock = new Date().toISOString(), start = performance.now(), cpus = os.cpus();
  const [memory, thermal, processes, gpuReading, powerReading, idle] = await Promise.all([
    timed(readMemory), timed(() => readThermal(thermalHelper)), timed(readProcesses),
    gpu ? timed(readGpu) : null, power ? timed(readPower) : null, input ? timed(secondsSinceInput) : null,
  ]);
  const end = performance.now();
  return {
    schema: 1, wallClock, atMs: start, costMs: end - start,
    componentMs: { memory: memory.ms, thermal: thermal.ms, processes: processes.ms, gpu: gpuReading?.ms ?? null, power: powerReading?.ms ?? null, input: idle?.ms ?? null },
    memory: memory.value, thermal: thermal.value, gpu: gpuReading?.value ?? null, power: powerReading?.value ?? null,
    secondsSinceInput: idle?.value ?? null,
    processes: processes.value, cpus,
  };
}

/** A sample without its per-pid table and os.cpus() counters: what a results file keeps. */
export function sampleRecord(raw) {
  const { processes, cpus, ...rest } = raw;
  return { ...rest, processes: processes ? { atMs: processes.atMs, spanMs: processes.spanMs, count: processes.count } : null };
}

const difference = (after, before, key) => (Number.isFinite(after?.[key]) && Number.isFinite(before?.[key]) ? after[key] - before[key] : null);

/**
 * The telemetry record of one block, from the samples before and after it:
 * what blocks.mjs evaluateBlock() reads, plus diagnostics. `excludePids`: this
 * run's Chrome processes; `ownPid` (this node process) is always excluded.
 */
export function blockTelemetry(before, after, { excludePids = [], ownPid = process.pid } = {}) {
  const memory = before.memory && after.memory ? {
    pressureBefore: before.memory.pressure, pressureAfter: after.memory.pressure, pageBytes: after.memory.pageBytes,
    swapoutPages: difference(after.memory, before.memory, "swapouts"), swapinPages: difference(after.memory, before.memory, "swapins"),
    compressedPages: difference(after.memory, before.memory, "compressions"),
    compressedMiB: (after.memory.compressions - before.memory.compressions) * after.memory.pageBytes / 2 ** 20,
    compressorBytesUsedBefore: before.memory.compressorBytesUsed ?? null, compressorBytesUsedAfter: after.memory.compressorBytesUsed ?? null,
    compressorGrowthBytes: difference(after.memory, before.memory, "compressorBytesUsed"),
    swapUsedBytesBefore: before.memory.swapUsedBytes ?? null, swapUsedBytesAfter: after.memory.swapUsedBytes ?? null,
  } : null;
  const thermal = before.thermal && after.thermal ? {
    stateBefore: before.thermal.thermalState, stateAfter: after.thermal.thermalState,
    pressureLevelBefore: before.thermal.thermalPressureLevel ?? null, pressureLevelAfter: after.thermal.thermalPressureLevel ?? null,
    lowPowerModeBefore: before.thermal.lowPowerMode ?? null, lowPowerModeAfter: after.thermal.lowPowerMode ?? null,
  } : null;
  return {
    wallClockBefore: before.wallClock, wallClockAfter: after.wallClock,
    intervalSeconds: (after.atMs - before.atMs) / 1000,
    memory, thermal,
    processCpu: before.processes && after.processes ? processCpuDelta(before.processes, after.processes, [ownPid, ...excludePids]) : null,
    systemBusyCores: before.cpus && after.cpus ? busyCores(before.cpus, after.cpus) : null,
    gpu: { idleBefore: before.gpu ?? null, after: after.gpu ?? null },
    input: { secondsSinceInputBefore: before.secondsSinceInput ?? null, secondsSinceInputAfter: after.secondsSinceInput ?? null },
    power: { before: before.power ?? null, after: after.power ?? null },
    sampleCostMs: { before: before.costMs, after: after.costMs },
  };
}

/**
 * The cost of sampling: `count` samples in a row (the first discarded as a
 * warm-up of the commands' own caches unless `keepFirst`), each sample's wall
 * milliseconds and their median per component. Record it with every timing
 * run: the policy requires the instrumentation overhead to be retained.
 */
export async function measureSampleCost({ count = 5, keepFirst = false, ...options } = {}) {
  const samples = [];
  for (let index = 0; index < count + (keepFirst ? 0 : 1); index++) samples.push(await sample(options));
  const kept = keepFirst ? samples : samples.slice(1);
  const componentMedians = Object.fromEntries(Object.keys(kept[0].componentMs).map(key => [key, kept.every(entry => entry.componentMs[key] !== null) ? median(kept.map(entry => entry.componentMs[key])) : null]));
  return {
    count: kept.length, costMs: kept.map(entry => entry.costMs), medianCostMs: median(kept.map(entry => entry.costMs)),
    componentMedianMs: componentMedians, samples: kept.map(sampleRecord), raw: kept,
  };
}
