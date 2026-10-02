/**
 * Keeping timings honest on a machine that is also being used: the same
 * guards as benchmarks/scene-ab. A timed round starts only after a spell
 * without keyboard, mouse or trackpad input (or after five minutes of waiting
 * for one), and is run again when there was input during it or other
 * processes were unusually busy. A round still disturbed after the retries is
 * kept and marked.
 *
 * This benchmark adds a third guard, for memory: a round is also run again
 * when the system was short of memory at either end of it, or compressed or
 * swapped out pages during it. A machine that is paging slows everything on
 * it without showing up as input or as busy cores.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Seconds since the keyboard, mouse or trackpad was last used (macOS), or null where that cannot be read. */
export async function secondsSinceInput() {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { maxBuffer: 16 * 1024 * 1024 });
    const match = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return match ? Number(match[1]) / 1e9 : null;
  } catch { return null; }
}

/** Waits for `idleSeconds` without input, at most `maxWaitSeconds`; returns whether the machine went idle. */
export async function waitForIdle(idleSeconds, maxWaitSeconds = 300) {
  let said = false;
  const started = Date.now();
  for (;;) {
    const idle = await secondsSinceInput();
    if (idle === null || idle >= idleSeconds) return true;
    if (Date.now() - started > maxWaitSeconds * 1000) { console.log(`  (still in use after ${maxWaitSeconds} s; going ahead)`); return false; }
    if (!said) console.log(`  (waiting for ${idleSeconds} s without keyboard or mouse input)`);
    said = true;
    await sleep(1000);
  }
}

/** Cores busy between two readings of os.cpus(), every process on the machine counted. */
export function busyCores(before, after) {
  let busy = 0;
  after.forEach((cpu, index) => {
    const a = cpu.times, b = before[index].times;
    const total = (a.user + a.nice + a.sys + a.idle + a.irq) - (b.user + b.nice + b.sys + b.idle + b.irq);
    if (total > 0) busy += 1 - (a.idle - b.idle) / total;
  });
  return busy;
}

/**
 * The system's memory state (macOS), or null where it cannot be read:
 * `pressure` is the kernel's level (1 normal, 2 warning, 4 critical), the
 * rest are running counts of pages since boot.
 */
export async function memoryState() {
  if (process.platform !== "darwin") return null;
  try {
    const [level, statistics] = await Promise.all([
      execFileAsync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
      execFileAsync("vm_stat"),
    ]);
    const count = name => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(statistics.stdout)?.[1] ?? NaN);
    const pageBytes = Number(/page size of (\d+) bytes/.exec(statistics.stdout)?.[1] ?? NaN);
    return { pressure: Number(level.stdout), pageBytes, compressions: count("Compressions"), swapouts: count("Swapouts"), swapins: count("Swapins") };
  } catch { return null; }
}

/** Waits for the kernel to report normal memory pressure, at most `maxWaitSeconds`. */
export async function waitForMemory(maxWaitSeconds = 300) {
  const started = Date.now();
  for (let said = false; ; said = true) {
    const state = await memoryState();
    if (state === null || state.pressure === 1) return true;
    if (Date.now() - started > maxWaitSeconds * 1000) { console.log(`  (still short of memory after ${maxWaitSeconds} s; going ahead)`); return false; }
    if (!said) console.log("  (waiting for memory pressure to return to normal)");
    await sleep(1000);
  }
}

/** Compressing more than this during a round counts as the machine being short of memory. */
const MAX_COMPRESSED_MIB = 16;

/**
 * Runs `round()` until one finishes undisturbed, at most `retries` extra
 * times. `ownCores` is how many cores the round itself keeps busy. Returns
 * `{ value, disturbed, attempts, busyCores, secondsSinceInput, memory }`;
 * `disturbed` is "input", "load", "memory" or null, and `memory` is what was
 * compressed and swapped during the round, in MiB.
 */
export async function quietRound(round, { idleSeconds = 10, maxExtraCores = 1.5, ownCores = 1, retries = 3 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    await waitForIdle(idleSeconds);
    await waitForMemory();
    const before = os.cpus(), memoryBefore = await memoryState(), started = Date.now();
    const value = await round();
    const elapsed = (Date.now() - started) / 1000, busy = busyCores(before, os.cpus()), idle = await secondsSinceInput(), memoryAfter = await memoryState();
    const mib = name => (memoryAfter[name] - memoryBefore[name]) * memoryAfter.pageBytes / 2 ** 20;
    const memory = memoryBefore && memoryAfter
      ? { pressureBefore: memoryBefore.pressure, pressureAfter: memoryAfter.pressure, compressedMiB: mib("compressions"), swappedOutMiB: mib("swapouts"), swappedInMiB: mib("swapins") }
      : null;
    const short = memory !== null && (memory.pressureBefore !== 1 || memory.pressureAfter !== 1 || memory.swappedOutMiB > 0 || memory.compressedMiB > MAX_COMPRESSED_MIB);
    const disturbed = idle !== null && idle < elapsed ? "input" : busy > ownCores + maxExtraCores ? "load" : short ? "memory" : null;
    last = { value, disturbed, attempts: attempt, busyCores: busy, secondsSinceInput: idle, memory };
    if (!disturbed) break;
    console.log(`  (round disturbed by ${disturbed}; ${attempt <= retries ? "running it again" : "kept, marked as disturbed"})`);
  }
  return last;
}
