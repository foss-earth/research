#!/usr/bin/env node
/**
 * Experiment 5: quality of the view against bytes received, for different
 * orders of sending the same units.
 *
 * No network here, only bytes: after B bytes of an order, the client holds
 * the units that have arrived whole, and each view is drawn from the finest
 * level it holds in each direction. Three orders (lib/ordering.mjs):
 *
 * - `level`: the coarse sphere, then each level whole.
 * - `gain`: greedy by error removed per byte, over the whole sphere.
 * - `view`: the units under the view first, level by level; quality is then
 *   measured on that view, and on the view facing the opposite way, which
 *   shows what a turn would reveal. `view-direct` is the same for a
 *   replacement scheme that fetches only the finest level under the view.
 *
 *   node benchmarks/spherical-image-representation/run-progressive.mjs
 *     [--representations=…] [--panoramas=…] [--delta=12] [--quality=80] [--tile=256] [--processes=5]
 *
 * Writes results/progressive.csv, one row per panorama, representation,
 * scheme, order and byte budget, averaged over the twelve evaluation views.
 */
import { representation } from "./lib/representations.mjs";
import { CORPUS, defaultCorpusRoot, loadSource } from "./lib/source.mjs";
import { resample, resolvePixels } from "./lib/field.mjs";
import { DELIVERY_RESOLUTION, analyze, makeHierarchy, toRgb } from "./lib/hierarchy.mjs";
import { buildScheme, layoutUnits } from "./lib/schemes.mjs";
import { evaluationViews, makeDisplay, mapViews, referenceViews, renderAvailable, unitsUnderRays } from "./lib/evaluation.mjs";
import { availabilityAt, gainOrder, levelOrder, residentBytes, unitGains, viewOrder } from "./lib/ordering.mjs";
import { meanSquaredError, psnrFromMse, ssim } from "./lib/metrics.mjs";
import { codecVersions } from "./lib/codecs.mjs";
import { parseArguments, writeCsv, writeResults } from "./lib/environment.mjs";
import { defaultProcesses, isWorker, runWorkers, workerDone, workerTask } from "./lib/pool.mjs";

const KIB = 1024;
const BUDGETS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096].map(k => k * KIB);

function measure(task) {
  const { options } = task;
  const rep = representation(task.representation), N = DELIVERY_RESOLUTION[rep.id];
  const sources = CORPUS.filter(entry => options.panoramas.includes(entry.id)).map(entry => loadSource(entry, options["corpus-root"]));
  const hierarchy = makeHierarchy(rep, N), { levels, finest, base } = hierarchy;
  const tiled = layoutUnits(hierarchy, options.tile), whole = layoutUnits(hierarchy, 1 << 20);
  const viewport = { size: options.size, fov: options.fov, supersample: options.supersample };
  const views = evaluationViews();
  const mapped = mapViews(rep, views, viewport);
  // The view a half turn away, looking as far below the horizon as this one looks above.
  const opposite = mapViews(rep, views.map(view => ({ ...view, yaw: view.yaw + 180, pitch: -view.pitch })), viewport);
  const fields = resample(rep, N, sources);
  const perPixel = options.supersample ** 2;
  const linear = new Float32Array(options.size * options.size * perPixel * 3), pixels = new Uint8Array(options.size * options.size * 3);
  const rows = [];

  sources.forEach((source, p) => {
    const analysis = analyze(hierarchy, fields[p].rgb);
    const references = referenceViews(source, mapped, viewport), oppositeReferences = referenceViews(source, opposite, viewport);
    function score(display, set, refs, v, available, level = -1) {
      renderAvailable(display, set[v].mapping, available, linear, level);
      resolvePixels(linear, perPixel, pixels);
      const mse = meanSquaredError(pixels, refs[v]);
      return { psnr: psnrFromMse(mse), ssim: ssim(pixels, refs[v], options.size, options.size) };
    }
    const mean = (set, refs, display, available, level) => {
      let psnr = 0, structural = 0;
      for (let v = 0; v < set.length; v++) { const s = score(display, set, refs, v, available, level); psnr += s.psnr; structural += s.ssim; }
      return { viewPsnr: psnr / set.length, viewSsim: structural / set.length };
    };

    // Yardsticks: the uncompressed full resolution, and the uncompressed coarse sphere.
    const exact = { tile: options.tile, grids: tiled.grids, units: tiled.units, images: levels.map((level, l) => (l >= base ? toRgb(analysis.values[l], level.count) : null)) };
    const exactDisplay = makeDisplay(hierarchy, exact);
    const common = { panorama: source.id, representation: rep.id, N };
    rows.push({ ...common, scheme: "exact", order: "all", budget: null, bytes: levels[finest].count * 3, units: null, ...mean(mapped, references, exactDisplay, null, finest) });
    rows.push({ ...common, scheme: "exact", order: "coarse", budget: null, bytes: levels[base].count * 3, units: null, ...mean(mapped, references, exactDisplay, null, base) });

    const candidates = [
      [tiled, { kind: "haar-residual", delta: options.delta }],
      [tiled, { kind: "haar-residual", delta: options.delta, precision: 0.5 }],
      [tiled, { kind: "image-residual", codec: "jpeg", quality: options.quality }],
      [tiled, { kind: "image-replacement", codec: "jpeg", quality: options.quality }],
      [tiled, { kind: "image-replacement", codec: "webp", quality: options.quality }],
      // One image per chart per level: how whole-image delivery behaves in this representation.
      [whole, { kind: "image-replacement", codec: "jpeg", quality: options.quality }],
    ];
    for (const [layout, settings] of candidates) {
      const scheme = buildScheme(hierarchy, analysis, layout, settings);
      const name = layout === whole ? `${scheme.id}-whole` : scheme.id;
      const display = makeDisplay(hierarchy, scheme);
      const gains = unitGains(hierarchy, scheme, analysis);
      const total = scheme.units.reduce((sum, unit) => sum + unit.bytes, 0);
      const budgets = [...BUDGETS.filter(budget => budget < total), total];

      for (const [order, list] of [["level", levelOrder(scheme)], ["gain", gainOrder(scheme, gains)]]) {
        let previous = null;
        for (const state of availabilityAt(scheme, list, budgets)) {
          if (!previous || previous.units !== state.units) previous = { units: state.units, quality: state.units ? mean(mapped, references, display, state.available) : { viewPsnr: null, viewSsim: null } };
          rows.push({ ...common, scheme: name, order, budget: state.budget, bytes: state.bytes, units: state.units, ...previous.quality, oppositePsnr: null, residentBytes: residentBytes(hierarchy, scheme, state.available), totalBytes: total });
        }
      }
      for (const direct of scheme.residual ? [false] : [false, true]) {
        const sums = budgets.map(() => ({ bytes: 0, units: 0, psnr: 0, ssim: 0, opposite: 0, resident: 0, shown: 0 }));
        mapped.forEach(({ mapping }, v) => {
          const list = viewOrder(scheme, unitsUnderRays(hierarchy, scheme, mapping), { direct, finest });
          let previous = null;
          availabilityAt(scheme, list, budgets).forEach((state, b) => {
            if (!previous || previous.units !== state.units) {
              previous = { units: state.units };
              if (state.units) { previous.own = score(display, mapped, references, v, state.available); previous.other = score(display, opposite, oppositeReferences, v, state.available); }
            }
            const sum = sums[b];
            sum.bytes += state.bytes; sum.units += state.units; sum.resident += residentBytes(hierarchy, scheme, state.available);
            if (state.units) { sum.psnr += previous.own.psnr; sum.ssim += previous.own.ssim; sum.opposite += previous.other.psnr; sum.shown++; }
          });
        });
        budgets.forEach((budget, b) => {
          const sum = sums[b], n = mapped.length, shown = sum.shown === n;
          rows.push({
            ...common, scheme: name, order: direct ? "view-direct" : "view", budget, bytes: sum.bytes / n, units: sum.units / n,
            viewPsnr: shown ? sum.psnr / n : null, viewSsim: shown ? sum.ssim / n : null, oppositePsnr: shown ? sum.opposite / n : null,
            residentBytes: sum.resident / n, totalBytes: total,
          });
        });
      }
    }
  });
  return { rows };
}

if (isWorker) {
  workerDone(measure(workerTask()));
} else {
  const options = parseArguments({
    representations: ["equirect", "cube", "eac", "oct-ea", "toast", "healpix", "ico-rhombus"], panoramas: CORPUS.map(entry => entry.id),
    delta: 12, quality: 80, tile: 256, processes: defaultProcesses, size: 512, fov: 75, supersample: 2, "corpus-root": defaultCorpusRoot,
  });
  const results = await runWorkers(import.meta.url, options.representations.map(id => ({ representation: id, options })), { processes: options.processes, label: "representation" });
  const rows = results.flatMap(result => result.rows);
  const table = new Map();
  for (const row of rows) {
    if (![64 * KIB, 256 * KIB, 1024 * KIB].includes(row.budget) || row.viewPsnr === null) continue;
    const key = `${row.representation}|${row.scheme}|${row.order}`;
    const entry = table.get(key) ?? table.set(key, { representation: row.representation, scheme: row.scheme, order: row.order }).get(key);
    const column = `${row.budget / KIB} KiB`;
    entry[column] = (entry[column] ?? 0) + row.viewPsnr / options.panoramas.length;
  }
  console.table([...table.values()].map(entry => Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, typeof value === "number" ? Number(value.toFixed(2)) : value]))));
  console.log(writeResults("progressive", import.meta.url, {
    viewport: { size: options.size, fovDeg: options.fov, raysPerPixel: options.supersample ** 2 }, views: evaluationViews(),
    budgetsBytes: BUDGETS, tile: options.tile, delta: options.delta, quality: options.quality, requestOverheadBytes: 0, codecs: codecVersions(),
    orders: { level: "coarse sphere, then each level whole", gain: "greedy by error removed per byte", view: "units under the view first, level by level", "view-direct": "coarse sphere, then only the finest level under the view" },
  }, {}));
  console.log(writeCsv("progressive", rows));
}
