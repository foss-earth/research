#!/usr/bin/env node
/**
 * Terminal-only cost envelopes for proposed wheel-force models.
 *
 * These are deterministic reference kernels, deliberately isolated from
 * JSBSim, terrain queries, rendering and audio.  They answer only: "how much
 * JS arithmetic and state update does this shape of model add?"  They are not
 * validated aircraft dynamics and must never be presented as a frame-time
 * forecast or as a substitute for an integrated solver benchmark.
 */
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const DT = 1 / 120;
const WHEELS = [
  { x: 1.3, y: 0, radius: 0.18, inertia: 0.052, brake: 0 },
  { x: -0.8, y: -1.2, radius: 0.22, inertia: 0.124, brake: 300 },
  { x: -0.8, y: 1.2, radius: 0.22, inertia: 0.124, brake: 300 },
];
const INV_MASS = 1 / 1100;
const INV_YAW_INERTIA = 1 / 1900;
const STEPS_PER_RUN = 720;
const WARMUP_RUNS = 40;
const SAMPLES = 11;
const MIN_SAMPLE_MILLISECONDS = 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function createState(cellsPerWheel = 0) {
  return {
    vx: 27,
    vy: 0.35,
    yawRate: 0.015,
    omega: WHEELS.map(wheel => 27 / wheel.radius),
    slipX: [0, 0, 0],
    slipY: [0, 0, 0],
    soil: new Float64Array(WHEELS.length * cellsPerWheel),
    checksum: 0,
  };
}

function contactInputs(step, index) {
  const phase = step * 0.021 + index * 1.7;
  return {
    normal: 2_000 + index * 700 + 650 * Math.max(0, Math.sin(phase)),
    surfaceX: 0,
    surfaceY: 0,
    brake: step > 360 && index > 0 ? 0.55 : 0.04,
  };
}

function applyBodyImpulse(state, wheel, impulseX, impulseY) {
  // The tire impulse is applied to the wheel; its equal and opposite response
  // is applied to the airframe at the axle.  This is the minimal coupling
  // needed to expose the arithmetic shape of a rigid-wheel solver.
  state.vx -= impulseX * INV_MASS;
  state.vy -= impulseY * INV_MASS;
  state.yawRate -= (wheel.x * impulseY - wheel.y * impulseX) * INV_YAW_INERTIA;
}

function coupledRigidStep(state, step) {
  for (let index = 0; index < WHEELS.length; index += 1) {
    const wheel = WHEELS[index];
    const input = contactInputs(step, index);
    const longitudinal = state.vx - state.yawRate * wheel.y - input.surfaceX;
    const lateral = state.vy + state.yawRate * wheel.x - input.surfaceY;
    const inverseEffectiveMass = INV_MASS + wheel.radius ** 2 / wheel.inertia
      + wheel.y ** 2 * INV_YAW_INERTIA;
    const desiredImpulse = (longitudinal - wheel.radius * state.omega[index]) / inverseEffectiveMass;
    const maxImpulse = 0.72 * input.normal * DT;
    const longitudinalImpulse = clamp(desiredImpulse, -maxImpulse, maxImpulse);
    const lateralImpulse = clamp(lateral / (INV_MASS + wheel.x ** 2 * INV_YAW_INERTIA),
      -maxImpulse, maxImpulse);
    const brakeTorque = input.brake * wheel.brake;
    const brakeImpulse = clamp(brakeTorque * DT / wheel.radius, -maxImpulse, maxImpulse);
    applyBodyImpulse(state, wheel, longitudinalImpulse, lateralImpulse);
    state.omega[index] += (wheel.radius * longitudinalImpulse - Math.sign(state.omega[index]) * brakeTorque * DT)
      / wheel.inertia;
    state.checksum += longitudinalImpulse + lateralImpulse + brakeImpulse;
  }
}

function combinedSlipBrushStep(state, step) {
  for (let index = 0; index < WHEELS.length; index += 1) {
    const wheel = WHEELS[index];
    const input = contactInputs(step, index);
    const longitudinal = state.vx - state.yawRate * wheel.y;
    const lateral = state.vy + state.yawRate * wheel.x;
    const referenceSpeed = Math.max(1, Math.abs(longitudinal));
    const kappa = clamp((longitudinal - wheel.radius * state.omega[index]) / referenceSpeed, -2, 2);
    const alpha = clamp(Math.atan2(lateral, referenceSpeed), -0.7, 0.7);
    // First-order relaxation keeps the contact patch from responding
    // instantaneously.  Values are representative tuning inputs only.
    state.slipX[index] += clamp((kappa - state.slipX[index]) * DT / 0.12, -0.3, 0.3);
    state.slipY[index] += clamp((alpha - state.slipY[index]) * DT / 0.16, -0.3, 0.3);
    const rawX = 16 * input.normal * Math.tanh(3 * state.slipX[index]);
    const rawY = 11 * input.normal * Math.tanh(4 * state.slipY[index]);
    const limit = 0.72 * input.normal;
    const ellipse = Math.max(1, Math.hypot(rawX / limit, rawY / limit));
    const forceX = rawX / ellipse;
    const forceY = rawY / ellipse;
    const impulseX = forceX * DT;
    const impulseY = forceY * DT;
    const brakeTorque = input.brake * wheel.brake;
    applyBodyImpulse(state, wheel, impulseX, impulseY);
    state.omega[index] += (wheel.radius * impulseX - Math.sign(state.omega[index]) * brakeTorque * DT)
      / wheel.inertia;
    state.checksum += forceX * 0.001 + forceY * 0.001 + ellipse;
  }
}

function compliantTireSoilStep(state, step, cellsPerWheel) {
  combinedSlipBrushStep(state, step);
  for (let index = 0; index < WHEELS.length; index += 1) {
    const wheel = WHEELS[index];
    const input = contactInputs(step, index);
    let reaction = 0;
    const offset = index * cellsPerWheel;
    for (let cell = 0; cell < cellsPerWheel; cell += 1) {
      const u = cellsPerWheel === 1 ? 0 : cell / (cellsPerWheel - 1) * 2 - 1;
      // A small, local pressure/compaction field.  It deliberately has bounded
      // storage: it shows scaling without pretending to be FEA or permanent ruts.
      const roadHeight = 0.006 * Math.sin(step * 0.029 + index + cell * 0.37);
      const targetCompression = Math.max(0, 0.021 * (1 - u * u) + roadHeight);
      const prior = state.soil[offset + cell];
      const compaction = clamp(prior + (targetCompression - prior) * 0.18, 0, 0.06);
      state.soil[offset + cell] = compaction;
      reaction += Math.max(0, 65_000 * compaction * (1 - 0.35 * Math.abs(u)));
    }
    // Feed the bounded patch reaction into the same generalized body state so
    // the kernel cannot be optimized into dead work.
    const normalCorrection = clamp((reaction / cellsPerWheel - input.normal) * DT * 0.00001, -0.02, 0.02);
    state.vx -= normalCorrection * Math.abs(state.slipX[index]);
    state.checksum += reaction * 0.000001 + wheel.radius;
  }
}

const CASES = [
  {
    id: "coupled-rigid",
    description: "3 generalized rigid wheel/contact impulses with axle moments and wheel inertia",
    run(state, step) { coupledRigidStep(state, step); },
    create: () => createState(),
  },
  {
    id: "combined-slip-brush",
    description: "rigid coupling plus longitudinal/lateral relaxation and friction ellipse",
    run(state, step) { combinedSlipBrushStep(state, step); },
    create: () => createState(),
  },
  {
    id: "compliant-tire-soil-8",
    description: "brush kernel plus 8 local compliance cells per wheel",
    run(state, step) { compliantTireSoilStep(state, step, 8); },
    create: () => createState(8),
  },
  {
    id: "compliant-tire-soil-32",
    description: "brush kernel plus 32 local compliance cells per wheel",
    run(state, step) { compliantTireSoilStep(state, step, 32); },
    create: () => createState(32),
  },
];

function runCase(testCase, runs) {
  let checksum = 0;
  for (let run = 0; run < runs; run += 1) {
    const state = testCase.create();
    for (let step = 0; step < STEPS_PER_RUN; step += 1) testCase.run(state, step);
    if (!Number.isFinite(state.vx + state.vy + state.yawRate + state.checksum)
      || state.omega.some(value => !Number.isFinite(value))) {
      throw new Error(`${testCase.id} produced a non-finite state`);
    }
    checksum += state.checksum + state.vx;
  }
  return checksum;
}

for (const testCase of CASES) runCase(testCase, WARMUP_RUNS);
const results = [];
for (const testCase of CASES) {
  let runsPerSample = 1;
  while (true) {
    const start = performance.now();
    runCase(testCase, runsPerSample);
    if (performance.now() - start >= MIN_SAMPLE_MILLISECONDS) break;
    runsPerSample *= 2;
  }
  const samples = [];
  let checksum = 0;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const start = performance.now();
    checksum += runCase(testCase, runsPerSample);
    const elapsed = performance.now() - start;
    samples.push(elapsed * 1_000 / (runsPerSample * STEPS_PER_RUN));
  }
  results.push({
    id: testCase.id,
    description: testCase.description,
    runsPerSample,
    samplesMicrosecondsPerThreeWheelStep: samples,
    medianMicrosecondsPerThreeWheelStep: median(samples),
    equivalentCpuMillisecondsPerSimulatedSecondAt120Hz: median(samples) * 0.12,
    checksum,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  machine: { platform: process.platform, arch: process.arch, node: process.version, cpu: cpus()[0]?.model ?? "not recorded" },
  methodology: {
    physicsHz: 120,
    wheels: 3,
    stepsPerRun: STEPS_PER_RUN,
    warmupRuns: WARMUP_RUNS,
    samples: SAMPLES,
    targetCalibrationMilliseconds: MIN_SAMPLE_MILLISECONDS,
    includes: "Reference-kernel arithmetic, bounded wheel/body state and local compliance arrays.",
    excludes: "JSBSim/WASM, property reads, terrain queries, collision detection, rendering, browser/audio work, and validation against aircraft data.",
    interpretation: "A cost envelope for shapes of algorithms, not an implementation performance prediction.",
  },
  results,
};
writeFileSync(resolve(import.meta.dirname, "results-reference-kernels.json"), `${JSON.stringify(report, null, 2)}\n`);
console.table(results.map(result => ({
  model: result.id,
  "µs / 3 wheels": result.medianMicrosecondsPerThreeWheelStep.toFixed(3),
  "CPU ms / simulated second": result.equivalentCpuMillisecondsPerSimulatedSecondAt120Hz.toFixed(3),
})));
