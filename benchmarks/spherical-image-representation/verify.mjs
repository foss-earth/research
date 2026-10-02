#!/usr/bin/env node
/**
 * Numerical checks of the benchmark's own mathematics, so that a result is
 * not an artefact of a wrong map. Run before trusting any other script here:
 *
 *   node benchmarks/spherical-image-representation/verify.mjs
 *
 * Checks, per representation: the chart map and its inverse agree both ways;
 * the cells cover the sphere exactly once (their areas sum to 4π); the
 * representations that claim equal area have it; and the border around each
 * chart is filled from true neighbours. HEALPix is compared with the
 * @hscmap/healpix package, pixel for pixel, when that package is installed
 * (`npm install --prefix build/tools/healpix @hscmap/healpix`). Then the
 * transform (it inverts, and quantized decoding stays within its bound) and
 * the image metrics.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { REPRESENTATIONS, representation } from "./lib/representations.mjs";
import { measureCells, summarizeCells } from "./lib/geometry.mjs";
import { mulberry32, randomDirection } from "./lib/random.mjs";
import { buildGutter, fieldShape } from "./lib/field.mjs";
import { analyze, makeHierarchy, quantizeAndDecode, synthesizeStep } from "./lib/hierarchy.mjs";
import { psnr, ssim } from "./lib/metrics.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const failures = [];
const rows = [];
function check(name, value, limit, detail = "") {
  const ok = value <= limit;
  rows.push({ check: name, value: Number(value.toPrecision(4)), limit, ok: ok ? "ok" : "FAIL", detail });
  if (!ok) failures.push(name);
}

const angle = (a, b) => {
  const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
};

for (const rep of REPRESENTATIONS) {
  const random = mulberry32(20261001);
  const dir = [0, 0, 0], back = [0, 0, 0], place = [0, 0, 0], again = [0, 0, 0];
  let worstDirection = 0, worstChart = 0, worstNorm = 0;
  for (let i = 0; i < 200000; i++) {
    // Direction → chart → direction.
    randomDirection(random, dir);
    rep.fromDir(dir[0], dir[1], dir[2], place);
    if (!(place[0] >= 0 && place[0] < rep.charts && place[1] >= 0 && place[1] <= 1 && place[2] >= 0 && place[2] <= 1)) worstDirection = Infinity;
    rep.toDir(place[0], place[1], place[2], back);
    worstDirection = Math.max(worstDirection, angle(dir, back));
    worstNorm = Math.max(worstNorm, Math.abs(Math.hypot(back[0], back[1], back[2]) - 1));
    // Chart → direction → chart, compared as directions because a point on a chart edge belongs to two charts.
    const chart = Math.floor(random() * rep.charts), u = random(), v = random();
    rep.toDir(chart, u, v, dir);
    rep.fromDir(dir[0], dir[1], dir[2], place);
    rep.toDir(place[0], place[1], place[2], again);
    worstDirection = Math.max(worstDirection, angle(dir, again));
    if (place[0] === chart) worstChart = Math.max(worstChart, Math.abs(place[1] - u), Math.abs(place[2] - v));
  }
  // The recursive maps stop at a flat leaf 2^-16 of a root wide; the closed forms are exact to rounding.
  check(`${rep.id}: direction round trip (rad)`, worstDirection, rep.recursive ? 1e-9 : 1e-9);
  check(`${rep.id}: chart round trip (chart units)`, worstChart, rep.id === "equirect" ? 1e-6 : 1e-7, rep.id === "equirect" ? "longitude is ill-conditioned at the poles" : "");
  check(`${rep.id}: unit length`, worstNorm, 1e-12);

  for (const N of rep.recursive ? [8, 32] : [7, 32]) {
    const summary = summarizeCells(measureCells(rep, N, { subdivide: 8 }));
    // Edges that are not great circles are approximated by 8 chords per cell side.
    check(`${rep.id} N=${N}: cell areas sum to the sphere`, Math.abs(summary.totalAreaOverSphere - 1), ["cube", "toast", "ico-rhombus", "ico-tri"].includes(rep.id) ? 1e-12 : 2e-4);
  }
}

// Equal area, where it is claimed: every cell's solid angle is 4π / samples.
for (const id of ["healpix", "oct-ea", "qsc"]) {
  const rep = representation(id);
  for (const [N, subdivide] of [[16, 4], [16, 16], [16, 64]]) {
    const cells = measureCells(rep, N, { subdivide });
    let low = Infinity, high = 0;
    for (const a of cells.area) { low = Math.min(low, a); high = Math.max(high, a); }
    // The error is the chord approximation of curved cell edges: it must fall as 1/subdivide².
    check(`${id} N=${N}: max/min cell area − 1, ${subdivide} chords per side`, high / low - 1, 0.4 / subdivide ** 2);
  }
}

// HEALPix against an independent implementation.
const healpixModule = `${root}build/tools/healpix/node_modules/@hscmap/healpix/lib/index.js`;
if (existsSync(healpixModule)) {
  const library = createRequire(import.meta.url)(healpixModule);
  const rep = representation("healpix");
  const random = mulberry32(7);
  const dir = [0, 0, 0], place = [0, 0, 0], centre = [0, 0, 0];
  for (const nside of [1, 2, 4, 16, 256, 4096]) {
    let mismatches = 0, worstCentre = 0;
    for (let i = 0; i < 200000; i++) {
      randomDirection(random, dir);
      rep.fromDir(dir[0], dir[1], dir[2], place);
      const x = Math.min(nside - 1, Math.floor(place[1] * nside)), y = Math.min(nside - 1, Math.floor(place[2] * nside));
      const mine = library.fxy2nest(nside, place[0], x, y), theirs = library.vec2pix_nest(nside, dir);
      if (mine !== theirs) mismatches++;
      rep.toDir(place[0], (x + 0.5) / nside, (y + 0.5) / nside, centre);
      worstCentre = Math.max(worstCentre, angle(centre, library.pix2vec_nest(nside, theirs)));
    }
    check(`healpix nside=${nside}: pixels that differ from @hscmap/healpix, of 200000`, mismatches, 0);
    check(`healpix nside=${nside}: pixel centre against @hscmap/healpix (rad)`, mismatches ? 0 : worstCentre, 1e-12);
  }
} else {
  rows.push({ check: "healpix against @hscmap/healpix", value: NaN, limit: 0, ok: "SKIPPED", detail: "package not installed in build/tools/healpix" });
}

// Chart borders: every border cell must be filled from a sample that really is its neighbour on the sphere.
for (const rep of REPRESENTATIONS) {
  const N = rep.recursive ? 16 : 12, { W, H, perCell, charts } = fieldShape(rep, N);
  const gutter = buildGutter(rep, N), pitch = Math.sqrt(4 * Math.PI / (charts * W * H * perCell));
  const a = [0, 0, 0], b = [0, 0, 0];
  const centre = (index, out) => {
    const k = index % perCell, cell = Math.floor(index / perCell), i = cell % W, j = Math.floor(cell / W) % H, chart = Math.floor(cell / (W * H));
    const offset = perCell === 2 ? (k === 0 ? 1 / 3 : 2 / 3) : 0.5;
    rep.toDir(chart, (i + offset) / W, (j + offset) / H, out);
  };
  let worst = 0;
  for (let g = 0; g < gutter.length; g += 2) {
    // The inside cell this border cell sits beside, and the sample chosen for the border.
    const padded = gutter[g], k = padded % perCell, cell = Math.floor(padded / perCell), pi = cell % (W + 2) - 1, pj = Math.floor(cell / (W + 2)) % (H + 2) - 1, chart = Math.floor(cell / ((W + 2) * (H + 2)));
    const i = Math.min(W - 1, Math.max(0, pi)), j = Math.min(H - 1, Math.max(0, pj));
    centre(((chart * H + j) * W + i) * perCell + k, a);
    centre(gutter[g + 1], b);
    worst = Math.max(worst, angle(a, b) / pitch);
  }
  // A neighbour is about one sample pitch away; the most stretched cells here are under three.
  check(`${rep.id}: border cells' samples, sample pitches from the cell beside them`, worst, rep.id === "equirect" ? 2 : 3.2);
}
{
  // Equirectangular's borders are known exactly: the row beyond a pole is the first row half a turn round, and the sides wrap.
  // The four corner cells are left out: the general rule reflects through the chart's corner, which here is the pole
  // itself, and lands one column from the exact neighbour, on a cell that is a sliver at the pole.
  const rep = representation("equirect"), N = 8, { W, H } = fieldShape(rep, N), gutter = buildGutter(rep, N);
  let wrong = 0;
  for (let g = 0; g < gutter.length; g += 2) {
    const pi = gutter[g] % (W + 2) - 1, pj = Math.floor(gutter[g] / (W + 2)) - 1;
    if ((pi < 0 || pi >= W) && (pj < 0 || pj >= H)) continue;
    const i = ((pj < 0 || pj >= H ? pi + W / 2 : pi) % W + W) % W, j = Math.min(H - 1, Math.max(0, pj));
    if (gutter[g + 1] !== j * W + i) wrong++;
  }
  check("equirect: border cells, corners aside, that are not the wrapped or pole-crossing neighbour", wrong, 0);
}

// The transform: analysis then synthesis gives back the input, and quantized decoding stays inside its bound.
for (const id of ["cube", "healpix", "equirect", "ico-rhombus"]) {
  const rep = representation(id), N = 32, hierarchy = makeHierarchy(rep, N, { baseSamples: 200 }), { levels, finest, charts } = hierarchy;
  const random = mulberry32(5), rgb = Uint8Array.from({ length: levels[finest].count * 3 }, () => Math.floor(random() * 256));
  const analysis = analyze(hierarchy, rgb);
  let rebuilt = analysis.values[0];
  for (let l = 0; l < finest; l++) rebuilt = synthesizeStep(charts, levels[l + 1].W, levels[l + 1].H, rebuilt, analysis.details[l], levels[l + 1].areas);
  let worst = 0;
  for (let i = 0; i < rebuilt.length; i++) worst = Math.max(worst, Math.abs(rebuilt[i] - analysis.values[finest][i]));
  check(`${id}: Haar analysis then synthesis, worst error on random data (byte units)`, worst, 1e-3);
  // A parent is the area-weighted mean of its children: so the top level is the area-weighted mean of the image.
  let total = 0, weight = 0;
  for (let i = 0; i < levels[finest].count; i++) { total += analysis.values[finest][i] * levels[finest].areas[i]; weight += levels[finest].areas[i]; }
  let top = 0, topWeight = 0;
  for (let i = 0; i < levels[0].count; i++) { top += analysis.values[0][i] * levels[0].areas[i]; topWeight += levels[0].areas[i]; }
  check(`${id}: coarsest level's weighted mean against the image's (byte units)`, Math.abs(top / topWeight - total / weight), 1e-3);
  const coded = quantizeAndDecode(hierarchy, analysis, 8, { chroma: 1 });
  let bound = 1 / 32, worstCoded = 0;
  for (let l = 0; l < finest; l++) bound += coded.steps[l][0][0] / 2 + coded.steps[l][0][2] / 2;
  for (let i = 0; i < coded.decoded[finest].length; i++) worstCoded = Math.max(worstCoded, Math.abs(coded.decoded[finest][i] - analysis.values[finest][i]));
  check(`${id}: quantized decoding, worst error ÷ the bound its steps give`, worstCoded / bound, 1);
}

// The image metrics obey their identities.
{
  const random = mulberry32(11), size = 64;
  const image = Uint8Array.from({ length: size * size * 3 }, (_, i) => Math.floor(128 + 100 * Math.sin(i / 37) * random()));
  const noisy = image.map(value => Math.max(0, Math.min(255, value + Math.round((random() - 0.5) * 40))));
  check("SSIM of an image with itself, distance from 1", Math.abs(ssim(image, image, size, size) - 1), 1e-12);
  check("SSIM is symmetric", Math.abs(ssim(image, noisy, size, size) - ssim(noisy, image, size, size)), 1e-12);
  check("SSIM falls with noise (must be below 0.99)", ssim(image, noisy, size, size), 0.99);
  check("PSNR of an image with itself is capped at 100 dB, distance", Math.abs(psnr(image, image) - 100), 0);
  const shifted = image.map(value => Math.min(255, value + 1));
  let changed = 0;
  for (let i = 0; i < image.length; i++) changed += (shifted[i] - image[i]) ** 2;
  check("PSNR against its definition, dB", Math.abs(psnr(image, shifted) - 10 * Math.log10(255 * 255 / (changed / image.length))), 1e-9);
}

console.table(rows);
if (failures.length) {
  console.error(`${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else console.log("All checks passed.");
