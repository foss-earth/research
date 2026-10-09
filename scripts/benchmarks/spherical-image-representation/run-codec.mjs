#!/usr/bin/env node
/**
 * Experiment 4: representation and codec together.
 *
 * The geometry comparison (run-reconstruction.mjs) used no compression. Here
 * each representation's charts are compressed whole, with the same codec and
 * settings for every representation, decoded again, and judged on the views
 * drawn from the decoded samples. So the question is no longer quality per
 * sample but quality per transmitted byte, and a geometry cannot win by
 * having been given a better codec.
 *
 *   node benchmarks/spherical-image-representation/run-codec.mjs
 *     [--representations=…] [--panoramas=…] [--codecs=jpeg,jpeg444,jpegjs,webp,avif] [--processes=5]
 *
 * Writes results/codec.csv: one row per panorama, representation, resolution,
 * codec and quality.
 */
import { REPRESENTATIONS, representation } from "./lib/representations.mjs";
import { CORPUS, defaultCorpusRoot, loadSource } from "./lib/source.mjs";
import { buildGutter, padField, resample, resolvePixels, sampleRays, triangleVertexMeans } from "./lib/field.mjs";
import { DELIVERY_RESOLUTION } from "./lib/hierarchy.mjs";
import { evaluationViews, mapViews, referenceViews } from "./lib/evaluation.mjs";
import { meanSquaredError, psnrFromMse, ssim } from "./lib/metrics.mjs";
import { IMAGE_CODECS, codecVersions, pngBytes } from "./lib/codecs.mjs";
import { parseArguments, writeCsv, writeResults } from "./lib/environment.mjs";
import { defaultProcesses, isWorker, runWorkers, workerDone, workerTask } from "./lib/pool.mjs";

const QUALITIES = { jpeg: [40, 60, 75, 85, 92], jpeg444: [40, 60, 75, 80, 85, 92], jpegjs: [80], webp: [40, 60, 75, 85, 92], avif: [35, 55, 75], jp2: [35, 55, 75] };
const resolutionOf = rep => DELIVERY_RESOLUTION[rep.id] ?? 512;

/** One chart as an image. A triangle-cell chart is 2W wide: each cell's lower triangle, then its upper, along the row. */
function chartImage(field, chart) {
  const { W, H, perCell, rgb } = field, bytes = W * H * perCell * 3;
  return { width: W * perCell, height: H, rgb: rgb.subarray(chart * bytes, (chart + 1) * bytes) };
}

function measure(task) {
  const { options } = task;
  const rep = representation(task.representation);
  const sources = CORPUS.filter(entry => options.panoramas.includes(entry.id)).map(entry => loadSource(entry, options["corpus-root"]));
  const viewport = { size: options.size, fov: options.fov, supersample: options.supersample };
  const mapped = mapViews(rep, evaluationViews(), viewport);
  const references = sources.map(source => referenceViews(source, mapped, viewport));
  const linear = new Float32Array(options.size * options.size * options.supersample ** 2 * 3), pixels = new Uint8Array(options.size * options.size * 3);
  const rows = [];
  for (const N of [resolutionOf(rep), resolutionOf(rep) / 2]) {
    const fields = resample(rep, N, sources), gutter = buildGutter(rep, N);
    sources.forEach((source, p) => {
      const field = fields[p];
      function quality(candidate) {
        const padded = padField(candidate, gutter), means = rep.triangleCells ? triangleVertexMeans(candidate, padded) : null;
        let psnr = 0, structural = 0;
        mapped.forEach(({ mapping }, v) => {
          sampleRays(candidate, padded, mapping, "linear", linear, means);
          resolvePixels(linear, options.supersample ** 2, pixels);
          psnr += psnrFromMse(meanSquaredError(pixels, references[p][v])); structural += ssim(pixels, references[p][v], options.size, options.size);
        });
        return { viewPsnr: psnr / mapped.length, viewSsim: structural / mapped.length };
      }
      const common = { panorama: source.id, representation: rep.id, N, samples: field.count };
      const charts = Array.from({ length: field.charts }, (_, chart) => chartImage(field, chart));
      const uncompressed = quality(field);
      rows.push({ ...common, codec: "raw", quality: null, bytes: field.count * 3, samplePsnr: null, ...uncompressed });
      if (options.png) rows.push({ ...common, codec: "png", quality: null, bytes: charts.reduce((sum, image) => sum + pngBytes(image), 0), samplePsnr: null, ...uncompressed });
      for (const name of options.codecs) {
        const codec = IMAGE_CODECS[name];
        for (const level of QUALITIES[name]) {
          const decoded = { ...field, rgb: new Uint8Array(field.rgb.length) };
          let bytes = 0;
          charts.forEach((image, chart) => {
            const encoded = codec.encode(image, level);
            bytes += encoded.length;
            decoded.rgb.set(codec.decode(encoded).rgb, chart * image.rgb.length);
          });
          rows.push({ ...common, codec: name, quality: level, bytes, samplePsnr: psnrFromMse(meanSquaredError(decoded.rgb, field.rgb)), ...quality(decoded) });
        }
      }
    });
  }
  for (const row of rows) row.bitsPerSample = row.bytes * 8 / row.samples;
  return { rows };
}

if (isWorker) {
  workerDone(measure(workerTask()));
} else {
  const options = parseArguments({
    representations: REPRESENTATIONS.map(rep => rep.id), panoramas: CORPUS.map(entry => entry.id), codecs: ["jpeg", "jpeg444", "jpegjs", "webp", "avif"],
    png: true, processes: defaultProcesses, size: 512, fov: 75, supersample: 2, "corpus-root": defaultCorpusRoot,
  });
  const results = await runWorkers(import.meta.url, options.representations.map(id => ({ representation: id, options })), { processes: options.processes, label: "representation" });
  const rows = results.flatMap(result => result.rows);
  const table = new Map();
  for (const row of rows) {
    const key = `${row.representation}|${row.N}|${row.codec}|${row.quality}`;
    const entry = table.get(key) ?? table.set(key, { representation: row.representation, N: row.N, codec: row.codec, quality: row.quality, kibibytes: 0, viewPsnr: 0, n: 0 }).get(key);
    entry.kibibytes += row.bytes / 1024; entry.viewPsnr += row.viewPsnr; entry.n++;
  }
  console.table([...table.values()].filter(entry => ["raw", "png"].includes(entry.codec) || entry.quality === 75).map(entry => ({ representation: entry.representation, N: entry.N, codec: entry.codec, quality: entry.quality, KiB: Math.round(entry.kibibytes / entry.n), "view PSNR": Number((entry.viewPsnr / entry.n).toFixed(2)) })));
  console.log(writeResults("codec", import.meta.url, {
    viewport: { size: options.size, fovDeg: options.fov, raysPerPixel: options.supersample ** 2 }, views: evaluationViews(), qualities: QUALITIES,
    resolutions: Object.fromEntries(options.representations.map(id => [id, [resolutionOf(representation(id)), resolutionOf(representation(id)) / 2]])),
    layout: "each chart compressed as one image; triangle cells as a 2W × H image, each cell's lower triangle then its upper along the row",
    codecs: codecVersions(),
    settings: { jpeg: "cjpeg -quality q -optimize -sample 2x2", jpeg444: "cjpeg -quality q -optimize -sample 1x1", jpegjs: "jpeg-js as scripts/prepare-panorama.mjs calls it: 4:4:4, standard Huffman tables", webp: "cwebp -q q -m 4", avif: "sips -s format avif -s formatOptions q", png: "scripts/lib/panoramaImage.mjs encodePng" },
  }, {}));
  console.log(writeCsv("codec", rows));
}
