#!/usr/bin/env node
/**
 * The deterministic simulator: the real client (lib/client.mjs) on Phase 1's
 * network model, judged on the CPU. Results are the "simulation" category and
 * are never pooled with the browser's.
 *
 *   node benchmarks/eac-progressive-prototype/run-sim.mjs [--sets=policies,representation,...] [--processes=4] [--name=sim]
 *
 * The sets are in config/experiments.json. Each varies one thing at a time
 * from config/default.json and is run on its own panoramas, network profiles,
 * camera traces and start orientations.
 *
 * Every quarter second of simulated time the view on screen is drawn from the
 * display table and compared with the source (PSNR and SSIM, the deficit
 * scale) and with the same scheme's view with everything arrived (the
 * shortfall). Time to "acceptable" and "high" are the first moments the
 * shortfall is within 3 and 1 dB: Phase 1's thresholds, kept for continuity and
 * not validated as perceptual limits. A run that never gets there says so.
 *
 * Writes results/<name>.csv (a row per run), results/<name>-series.json (every
 * sample of every run) and results/<name>.json (provenance and configuration).
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { CORPUS, defaultCorpusRoot, loadSource } from "../spherical-image-representation/lib/source.mjs";
import { isWorker, runWorkers, workerDone, workerTask } from "../spherical-image-representation/lib/pool.mjs";
import { parseArguments } from "../spherical-image-representation/lib/environment.mjs";
import { createSelector } from "./lib/selection.mjs";
import { createClient } from "./lib/client.mjs";
import { createSimStages, createSimTransport, profile, simulate, PROFILES } from "./lib/sim.mjs";
import { cameraPath } from "./lib/traces.mjs";
import { openDataset } from "./lib/render-cpu.mjs";
import { createJudge } from "./lib/judge.mjs";
import { configWith, viewportOf } from "./lib/config.mjs";
import { configDirectory, defaultDataset, loadConfig, readJson, resultsDirectory, writeCsv, writeResults } from "./lib/paths.mjs";

/** The moments of a quick turn: Phase 1's trace looks forward for 2 s and turns for 0.6 s. */
const TURN_ENDS_MS = 2600;

function runOne(task) {
  const config = configWith(task.variant.config), viewport = viewportOf(config);
  const datasetRoot = task.datasetRoot ?? defaultDataset;
  const dataset = openDataset(path.join(datasetRoot, task.panorama, `${config.dataset.projection}-t${config.dataset.tile}`));
  const source = loadSource(CORPUS.find(entry => entry.id === task.panorama), task.corpusRoot);
  const judge = createJudge({ source, viewport, stride: task.stride });
  const results = [];
  for (const run of task.runs) {
    const trace = cameraPath(run.trace, run.start), network = profile(run.profile);
    const transport = createSimTransport(network, { overheadBytes: 300, sharing: config.network?.sharing ?? "equal" }), stages = createSimStages();
    const selector = createSelector(dataset.tiling, config.selection);
    const client = createClient({ tiling: dataset.tiling, manifest: dataset.manifest, tileBytes: dataset.tileBytes, bootstrapSize: config.dataset.bootstrap, selector, policy: config.policy, limits: config.limits, transport, stages });
    const payload = config.policy.payload, bootstrap = dataset.bootstrap(config.dataset.bootstrap);
    const samples = [];
    simulate({ client, transport, stages, cameraAt: trace.at, viewport, durationMs: trace.duration * 1000, sampleMs: config.quality.sampleMs, onSample(time, camera) {
      const shown = client.bootstrapDisplayedAt !== null;
      const sample = { t: time, yaw: camera.yaw, pitch: camera.pitch, bytes: client.counters.bytesReceived, requests: client.counters.requests, ...client.resources() };
      if (shown) {
        const now = judge.score(dataset, client.table, camera, { bootstrap, payload }), complete = judge.score(dataset, client.completeTable(), camera, { bootstrap, payload });
        Object.assign(sample, { psnr: now.psnr, ssim: now.ssim, completePsnr: complete.psnr, shortfall: Math.max(0, complete.psnr - now.psnr) });
        // How the view is made up: cells shown at each level, −1 the bootstrap.
        const levels = new Array(dataset.tiling.maxLevel + 2).fill(0), cells = client.selection.inView;
        for (let cell = 0; cell < client.table.length; cell++) if (cells[cell]) levels[client.table[cell] < 0 ? 0 : dataset.tiling.level(client.table[cell]) + 1]++;
        sample.levels = levels;
      }
      samples.push(sample);
    } });
    const shown = samples.filter(sample => sample.psnr !== undefined), { acceptableShortfallDb, highShortfallDb } = config.quality;
    const first = (list, limit) => list.find(sample => sample.shortfall <= limit)?.t ?? null;
    const at = seconds => samples.findLast(sample => sample.t <= seconds * 1000);
    const { counters } = client;
    const row = {
      set: task.set, variant: task.variant.id, panorama: task.panorama, projection: config.dataset.projection, tile: config.dataset.tile, bootstrap: config.dataset.bootstrap,
      refinement: config.policy.refinement, payload, insurance: config.policy.insurance.enabled ? `level ${config.policy.insurance.maxLevel}, ${config.policy.insurance.slots} slots` : "off",
      profile: network.id, megabitsPerSecond: network.megabitsPerSecond, roundTripMs: network.roundTripMs, trace: run.trace, start: run.start,
      bootstrapMs: client.bootstrapDisplayedAt, acceptableMs: first(shown, acceptableShortfallDb), highMs: first(shown, highShortfallDb),
      meanShortfallDb: shown.length ? shown.reduce((sum, sample) => sum + sample.shortfall, 0) / shown.length : null,
      shareOfTimeHigh: shown.filter(sample => sample.shortfall <= highShortfallDb).length / samples.length,
      finalPsnr: shown.at(-1)?.psnr ?? null, finalSsim: shown.at(-1)?.ssim ?? null, completePsnr: shown.at(-1)?.completePsnr ?? null,
      bytesAt1s: at(1)?.bytes, bytesAt2s: at(2)?.bytes, bytesAt5s: at(5)?.bytes, bytesAt10s: at(10)?.bytes, bytes: counters.bytesReceived,
      requests: counters.requests, cancelled: counters.cancelled, cancelledBytes: counters.cancelledBytes, bytesNeverShown: client.bytesNeverShown(),
      insuranceBytes: counters.insuranceBytes, failures: counters.failures, redownloads: counters.redownloads, evictions: counters.evictions, levelCapped: counters.levelCapped,
      peakInflightRequests: counters.peak.inflightRequests, peakPendingTiles: counters.peak.pendingTiles, peakResidentTiles: counters.peak.residentTiles, peakDecodedBytes: counters.peak.decodedBytes,
    };
    if (run.trace === "quick-turn") {
      const after = shown.filter(sample => sample.t >= TURN_ENDS_MS), settle = limit => { const hit = after.find(sample => sample.shortfall <= limit); return hit ? hit.t - TURN_ENDS_MS : null; };
      Object.assign(row, { afterTurnShortfallDb: after[0]?.shortfall ?? null, afterTurnPsnr: after[0]?.psnr ?? null, afterTurnAcceptableMs: settle(acceptableShortfallDb), afterTurnHighMs: settle(highShortfallDb), beforeTurnShortfallDb: shown.findLast(sample => sample.t < 2000)?.shortfall ?? null });
    }
    results.push({ row, series: { set: task.set, variant: task.variant.id, panorama: task.panorama, profile: network.id, trace: run.trace, start: run.start, samples: samples.map(sample => ({ ...sample, psnr: sample.psnr === undefined ? null : Number(sample.psnr.toFixed(2)), shortfall: sample.shortfall === undefined ? null : Number(sample.shortfall.toFixed(2)), ssim: sample.ssim === undefined || sample.ssim === null ? null : Number(sample.ssim.toFixed(4)), completePsnr: undefined })) } });
  }
  dataset.forget();
  return results;
}

if (isWorker) workerDone(runOne(workerTask()));
else {
  const experiments = readJson(path.join(configDirectory, "experiments.json"));
  const options = parseArguments({ sets: Object.keys(experiments.simulation), processes: 4, name: "sim", stride: 2, "corpus-root": defaultCorpusRoot, "dataset-root": defaultDataset });
  const tasks = [];
  for (const setId of options.sets) {
    const set = experiments.simulation[setId];
    if (!set) throw new Error(`unknown set ${setId}; known: ${Object.keys(experiments.simulation).join(", ")}`);
    const runs = set.profiles.flatMap(id => set.traces.flatMap(([trace, starts]) => starts.map(start => ({ profile: id, trace, start }))));
    // One task per variant and panorama, so a worker reuses its decoded tiles and references across the task's runs.
    for (const variant of set.variants) for (const panorama of set.panoramas) tasks.push({ set: setId, variant, panorama, runs, stride: options.stride, corpusRoot: options["corpus-root"], datasetRoot: options["dataset-root"] });
  }
  console.log(`${tasks.length} tasks, ${tasks.reduce((sum, task) => sum + task.runs.length, 0)} runs`);
  const results = (await runWorkers(import.meta.url, tasks, { processes: options.processes, label: "variant and panorama" })).flat();
  const rows = results.map(result => result.row);
  console.log(writeResults(options.name, import.meta.url, { default: loadConfig(), sets: Object.fromEntries(options.sets.map(id => [id, experiments.simulation[id]])), profiles: PROFILES, stride: options.stride, category: "simulation: Phase 1's network model, no browser" }, {}));
  console.log(writeCsv(options.name, rows));
  const file = path.join(resultsDirectory, `${options.name}-series.json`);
  writeFileSync(file, `${JSON.stringify(results.map(result => result.series))}\n`);
  console.log(file);
}
