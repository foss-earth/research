// Node 24+ native TypeScript stripping; no browser, server, or GPU required.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const flightRoot = process.env.FLIGHT_SIM_ROOT ?? path.resolve(here, "../../../flight-sim");
const sourceFile = path.join(flightRoot, "src/flight/physics/wheelSpin.ts");
const { createWheelSpinState, stepWheelSpin, WHEEL_SPIN_CONFIGS } = await import(pathToFileURL(sourceFile).href);
const dt = 1 / 120;
const cases = ["gentle", "firm", "bounce", "braking", "reverse"];
const modes = ["instant", "inertia"];

function inputFor(scenario, step, wheel) {
  const time = step * dt;
  const touch = wheel === 0 ? 1 : 0.5 + (wheel === 2 ? 0.025 : 0);
  const onGround = time >= touch && !(scenario === "bounce" && time >= 0.8 && time < 1.1);
  const nominalLoad = wheel === 0 ? 900 : scenario === "firm" ? 4000 : 2400;
  const normalLoadNewtons = onGround ? nominalLoad * Math.min(1, (time - touch + dt) / 0.2) : 0;
  const speed = scenario === "braking" ? Math.max(0, 30 - Math.max(0, time - 1.5) * 8) : 30;
  return { onGround, rollMetersSec: scenario === "reverse" ? -speed : speed,
    normalLoadNewtons, compressionMeters: onGround ? 0.04 : 0, steeringRad: 0,
    brake: scenario === "braking" && time >= 1.5 && wheel !== 0 ? 1 : 0 };
}

const fixtures = Object.fromEntries(cases.map(scenario => [scenario,
  Array.from({ length: 480 }, (_, step) => WHEEL_SPIN_CONFIGS.map((_, wheel) => inputFor(scenario, step, wheel)))]));

function run(scenario, mode, record = false) {
  const states = WHEEL_SPIN_CONFIGS.map(() => createWheelSpinState());
  const trace = [];
  let heatJoules = 0;
  let firstContact = null;
  let mainSpinUpSeconds = null;
  let maxPowerWatts = 0;
  for (let step = 0; step < fixtures[scenario].length; step++) {
    let power = 0;
    for (let wheel = 0; wheel < states.length; wheel++) {
      const input = fixtures[scenario][step][wheel];
      stepWheelSpin(states[wheel], WHEEL_SPIN_CONFIGS[wheel], input, dt, mode);
      power += states[wheel].slipPowerWatts;
    }
    if (record) {
      if (firstContact === null && states[1].onGround) firstContact = step;
      if (firstContact !== null && mainSpinUpSeconds === null && states[1].onGround && Math.abs(states[1].slipMetersSec) < 0.01) {
        mainSpinUpSeconds = (step - firstContact + 1) * dt;
      }
      assert(states.every(wheel => Number.isFinite(wheel.omegaRadSec) && wheel.slipPowerWatts >= 0 && Number.isFinite(wheel.slipPowerWatts)));
      heatJoules += power * dt;
      maxPowerWatts = Math.max(maxPowerWatts, power);
      trace.push({ timeSeconds: step * dt, powerWatts: power, mainRpm: states[1].omegaRadSec * 60 / (2 * Math.PI),
        mainSlipMetersSec: states[1].slipMetersSec, mainContact: states[1].onGround });
    }
  }
  return { checksum: states.reduce((sum, wheel) => sum + wheel.omegaRadSec + wheel.angleRad, 0),
    heatJoules, mainSpinUpSeconds, maxPowerWatts, trace };
}

const includeTraces = process.argv.includes("--traces");
const outputArgument = process.argv.slice(2).find(argument => argument !== "--traces");
const results = [];
let checksum = 0;
for (const scenario of cases) for (const mode of modes) {
  for (let warmup = 0; warmup < 20; warmup++) checksum += run(scenario, mode).checksum;
  const samplesMicroseconds = [];
  for (let sample = 0; sample < 9; sample++) {
    const started = performance.now();
    for (let repeat = 0; repeat < 200; repeat++) checksum += run(scenario, mode).checksum;
    samplesMicroseconds.push((performance.now() - started) * 1000 / (200 * 480));
  }
  const sorted = [...samplesMicroseconds].sort((a, b) => a - b);
  const metrics = run(scenario, mode, true);
  if (mode === "instant") assert.equal(metrics.heatJoules, 0);
  else assert(metrics.heatJoules > 0);
  const { trace, ...summary } = metrics;
  results.push({ scenario, mode, medianMicrosecondsPerThreeWheelStep: sorted[4], samplesMicroseconds,
    ...summary, ...(includeTraces ? { trace } : {}) });
}
assert(Number.isFinite(checksum));
const report = { generatedAt: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model, platform: os.platform(), arch: os.arch(), node: process.version },
  sourceSha256: createHash("sha256").update(readFileSync(sourceFile)).digest("hex"),
  methodology: { physicsHz: 120, wheels: 3, stepsPerRun: 480, warmupRuns: 20, samples: 9, runsPerSample: 200,
    includes: "Three scalar wheel updates and loop/checksum overhead, with precomputed inputs; reset allocations once per480 steps",
    excludes: "JSBSim property reads, rendering, audio processing, full-game FPS and power; no aircraft force feedback",
    parameters: WHEEL_SPIN_CONFIGS },
  results, checksum };
const output = outputArgument ?? path.join(here, "results.json");
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.table(results.map(({ scenario, mode, medianMicrosecondsPerThreeWheelStep, mainSpinUpSeconds, heatJoules }) => ({
  scenario, mode, "µs / 3 wheels": medianMicrosecondsPerThreeWheelStep.toFixed(3),
  "main spin-up s": mainSpinUpSeconds.toFixed(4), "slip heat J": heatJoules.toFixed(1),
})));
console.log(`Saved ${output}`);
