#!/usr/bin/env node
/**
 * Experiment 2: viewport quality for a given number of spherical samples.
 *
 * Each source panorama is resampled into each representation at several
 * resolutions, with no compression. Perspective views are then rebuilt from
 * the samples and compared with the same views taken straight from the
 * source. Identical source, prefilter, precision (8-bit sRGB), camera and
 * reconstruction rule for every representation.
 *
 *   node benchmarks/spherical-image-representation/run-reconstruction.mjs
 *     [--representations=…] [--targets=75000,300000,1200000,4800000] [--processes=5]
 *     [--size=512] [--fov=75] [--supersample=3] [--corpus-root=…]
 *
 * Writes results/reconstruction.csv (one row per panorama, representation,
 * resolution, filter and view) and results/reconstruction.json (the means).
 */
import { REPRESENTATIONS, representation, resolutionFor, sampleCount } from "./lib/representations.mjs";
import { CORPUS, defaultCorpusRoot, loadSource } from "./lib/source.mjs";
import { buildGutter, mapRays, padField, resample, resolvePixels, sampleRays, triangleVertexMeans } from "./lib/field.mjs";
import { contentViews, sampleSource, standardViews, viewRays } from "./lib/views.mjs";
import { meanSquaredError, psnrFromMse, ssim } from "./lib/metrics.mjs";
import { parseArguments, writeCsv, writeResults } from "./lib/environment.mjs";
import { defaultProcesses, isWorker, runWorkers, workerDone, workerTask } from "./lib/pool.mjs";

// The recursive representations exist only at powers of two, so they get every level in range.
const RECURSIVE_LEVELS = { toast: [256, 512, 1024, 2048], "ico-rhombus": [64, 128, 256, 512, 1024], "ico-hex": [64, 128, 256, 512, 1024], "ico-tri": [64, 128, 256, 512] };

function resolutionsFor(rep, targets) {
  return RECURSIVE_LEVELS[rep.id] ?? [...new Set(targets.map(target => resolutionFor(rep, target)))];
}

function measure(task) {
  const { options } = task;
  const rep = representation(task.representation);
  const sources = CORPUS.filter(entry => options.panoramas.includes(entry.id)).map(entry => loadSource(entry, options["corpus-root"]));
  const { size, fov, supersample } = options;
  const perPixel = supersample * supersample;
  const shared = standardViews();
  const rows = [];

  const levels = resolutionsFor(rep, options.targets.map(Number)).map(N => {
    const fields = resample(rep, N, sources);
    const gutter = buildGutter(rep, N);
    return fields.map(field => {
      const padded = padField(field, gutter);
      return { field, padded, vertexMeans: rep.triangleCells ? triangleVertexMeans(field, padded) : null };
    });
  });

  const reference = new Float32Array(size * size * perPixel * 3), candidate = new Float32Array(size * size * perPixel * 3);
  const referencePixels = new Uint8Array(size * size * 3), candidatePixels = new Uint8Array(size * size * 3);
  function compare(view, mapping, rays, sourceIndex) {
    resolvePixels(sampleSource(sources[sourceIndex], rays, reference), perPixel, referencePixels);
    for (const level of levels) {
      const { field, padded, vertexMeans } = level[sourceIndex];
      for (const filter of ["nearest", "linear"]) {
        sampleRays(field, padded, mapping, filter, candidate, vertexMeans);
        resolvePixels(candidate, perPixel, candidatePixels);
        const mse = meanSquaredError(candidatePixels, referencePixels);
        rows.push({
          panorama: sources[sourceIndex].id, representation: rep.id, N: field.N, samples: field.count, filter,
          view: view.id, group: view.group, mse, psnr: psnrFromMse(mse), ssim: ssim(candidatePixels, referencePixels, size, size),
        });
      }
    }
  }
  for (const view of shared) {
    const rays = viewRays(view, size, fov, supersample), mapping = mapRays(rep, rays);
    for (let p = 0; p < sources.length; p++) compare(view, mapping, rays, p);
  }
  // The busiest and smoothest views differ per panorama.
  sources.forEach((source, p) => {
    for (const view of contentViews(source, fov)) {
      const rays = viewRays(view, size, fov, supersample);
      compare(view, mapRays(rep, rays), rays, p);
    }
  });
  return { rows, sources: sources.map(source => ({ id: source.id, panorama: source.panorama, sha256: source.sha256, width: source.width, height: source.height, content: source.content })) };
}

if (isWorker) {
  await workerDone(measure(workerTask()));
} else {
  const options = parseArguments({
    representations: REPRESENTATIONS.map(rep => rep.id), targets: ["75000", "300000", "1200000", "4800000"],
    panoramas: CORPUS.map(entry => entry.id), processes: defaultProcesses, size: 512, fov: 75, supersample: 3, "corpus-root": defaultCorpusRoot,
  });
  const results = await runWorkers(import.meta.url, options.representations.map(id => ({ representation: id, options })), { processes: options.processes, label: "representation" });
  const rows = results.flatMap(result => result.rows);

  // Means over views: of all views, and of each group.
  const groups = new Map();
  for (const row of rows) {
    for (const group of ["all", row.group]) {
      for (const panorama of ["all", row.panorama]) {
        const key = [row.representation, row.N, row.filter, panorama, group].join("|");
        let entry = groups.get(key);
        if (!entry) groups.set(key, entry = { representation: row.representation, N: row.N, samples: row.samples, filter: row.filter, panorama, group, views: 0, psnr: 0, mse: 0, ssim: 0 });
        entry.views++; entry.psnr += row.psnr; entry.mse += row.mse; entry.ssim += row.ssim;
      }
    }
  }
  const summary = [...groups.values()].map(entry => ({
    ...entry, psnr: entry.psnr / entry.views, psnrOfMeanMse: psnrFromMse(entry.mse / entry.views), mse: entry.mse / entry.views, ssim: entry.ssim / entry.views,
  }));
  const overall = summary.filter(entry => entry.panorama === "all" && entry.group === "all" && entry.filter === "linear");
  console.table(overall.map(entry => ({ representation: entry.representation, N: entry.N, samples: entry.samples, psnr: Number(entry.psnr.toFixed(2)), ssim: Number(entry.ssim.toFixed(4)) })));
  const { size, fov, supersample } = options;
  console.log(writeResults("reconstruction", import.meta.url, {
    viewport: { size, fovDeg: fov, raysPerPixel: supersample * supersample, pixelPitchDegAtCentre: 2 * Math.tan(fov * Math.PI / 360) / size * 180 / Math.PI },
    targets: options.targets.map(Number),
    resolutions: Object.fromEntries(options.representations.map(id => [id, resolutionsFor(representation(id), options.targets.map(Number)).map(N => ({ N, samples: sampleCount(representation(id), N) }))])),
    views: standardViews(),
    precision: "8-bit sRGB per channel for samples and for views",
    prefilter: "mean of 16 linear-light taps per cell, from the source pyramid level matching the tap spacing",
    filters: { nearest: "the cell containing the ray", linear: "bilinear in the chart; for hexagon cells, barycentric between the three nearest samples; for triangle cells, barycentric between two centroids and the mean around a vertex" },
  }, { sources: results[0].sources, summary }));
  console.log(writeCsv("reconstruction", rows));
}
