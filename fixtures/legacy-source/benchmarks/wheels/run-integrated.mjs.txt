// Node 26 terminal benchmark of the INTEGRATED fixed-step path with the real
// C172 WASM: createFixedStepPhysicsLoop (guards, snapshot, JSBSim Run()), the
// production terrain-contact and body-collision code, flight-control writes,
// the wheel adapter, the WheelCue bus and haptic aggregation. Each component is
// timed per accepted step and reported as p50/p95/p99 separately from the
// scalar reference kernels. No browser, renderer, audio device or server.
//
//   node --expose-gc benchmarks/wheels/run-integrated.mjs
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const flightRoot = process.env.FLIGHT_SIM_ROOT ?? path.resolve(here, '../../../flight-sim');
// Source uses extensionless TypeScript imports normally resolved by Vite.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (!specifier.startsWith('.') || !['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error.code)) throw error;
    for (const suffix of ['.ts', '/index.ts']) {
      try { return nextResolve(specifier + suffix, context); } catch { /* next */ }
    }
    throw error;
  }
} });
const src = file => pathToFileURL(path.join(flightRoot, 'src', file)).href;
const { JSBSimSdk } = await import(pathToFileURL(flightRoot + '/node_modules/@0x62/jsbsim-wasm/dist/index.js'));
const { wasmModuleUrl, wasmBinaryUrl } = await import(pathToFileURL(flightRoot + '/node_modules/@0x62/jsbsim-wasm/dist/wasm.js'));
const { createFixedStepPhysicsLoop, FIXED_DT } = await import(src('flight/physics/fixedStepLoop.ts'));
const { createTerrainContact } = await import(src('flight/physics/terrainContact.ts'));
const { createFrameSurfaceQuery } = await import(src('flight/physics/frameSurfaceQuery.ts'));
const { createVisibleMeshCollision } = await import(src('flight/physics/visibleMeshCollision.ts'));
const { createWheelSpinExperiment } = await import(src('flight/physics/createWheelSpinExperiment.ts'));
const { WHEEL_SPIN_CONFIGS } = await import(src('flight/physics/wheelSpin.ts'));
const { createWheelCueBus, createSlipAudioSink } = await import(src('flight/feedback/wheelCueBus.ts'));
const { createHapticsController } = await import(src('flight/feedback/haptics.ts'));
const { applyFlightControls } = await import(src('flight/input/applyFlightControls.ts'));
const { readFlightState } = await import(src('flight/bridge/ecefBridge.ts'));

const STEPS = Number(process.env.STEPS ?? 1440); // 12 simulated seconds per run
const SPAWN_STEPS = 60; // first 0.5 s after a fresh instance, reported separately
const TRACES = [
  { id: 'touchdown-rollout-brake', note: '1.6 m above 300 m terrain, 50 kt, 0.5 m/s sink, engine off; brakes from 6 s',
    ic: { 'ic/h-sl-ft': 301.6 / 0.3048, 'ic/vc-kts': 50, 'ic/vd-fps': 0.5 / 0.3048, 'ic/theta-deg': 2.48,
      'fcs/mixture-cmd-norm': 0, 'fcs/throttle-cmd-norm': 0 }, throttle: 0, brakeFromS: 6 },
  { id: 'airborne-cruise', note: '150 m above 300 m terrain, 90 kt, level, 70% throttle',
    ic: { 'ic/h-sl-ft': 450 / 0.3048, 'ic/vc-kts': 90, 'ic/vd-fps': 0, 'ic/theta-deg': 1,
      'fcs/mixture-cmd-norm': 1, 'fcs/throttle-cmd-norm': 0.7 }, throttle: 0.7, brakeFromS: Infinity },
];
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const now = () => performance.now();
const manifest = JSON.parse(readFileSync(flightRoot + '/public/jsbsim-data/manifest.json', 'utf8'));
const MODES = [
  { id: 'feedback-off', rotation: 'off', cues: false, haptics: false },
  { id: 'instant', rotation: 'instant', cues: true, haptics: false },
  { id: 'inertia', rotation: 'inertia', cues: true, haptics: false },
  { id: 'inertia+cues+haptics', rotation: 'inertia', cues: true, haptics: true },
];
const COMPONENTS = ['wholeStep', 'jsbsimRun', 'terrainContact', 'bodyCollision', 'controlWrites', 'wheelAdapter',
  'cueBusAndSinks', 'loopOverhead', 'hapticTickPerFrame', 'audioSinkTakePerFrame'];

// Analytic flat ground at the IC terrain height. Measures the JS contact logic
// and SDK writes, not tile lookup, BVH traversal or streamed terrain.
const flatSurface = {
  sample: () => ({ point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, distanceMeters: 0,
    heightMeters: 300, meshId: 'flat', revision: 1, quality: 1 }),
  raycast: () => null,
};

async function createSdk() {
  const sdk = await JSBSimSdk.create({ moduleUrl: wasmModuleUrl, wasmUrl: wasmBinaryUrl,
    persistence: { enabled: false }, log: { console: false } });
  for (const file of manifest.files) sdk.writeDataFile(file, readFileSync(flightRoot + '/public/jsbsim-data/' + file, 'utf8'));
  sdk.configurePaths({ rootDir: '/runtime', aircraftPath: 'aircraft', enginePath: 'engine', systemsPath: 'systems' });
  assert.equal(sdk.loadModel('c172p'), true);
  return sdk;
}

function initialize(sdk, trace) {
  for (const [name, value] of Object.entries({ 'simulation/dt': FIXED_DT, 'ic/lat-geod-deg': 34, 'ic/long-gc-deg': -118.3,
    'ic/terrain-elevation-ft': 300 / 0.3048, 'ic/psi-true-deg': 0, 'ic/phi-deg': 0, ...trace.ic })) sdk.setPropertyValue(name, value);
  assert.equal(sdk.runIc(), true);
}

const controlsAt = (trace, step) => ({ elevator: 0, aileron: 0, rudder: 0, throttle: trace.throttle, pitchTrim: 0, flaps: 0,
  brake: step * FIXED_DT >= trace.brakeFromS ? 1 : 0 });

/**
 * One 12 s touchdown/rollout/braking run on a fresh SDK instance, so every run
 * starts from identical JSBSim state (re-running IC on a reused instance does
 * not reset every actuator/integrator and is not bit-reproducible).
 */
async function run(mode, trace, { countReads = false } = {}) {
  const sdk = await createSdk();
  try { return runOn(sdk, mode, trace, countReads); } finally { sdk.destroy(); }
}

function runOn(sdk, mode, trace, countReads) {
  initialize(sdk, trace);
  let reads = 0;
  const rawRead = sdk.getPropertyValue;
  if (countReads) sdk.getPropertyValue = name => { reads += 1; return rawRead.call(sdk, name); };
  const samples = Object.fromEntries(COMPONENTS.map(key => [key, new Float64Array(STEPS)]));
  const grounded = new Uint8Array(STEPS);
  let runMs = 0, terrainMs = 0, collisionMs = 0, controlsMs = 0, adapterMs = 0, cuesMs = 0;
  const rawRun = sdk.run;
  sdk.run = () => { const start = now(); const ok = rawRun.call(sdk); runMs += now() - start; return ok; };
  const surface = createFrameSurfaceQuery(flatSurface);
  const terrain = createTerrainContact(sdk, surface);
  const body = createVisibleMeshCollision(sdk, surface);
  const wheels = createWheelSpinExperiment(sdk);
  const bus = createWheelCueBus(WHEEL_SPIN_CONFIGS.map(config => config.name));
  const audio = createSlipAudioSink();
  const played = [];
  const haptics = createHapticsController([{ play: envelope => played.push(envelope), cancel() {} }]);
  bus.subscribe(audio);
  if (mode.haptics) { bus.subscribe(haptics); haptics.setEnabled(true); haptics.setStrength(1); }
  let accepted = 0;
  let revision = 0;
  const loop = createFixedStepPhysicsLoop(sdk, () => {
    if (mode.rotation === 'off') return;
    const a = now();
    wheels.step(FIXED_DT, mode.rotation);
    adapterMs += now() - a;
    if (!mode.cues) return;
    const b = now();
    accepted += 1;
    bus.publish(accepted * FIXED_DT, FIXED_DT, wheels.getStates());
    cuesMs += now() - b;
  });
  terrain.reset();
  body.reset();
  loop.reset();
  const trajectory = [];
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  for (let step = 0; step < STEPS; step++) {
    runMs = terrainMs = collisionMs = controlsMs = adapterMs = cuesMs = 0;
    const start = now();
    surface.beginFrame();
    loop.update(FIXED_DT, () => {
      const a = now();
      const contact = terrain.update(false, false, true, true);
      terrainMs += now() - a;
      if (contact === false) return false;
      if (contact === 'reset') { body.reset(); bus.setGroundRevision(++revision); }
      const b = now();
      const collisionReset = body.update();
      collisionMs += now() - b;
      if (collisionReset) { wheels.reset(); bus.invalidate('reset'); return 'reset'; }
      const c = now();
      applyFlightControls(sdk, controlsAt(trace, step), 1);
      controlsMs += now() - c;
      return contact;
    });
    const whole = now() - start;
    samples.wholeStep[step] = whole;
    samples.jsbsimRun[step] = runMs;
    samples.terrainContact[step] = terrainMs;
    samples.bodyCollision[step] = collisionMs;
    samples.controlWrites[step] = controlsMs;
    samples.wheelAdapter[step] = adapterMs;
    samples.cueBusAndSinks[step] = cuesMs;
    samples.loopOverhead[step] = whole - runMs - terrainMs - collisionMs - controlsMs - adapterMs - cuesMs;
    // Presentation work runs once per rendered frame (60 FPS = every second step).
    if (step % 2 === 1) {
      const h = now();
      if (mode.haptics) haptics.tick(step * FIXED_DT * 1000, true);
      const tick = now();
      audio.takeMeanPowerWatts();
      const done = now();
      samples.hapticTickPerFrame[step] = mode.haptics ? tick - h : NaN;
      samples.audioSinkTakePerFrame[step] = done - tick;
    } else {
      samples.hapticTickPerFrame[step] = NaN;
      samples.audioSinkTakePerFrame[step] = NaN;
    }
    grounded[step] = [0, 1, 2].some(i => rawRead.call(sdk, `gear/unit[${i}]/WOW`) > 0.5) ? 1 : 0;
    if (step % 120 === 119) trajectory.push(['position/h-sl-ft', 'velocities/u-fps', 'velocities/q-rad_sec', 'velocities/r-rad_sec',
      'position/lat-geod-deg', 'position/long-gc-deg'].map(name => rawRead.call(sdk, name)));
  }
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  sdk.run = rawRun;
  sdk.getPropertyValue = rawRead;
  assert.equal(loop.getFault(), null, `fault in ${mode.id}/${trace.id}`);
  return { samples, grounded, trajectory, readsPerStep: countReads ? reads / STEPS : null, hapticEnvelopes: played.length, heapDeltaBytes };
}

const quantile = (sorted, q) => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
function summarize(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const us = value => value === null ? null : Number((value * 1000).toFixed(3));
  return { n: finite.length, p50Us: us(quantile(finite, 0.5)), p95Us: us(quantile(finite, 0.95)), p99Us: us(quantile(finite, 0.99)),
    maxUs: us(finite.at(-1)), meanUs: us(mean) };
}

// flightLog narrates terrain placement; keep the terminal output to results.
const print = console.log.bind(console);
console.log = console.info = () => {};
{
  // Reads per step and one-way invariance, outside timing.
  const readCounts = {};
  const hapticEnvelopes = {};
  for (const trace of TRACES) {
    const reference = await run(MODES[0], trace, { countReads: true });
    assert.deepEqual((await run(MODES[0], trace)).trajectory, reference.trajectory, 'fresh-instance runs must be reproducible');
    readCounts[`${trace.id}/${MODES[0].id}`] = reference.readsPerStep;
    for (const mode of MODES.slice(1)) {
      const probe = await run(mode, trace, { countReads: true });
      readCounts[`${trace.id}/${mode.id}`] = probe.readsPerStep;
      assert.deepEqual(probe.trajectory, reference.trajectory, `${mode.id} changed the ${trace.id} trajectory`);
      if (mode.haptics) hapticEnvelopes[trace.id] = probe.hapticEnvelopes;
    }
  }

  for (const trace of TRACES) for (const mode of MODES) await run(mode, trace); // warm-up round
  const collected = {};
  for (let round = 0; round < ROUNDS; round++) {
    const ordered = round % 2 ? [...MODES].reverse() : MODES;
    for (const trace of TRACES) {
      for (const mode of ordered) {
        const key = `${trace.id}/${mode.id}`;
        (collected[key] ??= []).push(await run(mode, trace));
      }
    }
  }

  // Isolated flight-state bridge read (called twice per step inside the loop).
  const sdk = await createSdk();
  initialize(sdk, TRACES[0]);
  for (let i = 0; i < 20_000; i++) readFlightState(sdk);
  const flightStateSamples = [];
  for (let sample = 0; sample < 11; sample++) {
    const start = now();
    for (let i = 0; i < 20_000; i++) readFlightState(sdk);
    flightStateSamples.push((now() - start) * 1000 / 20_000);
  }
  flightStateSamples.sort((a, b) => a - b);
  sdk.destroy();

  const results = [];
  for (const trace of TRACES) {
    for (const mode of MODES) {
      const rounds = collected[`${trace.id}/${mode.id}`];
      const byPhase = {};
      const phases = { spawnTransient: (round, step) => step < SPAWN_STEPS,
        airborne: (round, step) => step >= SPAWN_STEPS && !round.grounded[step],
        grounded: (round, step) => step >= SPAWN_STEPS && Boolean(round.grounded[step]) };
      for (const [phase, include] of Object.entries(phases)) {
        byPhase[phase] = Object.fromEntries(COMPONENTS.map(component => {
          const values = [];
          for (const round of rounds) for (let step = 0; step < STEPS; step++) if (include(round, step)) values.push(round.samples[component][step]);
          return [component, summarize(values)];
        }));
      }
      const heap = rounds.map(round => round.heapDeltaBytes).sort((a, b) => a - b);
      results.push({ trace: trace.id, mode: mode.id, sdkPropertyReadsPerStep: Number(readCounts[`${trace.id}/${mode.id}`].toFixed(2)),
        stepsPerRound: STEPS, rounds: rounds.length,
        groundedStepsPerRun: rounds[0].grounded.reduce((sum, value) => sum + value, 0), byPhase,
        medianStepLoopHeapDeltaBytes: heap[Math.floor(heap.length / 2)] });
    }
  }

  const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const hashed = ['flight/physics/fixedStepLoop.ts', 'flight/physics/terrainContact.ts', 'flight/physics/visibleMeshCollision.ts',
    'flight/physics/createWheelSpinExperiment.ts', 'flight/physics/wheelSpin.ts', 'flight/feedback/wheelCueBus.ts',
    'flight/feedback/haptics.ts'];
  const report = {
    generatedAt: new Date().toISOString(),
    machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, platform: os.platform(), arch: os.arch(), node: process.version,
      totalMemGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)) },
    sdkVersion: JSON.parse(readFileSync(flightRoot + '/node_modules/@0x62/jsbsim-wasm/package.json', 'utf8')).version,
    sourceSha256: { ...Object.fromEntries(hashed.map(file => [file, sha256(path.join(flightRoot, 'src', file))])), wasm: sha256(wasmBinaryUrl) },
    labels: {
      measured: 'Per accepted 120 Hz step on this machine in Node/V8: whole fixed step and its components through the production fixed-step loop with real C172 WASM, dynamic touchdown/rollout/braking; SDK reads per step; flight-state bridge read cost; coarse heap delta.',
      inferred: 'Any per-frame or percent-of-core conversion; browser behaviour from Node/V8.',
      unmeasured: 'Airborne flight near terrain (the airborne trace cruises 150 m up; the touchdown trace is airborne only ~0.2 s, inside the spawn transient), streamed Google/raster terrain queries and BVH/mesh raycasts (the surface here is analytic and raycasts return no hit), rendering, real-time audio thread, browser main-thread contention, other devices/browsers, power.',
    },
    methodology: { physicsHz: 1 / FIXED_DT, stepsPerRun: STEPS, rounds: ROUNDS, warmupRounds: 1,
      timer: 'performance.now() around each component; ~0.03–0.1 µs instrumentation overhead per bracket is included in the samples',
      traces: TRACES.map(({ id, note }) => ({ id, note })), spawnTransientSteps: SPAWN_STEPS,
      surface: 'flat analytic 300 m; raycast returns null',
      heap: 'V8 heapUsed around the step loop only, after a forced GC; allocation-rate indicator, not resident memory',
      invariance: 'Trajectory (altitude, u, q, r, lat, lon every simulated second) asserted identical across all modes' },
    flightStateReadMicroseconds: { median: Number(flightStateSamples[5].toFixed(3)), callsPerStepInLoop: 2 },
    hapticEnvelopesPerRun: hapticEnvelopes,
    results,
  };
  const output = new URL('./results-integrated.json', import.meta.url);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log = print;
  const rows = [];
  for (const result of results) {
    for (const phase of ['airborne', 'grounded']) {
      const c = result.byPhase[phase];
      if (!c.wholeStep) continue;
      rows.push({ trace: result.trace, mode: result.mode, phase, reads: result.sdkPropertyReadsPerStep,
        'whole p50': c.wholeStep.p50Us, 'whole p95': c.wholeStep.p95Us, 'run p50': c.jsbsimRun.p50Us,
        'terrain p50': c.terrainContact.p50Us, 'body p50': c.bodyCollision.p50Us, 'adapter p50': c.wheelAdapter.p50Us,
        'adapter p95': c.wheelAdapter.p95Us, 'cues p50': c.cueBusAndSinks.p50Us, 'overhead p50': c.loopOverhead.p50Us });
    }
  }
  console.table(rows);
  console.log('flightState read µs:', report.flightStateReadMicroseconds, 'haptic envelopes/run:', hapticEnvelopes);
  console.log('Results:', output.href);
}
