#!/usr/bin/env node
/**
 * Experiments 6 and 7: delivery over a simulated network while the camera
 * moves.
 *
 * For each representation, scheme, network profile and camera trace, the
 * model in lib/network.mjs delivers the scheme's units while a simple client
 * policy chooses what to ask for. Every quarter second the view the person
 * has at that moment is drawn from what has arrived and compared with the
 * same view from the source.
 *
 * Policies (a simulator, not a production scheduler):
 *
 * Every policy fetches the coarse sphere first and alone.
 *
 * - `view`: the coarse sphere; then the units under the current view, level
 *   by level, most-covered first; then nothing. Requests the view no longer
 *   needs are cancelled when the view needs their slot.
 * - `view-fill`: the same, and once everything under the view has arrived,
 *   the rest of the sphere in level order, so a turn finds more than the
 *   coarse sphere.
 * - `view-direct` (replacement schemes): the coarse sphere, then only the
 *   finest level under the view. Nothing else.
 * - `global`: the coarse sphere, then every level whole. The camera is ignored.
 *
 * Quality is reported two ways. The shortfall is how far the view is, in dB of
 * PSNR, below what the same scheme shows for that view once everything has
 * arrived: it measures delivery alone. "Acceptable" is a shortfall within
 * 3 dB, "high" within 1 dB. The deficit is how far the view is below the same
 * view drawn from the uncompressed equirectangular control at full
 * resolution: it also counts what the scheme's representation and codec lose.
 *
 *   node benchmarks/spherical-image-representation/run-network.mjs
 *     [--representations=…] [--panoramas=…] [--traces=…] [--delta=12] [--quality=80] [--tile=256]
 *     [--concurrency=6] [--sharing=equal|ordered] [--overhead=300] [--processes=5] [--name=network] [--series=false]
 *
 * Bytes "never looked at" are a unit's bytes times the share of its cells that
 * no view covered during the trace, so a whole-image file is charged for the
 * part of the image nobody saw.
 *
 * Writes results/network.csv (one row per run) and results/network-series.json
 * (the shortfall and deficit at every quarter second of every run).
 */
import { representation } from "./lib/representations.mjs";
import { CORPUS, defaultCorpusRoot, loadSource } from "./lib/source.mjs";
import { buildGutter, mapRays, padField, resample, resolvePixels, sampleRays } from "./lib/field.mjs";
import { DELIVERY_RESOLUTION, analyze, makeHierarchy } from "./lib/hierarchy.mjs";
import { buildScheme, layoutUnits } from "./lib/schemes.mjs";
import { makeDisplay, renderAvailable, unitsUnderRays } from "./lib/evaluation.mjs";
import { levelOrder, residentBytes, usable } from "./lib/ordering.mjs";
import { PROFILES, simulateDelivery } from "./lib/network.mjs";
import { TRACES, trace as traceById } from "./lib/traces.mjs";
import { sampleSource, viewRays } from "./lib/views.mjs";
import { meanSquaredError, psnrFromMse } from "./lib/metrics.mjs";
import { codecVersions } from "./lib/codecs.mjs";
import { parseArguments, writeCsv, writeJson, writeResults } from "./lib/environment.mjs";
import { defaultProcesses, isWorker, runWorkers, workerDone, workerTask } from "./lib/pool.mjs";

const STEP = 0.05, EVALUATE_EVERY = 5;
const ACCEPTABLE_DB = 3, HIGH_DB = 1;
const control = representation("equirect");

function measure(task) {
  const { options } = task;
  const rep = representation(task.representation), N = DELIVERY_RESOLUTION[rep.id], path = traceById(task.trace);
  const sources = CORPUS.filter(entry => options.panoramas.includes(entry.id)).map(entry => loadSource(entry, options["corpus-root"]));
  const hierarchy = makeHierarchy(rep, N), { finest } = hierarchy;
  const tiled = layoutUnits(hierarchy, options.tile), whole = layoutUnits(hierarchy, 1 << 20);
  const { size, fov, supersample } = options, perPixel = supersample ** 2;
  const fields = resample(rep, N, sources);
  const controlN = DELIVERY_RESOLUTION.equirect, controlFields = resample(control, controlN, sources), controlGutter = buildGutter(control, controlN);

  // The camera at every scheduling step, with the rays the scheduler looks along (a coarse grid, a
  // little wider than the view) and, every quarter second, the rays the picture is judged on.
  const steps = Math.round(path.duration / STEP) + 1;
  const moments = [];
  for (let s = 0; s < steps; s++) {
    const view = path.at(s * STEP), key = `${view.yaw.toFixed(3)}/${view.pitch.toFixed(3)}`;
    const same = moments.at(-1)?.key === key ? moments.at(-1) : null;
    const moment = { time: s * STEP, view, key, scout: same?.scout ?? mapRays(rep, viewRays(view, 24, fov + 10, 1)) };
    if (s % EVALUATE_EVERY === 0) {
      const previous = moments.findLast(item => item.rays);
      if (previous?.key === key) Object.assign(moment, { rays: previous.rays, mapping: previous.mapping, controlMapping: previous.controlMapping, shared: previous });
      else { moment.rays = viewRays(view, size, fov, supersample); moment.mapping = mapRays(rep, moment.rays); moment.controlMapping = mapRays(control, moment.rays); }
    }
    moments.push(moment);
  }
  const judged = moments.filter(moment => moment.rays);
  // Which cells of each level any judged view covered, for charging bytes to what was looked at:
  // a unit's bytes count as looked at in proportion to the share of its cells that were.
  const seenCells = hierarchy.levels.map(level => new Uint8Array(level.count)), seenKeys = new Set();
  for (const moment of judged) {
    if (seenKeys.has(moment.key)) continue;
    seenKeys.add(moment.key);
    const { chart, u, v, count } = moment.mapping;
    for (let l = hierarchy.base; l <= finest; l++) {
      const { W, H } = hierarchy.levels[l], seen = seenCells[l];
      for (let r = 0; r < count; r++) seen[(chart[r] * H + Math.min(H - 1, Math.floor(v[r] * H))) * W + Math.min(W - 1, Math.floor(u[r] * W))] = 1;
    }
  }
  function seenShares(layout) {
    return Float64Array.from(layout.units, unit => {
      const { W, H } = hierarchy.levels[unit.level], seen = seenCells[unit.level];
      let covered = 0, cells = 0;
      for (const chart of unit.chart < 0 ? Array.from({ length: hierarchy.charts }, (_, c) => c) : [unit.chart]) {
        for (let y = unit.y0; y < unit.y1; y++) for (let x = unit.x0; x < unit.x1; x++) { covered += seen[(chart * H + y) * W + x]; cells++; }
      }
      return covered / cells;
    });
  }
  const linear = new Float32Array(size * size * perPixel * 3), pixels = new Uint8Array(size * size * 3);
  const rows = [], series = [];

  sources.forEach((source, p) => {
    const analysis = analyze(hierarchy, fields[p].rgb);
    // References and the control's quality at each judged moment.
    const controlPadded = padField(controlFields[p], controlGutter);
    for (const moment of judged) {
      if (moment.shared?.reference?.[p]) { (moment.reference ??= [])[p] = moment.shared.reference[p]; (moment.controlPsnr ??= [])[p] = moment.shared.controlPsnr[p]; continue; }
      (moment.reference ??= [])[p] = resolvePixels(sampleSource(source, moment.rays, linear), perPixel, new Uint8Array(size * size * 3));
      sampleRays(controlFields[p], controlPadded, moment.controlMapping, "linear", linear);
      (moment.controlPsnr ??= [])[p] = psnrFromMse(meanSquaredError(resolvePixels(linear, perPixel, pixels), moment.reference[p]));
    }

    const candidates = [
      { layout: tiled, settings: { kind: "haar-residual", delta: options.delta }, policies: ["view", "view-fill", "global"] },
      { layout: tiled, settings: { kind: "haar-residual", delta: options.delta, precision: 0.5 }, policies: ["view"] },
      { layout: tiled, settings: { kind: "image-residual", codec: "jpeg", quality: options.quality }, policies: ["view", "view-fill", "global"] },
      { layout: tiled, settings: { kind: "image-replacement", codec: "jpeg", quality: options.quality }, policies: ["view", "view-fill", "view-direct", "global"] },
      { layout: whole, settings: { kind: "image-replacement", codec: "jpeg", quality: options.quality }, policies: ["global", "view-direct"], suffix: "-whole" },
    ];
    for (const candidate of candidates) {
      const scheme = buildScheme(hierarchy, analysis, candidate.layout, candidate.settings);
      const name = scheme.id + (candidate.suffix ?? "");
      const display = makeDisplay(hierarchy, scheme);
      const everything = levelOrder(scheme);
      // What each moment's view touches: for the scheduler, and for the accounting of what was ever looked at.
      const touchedAt = new Map();
      const touched = moment => {
        if (!touchedAt.has(moment.key)) {
          const map = unitsUnderRays(hierarchy, scheme, moment.scout);
          const sorted = [...map.keys()].sort((a, b) => scheme.units[a].level - scheme.units[b].level || map.get(b) - map.get(a) || a - b);
          touchedAt.set(moment.key, { sorted, set: new Set(sorted) });
        }
        return touchedAt.get(moment.key);
      };
      // What the scheme shows at each judged moment with everything arrived.
      const everythingArrived = new Uint8Array(scheme.units.length).fill(1), complete = new Map();
      for (const moment of judged) {
        if (complete.has(moment.key)) continue;
        renderAvailable(display, moment.mapping, everythingArrived, linear);
        complete.set(moment.key, psnrFromMse(meanSquaredError(resolvePixels(linear, perPixel, pixels), moment.reference[p])));
      }
      const steadyDeficit = judged.reduce((sum, moment) => sum + moment.controlPsnr[p] - complete.get(moment.key), 0) / judged.length;
      const seenShare = seenShares(candidate.layout);

      for (const policy of candidate.policies) for (const profile of PROFILES) {
        const wanted = (stepIndex, arrived) => {
          const moment = moments[Math.min(stepIndex, moments.length - 1)];
          if (policy === "global") return { list: everything, keep: null };
          const view = touched(moment);
          if (policy === "view-direct") { const list = [0, ...view.sorted.filter(unit => scheme.units[unit].level === finest)]; return { list, keep: new Set(list) }; }
          // The rest of the sphere must not share the link with the view: it waits until the view has everything.
          const fill = policy === "view-fill" && view.sorted.every(unit => arrived[unit]);
          return { list: fill ? [0, ...view.sorted, ...everything] : [0, ...view.sorted], keep: view.set };
        };
        const points = [];
        let cache = null;
        const outcome = simulateDelivery({
          scheme, profile, duration: path.duration, wanted, stepSeconds: STEP, concurrency: options.concurrency, overheadBytes: options.overhead, sharing: options.sharing,
          onStep(time, arrived) {
            const moment = moments[Math.round(time / STEP)];
            if (!moment?.rays) return;
            const available = usable(scheme, arrived);
            let held = 0;
            for (let i = 0; i < available.length; i++) held += available[i];
            if (!available[0]) { points.push({ time, deficit: null, shortfall: null, psnr: null, held }); return; }
            if (!cache || cache.key !== moment.key || cache.held !== held) {
              renderAvailable(display, moment.mapping, available, linear);
              const psnr = psnrFromMse(meanSquaredError(resolvePixels(linear, perPixel, pixels), moment.reference[p]));
              cache = { key: moment.key, held, psnr, resident: residentBytes(hierarchy, scheme, available) };
            }
            points.push({ time, psnr: cache.psnr, deficit: moment.controlPsnr[p] - cache.psnr, shortfall: Math.max(0, complete.get(moment.key) - cache.psnr), held, resident: cache.resident });
          },
        });
        const shown = points.filter(point => point.deficit !== null);
        const firstWithin = limit => shown.find(point => point.shortfall <= limit)?.time ?? null;
        const meanOf = key => (shown.length ? shown.reduce((sum, point) => sum + point[key], 0) / shown.length : null);
        let wasted = 0, payload = 0;
        scheme.units.forEach((unit, index) => { payload += outcome.received[index]; wasted += outcome.received[index] * (1 - seenShare[index]); });
        const common = { panorama: source.id, representation: rep.id, scheme: name, policy, profile: profile.id, trace: path.id };
        const row = {
          ...common,
          megabitsPerSecond: profile.megabitsPerSecond, roundTripMs: profile.roundTripMs,
          timeToCoarseSphere: Number.isNaN(outcome.arrival[0]) ? null : outcome.arrival[0],
          timeToAcceptable: firstWithin(ACCEPTABLE_DB), timeToHigh: firstWithin(HIGH_DB),
          meanShortfallDb: meanOf("shortfall"), worstShortfallDb: shown.length ? Math.max(...shown.map(point => point.shortfall)) : null,
          shareOfTimeBlank: 1 - shown.length / points.length,
          shareOfTimeAcceptable: shown.filter(point => point.shortfall <= ACCEPTABLE_DB).length / points.length,
          shareOfTimeHigh: shown.filter(point => point.shortfall <= HIGH_DB).length / points.length,
          meanDeficitDb: meanOf("deficit"), deficitWithEverythingDb: steadyDeficit,
          bytesReceived: payload, bytesNeverLookedAt: wasted, bytesCancelled: outcome.cancelledBytes,
          requests: outcome.requests, requestsCancelled: outcome.cancelled,
          schemeBytes: scheme.units.reduce((sum, unit) => sum + unit.bytes, 0), schemeUnits: scheme.units.length,
          finalResidentBytes: shown.at(-1)?.resident ?? 0,
        };
        if (path.id === "quick-turn") {
          // How long after the turn ends the newly revealed view takes to become useful.
          const after = shown.filter(point => point.time >= 2.6);
          row.afterTurnShortfallDb = after[0]?.shortfall ?? null;
          const settle = limit => { const hit = after.find(point => point.shortfall <= limit); return hit ? hit.time - 2.6 : null; };
          row.afterTurnTimeToAcceptable = settle(ACCEPTABLE_DB); row.afterTurnTimeToHigh = settle(HIGH_DB);
        }
        rows.push(row);
        const rounded = key => points.map(point => (point[key] === null ? null : Math.round(point[key] * 100) / 100));
        series.push({ ...common, shortfallDb: rounded("shortfall"), deficitDb: rounded("deficit") });
      }
    }
  });
  return { rows, series };
}

if (isWorker) {
  workerDone(measure(workerTask()));
} else {
  const options = parseArguments({
    representations: ["equirect", "cube", "healpix", "ico-rhombus", "oct-ea"], panoramas: ["northrop-mall", "bookstore", "superblock"], traces: TRACES.map(item => item.id),
    delta: 12, quality: 80, tile: 256, concurrency: 6, overhead: 300, processes: defaultProcesses, size: 512, fov: 75, supersample: 2, "corpus-root": defaultCorpusRoot,
    // A variant run (another tile size, say) can be kept beside the main one under its own name.
    name: "network", series: true, sharing: "equal",
  });
  const tasks = options.representations.flatMap(id => options.traces.map(trace => ({ representation: id, trace, options })));
  const results = await runWorkers(import.meta.url, tasks, { processes: options.processes, label: "representation and trace" });
  const rows = results.flatMap(result => result.rows);
  const pick = rows.filter(row => row.profile === "constrained-mobile" && row.trace === "quick-turn");
  const table = new Map();
  for (const row of pick) {
    const key = `${row.representation}|${row.scheme}|${row.policy}`;
    const entry = table.get(key) ?? table.set(key, { representation: row.representation, scheme: row.scheme, policy: row.policy, n: 0, coarse: 0, mean: 0, wasted: 0 }).get(key);
    entry.n++; entry.coarse += row.timeToCoarseSphere ?? NaN; entry.mean += row.meanShortfallDb ?? NaN; entry.wasted += row.bytesNeverLookedAt / 1024;
  }
  console.log("constrained-mobile, quick turn, mean over panoramas:");
  console.table([...table.values()].map(entry => ({ representation: entry.representation, scheme: entry.scheme, policy: entry.policy, "s to coarse sphere": Number((entry.coarse / entry.n).toFixed(2)), "mean dB short of its own final": Number((entry.mean / entry.n).toFixed(2)), "KiB never looked at": Math.round(entry.wasted / entry.n) })));
  console.log(writeResults(options.name, import.meta.url, {
    viewport: { size: options.size, fovDeg: options.fov, raysPerPixel: options.supersample ** 2 },
    profiles: PROFILES, traces: TRACES.map(({ id, description, duration }) => ({ id, description, duration })),
    model: { concurrency: options.concurrency, sharing: options.sharing, responseOverheadBytes: options.overhead, schedulerStepSeconds: STEP, judgedEverySeconds: STEP * EVALUATE_EVERY, assumptions: "see lib/network.mjs" },
    thresholds: { acceptableShortfallDb: ACCEPTABLE_DB, highShortfallDb: HIGH_DB, shortfall: "below what the same scheme shows for the same view with everything arrived", deficit: `below the uncompressed equirectangular control at ${2 * DELIVERY_RESOLUTION.equirect} × ${DELIVERY_RESOLUTION.equirect}` },
    tile: options.tile, delta: options.delta, quality: options.quality, codecs: codecVersions(),
  }, {}));
  console.log(writeCsv(options.name, rows));
  // One entry per run, a value every quarter second from the moment of entering; null until the coarse sphere arrives.
  if (options.series) console.log(writeJson(`${options.name}-series`, { secondsBetweenValues: STEP * EVALUATE_EVERY, runs: results.flatMap(result => result.series) }));
}
