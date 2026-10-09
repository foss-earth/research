#!/usr/bin/env node
/**
 * Experiment 3: the hierarchy, and replacement against residual refinement.
 *
 * Each panorama is put in each representation's quadtree and cut into units
 * four ways (lib/schemes.mjs). For every scheme and level this records the
 * bytes of that level, the bytes of everything up to it, and the quality of
 * views drawn from that level alone. It also checks the transform itself:
 * that it inverts exactly, and that quantized decoding stays within the
 * error the steps allow.
 *
 *   node benchmarks/spherical-image-representation/run-hierarchy.mjs
 *     [--representations=…] [--panoramas=…] [--deltas=3,6,12,24] [--qualities=50,70,80,90]
 *     [--tile=256] [--processes=5]
 *
 * Writes results/hierarchy.csv (one row per panorama, representation, scheme
 * and level), results/hierarchy.json (transform checks, coefficient
 * statistics, compressor comparison).
 */
import { representation } from "./lib/representations.mjs";
import { CORPUS, defaultCorpusRoot, loadSource } from "./lib/source.mjs";
import { resample, resolvePixels } from "./lib/field.mjs";
import { DELIVERY_RESOLUTION, analyze, detailSteps, entropyBits, makeHierarchy, synthesizeStep, toRgb } from "./lib/hierarchy.mjs";
import { buildScheme, detailStatistics, layoutUnits } from "./lib/schemes.mjs";
import { evaluationViews, makeDisplay, mapViews, referenceViews, renderAvailable } from "./lib/evaluation.mjs";
import { meanSquaredError, psnrFromMse, ssim } from "./lib/metrics.mjs";
import { codecVersions } from "./lib/codecs.mjs";
import { parseArguments, writeCsv, writeResults } from "./lib/environment.mjs";
import { defaultProcesses, isWorker, runWorkers, workerDone, workerTask } from "./lib/pool.mjs";

function measure(task) {
  const { options } = task;
  const rep = representation(task.representation), N = DELIVERY_RESOLUTION[rep.id];
  const sources = CORPUS.filter(entry => options.panoramas.includes(entry.id)).map(entry => loadSource(entry, options["corpus-root"]));
  const hierarchy = makeHierarchy(rep, N), layout = layoutUnits(hierarchy, options.tile);
  const { levels, finest, base, charts } = hierarchy;
  const viewport = { size: options.size, fov: options.fov, supersample: options.supersample };
  const mapped = mapViews(rep, evaluationViews(), viewport);
  const fields = resample(rep, N, sources);
  const rays = options.size * options.size * options.supersample ** 2;
  const linear = new Float32Array(rays * 3), pixels = new Uint8Array(options.size * options.size * 3);
  const rows = [], transform = [], statistics = [];

  sources.forEach((source, p) => {
    const analysis = analyze(hierarchy, fields[p].rgb);
    const references = referenceViews(source, mapped, viewport);
    const exact = levels.map((level, l) => (l >= base ? toRgb(analysis.values[l], level.count) : null));

    // The transform inverts exactly.
    let rebuilt = analysis.values[0], worstInverse = 0;
    for (let l = 0; l < finest; l++) rebuilt = synthesizeStep(charts, levels[l + 1].W, levels[l + 1].H, rebuilt, analysis.details[l], levels[l + 1].areas);
    for (let i = 0; i < rebuilt.length; i++) worstInverse = Math.max(worstInverse, Math.abs(rebuilt[i] - analysis.values[finest][i]));

    function viewQuality(display, level) {
      let mse = 0, psnr = 0, structural = 0;
      mapped.forEach(({ mapping }, v) => {
        renderAvailable(display, mapping, null, linear, level);
        resolvePixels(linear, options.supersample ** 2, pixels);
        const error = meanSquaredError(pixels, references[v]);
        mse += error; psnr += psnrFromMse(error); structural += ssim(pixels, references[v], options.size, options.size);
      });
      return { viewPsnr: psnr / mapped.length, viewPsnrOfMeanMse: psnrFromMse(mse / mapped.length), viewSsim: structural / mapped.length };
    }
    function record(scheme) {
      const display = makeDisplay(hierarchy, scheme);
      let cumulative = 0;
      for (let l = base; l <= finest; l++) {
        const levelBytes = scheme.units.filter(unit => unit.level === l).reduce((sum, unit) => sum + unit.bytes, 0);
        cumulative += levelBytes;
        rows.push({
          panorama: source.id, representation: rep.id, N, scheme: scheme.id, kind: scheme.kind, parameter: scheme.delta ?? scheme.quality, codec: scheme.codec ?? "deflate",
          level: l, levelSamples: levels[l].count, units: scheme.units.filter(unit => unit.level === l).length,
          levelBytes, cumulativeBytes: cumulative,
          // Codec loss alone: the decoded level against the exact level, sample for sample.
          samplePsnr: scheme.kind === "exact" ? null : psnrFromMse(meanSquaredError(scheme.images[l], exact[l])),
          ...viewQuality(display, l),
        });
      }
    }

    // No codec: the exact pyramid, three bytes a sample.
    record({ id: "exact", kind: "exact", tile: options.tile, grids: layout.grids, images: exact, units: layout.units.map(unit => ({ ...unit, bytes: (unit.chart < 0 ? charts : 1) * (unit.x1 - unit.x0) * (unit.y1 - unit.y0) * 3 })) });

    for (const delta of options.deltas.map(Number)) {
      const residual = buildScheme(hierarchy, analysis, layout, { kind: "haar-residual", delta }, { detail: true });
      record(residual);
      record(buildScheme(hierarchy, analysis, layout, { kind: "haar-replacement", delta }));
      // The same details with steps that shrink half as fast toward the coarse levels.
      record(buildScheme(hierarchy, analysis, layout, { kind: "haar-residual", delta, precision: 0.5 }));

      // Quantized decoding stays within what the steps allow: half a step per detail, per level.
      let bound = 1 / 32;
      for (let l = 0; l < finest; l++) { const steps = detailSteps(delta, finest - l - 1, 1)[0]; bound += steps[0] / 2 + steps[2] / 2; }
      let worstLuma = 0;
      const decoded = residual.coded.decoded[finest], count = levels[finest].count;
      for (let i = 0; i < count; i++) worstLuma = Math.max(worstLuma, Math.abs(decoded[i] - analysis.values[finest][i]));
      transform.push({ panorama: source.id, representation: rep.id, delta, worstInverseError: worstInverse, worstLumaError: worstLuma, lumaErrorBound: bound, withinBound: worstLuma <= bound });

      // What the details look like, level by level, and what each compressor makes of them.
      for (let l = 0; l < finest; l++) {
        const quantized = residual.coded.quantized[l], parents = levels[l].count;
        let entropy = 0;
        for (let band = 0; band < 9; band++) entropy += entropyBits(quantized.subarray(band * parents, (band + 1) * parents));
        const units = residual.units.filter(unit => unit.level === l + 1);
        const sum = name => (l + 1 > base ? units.reduce((total, unit) => total + unit.sizes[name], 0) : null);
        statistics.push({
          panorama: source.id, representation: rep.id, delta, childLevel: l + 1, childSamples: levels[l + 1].count,
          ...flatten(detailStatistics(quantized, parents)),
          entropyBytes: entropy / 8, packedBytes: sum("raw"), deflateBytes: sum("deflate"), brotliBytes: sum("brotli"), zstdBytes: sum("zstd"),
        });
      }
    }
    for (const quality of options.qualities.map(Number)) {
      record(buildScheme(hierarchy, analysis, layout, { kind: "image-replacement", codec: "jpeg", quality }));
      record(buildScheme(hierarchy, analysis, layout, { kind: "image-residual", codec: "jpeg", quality }));
      record(buildScheme(hierarchy, analysis, layout, { kind: "image-replacement", codec: "webp", quality }));
    }
  });
  return { rows, transform, statistics, hierarchy: { representation: rep.id, N, levels: levels.map(level => ({ W: level.W, H: level.H, samples: level.count })), base, finest, units: layout.units.length } };
}

function flatten(stats) {
  const out = {};
  for (const [group, values] of Object.entries({ luma: stats.luma, chroma: stats.chroma })) for (const [key, value] of Object.entries(values)) out[`${group}${key[0].toUpperCase()}${key.slice(1)}`] = value;
  out.lumaHistogram = stats.lumaHistogram.fraction.map(value => Number(value.toPrecision(4))).join(" ");
  return out;
}

if (isWorker) {
  workerDone(measure(workerTask()));
} else {
  const options = parseArguments({
    representations: ["equirect", "cube", "eac", "oct-ea", "toast", "healpix", "ico-rhombus"], panoramas: CORPUS.map(entry => entry.id),
    deltas: ["3", "6", "12", "24"], qualities: ["50", "70", "80", "90"], tile: 256, processes: defaultProcesses,
    size: 512, fov: 75, supersample: 2, "corpus-root": defaultCorpusRoot,
  });
  const results = await runWorkers(import.meta.url, options.representations.map(id => ({ representation: id, options })), { processes: options.processes, label: "representation" });
  const rows = results.flatMap(result => result.rows);
  const finestRows = rows.filter(row => row.level === results.find(result => result.hierarchy.representation === row.representation).hierarchy.finest);
  const table = new Map();
  for (const row of finestRows) {
    const key = `${row.representation} ${row.scheme}`;
    const entry = table.get(key) ?? table.set(key, { representation: row.representation, scheme: row.scheme, kibibytes: 0, viewPsnr: 0, n: 0 }).get(key);
    entry.kibibytes += row.cumulativeBytes / 1024; entry.viewPsnr += row.viewPsnr; entry.n++;
  }
  console.table([...table.values()].map(entry => ({ representation: entry.representation, scheme: entry.scheme, "KiB to finest": Math.round(entry.kibibytes / entry.n), "view PSNR": Number((entry.viewPsnr / entry.n).toFixed(2)) })));
  const transform = results.flatMap(result => result.transform);
  console.log(`transform: worst inverse error ${Math.max(...transform.map(row => row.worstInverseError)).toExponential(2)}; quantized decoding within its bound in ${transform.filter(row => row.withinBound).length}/${transform.length} cases`);
  console.log(writeResults("hierarchy", import.meta.url, {
    viewport: { size: options.size, fovDeg: options.fov, raysPerPixel: options.supersample ** 2 }, views: evaluationViews(),
    tile: options.tile, deltas: options.deltas.map(Number), qualities: options.qualities.map(Number), chromaStepFactor: 2,
    codecs: codecVersions(),
  }, { hierarchies: results.map(result => result.hierarchy), transform, statistics: results.flatMap(result => result.statistics) }));
  console.log(writeCsv("hierarchy", rows));
}
