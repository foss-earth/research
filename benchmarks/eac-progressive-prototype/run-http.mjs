#!/usr/bin/env node
/**
 * The prototype over real HTTP: the page (viewer/page.ts) in headless Chrome
 * on this machine's GPU, fetching the static dataset from a loopback HTTP/2
 * server (lib/browser.mjs) through Chrome's network emulation. A category of
 * its own ("throttled real HTTP, loopback"), never pooled with the simulator.
 *
 *   node benchmarks/eac-progressive-prototype/run-http.mjs [--sets=main,backends,busy,warm,stress,failures] [--name=http]
 *
 * The sets are in config/experiments.json. Within a set, each repetition runs
 * the variants in the opposite order to the last. Every run starts in a fresh
 * browser context with its HTTP cache cleared (`Network.clearBrowserCache`),
 * except the second visit of a `warm` set, which reuses the first visit's
 * context; there is no service worker or application cache to clear.
 *
 * A run records frames, requests, decodes, uploads and the display table
 * every quarter second; nothing is read back from the GPU while it runs. Its
 * pictures are judged afterwards: tile states on the CPU by the renderer the
 * GPU checks validated (run-gpu-checks.mjs), and the control's two states
 * (preview, whole image) by replaying them on the GPU and reading them back.
 *
 * Sets marked `quiet` wait for ten seconds without keyboard or mouse input and
 * for normal memory pressure, and are run again if disturbed
 * (../spherical-image-representation/lib/quiet.mjs). `keepBusy` spins other
 * cores, the second processor state Phase 1 found.
 *
 * Writes results/<name>.csv (a row per run), results/<name>-series.json (the
 * judged samples), results/<name>-frames.json (frame intervals of selected
 * runs) and results/<name>.json (calibration, browser, GPU, configuration).
 * The pages' raw output stays in build/benchmarks/eac-progressive-prototype/http/.
 *
 * `--plain-http` serves HTTP/1.1 without TLS instead, for the warm-cache set: Chrome does not cache
 * responses from a connection with a certificate error, and the loopback certificate is self-signed.
 *
 * `--from=<that folder>` rebuilds every result from a run's raw output without
 * running the browser again (only the calibration and the control's replays,
 * which need it); `--from-log=<the run's log>` supplies which rounds the quiet
 * guard kept as disturbed. The server's own byte counts are not kept on disk,
 * so a rebuilt run has none; the page's counts are the measure anyway.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newOutputDirectory } from "../../scripts/lib/outputDirectory.mjs";
import { parseArguments } from "../spherical-image-representation/lib/environment.mjs";
import { meanSquaredError, psnrFromMse, ssim } from "../spherical-image-representation/lib/metrics.mjs";
import { CORPUS, loadSource } from "../spherical-image-representation/lib/source.mjs";
import { quietRound } from "../spherical-image-representation/lib/quiet.mjs";
import { isWorker, runWorkers, workerDone, workerTask } from "../spherical-image-representation/lib/pool.mjs";
import { bundlePage, calibrate, calibrationFiles, encodeSpec, openChrome, openPage, startServer } from "./lib/browser.mjs";
import { configWith } from "./lib/config.mjs";
import { openDataset, referenceView } from "./lib/render-cpu.mjs";
import { createJudge } from "./lib/judge.mjs";
import { profile as profileOf } from "./lib/sim.mjs";
import { cameraPath } from "./lib/traces.mjs";
import { configDirectory, defaultDataset, readJson, repositoryRoot, resultsDirectory, statistics, writeCsv, writeResults } from "./lib/paths.mjs";


/**
 * Judges one dataset's runs: every recorded sample's display table drawn on the CPU and compared with
 * the source (absolute) and with the same view at the finest level (the shortfall). Runs in a worker.
 */
function judgeRuns(task) {
  const source = loadSource(CORPUS.find(entry => entry.id === task.panorama)), data = openDataset(path.join(defaultDataset, task.variantDirectory));
  const { tiling } = data, C = tiling.cells, judges = new Map(), sum = list => list.reduce((total, value) => total + value, 0);
  return task.runs.map(run => {
    const key = `${run.viewport.width}x${run.viewport.height}`;
    if (!judges.has(key)) judges.set(key, createJudge({ source, viewport: run.viewport, stride: 2 }));
    const judge = judges.get(key), bootstrap = data.bootstrap(run.config.bootstrap), payload = run.config.payload, points = [];
    for (const sample of run.samples) {
      if (!sample.bootstrapShown) { points.push({ t: sample.t, bytes: sample.bytes, psnr: null, shortfall: null }); continue; }
      const table = Int32Array.from(sample.table), now = judge.score(data, table, sample.camera, { bootstrap, payload });
      // The same view with everything it needs: every cell at the finest level, which a phone's pixels need.
      const complete = table.map((_, cell) => tiling.id(Math.floor(cell / (C * C)), tiling.maxLevel, cell % C, Math.floor(cell / C) % C));
      const full = judge.score(data, complete, sample.camera, { bootstrap, payload });
      points.push({ t: sample.t, yaw: sample.camera.yaw, pitch: sample.camera.pitch, bytes: sample.bytes, psnr: now.psnr, ssim: now.ssim, shortfall: Math.max(0, full.psnr - now.psnr), residentTiles: sample.residentTiles, decodedBytes: sample.decodedBytes, inflightRequests: sample.inflightRequests, pendingTiles: sample.pendingTiles });
    }
    const shown = points.filter(point => point.psnr !== null), first = limit => shown.find(point => point.shortfall <= limit)?.t ?? null;
    const at = seconds => points.findLast(point => point.t <= seconds * 1000);
    const fields = { acceptableMs: first(run.config.quality.acceptableShortfallDb), highMs: first(run.config.quality.highShortfallDb), meanShortfallDb: shown.length ? sum(shown.map(point => point.shortfall)) / shown.length : null, finalPsnr: shown.at(-1)?.psnr ?? null, finalSsim: shown.at(-1)?.ssim ?? null, bytesAt1s: at(1)?.bytes, bytesAt2s: at(2)?.bytes, bytesAt5s: at(5)?.bytes, bytesAt10s: at(10)?.bytes };
    if (run.trace === "quick-turn") {
      const after = shown.filter(point => point.t >= 2600), settle = limit => { const hit = after.find(point => point.shortfall <= limit); return hit ? hit.t - 2600 : null; };
      Object.assign(fields, { afterTurnShortfallDb: after[0]?.shortfall ?? null, afterTurnPsnr: after[0]?.psnr ?? null, afterTurnAcceptableMs: settle(run.config.quality.acceptableShortfallDb), afterTurnHighMs: settle(run.config.quality.highShortfallDb) });
    }
    return { row: run.row, fields, series: { ...run.meta, points: points.map(point => ({ ...point, psnr: point.psnr === null ? null : Number(point.psnr.toFixed(2)), shortfall: point.shortfall === null ? null : Number(point.shortfall.toFixed(2)), ssim: point.ssim === undefined ? null : Number(point.ssim.toFixed(4)) })) } };
  });
}

if (isWorker) workerDone(judgeRuns(workerTask()));
else await main();

async function main() {
const experiments = readJson(path.join(configDirectory, "experiments.json")).http;
const options = parseArguments({ sets: ["main", "backends", "busy", "warm", "stress", "failures"], name: "http", from: "", "from-log": "", "plain-http": false, tour: path.join(repositoryRoot, "../UMN-VR/UMN-VR.github.io/public/tour/twin-cities") });
const out = newOutputDirectory("benchmarks", "eac-progressive-prototype", "http");
process.env.TMPDIR = out;
const sink = path.join(out, "sink"), readSink = options.from ? path.join(options.from, "sink") : sink;
// Rounds the quiet guard kept although disturbed, from the original run's log, when rebuilding.
const disturbedIn = new Map(options["from-log"] ? readFileSync(options["from-log"], "utf8").split("\n").filter(line => /^[a-z].*: .*disturbed by /.test(line)).map(line => [line.slice(0, line.indexOf(":")), line.slice(line.lastIndexOf("disturbed by ") + 13).trim()]) : []);
/** The tour's own name for each panorama of the corpus. */
const TOUR_ASSET = { "northrop-mall": "northrop-mall", bookstore: "student-union-bookstore", superblock: "superblock" };
const scene = JSON.parse(readFileSync(path.join(options.tour, "scene.json"), "utf8"));

function controlFor(panorama) {
  const asset = scene.assets.find(item => item.id === TOUR_ASSET[panorama]);
  const preview = asset.representations.find(item => item.id === "preview-64"), whole = asset.representations.filter(item => item.role === "immersion").sort((a, b) => b.width - a.width)[0];
  return { previewFaces: preview.faces, whole: whole.url, width: whole.width, height: whole.height, previewBytes: preview.encodedBytes, wholeBytes: whole.encodedBytes, asset: asset.id, wholeId: whole.id };
}

const frameStats = (frames, column) => statistics(frames.map(frame => frame[column]));
const sum = list => list.reduce((total, value) => total + value, 0);

const pageScript = await bundlePage(out);
const server = await startServer({ roots: { "/data/": defaultDataset, "/tour/": options.tour, "/cal/": calibrationFiles() }, pageScript, sinkDirectory: sink, plain: options["plain-http"] });
const { chrome, browser, gpu } = await openChrome(path.join(out, "chrome-profile"));
const rows = [], series = [], frameSeries = [], calibration = {}, backends = {}, controlStates = [], judging = [];
const sources = new Map();
const source = panorama => { if (!sources.has(panorama)) sources.set(panorama, loadSource(CORPUS.find(entry => entry.id === panorama))); return sources.get(panorama); };

try {
  console.log(`${browser.product}; ${gpu.devices?.map(device => device.deviceString).join(", ")}; serving ${server.origin}`);
  // What Chrome's emulation does to a request, for each profile used.
  for (const id of new Set(options.sets.flatMap(set => experiments[set].profiles))) {
    if (id === "none") continue;
    const network = profileOf(id), viewportCss = configWith({}).viewport;
    calibration[id] = { nominal: network, measured: await calibrate(chrome, server.origin, network, viewportCss) };
    const measured = calibration[id].measured;
    console.log(`calibration ${id}: small request ${statistics(measured.smallRequestMs).median.toFixed(0)} ms (nominal round trip ${network.roundTripMs}), 1 MiB ${(measured.oneMiB.ms / 1000).toFixed(2)} s (${(8 * measured.oneMiB.bytes / measured.oneMiB.ms / 1000).toFixed(2)} Mbit/s), six ¼ MiB at once ${(measured.sixQuarterMiB.ms / 1000).toFixed(2)} s, ${measured.protocol}`);
  }

  for (const setId of options.sets) {
    const set = experiments[setId];
    for (let repeat = 0; repeat < set.repeat; repeat++) {
      const variants = repeat % 2 ? [...set.variants].reverse() : set.variants;
      for (const backend of set.backends) for (const panorama of set.panoramas) for (const network of set.profiles) for (const [trace, start] of set.runs) for (const variant of variants) {
        const config = configWith(variant.config), runId = `${setId}-${variant.id}-${panorama}-${backend}-${network}-${trace}-${start}-r${repeat}`;
        const variantDirectory = path.join(panorama, `${config.dataset.projection}-t${config.dataset.tile}`);
        const control = variant.control ? controlFor(panorama) : null;
        const spec = {
          mode: "run", backend, runId, sink: `${server.origin}/sink/`, config, trace, start, laps: set.laps ?? 1, tailSeconds: 0,
          data: control ? `${server.origin}/tour/` : `${server.origin}/data/${variantDirectory}/`, control, render: variant.render ?? config.render.path, meshGrid: 32, cache: "default", log: true, gate: true,
        };
        Object.assign(server.faults, { failEvery: 0, delayMs: 0, tileRequests: 0 }, variant.faults ?? {});
        const visits = set.warm ? ["cold", "warm"] : ["cold"];
        let context = null;
        for (const visit of visits) {
          const id = visit === "cold" ? runId : `${runId}-warm`, logStart = server.log.length;
          const once = async () => {
            const page = await openPage(chrome, { url: `${server.origin}/?spec=${encodeSpec({ ...spec, runId: id })}`, viewport: config.viewport, network: network === "none" ? null : profileOf(network), context, clearCache: visit === "cold", gated: true });
            try {
              await page.waitFor("window.eac?.done === true", 180000);
              const state = await page.evaluate("window.eac");
              if (state.error) throw new Error(state.error);
              return { page, messages: page.messages };
            } finally { await page.close({ keepContext: set.warm && visit === "cold" }); context = set.warm && visit === "cold" ? page.browserContextId : null; }
          };
          const spinners = Array.from({ length: set.keepBusy ?? 0 }, () => spawn(process.execPath, ["-e", "for (;;) { const end = Date.now() + 200; while (Date.now() < end); if (process.ppid === 1) process.exit(); }"], { stdio: "ignore" }));
          let round;
          if (options.from) {
            for (const spinner of spinners) spinner.kill();
            if (!existsSync(path.join(readSink, `${id}.json`))) { console.log(`${id}: no raw output, left out`); continue; }
            round = { value: { messages: [] }, disturbed: disturbedIn.get(id) ?? null, attempts: null };
          } else {
            try { round = set.quiet ? await quietRound(once, { ownCores: 3 + (set.keepBusy ?? 0), retries: 2 }) : { value: await once(), disturbed: null, attempts: 1 }; } finally { for (const spinner of spinners) spinner.kill(); }
          }
          const result = JSON.parse(readFileSync(path.join(readSink, `${id}.json`), "utf8"));
          backends[`${backend}`] ??= result.backend;
          const served = server.log.slice(logStart), panoramaServed = served.filter(entry => entry.path.startsWith("/data/") || entry.path.startsWith("/tour/"));
          const resources = result.resources.filter(entry => entry.name.startsWith("/data/") || entry.name.startsWith("/tour/"));
          const frames = result.frames, settled = frames.slice(5);
          const row = {
            category: "throttled real HTTP, loopback", set: setId, variant: variant.id, visit, repeat, panorama, backend, backendActual: result.backend.isWebGPU ? "webgpu" : `webgl${result.backend.webGLVersion}`, render: spec.render,
            projection: control ? "equirectangular (control)" : config.dataset.projection, profile: network, trace, start, laps: set.laps ?? 1,
            drawingBuffer: `${result.viewport.width}x${result.viewport.height}`, disturbed: round.disturbed, attempts: round.attempts, keepBusy: set.keepBusy ?? 0,
            serverRequests: options.from ? null : panoramaServed.length, serverBytes: options.from ? null : sum(panoramaServed.map(entry => entry.bytes)), serverAborted: options.from ? null : panoramaServed.filter(entry => entry.aborted).length, serverFailed: options.from ? null : panoramaServed.filter(entry => entry.status >= 500).length,
            panoramaRequests: resources.length, panoramaTransferBytes: sum(resources.map(entry => entry.transferSize)),
            transferBytes: sum(resources.map(entry => entry.transferSize)), resourcesFromCache: resources.filter(entry => entry.transferSize === 0 && entry.encodedBodySize > 0).length, protocol: resources[0]?.protocol ?? null,
            appScriptBytes: result.resources.find(entry => entry.name.startsWith("/page.js"))?.transferSize ?? null,
            frames: frames.length, frameIntervalMedian: frameStats(settled, 1)?.median, frameIntervalP95: frameStats(settled, 1)?.p95, frameIntervalP99: frameStats(settled, 1)?.p99, frameIntervalMax: frameStats(settled, 1)?.max,
            framesOver20Ms: settled.filter(frame => frame[1] > 20).length, framesOver33Ms: settled.filter(frame => frame[1] > 33.4).length,
            tickMsMedian: frameStats(settled, 2)?.median, tickMsP99: frameStats(settled, 2)?.p99, tickMsMax: frameStats(settled, 2)?.max, renderCallMsMedian: frameStats(settled, 3)?.median, renderCallMsP99: frameStats(settled, 3)?.p99, renderCallMsMax: frameStats(settled, 3)?.max,
            gpuTimer: result.gpu.source, gpuValid: result.gpu.valid ?? (result.gpu.meanMs !== null), gpuMsMean: result.gpu.meanMs,
            errors: result.errors.length, pageMessages: round.value.messages.length,
          };
          if (control) {
            const timings = result.control.timings;
            Object.assign(row, { bootstrapMs: timings.previewShown, wholeShownMs: timings.wholeShown, wholeArrivedMs: timings.wholeArrived, wholeDecodeMs: timings.wholeDecoded - timings.wholeArrived, wholeUploadMs: timings.wholeShown - timings.wholeDecoded, uploadFramesOver4MiB: frames.filter(frame => frame[4] > 0).length, previewGpuBytes: result.control.previewGpuBytes, wholeGpuBytes: result.control.wholeGpuBytes, bytes: row.transferBytes });
            const worst = frames.filter(frame => frame[4] > 0);
            row.worstUploadFrameWorkMs = worst.length ? Math.max(...worst.map(frame => frame[2] + frame[3])) : null;
            for (const sample of result.samples) controlStates.push({ runId: id, panorama, backend, sample });
          } else {
            const counters = result.counters;
            Object.assign(row, {
              bootstrapMs: result.bootstrapDisplayedAt, bytes: counters.bytesReceived, requests: counters.requests, cancelled: counters.cancelled, cancelledBytes: counters.cancelledBytes, bytesNeverShown: result.bytesNeverShown, failures: counters.failures, retries: counters.retries,
              evictions: counters.evictions, redownloads: counters.redownloads, rematerialized: counters.rematerialized, levelCapped: counters.levelCapped, dropped: counters.dropped,
              peakInflightRequests: counters.peak.inflightRequests, peakPendingTiles: counters.peak.pendingTiles, peakResidentTiles: counters.peak.residentTiles, peakDecodedBytes: counters.peak.decodedBytes, peakCompressedBytes: counters.peak.compressedBytes,
              atlasBytes: result.renderer.atlasBytes, tileUploads: result.renderer.tileUploads, tileUploadBytes: result.renderer.tileUploadBytes, tableUploads: result.renderer.tableUploads, tableUploadBytes: result.renderer.tableUploadBytes,
              uploadCallMsMedian: result.renderer.uploadMs?.median, uploadCallMsMax: result.renderer.uploadMs?.max,
              decodeMsMedian: statistics(result.decodes.map(item => item[2]))?.median, decodeMsP95: statistics(result.decodes.map(item => item[2]))?.p95, readbackMsMedian: statistics(result.decodes.map(item => item[3]))?.median,
              reconstructMsMedian: statistics(result.decodes.filter(item => item[4] > 0).map(item => item[4]))?.median, reconstructMsMax: statistics(result.decodes.filter(item => item[4] > 0).map(item => item[4]))?.max,
              uploadFrames: frames.filter(frame => frame[4] > 0).length, worstUploadFrameWorkMs: Math.max(0, ...frames.filter(frame => frame[4] > 0).map(frame => frame[2] + frame[3])),
              triangles: result.renderer.triangles,
            });
            // Judged after every browser run has finished, in worker processes, on the CPU renderer the GPU checks validated.
            judging.push({ row: rows.length, panorama, variantDirectory, viewport: { ...result.viewport, verticalFovDeg: config.viewport.verticalFovDeg }, config: { quality: config.quality, payload: config.policy.payload, bootstrap: config.dataset.bootstrap }, trace, samples: result.samples, meta: { runId: id, set: setId, variant: variant.id, visit, panorama, backend, profile: network, trace, start } });
          }
          if (["backends", "busy", "stress"].includes(setId) && repeat === 0) frameSeries.push({ runId: id, set: setId, variant: variant.id, backend, trace, frames: frames.map(frame => [frame[0], frame[1], Number((frame[2] + frame[3]).toFixed(3)), frame[4]]) });
          rows.push(row);
          console.log(`${id}: ${row.backendActual}, bootstrap ${row.bootstrapMs?.toFixed(0)} ms, ${control ? `whole image ${row.wholeShownMs === null || row.wholeShownMs === undefined ? "not shown" : `${row.wholeShownMs.toFixed(0)} ms`}` : `${Math.round(row.bytes / 1024)} KiB received`}, ${row.panoramaRequests} requests, frames p99 ${row.frameIntervalP99?.toFixed(1)} ms${round.disturbed ? `, disturbed by ${round.disturbed}` : ""} (quality is judged at the end)`);
        }
      }
    }
  }

  // The control's pictures: each state it showed, replayed on the GPU it ran on and read back.
  const needed = new Map();
  for (const { panorama, backend, sample } of controlStates) {
    if (sample.state === "none") continue;
    const key = `${panorama}|${backend}|${sample.camera.yaw.toFixed(3)}|${sample.camera.pitch.toFixed(3)}`;
    needed.set(key, { panorama, backend, camera: sample.camera });
  }
  const controlScores = new Map();
  for (const [panorama, backend] of new Set([...needed.values()].map(item => `${item.panorama}|${item.backend}`)).values().map(key => key.split("|"))) {
    const config = configWith({}), control = controlFor(panorama), runId = `control-replay-${panorama}-${backend}`;
    const page = await openPage(chrome, { url: `${server.origin}/?spec=${encodeSpec({ mode: "replay", backend, runId, sink: `${server.origin}/sink/`, config, data: `${server.origin}/tour/`, control, render: "ray", meshGrid: 32 })}`, viewport: config.viewport, network: null });
    try {
      await page.waitFor("window.eac?.ready === true || window.eac?.done === true", 120000);
      const ready = await page.evaluate("window.eac");
      if (ready.error) throw new Error(ready.error);
      const viewport = { ...ready.result.viewport, verticalFovDeg: config.viewport.verticalFovDeg };
      for (const item of [...needed.values()].filter(entry => entry.panorama === panorama && entry.backend === backend)) {
        const reference = referenceView(source(panorama), item.camera, viewport, { stride: 2 }), scores = {};
        for (const which of ["preview", "whole"]) {
          const name = `${runId}-${which}-${item.camera.yaw.toFixed(2)}-${item.camera.pitch.toFixed(2)}`;
          await page.evaluate(`window.eac.show(${JSON.stringify({ camera: item.camera, which, name })})`);
          const capture = path.join(sink, `${name}.rgba`), rgba = readFileSync(capture), rgb = new Uint8Array(reference.length);
          // Scored and not kept: a capture is 10 MB, and the scores are the result.
          rmSync(capture);
          // Every second pixel each way, as the tiles are judged. WebGL reads the bottom row first; WebGPU's canvas
          // here is BGRA (run-gpu-checks.mjs found both).
          const webGpu = backend === "webgpu";
          let at = 0;
          for (let y = 0; y < viewport.height; y += 2) for (let x = 0; x < viewport.width; x += 2, at += 3) {
            const row = webGpu ? y : viewport.height - 1 - y, from = (row * viewport.width + x) * 4;
            rgb[at] = rgba[from + (webGpu ? 2 : 0)]; rgb[at + 1] = rgba[from + 1]; rgb[at + 2] = rgba[from + (webGpu ? 0 : 2)];
          }
          const width = Math.ceil(viewport.width / 2), height = Math.ceil(viewport.height / 2);
          scores[which] = { psnr: psnrFromMse(meanSquaredError(rgb, reference)), ssim: ssim(rgb, reference, width, height) };
        }
        controlScores.set(`${panorama}|${backend}|${item.camera.yaw.toFixed(3)}|${item.camera.pitch.toFixed(3)}`, scores);
      }
    } finally { await page.close(); }
  }
  for (const row of rows.filter(item => item.variant === "control")) {
    const states = controlStates.filter(item => item.runId === `${row.set}-control-${row.panorama}-${row.backend}-${row.profile}-${row.trace}-${row.start}-r${row.repeat}${row.visit === "warm" ? "-warm" : ""}`);
    const points = states.map(({ sample }) => {
      if (sample.state === "none") return { t: sample.t, psnr: null, shortfall: null };
      const scores = controlScores.get(`${row.panorama}|${row.backend}|${sample.camera.yaw.toFixed(3)}|${sample.camera.pitch.toFixed(3)}`);
      return { t: sample.t, yaw: sample.camera.yaw, psnr: scores[sample.state].psnr, ssim: scores[sample.state].ssim, shortfall: Math.max(0, scores.whole.psnr - scores[sample.state].psnr), state: sample.state };
    });
    const shown = points.filter(point => point.psnr !== null), first = limit => shown.find(point => point.shortfall <= limit)?.t ?? null;
    Object.assign(row, { acceptableMs: first(3), highMs: first(1), meanShortfallDb: shown.length ? sum(shown.map(point => point.shortfall)) / shown.length : null, finalPsnr: shown.at(-1)?.psnr ?? null, finalSsim: shown.at(-1)?.ssim ?? null });
    if (row.trace === "quick-turn") {
      const after = shown.filter(point => point.t >= 2600), settle = limit => { const hit = after.find(point => point.shortfall <= limit); return hit ? hit.t - 2600 : null; };
      Object.assign(row, { afterTurnShortfallDb: after[0]?.shortfall ?? null, afterTurnPsnr: after[0]?.psnr ?? null, afterTurnAcceptableMs: settle(3), afterTurnHighMs: settle(1) });
    }
    series.push({ runId: `${row.set}-control-${row.panorama}`, set: row.set, variant: "control", visit: row.visit, panorama: row.panorama, backend: row.backend, profile: row.profile, trace: row.trace, start: row.start, points });
  }
} finally {
  await chrome.close();
  await server.close();
}
// Judging, in four worker processes, one per dataset at a time.
const groups = new Map();
for (const item of judging) {
  const key = `${item.panorama}|${item.variantDirectory}`;
  if (!groups.has(key)) groups.set(key, { panorama: item.panorama, variantDirectory: item.variantDirectory, runs: [] });
  groups.get(key).runs.push(item);
}
const judged = (await runWorkers(import.meta.url, [...groups.values()], { processes: 4, label: "dataset judged" })).flat();
for (const result of judged) { Object.assign(rows[result.row], result.fields); series.push(result.series); }
console.log(writeResults(options.name, import.meta.url, { sets: Object.fromEntries(options.sets.map(id => [id, experiments[id]])), category: "throttled real HTTP over the loopback, Chrome's network emulation; not a remote host" }, { browser: browser.product, gpu, backends, calibration }));
console.log(writeCsv(options.name, rows));
writeFileSync(path.join(resultsDirectory, `${options.name}-series.json`), `${JSON.stringify(series)}\n`);
writeFileSync(path.join(resultsDirectory, `${options.name}-frames.json`), `${JSON.stringify(frameSeries)}\n`);
console.log(`Raw page output: ${out}`);
}
