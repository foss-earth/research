// Node 26 terminal benchmark of the actual production adapter and installed WASM.
// No renderer, audio device, browser, server, or production file modifications.
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const flightRoot = process.env.FLIGHT_SIM_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../flight-sim');
// Source uses extensionless TypeScript imports normally resolved by Vite.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') ||
        !context.parentURL?.startsWith(pathToFileURL(flightRoot + '/src/').href)) throw error;
    return nextResolve(specifier + '.ts', context);
  }
} });
const { JSBSimSdk } = await import(pathToFileURL(flightRoot + '/node_modules/@0x62/jsbsim-wasm/dist/index.js'));
const { wasmModuleUrl, wasmBinaryUrl } = await import(pathToFileURL(flightRoot + '/node_modules/@0x62/jsbsim-wasm/dist/wasm.js'));
const adapterPath = flightRoot + '/src/flight/physics/createWheelSpinExperiment.ts';
const modelPath = flightRoot + '/src/flight/physics/wheelSpin.ts';
const { createWheelSpinExperiment } = await import(pathToFileURL(adapterPath));
const dt = 1 / 120;
const sdks = [];
const manifest = JSON.parse(readFileSync(flightRoot + '/public/jsbsim-data/manifest.json', 'utf8'));
async function fixture(grounded) {
  const sdk = await JSBSimSdk.create({ moduleUrl: wasmModuleUrl, wasmUrl: wasmBinaryUrl,
    persistence: { enabled: false }, log: { console: false } });
  sdks.push(sdk);
  for (const file of manifest.files) sdk.writeDataFile(file, readFileSync(flightRoot + '/public/jsbsim-data/' + file, 'utf8'));
  sdk.configurePaths({ rootDir: '/runtime', aircraftPath: 'aircraft', enginePath: 'engine', systemsPath: 'systems' });
  assert.equal(sdk.loadModel('c172p'), true);
  for (const [name, value] of Object.entries({ 'simulation/dt': dt,
    'ic/lat-geod-deg': 34, 'ic/long-gc-deg': -118.3,
    'ic/h-sl-ft': (grounded ? 301.6 : 400) / 0.3048,
    'ic/terrain-elevation-ft': 300 / 0.3048,
    'ic/psi-true-deg': 0, 'ic/theta-deg': 2.48, 'ic/phi-deg': 0,
    'ic/vc-kts': 50, 'ic/vd-fps': 0.5 / 0.3048,
    'fcs/mixture-cmd-norm': 0, 'fcs/throttle-cmd-norm': 0 })) sdk.setPropertyValue(name, value);
  assert.equal(sdk.runIc(), true);
  let steps = 0;
  const contacts = () => [0, 1, 2].map(i => sdk.getPropertyValue(`gear/unit[${i}]/WOW`) > 0.5);
  while (grounded && !contacts().every(Boolean) && steps < 1440) {
    assert.equal(sdk.run(), true);
    steps++;
  }
  assert.equal(grounded ? contacts().every(Boolean) : contacts().every(x => !x), true);
  return { sdk, snapshot: { initializationSteps: steps, simulationTimeSeconds: sdk.getPropertyValue('simulation/sim-time-sec'),
    wow: contacts(), wheelSpeedMetersSec: [0, 1, 2].map(i => sdk.getPropertyValue(`gear/unit[${i}]/wheel-speed-fps`) * 0.3048),
    compressionMeters: [0, 1, 2].map(i => sdk.getPropertyValue(`gear/unit[${i}]/compression-ft`) * 0.3048),
    compressionVelocityMetersSec: [0, 1, 2].map(i => sdk.getPropertyValue(`gear/unit[${i}]/compression-velocity-fps`) * 0.3048),
    brake: ['left', 'right'].map(side => sdk.getPropertyValue(`fcs/${side}-brake-cmd-norm`)) } };
}

const cases = [];
let checksum = 0;
try {
  for (const grounded of [false, true]) {
    const { sdk, snapshot } = await fixture(grounded);
    // Instrument once outside timing to prove the property reads actually used.
    const propertyReads = [];
    createWheelSpinExperiment({ getPropertyValue(name) { propertyReads.push(name); return sdk.getPropertyValue(name); } }).step(dt, 'inertia');
    for (const mode of ['instant', 'inertia', 'property-reads-only']) {
      const experiment = mode === 'property-reads-only' ? null : createWheelSpinExperiment(sdk);
      const runBatch = iterations => {
        if (experiment) {
          for (let i = 0; i < iterations; i++) experiment.step(dt, mode);
          checksum += experiment.getStates().reduce((sum, s) => sum + s.omegaRadSec + s.angleRad, 0);
        } else {
          let sum = 0;
          for (let i = 0; i < iterations; i++) {
            for (const property of propertyReads) sum += sdk.getPropertyValue(property);
          }
          checksum += sum;
        }
      };
      const timed = iterations => { const start = performance.now(); runBatch(iterations); return performance.now() - start; };
      timed(10000);
      let iterations = 1000;
      while (timed(iterations) < 30) iterations *= 2;
      cases.push({ scenario: grounded ? 'all-three-grounded' : 'airborne', mode, snapshot,
        sdkPropertyReadsPerStep: propertyReads.length, propertyReads,
        iterationsPerSample: iterations, timed, samplesMilliseconds: [] });
    }
  }
  // Paired mode order reversed every round to balance warm-up/temperature bias.
  for (let sample = 0; sample < 11; sample++) {
    const ordered = sample % 2 ? [...cases].reverse() : cases;
    for (const entry of ordered) entry.samplesMilliseconds.push(entry.timed(entry.iterationsPerSample));
  }
  const results = cases.map(({ timed, ...entry }) => {
    const samplesMicrosecondsPerStep = entry.samplesMilliseconds.map(ms => ms * 1000 / entry.iterationsPerSample);
    const median = [...samplesMicrosecondsPerStep].sort((a, b) => a - b)[5];
    return { ...entry, samplesMicrosecondsPerStep, medianMicrosecondsPerThreeWheelStep: median,
      averageMicrosecondsPer60FpsFrameAt120Hz: 2 * median,
      cpuMillisecondsPerSecondAt120Hz: 120 * median / 1000 };
  });
  assert(Number.isFinite(checksum));
  const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const report = { generatedAt: new Date().toISOString(),
    machine: { cpu: os.cpus()[0]?.model, platform: os.platform(), arch: os.arch(), node: process.version },
    sdkVersion: JSON.parse(readFileSync(flightRoot + '/node_modules/@0x62/jsbsim-wasm/package.json', 'utf8')).version,
    sourceSha256: { adapter: sha256(adapterPath), model: sha256(modelPath), wasm: sha256(wasmBinaryUrl) },
    methodology: { physicsHz: 120, wheels: 3, measuredSamples: 11, targetCalibrationMilliseconds: 30,
      includes: 'Actual production three-wheel adapter, SDK string property lookup, JS/WASM boundary and scalar wheel math; frozen real C172 telemetry; steady wheel-state after warmup; loop and final checksum overhead.',
      excludes: 'JSBSim simulation advance, loading/initialization, browser overhead, visuals, audio, frame time, power, and dynamic touchdown transients.',
      caution: 'Node V8 terminal microbenchmark on this machine; not measured Safari/Chrome or other hardware; read-only baseline has separate sum/loop overhead and should not be subtracted as an exact isolated model cost.' },
    results, checksum };
  const output = new URL('./results-adapter.json', import.meta.url);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.table(results.map(r => ({ scenario: r.scenario, mode: r.mode, reads: r.sdkPropertyReadsPerStep,
    'µs / 3 wheels': r.medianMicrosecondsPerThreeWheelStep.toFixed(3),
    'µs / 60 FPS frame': r.averageMicrosecondsPer60FpsFrameAt120Hz.toFixed(3),
    'CPU ms / second': r.cpuMillisecondsPerSecondAt120Hz.toFixed(4) })));
  console.log('Results:', output.href);
} finally { for (const sdk of sdks) sdk.destroy(); }
