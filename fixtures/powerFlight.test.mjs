// No actual child, browser, battery, build, key, or network is used by this fixture.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { newOutputDirectory } from "../scripts/lib/outputDirectory.mjs";
import { flightChildArgs, parseFlightPowerOptions, runFlightPower, summarizeFlightPower, trimRouteSamples,
  validateFlightPowerInputs, validateIdleBaseline } from "../scripts/benchmarks/power/flight.mjs";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const sample = (timestampMs, watts = 20, extra = {}) => ({ timestampMs, watts, valid: true, discharging: true,
  externalConnected: false, isCharging: false, power: { source: "Battery Power", lowPowerMode: true }, ...extra });
const baseline = () => ({ kind: "idle", configuration: { brightness: "current-level-unchanged", lowPowerMode: true },
  summary: { status: "ok", coverage: 1, rejectedSamples: 0, wholeMachineWatts: 10 } });
const options = () => ({ fly: "/fly", out: "/fly/build/run", baseline: "/research/build/idle.json", brightness: "current-level-unchanged",
  route: "cruise", renderer: "webgpu-webgpu", idleSeconds: 10, maxWaitSeconds: 300, timeoutSeconds: 660 });
const processOk = () => ({ exitCode: 0, signal: null, timedOut: false, spawnError: null });
const flightReport = (start = 500, end = 180500) => ({ route: "cruise", headed: true, displayCompositing: true,
  durationClock: "accepted-physics-steps", baselineStatus: "unverified-route-coverage", runs: { "webgpu-webgpu": {
    exceptions: [], routeWaitError: null, route: { route: { id: "cruise", durationSeconds: 180 }, status: "complete", elapsedSeconds: 180,
      acceptedSteps: 21600, startedAtEpochMs: start, completedAtEpochMs: end, maxAltitudeErrorMeters: 5, maxHeadingErrorDeg: 1 },
  } } });

test("route clock trimming interpolates bracketed boundaries and integrates exactly that window", () => {
  const samples = [sample(0, 10), sample(1000, 20), sample(4000, 50)];
  const trimmed = trimRouteSamples(samples, { startedAtEpochMs: 500, completedAtEpochMs: 3500 });
  assert.equal(trimmed.status, "ok"); assert.equal(trimmed.durationMs, 3000); assert.equal(trimmed.interpolatedBoundaries, 2);
  assert.deepEqual(trimmed.samples.map(value => value.timestampMs), [500, 1000, 3500]);
  assert.deepEqual(trimmed.samples.map(value => value.watts), [15, 20, 45]);
  assert.deepEqual(samples.map(value => value.timestampMs), [0, 1000, 4000]);
  const exact = trimRouteSamples(samples, { startedAtEpochMs: 0, completedAtEpochMs: 4000 });
  assert.equal(exact.interpolatedBoundaries, 0);
  const report = flightReport(500, 3500);
  const result = summarizeFlightPower({ samples, flightReport: report, ...options(), idleWatts: 10, process: processOk() });
  close(result.power.wholeMachineWatts, 30); close(result.power.energyJoules, 90); close(result.power.wattsOverIdle, 20);
  assert.equal(result.qualifiedPower, true); assert.equal(result.qualified, false); assert.equal(result.coverageValidation, "unverified");
});

test("route trimming never extrapolates, bridges invalid boundary readings, or accepts long gaps", () => {
  for (const [samples, clock] of [
    [[sample(1000), sample(2000)], { startedAtEpochMs: 0, completedAtEpochMs: 2000 }],
    [[sample(0), sample(1000)], { startedAtEpochMs: 0, completedAtEpochMs: 2000 }],
    [[sample(0), sample(6000)], { startedAtEpochMs: 500, completedAtEpochMs: 5500 }],
    [[sample(0), sample(1000, 20, { valid: false }), sample(2000)], { startedAtEpochMs: 500, completedAtEpochMs: 2000 }],
    [[sample(0), sample(1000, 20, { power: { source: "AC Power", lowPowerMode: true } })], { startedAtEpochMs: 0, completedAtEpochMs: 500 }],
    [[sample(0), sample(1000)], { startedAtEpochMs: null, completedAtEpochMs: 1000 }],
    [[sample(1000), sample(0)], { startedAtEpochMs: 0, completedAtEpochMs: 1000 }],
  ]) {
    const result = trimRouteSamples(samples, clock); assert.equal(result.status, "failed"); assert.deepEqual(result.samples, []);
  }
  assert.throws(() => trimRouteSamples([sample(0), sample(1000)], { startedAtEpochMs: 0, completedAtEpochMs: 1000 }, { maxGapMs: 6000 }), /5000/);
});

test("interior invalid data stays missing and cannot qualify flight power", () => {
  const samples = Array.from({ length: 182 }, (_, index) => sample(index * 1000));
  samples[90] = sample(90000, 20, { valid: false, power: { source: "AC Power", lowPowerMode: false } });
  const result = summarizeFlightPower({ samples, flightReport: flightReport(), ...options(), idleWatts: 10, process: processOk() });
  assert.equal(result.powerMeasuredValid, false); assert.equal(result.qualifiedPower, false);
  assert.equal(result.power.rejectedSamples, 1); assert.ok(result.power.coverage < 1);
});

test("tracking, route completion, process success and exceptions each gate qualification", () => {
  const samples = Array.from({ length: 182 }, (_, index) => sample(index * 1000));
  for (const mutate of [
    report => { report.runs["webgpu-webgpu"].route.maxAltitudeErrorMeters = 20.01; },
    report => { report.runs["webgpu-webgpu"].route.maxHeadingErrorDeg = 5.01; },
    report => { report.runs["webgpu-webgpu"].route.status = "failed"; },
    report => { report.runs["webgpu-webgpu"].route.acceptedSteps = 21599; },
    report => { report.runs["webgpu-webgpu"].exceptions = ["not retained by wrapper"]; },
    report => { report.headed = false; },
  ]) {
    const report = flightReport(); mutate(report);
    const result = summarizeFlightPower({ samples, flightReport: report, ...options(), idleWatts: 10, process: processOk() });
    assert.equal(result.qualifiedPower, false); assert.equal(result.qualified, false);
  }
  const result = summarizeFlightPower({ samples, flightReport: flightReport(), ...options(), idleWatts: 10,
    process: { ...processOk(), timedOut: true } });
  assert.equal(result.qualifiedPower, false); assert.equal(result.powerMeasuredValid, true);
});

test("wrong brightness, unverified LPM or incomplete idle baselines fail before collection", () => {
  assert.equal(validateIdleBaseline(baseline(), "current-level-unchanged"), 10);
  for (const mutate of [
    value => { value.configuration.brightness = "different"; },
    value => { value.configuration.lowPowerMode = null; },
    value => { value.summary.coverage = null; },
    value => { value.summary.coverage = 0.94; },
    value => { value.summary.rejectedSamples = 1; },
    value => { value.kind = "workload"; },
    value => { value.summary.wholeMachineWatts = 0; },
  ]) { const value = baseline(); mutate(value); assert.throws(() => validateIdleBaseline(value, "current-level-unchanged"), /Idle baseline/); }
});

test("CLI rejects builds and child arguments always use the prebuilt public executable", () => {
  const args = ["--fly=/fly", "--out=/fly/build/run", "--baseline=/research/build/idle.json", "--brightness=current-level-unchanged", "--route=low"];
  const parsed = parseFlightPowerOptions(args); assert.equal(parsed.renderer, "webgpu-webgpu"); assert.equal(parsed.route, "low");
  for (const extra of ["--build-only", "--no-build", "--renderer=invalid", "--timeout-seconds=5"]) assert.throws(() => parseFlightPowerOptions([...args, extra]));
  const childArgs = flightChildArgs(parsed, "/fly/scripts/profile-flight.mjs");
  assert.ok(childArgs.includes("--no-build")); assert.ok(childArgs.includes("--headed")); assert.ok(!childArgs.includes("--build-only"));
  assert.equal(childArgs[0], "/fly/scripts/profile-flight.mjs"); assert.ok(childArgs.includes("--runs=webgpu-webgpu"));
});

function fakePorts({ invalidBaseline = false, timeout = false, spawnError = false, invalidInitial = false } = {}) {
  let clock = 0, child, timer, terminatedAt = null;
  const calls = [], signals = new EventEmitter();
  const ports = {
    validateInputs: async () => ({ ...options(), script: "/fly/scripts/profile-flight.mjs", report: "/fly/build/run/report.json" }),
    readJson: async file => file.endsWith("report.json") ? flightReport() : invalidBaseline ? { ...baseline(), kind: "workload" } : baseline(),
    waitForQuiet: async () => { calls.push("quiet"); },
    readBattery: async () => { calls.push("battery"); return sample(clock, 20, invalidInitial ? { valid: false } : {}); },
    now: () => clock, signals,
    setTimeout: callback => { timer = callback; return 1; }, clearTimeout: () => { calls.push("clear-timeout"); },
    spawn: (executable, args, config) => {
      calls.push({ executable, args, config }); child = new EventEmitter();
      child.kill = signal => { calls.push(signal); terminatedAt = clock; return true; };
      if (spawnError) queueMicrotask(() => { child.emit("error", new Error("secret must not be retained")); child.emit("close", -2, null); });
      return child;
    },
    sleep: async () => {
      clock += 1000;
      if (timeout && clock === 660000) timer();
      if (timeout ? terminatedAt !== null && clock >= terminatedAt + 2000 : clock >= 181000) child.emit("close", timeout ? 1 : 0, null);
    },
  };
  return { ports, calls, get clock() { return clock; } };
}

test("mock collection waits for idle, never builds, trims route clocks and suppresses child logs", async () => {
  const fake = fakePorts(); const report = await runFlightPower(options(), fake.ports);
  assert.equal(fake.calls[0], "quiet"); assert.equal(fake.calls[1], "battery");
  const spawned = fake.calls.find(value => typeof value === "object");
  assert.deepEqual(spawned.config, { cwd: "/fly", shell: false, stdio: ["ignore", "ignore", "ignore"] });
  assert.ok(spawned.args.includes("--no-build")); assert.ok(!spawned.args.includes("--build-only"));
  assert.equal(report.qualifiedPower, true); assert.equal(report.qualified, false);
  assert.equal(report.interval.durationMs, 180000); assert.equal(report.power.coveredMs, 180000);
  assert.equal(report.configuration.buildDuringCollection, false);
  assert.equal(fake.ports.signals.listenerCount("SIGTERM"), 0);
});

test("bad baselines and initial AC/read failures cannot spawn a flight", async () => {
  for (const settings of [{ invalidBaseline: true }, { invalidInitial: true }]) {
    const fake = fakePorts(settings); await assert.rejects(runFlightPower(options(), fake.ports));
    assert.equal(fake.calls.some(value => typeof value === "object"), false);
  }
});

test("timeout sends SIGTERM once and waits for natural child cleanup before returning", async () => {
  const fake = fakePorts({ timeout: true }); const report = await runFlightPower(options(), fake.ports);
  assert.equal(fake.clock, 662000); assert.deepEqual(fake.calls.filter(value => value === "SIGTERM"), ["SIGTERM"]);
  assert.equal(report.process.timedOut, true); assert.equal(report.qualifiedPower, false);
  assert.equal(fake.calls.includes("SIGKILL"), false);
});

test("spawn failures retain a fixed failure code and no raw child error", async () => {
  const fake = fakePorts({ spawnError: true }); const report = await runFlightPower(options(), fake.ports);
  assert.equal(report.process.spawnError, "spawn-failed"); assert.equal(report.qualifiedPower, false);
  assert.equal(JSON.stringify(report).includes("secret must not be retained"), false);
});

test("missing build artifacts and redirected build paths fail before spawning", async () => {
  const root = newOutputDirectory("validation", "power-flight-fixtures");
  const fly = path.join(root, "fly"), out = path.join(fly, "build", "run"), idle = path.join(root, "idle.json");
  try {
    await mkdir(path.join(fly, "scripts"), { recursive: true }); await mkdir(out, { recursive: true });
    await writeFile(path.join(fly, "scripts", "profile-flight.mjs"), "// public executable fixture\n");
    await writeFile(idle, JSON.stringify(baseline()));
    const requested = { ...options(), fly, out, baseline: idle };
    let spawned = false;
    const validate = candidate => validateFlightPowerInputs(candidate, { buildRoot: root, ignored: async () => true });
    await assert.rejects(runFlightPower(requested, { validateInputs: validate, spawn: () => { spawned = true; } }));
    assert.equal(spawned, false);
    await mkdir(path.join(out, "dist")); await writeFile(path.join(out, "dist", "index.html"), "<!doctype html>");
    const paths = await validate(requested); assert.equal(paths.report, path.join(out, "report.json"));
    await writeFile(paths.report, "{}"); await assert.rejects(validate(requested), /fresh prebuilt/); await rm(paths.report);
    const redirected = path.join(fly, "build", "redirected"); await symlink(out, redirected);
    await assert.rejects(validate({ ...requested, out: redirected }), /symbolic links/);
    const redirectedIdle = path.join(root, "redirected-idle.json"); await symlink(idle, redirectedIdle);
    await assert.rejects(validate({ ...requested, baseline: redirectedIdle }), /symbolic links/);
    await assert.rejects(validate({ ...requested, out: path.join(root, "outside") }), /owner's build/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
