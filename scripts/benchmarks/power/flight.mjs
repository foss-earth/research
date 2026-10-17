/** Battery wrapper around fly's public profiler executable; never builds or reads a key. */
import { execFile, spawn } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readBattery, summarizePower } from "./battery.mjs";
import { buildRoot } from "../../lib/researchPaths.mjs";
import { newOutputDirectory } from "../../lib/outputDirectory.mjs";

const runFile = promisify(execFile);
const RENDERERS = ["webgpu-webgpu", "webgpu-canvas2d", "webgl2-canvas2d"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseFlightPowerOptions(args) {
  const names = new Set(["fly", "out", "baseline", "brightness", "route", "renderer", "idle-seconds", "max-wait-seconds", "timeout-seconds"]);
  const values = {};
  for (const arg of args) {
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !names.has(match[1]) || Object.hasOwn(values, match[1])) throw new Error("Unknown, missing, or duplicate flight power option; use --help. Builds must finish before power collection.");
    values[match[1]] = match[2];
  }
  for (const name of ["fly", "out", "baseline", "brightness", "route"]) if (!values[name]?.trim()) throw new Error(`--${name} is required.`);
  if (!["cruise", "low"].includes(values.route)) throw new Error("--route must be cruise or low.");
  const renderer = values.renderer ?? "webgpu-webgpu";
  if (!RENDERERS.includes(renderer)) throw new Error("Unknown flight renderer.");
  const idleSeconds = Number(values["idle-seconds"] ?? 10), maxWaitSeconds = Number(values["max-wait-seconds"] ?? 300);
  const timeoutSeconds = Number(values["timeout-seconds"] ?? 660);
  if (!Number.isFinite(idleSeconds) || idleSeconds < 1 || idleSeconds > 300
      || !Number.isFinite(maxWaitSeconds) || maxWaitSeconds < idleSeconds || maxWaitSeconds > 3600
      || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 660 || timeoutSeconds > 900) throw new Error("Invalid flight power wait/timeout; timeout must allow the profiler's 600 second limit plus cleanup.");
  return { fly: path.resolve(values.fly), out: path.resolve(values.out), baseline: path.resolve(values.baseline),
    brightness: values.brightness, route: values.route, renderer, idleSeconds, maxWaitSeconds, timeoutSeconds };
}

/** Every existing component is real; no symlink can redirect a build input/output. */
async function realFile(candidate, { within = null, directory = false } = {}) {
  const absolute = path.resolve(candidate);
  if (within && !absolute.startsWith(path.resolve(within) + path.sep)) throw new Error("Flight power inputs and outputs must remain inside their owner's build/ tree.");
  let cursor = path.parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Flight power paths cannot follow symbolic links.");
  }
  if (await realpath(absolute) !== absolute) throw new Error("Flight power paths must be real paths.");
  const entry = await lstat(absolute);
  if (directory ? !entry.isDirectory() : !entry.isFile()) throw new Error("A required flight power input has the wrong file type.");
  return absolute;
}

export async function validateFlightPowerInputs(options, ports = {}) {
  const researchBuild = ports.buildRoot ?? buildRoot;
  const fly = await realFile(options.fly, { directory: true });
  const script = await realFile(path.join(fly, "scripts", "profile-flight.mjs"));
  const out = await realFile(options.out, { within: path.join(fly, "build"), directory: true });
  await realFile(path.join(out, "dist", "index.html"), { within: path.join(fly, "build") });
  const baseline = await realFile(options.baseline, { within: researchBuild });
  const ignored = ports.ignored ?? (async () => {
    try { await runFile("git", ["check-ignore", "--quiet", "--", out], { cwd: fly }); return true; }
    catch { return false; }
  });
  if (!await ignored(out, fly)) throw new Error("Flight output must be in fly's gitignored build/ tree.");
  const report = path.join(out, "report.json");
  try { await lstat(report); throw new Error("Use a fresh prebuilt flight output: report.json already exists."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { fly, script, out, baseline, report };
}

export function validateIdleBaseline(baseline, brightness) {
  const summary = baseline?.summary;
  if (baseline?.kind !== "idle" || summary?.status !== "ok" || !Number.isFinite(summary.coverage) || summary.coverage < 0.95
      || summary.rejectedSamples !== 0 || !Number.isFinite(summary.wholeMachineWatts) || summary.wholeMachineWatts <= 0
      || baseline.configuration?.brightness !== brightness || baseline.configuration?.lowPowerMode !== true) throw new Error("Idle baseline must have complete valid discharge coverage, Low Power Mode, and the same recorded brightness.");
  return summary.wholeMachineWatts;
}

const validDischarge = sample => sample?.valid === true && sample.discharging === true && sample.externalConnected === false
  && sample.isCharging === false && Number.isFinite(sample.timestampMs) && Number.isFinite(sample.watts) && sample.watts > 0
  && sample.power?.source === "Battery Power" && sample.power.lowPowerMode === true;

/** Exact route-window integration boundaries: interpolate only valid adjacent readings. */
export function trimRouteSamples(samples, { startedAtEpochMs, completedAtEpochMs }, { maxGapMs = 5000 } = {}) {
  const failed = reason => ({ status: "failed", reason, samples: [], durationMs: null, interpolatedBoundaries: 0 });
  if (!Number.isFinite(startedAtEpochMs) || !Number.isFinite(completedAtEpochMs) || completedAtEpochMs <= startedAtEpochMs) return failed("missing-or-invalid-route-clock");
  if (!Array.isArray(samples) || samples.length < 2 || samples.some((sample, index) => !Number.isFinite(sample?.timestampMs)
      || (index > 0 && sample.timestampMs <= samples[index - 1].timestampMs))) return failed("invalid-battery-clock");
  if (!Number.isFinite(maxGapMs) || maxGapMs <= 0 || maxGapMs > 5000) throw new Error("Route boundary gaps must be at most 5000ms.");
  const boundary = timestampMs => {
    const index = samples.findIndex(sample => sample.timestampMs >= timestampMs);
    if (index < 0) return null;
    const right = samples[index];
    if (right.timestampMs === timestampMs) return validDischarge(right) ? right : null;
    const left = samples[index - 1];
    if (!validDischarge(left) || !validDischarge(right) || right.timestampMs - left.timestampMs > maxGapMs) return null;
    const weight = (timestampMs - left.timestampMs) / (right.timestampMs - left.timestampMs);
    return { timestampMs, valid: true, reason: null, discharging: true, externalConnected: false, isCharging: false,
      watts: left.watts + weight * (right.watts - left.watts), power: { source: "Battery Power", lowPowerMode: true },
      interpolated: true, bracketMs: [left.timestampMs, right.timestampMs] };
  };
  const start = boundary(startedAtEpochMs), end = boundary(completedAtEpochMs);
  if (!start || !end) return failed("route-boundaries-not-bracketed-by-valid-discharge");
  const inner = samples.filter(sample => sample.timestampMs > startedAtEpochMs && sample.timestampMs < completedAtEpochMs);
  return { status: "ok", reason: null, samples: [start, ...inner, end], durationMs: completedAtEpochMs - startedAtEpochMs,
    interpolatedBoundaries: Number(start.interpolated === true) + Number(end.interpolated === true) };
}

export function flightChildArgs(options, script) {
  if (!["cruise", "low"].includes(options.route) || !RENDERERS.includes(options.renderer)) throw new Error("Invalid flight route or renderer.");
  return [script, `--route=${options.route}`, `--runs=${options.renderer}`, "--no-build", "--headed", `--out=${options.out}`, "--timeout=600"];
}

/** Keep only public numeric route facts, never child errors, settings, URLs or logs. */
export function summarizeFlightPower({ samples, flightReport, route, renderer, idleWatts, process: lifecycle }) {
  const run = flightReport?.runs?.[renderer], snapshot = run?.route;
  const clock = { startedAtEpochMs: snapshot?.startedAtEpochMs ?? null, completedAtEpochMs: snapshot?.completedAtEpochMs ?? null };
  const trimmed = trimRouteSamples(samples, clock);
  const power = summarizePower(trimmed.samples, { idleWatts });
  const powerValid = trimmed.status === "ok" && power.status === "ok" && power.coverage >= 0.95
    && power.rejectedSamples === 0 && trimmed.samples.every(validDischarge);
  const routeComplete = flightReport?.route === route && snapshot?.route?.id === route && snapshot.status === "complete"
    && snapshot.route.durationSeconds === 180 && snapshot.elapsedSeconds === 180 && snapshot.acceptedSteps === 21600
    && flightReport?.headed === true && flightReport?.displayCompositing === true && flightReport?.durationClock === "accepted-physics-steps";
  const withinTrackingLimits = Number.isFinite(snapshot?.maxAltitudeErrorMeters) && snapshot.maxAltitudeErrorMeters >= 0 && snapshot.maxAltitudeErrorMeters <= 20
    && Number.isFinite(snapshot?.maxHeadingErrorDeg) && snapshot.maxHeadingErrorDeg >= 0 && snapshot.maxHeadingErrorDeg <= 5;
  const processValid = lifecycle?.exitCode === 0 && lifecycle.signal === null && lifecycle.timedOut === false && lifecycle.spawnError === null;
  const reasons = [];
  if (!processValid) reasons.push("profiler-process-failed");
  if (!routeComplete) reasons.push("route-not-complete");
  if (!withinTrackingLimits) reasons.push("tracking-limits-failed-or-unverified");
  if (flightReport?.error || run?.routeWaitError || !run || !Array.isArray(run.exceptions) || run.exceptions.length) reasons.push("profiler-report-failed-or-unverified");
  if (!powerValid) reasons.push(trimmed.reason ?? "incomplete-route-discharge-coverage");
  const qualifiedPower = reasons.length === 0;
  return { qualified: false, baselineStatus: "unverified-route-coverage", coverageValidation: "unverified", qualifiedPower,
    powerMeasuredValid: powerValid, reasons, routeComplete, withinTrackingLimits,
    route: { id: route, renderer, status: snapshot?.status === "complete" ? "complete" : "failed-or-missing", ...clock,
      elapsedSeconds: Number.isFinite(snapshot?.elapsedSeconds) ? snapshot.elapsedSeconds : null,
      acceptedSteps: Number.isSafeInteger(snapshot?.acceptedSteps) ? snapshot.acceptedSteps : null,
      maxAltitudeErrorMeters: Number.isFinite(snapshot?.maxAltitudeErrorMeters) ? snapshot.maxAltitudeErrorMeters : null,
      maxHeadingErrorDeg: Number.isFinite(snapshot?.maxHeadingErrorDeg) ? snapshot.maxHeadingErrorDeg : null },
    interval: { status: trimmed.status, reason: trimmed.reason, durationMs: trimmed.durationMs,
      interpolatedBoundaries: trimmed.interpolatedBoundaries, method: "linear-watts-between-adjacent-valid-readings; no extrapolation; max gap 5000ms" }, power };
}

/** Ports permit deterministic lifecycle tests without a browser, battery or child process. */
export async function runFlightPower(options, ports = {}) {
  const inputs = await (ports.validateInputs ?? validateFlightPowerInputs)(options);
  const readJson = ports.readJson ?? (async file => JSON.parse(await readFile(await realFile(file), "utf8")));
  const idleWatts = validateIdleBaseline(await readJson(inputs.baseline), options.brightness);
  const waitForQuiet = ports.waitForQuiet ?? (async (...args) => (await import("../earth-compare/run.mjs")).waitForQuiet(...args));
  await waitForQuiet(options.idleSeconds, options.maxWaitSeconds);
  const battery = ports.readBattery ?? readBattery;
  const first = await battery();
  if (!validDischarge(first)) throw new Error("Flight power collection requires confirmed unplugged discharge and Low Power Mode.");
  const samples = [first];
  const lifecycle = { exitCode: null, signal: null, timedOut: false, spawnError: null };
  const now = ports.now ?? Date.now;
  const nextBattery = async () => {
    try { return await battery(); }
    catch { return { timestampMs: now(), valid: false, reason: "battery-read-failed", watts: null, power: null }; }
  };
  const startedAtEpochMs = now();
  let child, closed = false, timer, signalListener;
  const complete = new Promise(resolve => {
    try {
      child = (ports.spawn ?? spawn)(process.execPath, flightChildArgs({ ...options, out: inputs.out }, inputs.script), {
        cwd: inputs.fly, shell: false, stdio: ["ignore", "ignore", "ignore"],
      });
      child.once("error", () => { lifecycle.spawnError = "spawn-failed"; });
      child.once("close", (code, signal) => { lifecycle.exitCode = code; lifecycle.signal = signal ?? null; closed = true; resolve(); });
    } catch { lifecycle.spawnError = "spawn-failed"; closed = true; resolve(); }
  });
  if (!closed) {
    const terminate = () => {
      if (closed) return;
      lifecycle.timedOut = true;
      try { child.kill("SIGTERM"); } catch { lifecycle.spawnError = "termination-failed"; }
    };
    timer = (ports.setTimeout ?? setTimeout)(terminate, options.timeoutSeconds * 1000);
    signalListener = () => {
      if (closed) return;
      lifecycle.spawnError = "interrupted";
      try { child.kill("SIGTERM"); } catch { lifecycle.spawnError = "termination-failed"; }
    };
    (ports.signals ?? process).on("SIGINT", signalListener);
    (ports.signals ?? process).on("SIGTERM", signalListener);
  }
  try {
    while (!closed) {
      await Promise.race([(ports.sleep ?? sleep)(1000), complete]);
      if (!closed) samples.push(await nextBattery());
    }
    await complete; // Includes profiler cleanup: never leave a still-running child.
    samples.push(await nextBattery());
  } finally {
    if (timer !== undefined) (ports.clearTimeout ?? clearTimeout)(timer);
    if (signalListener) {
      (ports.signals ?? process).off("SIGINT", signalListener);
      (ports.signals ?? process).off("SIGTERM", signalListener);
    }
  }
  let flightReport = null;
  try { flightReport = await readJson(inputs.report); } catch { lifecycle.reportError = "missing-or-invalid-report"; }
  return { schema: 1, generatedAt: new Date().toISOString(), kind: "flight", startedAtEpochMs, completedAtEpochMs: now(),
    configuration: { brightness: options.brightness, lowPowerMode: true, route: options.route, renderer: options.renderer,
      sampleIntervalMs: 1000, timeoutSeconds: options.timeoutSeconds, buildDuringCollection: false },
    baseline: inputs.baseline, flightReport: inputs.report, process: lifecycle,
    ...summarizeFlightPower({ samples, flightReport, route: options.route, renderer: options.renderer, idleWatts, process: lifecycle }), samples };
}

const HELP = `Usage: node scripts/benchmarks/power/flight.mjs --fly=<checkout> --out=<fly/build/prebuilt-run> --baseline=<research/build/.../power.json> --brightness=<fixed label> --route=cruise|low [--renderer=webgpu-webgpu]
Prebuild fly's --out directory using its profiler --build-only on the adapter first.
This wrapper always passes --no-build. Keep brightness unchanged from the idle baseline,
unplug, and enable Low Power Mode yourself. It waits for strict idle before starting.
Output is a new research/build/benchmarks/power/flight/.../power.json. Route coverage stays unverified.
Optional: --idle-seconds=10 --max-wait-seconds=300 --timeout-seconds=660\n`;

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(HELP); return; }
  const report = await runFlightPower(parseFlightPowerOptions(args));
  const output = path.join(newOutputDirectory("benchmarks", "power", "flight"), "power.json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(`${output}\n`);
  if (!report.qualifiedPower) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Flight power collection failed validation or could not complete; no raw child logs were retained. Use --help to check inputs.\n"); process.exitCode = 1; });
}
