/**
 * The quadtree every chart representation shares, and the simplest transform
 * that refines it: an area-weighted Haar.
 *
 * Level L is the full resolution; level l has charts of half the width and
 * height of level l + 1, as far as both stay whole. A parent cell's value is
 * the area-weighted mean of its four children, so a level is exactly the
 * image a box filter over that level's cells would give.
 *
 * The transform turns four children into their parent and three details:
 *
 *   d0 = c00 − c10          d1 = c01 − c11          (differences along a row)
 *   s0, s1 = the two rows' area-weighted means
 *   d2 = s0 − s1            parent = area-weighted mean of s0 and s1
 *
 * It is exactly invertible in real arithmetic. Details are then quantized
 * uniformly. A step is chosen per level so that one unit of error costs the
 * same at full resolution wherever it is made: a detail d levels below the
 * finest spreads over 4^d samples, so its step is 2^d times smaller. That is
 * the allocation an orthonormal Haar gives; it is not tuned further.
 */
import { BYTE_CODECS } from "./codecs.mjs";
import { triangleSolidAngle } from "./geometry.mjs";

/** Full resolutions for the delivery experiments: 2.6–4.2 million samples, each a multiple of a 256-cell tile. */
export const DELIVERY_RESOLUTION = { equirect: 1280, cube: 768, eac: 768, qsc: 768, oct: 1792, "oct-ea": 1792, toast: 2048, healpix: 512, "ico-rhombus": 512 };

/** Smallest quantization step: 8-bit sources hold nothing finer. */
const FINEST_STEP = 1 / 16;

// ─── Colour ────────────────────────────────────────────────────────────

/** sRGB bytes → JPEG's full-range Y′CbCr as three float planes. */
export function toYcc(rgb, count) {
  const ycc = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    ycc[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    ycc[count + i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    ycc[2 * count + i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return ycc;
}

export function toRgb(ycc, count, rgb = new Uint8Array(count * 3)) {
  for (let i = 0; i < count; i++) {
    const y = ycc[i], cb = ycc[count + i] - 128, cr = ycc[2 * count + i] - 128;
    const r = y + 1.402 * cr, g = y - 0.344136 * cb - 0.714136 * cr, b = y + 1.772 * cb;
    rgb[i * 3] = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0;
    rgb[i * 3 + 1] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0;
    rgb[i * 3 + 2] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
  }
  return rgb;
}

// ─── The quadtree ──────────────────────────────────────────────────────

/**
 * Solid angle of every cell at resolution N, each as two spherical triangles;
 * for an equal-area representation, the constant it is by construction.
 */
export function cellAreas(rep, N) {
  const W = rep.chartWidth(N), H = rep.chartHeight(N);
  const areas = new Float32Array(rep.charts * W * H);
  if (rep.equalArea) return areas.fill(4 * Math.PI / areas.length);
  const corners = new Float64Array((W + 1) * (H + 1) * 3), out = [0, 0, 0];
  for (let chart = 0; chart < rep.charts; chart++) {
    for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) { rep.toDir(chart, i / W, j / H, out); corners.set(out, (j * (W + 1) + i) * 3); }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const p00 = (j * (W + 1) + i) * 3, p10 = p00 + 3, p01 = p00 + (W + 1) * 3, p11 = p01 + 3;
      areas[(chart * H + j) * W + i] = triangleSolidAngle(corners, p00, corners, p10, corners, p01) + triangleSolidAngle(corners, p11, corners, p01, corners, p10);
    }
  }
  return areas;
}

/**
 * The levels of a representation at resolution N: `levels[l] = { W, H, count,
 * areas }`, `finest` = L, and `base`, the finest level with at most
 * `baseSamples` samples, which is sent whole as the coarse sphere.
 */
export function makeHierarchy(rep, N, { baseSamples = 32000 } = {}) {
  if (rep.triangleCells || rep.hexagonCells) throw new Error(`${rep.id} has no quadtree of nested cells`);
  let W = rep.chartWidth(N), H = rep.chartHeight(N), areas = cellAreas(rep, N);
  const levels = [{ W, H, count: rep.charts * W * H, areas }];
  while (W % 2 === 0 && H % 2 === 0) {
    areas = parentAreas(rep.charts, W, H, areas);
    W /= 2; H /= 2;
    levels.unshift({ W, H, count: rep.charts * W * H, areas });
  }
  let base = 0;
  for (let l = 0; l < levels.length; l++) if (levels[l].count <= baseSamples) base = l;
  return { rep, N, charts: rep.charts, levels, finest: levels.length - 1, base };
}

function parentAreas(charts, W, H, areas) {
  const w = W / 2, h = H / 2, parent = new Float32Array(charts * w * h);
  for (let chart = 0; chart < charts; chart++) for (let J = 0; J < h; J++) for (let I = 0; I < w; I++) {
    const c = (chart * H + 2 * J) * W + 2 * I;
    parent[(chart * h + J) * w + I] = areas[c] + areas[c + 1] + areas[c + W] + areas[c + W + 1];
  }
  return parent;
}

// ─── The transform ─────────────────────────────────────────────────────

/**
 * One level up: children (three planes of `charts` × W × H) → `{ parent,
 * detail }`. `detail` holds, for each plane, d0 then d1 then d2 for every
 * parent: index `(plane·3 + k)·parents + p`.
 */
export function analyzeStep(charts, W, H, child, areas) {
  const w = W / 2, h = H / 2, parents = charts * w * h, children = charts * W * H;
  const parent = new Float32Array(parents * 3), detail = new Float32Array(parents * 9);
  for (let chart = 0; chart < charts; chart++) for (let J = 0; J < h; J++) for (let I = 0; I < w; I++) {
    const c = (chart * H + 2 * J) * W + 2 * I, p = (chart * h + J) * w + I;
    const a00 = areas[c], a10 = areas[c + 1], a01 = areas[c + W], a11 = areas[c + W + 1];
    const top = a00 + a10, bottom = a01 + a11;
    for (let plane = 0; plane < 3; plane++) {
      const o = plane * children + c;
      const c00 = child[o], c10 = child[o + 1], c01 = child[o + W], c11 = child[o + W + 1];
      const s0 = (a00 * c00 + a10 * c10) / top, s1 = (a01 * c01 + a11 * c11) / bottom;
      parent[plane * parents + p] = (top * s0 + bottom * s1) / (top + bottom);
      const d = plane * 3 * parents + p;
      detail[d] = c00 - c10; detail[d + parents] = c01 - c11; detail[d + 2 * parents] = s0 - s1;
    }
  }
  return { parent, detail };
}

/** One level down: parent and detail → children. The exact inverse of `analyzeStep`. */
export function synthesizeStep(charts, W, H, parent, detail, areas) {
  const w = W / 2, h = H / 2, parents = charts * w * h, children = charts * W * H;
  const child = new Float32Array(children * 3);
  for (let chart = 0; chart < charts; chart++) for (let J = 0; J < h; J++) for (let I = 0; I < w; I++) {
    const c = (chart * H + 2 * J) * W + 2 * I, p = (chart * h + J) * w + I;
    const a00 = areas[c], a10 = areas[c + 1], a01 = areas[c + W], a11 = areas[c + W + 1];
    const top = a00 + a10, bottom = a01 + a11;
    for (let plane = 0; plane < 3; plane++) {
      const d = plane * 3 * parents + p, value = parent[plane * parents + p];
      const d0 = detail[d], d1 = detail[d + parents], d2 = detail[d + 2 * parents];
      const s0 = value + bottom / (top + bottom) * d2, s1 = value - top / (top + bottom) * d2;
      const o = plane * children + c;
      child[o] = s0 + a10 / top * d0; child[o + 1] = s0 - a00 / top * d0;
      child[o + W] = s1 + a11 / bottom * d1; child[o + W + 1] = s1 - a01 / bottom * d1;
    }
  }
  return child;
}

/**
 * Quantization steps for the details `depth` levels below the finest (0 for
 * the last refinement), as `[plane][k]`. `chroma` multiplies the Cb and Cr steps.
 * `precision` is how fast steps shrink toward the coarse levels: 1 halves the
 * step per level, the allocation that minimizes error once everything has
 * arrived; less spends fewer bytes on the coarse levels, which arrive first,
 * and leaves more error at the end.
 */
export function detailSteps(delta, depth, chroma, precision = 1) {
  const scale = 2 ** (depth * precision);
  const row = Math.max(FINEST_STEP, delta * Math.SQRT2 / scale), column = Math.max(FINEST_STEP, delta / scale);
  const coarse = [Math.max(FINEST_STEP, row * chroma), Math.max(FINEST_STEP, row * chroma), Math.max(FINEST_STEP, column * chroma)];
  return [[row, row, column], coarse, coarse];
}

/** Rounds details to their steps: `Int32Array` in the layout of `detail`. */
export function quantizeDetail(detail, parents, steps) {
  const quantized = new Int32Array(detail.length);
  for (let plane = 0; plane < 3; plane++) for (let k = 0; k < 3; k++) {
    const from = (plane * 3 + k) * parents, step = steps[plane][k];
    for (let p = 0; p < parents; p++) quantized[from + p] = Math.round(detail[from + p] / step);
  }
  return quantized;
}

export function dequantizeDetail(quantized, parents, steps) {
  const detail = new Float32Array(quantized.length);
  for (let plane = 0; plane < 3; plane++) for (let k = 0; k < 3; k++) {
    const from = (plane * 3 + k) * parents, step = steps[plane][k];
    for (let p = 0; p < parents; p++) detail[from + p] = quantized[from + p] * step;
  }
  return detail;
}

// ─── Bytes ─────────────────────────────────────────────────────────────

/**
 * Signed integers as bytes for a general-purpose compressor: zigzag, one byte
 * below 255, else an escape and 32 bits.
 */
export function packIntegers(values, out, at) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i], z = v < 0 ? -2 * v - 1 : 2 * v;
    if (z < 255) out[at++] = z;
    else { out[at++] = 255; out[at++] = z & 255; out[at++] = (z >>> 8) & 255; out[at++] = (z >>> 16) & 255; out[at++] = z >>> 24; }
  }
  return at;
}

export function unpackIntegers(bytes, at, values) {
  for (let i = 0; i < values.length; i++) {
    let z = bytes[at++];
    if (z === 255) { z = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24); at += 4; }
    values[i] = z & 1 ? -(z + 1) / 2 : z / 2;
  }
  return at;
}

/** Shannon entropy of a set of integers in bits, treating them as independent draws. */
export function entropyBits(values) {
  const counts = new Map();
  for (let i = 0; i < values.length; i++) counts.set(values[i], (counts.get(values[i]) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= count * Math.log2(count / values.length);
  return bits;
}

/** The quantized details of the parents in a rectangle of one chart, plane by plane and kind by kind, as packed bytes. */
export function packDetailBlock(quantized, level, chart, x0, y0, x1, y1) {
  const { W, H, count } = level, cells = (x1 - x0) * (y1 - y0);
  const row = new Int32Array(x1 - x0), out = new Uint8Array(cells * 9 * 5);
  let at = 0;
  for (let band = 0; band < 9; band++) for (let y = y0; y < y1; y++) {
    const from = band * count + (chart * H + y) * W + x0;
    for (let x = 0; x < row.length; x++) row[x] = quantized[from + x];
    at = packIntegers(row, out, at);
  }
  return out.subarray(0, at);
}

/** Sizes of a byte block under each general-purpose compressor. */
export function compressedSizes(bytes, codecs = Object.keys(BYTE_CODECS)) {
  return Object.fromEntries(codecs.map(name => [name, BYTE_CODECS[name](bytes).length]));
}

// ─── A whole pyramid ───────────────────────────────────────────────────

/**
 * Analyses a field (sRGB bytes at the hierarchy's finest level) into every
 * level's exact values and every transition's exact details:
 * `values[l]` for l = 0…L and `details[l]` for the step from l to l + 1.
 */
export function analyze(hierarchy, rgb) {
  const { charts, levels, finest } = hierarchy;
  const values = new Array(finest + 1), details = new Array(finest);
  values[finest] = toYcc(rgb, levels[finest].count);
  for (let l = finest - 1; l >= 0; l--) {
    const child = levels[l + 1];
    const step = analyzeStep(charts, child.W, child.H, values[l + 1], child.areas);
    values[l] = step.parent; details[l] = step.detail;
  }
  return { values, details };
}

/**
 * Quantizes an analysis with full-resolution step `delta` and rebuilds every
 * level from the quantized data, as a decoder would: `quantized[l]`,
 * `base` (level 0 in steps of 1/16) and `decoded[l]` for l = 0…L.
 * `top` is the level treated as full resolution; levels above it are left out.
 */
export function quantizeAndDecode(hierarchy, analysis, delta, { chroma = 2, precision = 1, top = hierarchy.finest } = {}) {
  const { charts, levels } = hierarchy;
  const base = Int32Array.from(analysis.values[0], value => Math.round(value / FINEST_STEP));
  const decoded = [Float32Array.from(base, value => value * FINEST_STEP)], quantized = [], steps = [];
  for (let l = 0; l < top; l++) {
    const child = levels[l + 1];
    steps[l] = detailSteps(delta, top - l - 1, chroma, precision);
    quantized[l] = quantizeDetail(analysis.details[l], levels[l].count, steps[l]);
    decoded[l + 1] = synthesizeStep(charts, child.W, child.H, decoded[l], dequantizeDetail(quantized[l], levels[l].count, steps[l]), child.areas);
  }
  return { base, quantized, steps, decoded };
}
