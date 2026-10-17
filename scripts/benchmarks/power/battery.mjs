/** Whole-machine discharge power. Read-only; never invokes sudo or changes settings. */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readPower } from "../ai-framegen-upscale/lib/environment.mjs";
import { newOutputDirectory } from "../../lib/outputDirectory.mjs";

const execFileAsync = promisify(execFile);

/**
 * Source-specific Low Power Mode from `pmset -g custom`. Never use another
 * source's setting: AC Power and Battery Power can have opposite values.
 */
export function parsePmsetCustom(text, source) {
  if (source !== "Battery Power" && source !== "AC Power" && source !== "UPS Power") return null;
  let section = null, result = null, found = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const header = /^\s*(Battery Power|AC Power|UPS Power):\s*$/.exec(line);
    if (header) { section = header[1]; continue; }
    if (/^\S.*:\s*$/.test(line)) { section = null; continue; }
    const setting = /^\s*lowpowermode\s+([01])\s*$/.exec(line);
    if (section === source && setting) {
      const value = setting[1] === "1";
      if (found && value !== result) return null;
      result = value; found = true;
    }
  }
  return found ? { lowPowerMode: result } : null;
}

/** Keep readPower's current source; only fill an unknown mode from that source. */
export function withSourcePowerMode(power, customText) {
  if (!power || power.lowPowerMode !== null) return power;
  const custom = parsePmsetCustom(customText, power.source);
  return custom ? { ...power, lowPowerMode: custom.lowPowerMode } : power;
}

/** ioreg prints two's-complement current as unsigned u64. Decode before Number(). */
export function parseBattery(text) {
  const scalar = key => new RegExp(`"${key}"\\s*=\\s*([^\\s,}]+)`).exec(text ?? "")?.[1] ?? null;
  const flag = key => {
    const value = scalar(key);
    return /^(Yes|true|1)$/i.test(value ?? "") ? true : /^(No|false|0)$/i.test(value ?? "") ? false : null;
  };
  const externalConnected = flag("ExternalConnected"), isCharging = flag("IsCharging");
  let currentMa = null, voltageMv = null;
  try {
    const rawCurrent = scalar("Amperage") ?? scalar("InstantAmperage");
    const rawVoltage = scalar("Voltage");
    if (rawCurrent !== null && /^-?\d+$/.test(rawCurrent)) {
      const integer = BigInt(rawCurrent);
      if (integer < -(1n << 63n) || integer > (1n << 64n) - 1n) throw new Error("current outside u64/i64");
      const signed = BigInt.asIntN(64, integer);
      if (signed < -100000n || signed > 100000n) throw new Error("implausible current");
      currentMa = Number(signed);
    }
    if (rawVoltage !== null && /^\d+$/.test(rawVoltage)) voltageMv = Number(rawVoltage);
  } catch { /* Invalid data is reported below, not converted to zero. */ }
  const validVoltage = Number.isFinite(voltageMv) && voltageMv > 0 && voltageMv <= 100000;
  const discharging = currentMa !== null && currentMa < 0 && externalConnected === false && isCharging === false;
  let reason = null;
  if (!validVoltage || currentMa === null) reason = "missing-or-invalid-battery-data";
  else if (externalConnected === null || isCharging === null) reason = "unknown-battery-state";
  else if (!discharging) reason = "not-discharging";
  const valid = reason === null;
  return { valid, reason, voltageMv: validVoltage ? voltageMv : null, currentMa, watts: valid ? -voltageMv * currentMa / 1e6 : null, discharging, isCharging, externalConnected };
}

/** timestampMs is wall-clock milliseconds; readPower corroborates unplugged state. */
export async function readBattery() {
  if (process.platform !== "darwin") return { timestampMs: Date.now(), valid: false, reason: "unsupported-platform", watts: null, power: null };
  try {
    const [battery, primaryPower] = await Promise.all([
      execFileAsync("ioreg", ["-rn", "AppleSmartBattery"], { timeout: 5000, maxBuffer: 1024 * 1024 }),
      readPower(),
    ]);
    let power = primaryPower;
    if (power?.lowPowerMode === null) {
      try {
        const custom = await execFileAsync("pmset", ["-g", "custom"], { timeout: 5000, maxBuffer: 1024 * 1024 });
        power = withSourcePowerMode(power, custom.stdout);
      } catch { /* Mode remains unknown; no settings are changed. */ }
    }
    const sample = { timestampMs: Date.now(), ...parseBattery(battery.stdout), power };
    if (power?.source !== "Battery Power" || (power.batteryState !== null && power.batteryState !== "discharging")) return { ...sample, valid: false, reason: "unconfirmed-battery-power", watts: null };
    return sample;
  } catch { return { timestampMs: Date.now(), valid: false, reason: "battery-read-failed", watts: null, power: null }; }
}

/**
 * Trapezoid integration over adjacent valid discharge readings. Invalid points
 * and gaps break coverage; they are never bridged or silently treated as zero.
 * A missing idle baseline leaves net power null, while idle collection can use 0.
 */
export function summarizePower(samples, { idleWatts = null, maxGapMs = 5000 } = {}) {
  if (!Array.isArray(samples)) throw new Error("samples must be an array");
  if (idleWatts !== null && (!Number.isFinite(idleWatts) || idleWatts < 0)) throw new Error("idleWatts must be nonnegative or null");
  if (!Number.isFinite(maxGapMs) || maxGapMs <= 0) throw new Error("maxGapMs must be positive");
  const valid = sample => sample?.valid === true && sample.discharging === true && Number.isFinite(sample.timestampMs)
    && Number.isFinite(sample.watts) && sample.watts > 0
    && sample.externalConnected === false && sample.isCharging === false
    && (!sample.power || sample.power.source === "Battery Power");
  let coveredMs = 0, energyJoules = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1], current = samples[index];
    const deltaMs = current?.timestampMs - previous?.timestampMs;
    if (valid(previous) && valid(current) && deltaMs > 0 && deltaMs <= maxGapMs) {
      coveredMs += deltaMs;
      energyJoules += (previous.watts + current.watts) / 2 * deltaMs / 1000;
    }
  }
  const ordered = samples.every((sample, index) => Number.isFinite(sample?.timestampMs) && (index === 0 || sample.timestampMs > samples[index - 1].timestampMs));
  const durationMs = ordered && samples.length > 1 ? samples.at(-1).timestampMs - samples[0].timestampMs : null;
  const validSamples = samples.filter(valid).length;
  const accepted = ordered && coveredMs > 0;
  const wholeMachineWatts = accepted ? energyJoules / (coveredMs / 1000) : null;
  return {
    status: accepted ? "ok" : "failed", reason: accepted ? null : !ordered ? "invalid-sample-timestamps" : "insufficient-discharge-coverage",
    sampleCount: samples.length, validSamples, rejectedSamples: samples.length - validSamples,
    coveredMs: accepted ? coveredMs : 0, durationMs,
    coverage: accepted && durationMs > 0 ? coveredMs / durationMs : null,
    wholeMachineWatts, idleWatts,
    wattsOverIdle: wholeMachineWatts !== null && idleWatts !== null ? wholeMachineWatts - idleWatts : null,
    energyJoules: accepted ? energyJoules : null,
    netEnergyJoules: accepted && idleWatts !== null ? energyJoules - idleWatts * coveredMs / 1000 : null,
  };
}

const HELP = `Usage: node scripts/benchmarks/power/battery.mjs --idle|--baseline=<idle.json> --brightness=<fixed setting> [--duration-seconds=60] [--interval-ms=1000]
Collects whole-machine battery discharge power in research/build/benchmarks/power/.
Set fixed brightness and Low Power Mode yourself, then unplug. This script only reads state.
Use --idle first, then pass that run's power.json as --baseline for workload runs.
Optional --label=<name> records what workload was running. No settings are changed.\n`;

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(HELP); return; }
  const options = {};
  for (const arg of args) {
    const match = /^--(idle|baseline|brightness|duration-seconds|interval-ms|label)(?:=(.*))?$/.exec(arg);
    if (!match || (match[1] !== "idle" && !match[2])) throw new Error(`invalid option ${arg}; use --help`);
    if (Object.hasOwn(options, match[1])) throw new Error(`duplicate option --${match[1]}`);
    options[match[1]] = match[1] === "idle" ? true : match[2];
  }
  if (Boolean(options.idle) === Boolean(options.baseline)) throw new Error("choose exactly one of --idle and --baseline");
  if (!options.brightness?.trim()) throw new Error("record the fixed brightness with --brightness");
  const durationSeconds = Number(options["duration-seconds"] ?? 60), intervalMs = Number(options["interval-ms"] ?? 1000);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600 || !Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 5000) throw new Error("duration must be 1..3600 seconds; interval 100..5000 ms");
  let idleWatts = 0, baseline = null;
  if (options.baseline) {
    baseline = JSON.parse(await readFile(options.baseline, "utf8"));
    if (baseline.kind !== "idle" || baseline.summary?.status !== "ok" || baseline.summary.coverage < 0.95
        || !Number.isFinite(baseline.summary.wholeMachineWatts) || baseline.configuration?.brightness !== options.brightness
        || baseline.configuration?.lowPowerMode !== true) throw new Error("baseline must be an accepted idle collection at the same recorded brightness and Low Power Mode");
    idleWatts = baseline.summary.wholeMachineWatts;
  }
  const first = await readBattery();
  if (!first.valid || first.power?.lowPowerMode !== true) throw new Error(`power run requires confirmed discharge and Low Power Mode (${first.reason ?? "Low Power Mode is off or unknown"})`);
  const samples = [first], started = performance.now();
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on("SIGINT", stop);
  try {
    while (!interrupted && performance.now() - started < durationSeconds * 1000) {
      await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, durationSeconds * 1000 - (performance.now() - started)))));
      const sample = await readBattery();
      if (sample.power?.lowPowerMode !== true) { sample.valid = false; sample.reason = "low-power-mode-changed-or-unknown"; sample.watts = null; }
      samples.push(sample);
    }
  } finally { process.off("SIGINT", stop); }
  const summary = summarizePower(samples, { idleWatts, maxGapMs: Math.max(5000, intervalMs * 3) });
  if (interrupted || summary.coverage < 0.95 || summary.rejectedSamples > 0) { summary.status = "failed"; summary.reason = interrupted ? "interrupted" : "incomplete-discharge-coverage"; }
  const directory = newOutputDirectory("benchmarks", "power");
  const output = path.join(directory, "power.json");
  await writeFile(output, JSON.stringify({
    schema: 1, generatedAt: new Date().toISOString(), kind: options.idle ? "idle" : "workload",
    configuration: { brightness: options.brightness, lowPowerMode: true, durationSeconds, intervalMs, label: options.label ?? null },
    baseline: options.baseline ? path.resolve(options.baseline) : null,
    summary, samples,
  }, null, 2) + "\n");
  process.stdout.write(`${output}\n`);
  if (summary.status !== "ok") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
