/**
 * Delivery schemes: ways to cut one panorama, held in one representation's
 * quadtree, into units a client fetches one at a time.
 *
 * Every scheme has the same shape. The coarse sphere (the hierarchy's base
 * level, all charts) is unit 0. Above it, each level is cut into tiles of
 * `tile` × `tile` cells per chart, one unit each. A scheme is either
 *
 * - a **replacement** pyramid: a unit holds everything needed to draw its
 *   tile at its level, and depends on nothing; or
 * - a **residual** pyramid: a unit holds only what turns its parent's cells
 *   into its own, and is useless until its parent has arrived.
 *
 * Building a scheme encodes every unit, records its size, and decodes it
 * again, so `images[l]` is what a client would hold at level l with every
 * unit of that level present. Which units a client actually has at some
 * moment is the simulator's business: it only needs sizes and these images.
 */
import zlib from "node:zlib";
import { IMAGE_CODECS } from "./codecs.mjs";
import { analyzeStep, compressedSizes, dequantizeDetail, detailSteps, entropyBits, packDetailBlock, packIntegers, quantizeAndDecode, quantizeDetail, synthesizeStep, toRgb } from "./hierarchy.mjs";

const deflate = bytes => zlib.deflateRawSync(bytes, { level: 9 }).length;

/** The tile grid of every level above the base, and the unit list without sizes. */
export function layoutUnits(hierarchy, tile) {
  const { charts, levels, finest, base } = hierarchy;
  const units = [{ index: 0, level: base, chart: -1, x0: 0, y0: 0, x1: levels[base].W, y1: levels[base].H, parent: -1 }];
  const grids = new Array(finest + 1).fill(null);
  for (let l = base + 1; l <= finest; l++) {
    const { W, H } = levels[l], tilesX = Math.ceil(W / tile), tilesY = Math.ceil(H / tile);
    const lookup = new Int32Array(charts * tilesX * tilesY);
    for (let chart = 0; chart < charts; chart++) for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tile, y0 = ty * tile;
      let parent = 0;
      if (l - 1 > base) {
        const up = grids[l - 1];
        parent = up.lookup[(chart * up.tilesY + Math.floor(y0 / 2 / tile)) * up.tilesX + Math.floor(x0 / 2 / tile)];
      }
      lookup[(chart * tilesY + ty) * tilesX + tx] = units.length;
      units.push({ index: units.length, level: l, chart, x0, y0, x1: Math.min(W, x0 + tile), y1: Math.min(H, y0 + tile), parent });
    }
    grids[l] = { tilesX, tilesY, lookup };
  }
  return { units, grids, tile };
}

/** A rectangle of one chart of a level's planar Y′CbCr values, as its own three planes. */
function extractPlanes(values, level, chart, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, out = new Float32Array(w * h * 3);
  for (let plane = 0; plane < 3; plane++) for (let y = 0; y < h; y++) {
    const from = plane * level.count + (chart * level.H + y0 + y) * level.W + x0;
    out.set(values.subarray(from, from + w), plane * w * h + y * w);
  }
  return out;
}
function insertPlanes(values, level, chart, x0, y0, x1, y1, planes) {
  const w = x1 - x0, h = y1 - y0;
  for (let plane = 0; plane < 3; plane++) for (let y = 0; y < h; y++) {
    values.set(planes.subarray(plane * w * h + y * w, plane * w * h + (y + 1) * w), plane * level.count + (chart * level.H + y0 + y) * level.W + x0);
  }
}
function extractAreas(level, chart, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const from = (chart * level.H + y0 + y) * level.W + x0;
    out.set(level.areas.subarray(from, from + w), y * w);
  }
  return out;
}

/** A rectangle of one chart of a level's RGB bytes as an image, and back. */
function extractImage(rgb, level, chart, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const from = ((chart * level.H + y0 + y) * level.W + x0) * 3;
    out.set(rgb.subarray(from, from + w * 3), y * w * 3);
  }
  return { width: w, height: h, rgb: out };
}
function insertImage(rgb, level, chart, x0, y0, image) {
  for (let y = 0; y < image.height; y++) {
    rgb.set(image.rgb.subarray(y * image.width * 3, (y + 1) * image.width * 3), ((chart * level.H + y0 + y) * level.W + x0) * 3);
  }
}
/** Every chart of a level side by side, so the coarse sphere is one image. */
function atlasImage(rgb, level, charts) {
  const out = new Uint8Array(level.count * 3);
  for (let chart = 0; chart < charts; chart++) for (let y = 0; y < level.H; y++) {
    const from = ((chart * level.H + y) * level.W) * 3;
    out.set(rgb.subarray(from, from + level.W * 3), (y * level.W * charts + chart * level.W) * 3);
  }
  return { width: level.W * charts, height: level.H, rgb: out };
}
function fromAtlas(image, level, charts, rgb) {
  for (let chart = 0; chart < charts; chart++) for (let y = 0; y < level.H; y++) {
    const from = (y * level.W * charts + chart * level.W) * 3;
    rgb.set(image.rgb.subarray(from, from + level.W * 3), ((chart * level.H + y) * level.W) * 3);
  }
  return rgb;
}

/**
 * Encodes a rectangle on its own with the Haar transform: its own pyramid down
 * to where a side becomes odd, the top of that pyramid stored in 1/16 steps.
 * Returns the packed bytes and the decoded planes.
 */
function codeAlone(planes, areas, w, h, delta, chroma) {
  const stack = [{ w, h, values: planes, areas }];
  while (stack[0].w % 2 === 0 && stack[0].h % 2 === 0) {
    const child = stack[0], pw = child.w / 2, ph = child.h / 2;
    const step = analyzeStep(1, child.w, child.h, child.values, child.areas);
    const parentAreas = new Float32Array(pw * ph);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const c = 2 * y * child.w + 2 * x;
      parentAreas[y * pw + x] = child.areas[c] + child.areas[c + 1] + child.areas[c + child.w] + child.areas[c + child.w + 1];
    }
    child.detail = step.detail;
    stack.unshift({ w: pw, h: ph, values: step.parent, areas: parentAreas });
  }
  const top = Int32Array.from(stack[0].values, value => Math.round(value * 16));
  const out = new Uint8Array((w * h * 3 + 16) * 5);
  let at = packIntegers(top, out, 0);
  let decoded = Float32Array.from(top, value => value / 16);
  for (let k = 1; k < stack.length; k++) {
    const child = stack[k], parents = stack[k - 1].w * stack[k - 1].h;
    const steps = detailSteps(delta, stack.length - 1 - k, chroma);
    const quantized = quantizeDetail(child.detail, parents, steps);
    at = packIntegers(quantized, out, at);
    decoded = synthesizeStep(1, child.w, child.h, decoded, dequantizeDetail(quantized, parents, steps), child.areas);
  }
  return { bytes: out.subarray(0, at), decoded };
}

/** Bilinear ×2 enlargement of one chart's rectangle of a level, read with the chart's edges clamped: the residual scheme's prediction. */
function predictTile(rgb, parentLevel, chart, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, out = new Uint8Array(w * h * 3), { W, H } = parentLevel;
  const base = chart * H * W * 3;
  for (let y = 0; y < h; y++) {
    const fy = (y0 + y + 0.5) / 2 - 0.5, yf = Math.floor(fy), ty = fy - yf;
    const ya = Math.max(0, yf), yb = Math.min(H - 1, yf + 1);
    for (let x = 0; x < w; x++) {
      const fx = (x0 + x + 0.5) / 2 - 0.5, xf = Math.floor(fx), tx = fx - xf;
      const xa = Math.max(0, xf), xb = Math.min(W - 1, xf + 1);
      const p00 = base + (ya * W + xa) * 3, p10 = base + (ya * W + xb) * 3, p01 = base + (yb * W + xa) * 3, p11 = base + (yb * W + xb) * 3;
      for (let c = 0; c < 3; c++) {
        out[(y * w + x) * 3 + c] = (rgb[p00 + c] * (1 - tx) + rgb[p10 + c] * tx) * (1 - ty) + (rgb[p01 + c] * (1 - tx) + rgb[p11 + c] * tx) * ty + 0.5;
      }
    }
  }
  return out;
}

/**
 * Builds a scheme for one panorama. `options`:
 *
 * - `{ kind: "haar-residual", delta, chroma, precision }`: quantized Haar details, deflated.
 * - `{ kind: "haar-replacement", delta, chroma }`: each tile Haar-coded alone
 *   with the same quantizer and compressor: the like-for-like control.
 * - `{ kind: "image-replacement", codec, quality }`: each tile a JPEG, WebP…
 * - `{ kind: "image-residual", codec, quality }`: each tile the difference from
 *   its enlarged, already-decoded parent, offset to mid-grey, as a JPEG, WebP…
 *
 * `analysis` is `analyze(hierarchy, field.rgb)`, shared between schemes.
 * `detail: true` also records each unit's size under Brotli and Zstandard and
 * its zeroth-order entropy.
 */
export function buildScheme(hierarchy, analysis, layout, options, { detail = false } = {}) {
  const { charts, levels, finest, base } = hierarchy, { tile } = layout;
  const units = layout.units.map(unit => ({ ...unit, bytes: 0 }));
  const images = new Array(finest + 1).fill(null);
  const exact = l => toRgb(analysis.values[l], levels[l].count);
  const residual = options.kind.endsWith("residual");

  if (options.kind === "haar-residual") {
    const { delta, chroma = 2, precision = 1 } = options;
    const coded = quantizeAndDecode(hierarchy, analysis, delta, { chroma, precision });
    // The coarse sphere: level 0 and every step up to the base, whole.
    const parts = [new Uint8Array(coded.base.length * 5)];
    parts[0] = parts[0].subarray(0, packIntegers(coded.base, parts[0], 0));
    for (let l = 0; l < base; l++) for (let chart = 0; chart < charts; chart++) parts.push(packDetailBlock(coded.quantized[l], levels[l], chart, 0, 0, levels[l].W, levels[l].H));
    const coarse = Buffer.concat(parts);
    units[0].bytes = deflate(coarse);
    if (detail) units[0].sizes = { raw: coarse.length, ...compressedSizes(coarse) };
    for (const unit of units.slice(1)) {
      const l = unit.level - 1, parentLevel = levels[l];
      const x0 = unit.x0 / 2, y0 = unit.y0 / 2, x1 = unit.x1 / 2, y1 = unit.y1 / 2;
      const packed = packDetailBlock(coded.quantized[l], parentLevel, unit.chart, x0, y0, x1, y1);
      unit.bytes = deflate(packed);
      // The squared error this unit removes at full resolution, by the transform's own accounting.
      const scale = 4 ** (finest - l - 1), meanArea = 4 * Math.PI / parentLevel.count;
      let gain = 0;
      for (let band = 0; band < 9; band++) {
        const step = coded.steps[l][Math.floor(band / 3)][band % 3], weight = (band % 3 === 2 ? 1 : 0.5) * scale;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const p = (unit.chart * parentLevel.H + y) * parentLevel.W + x, value = coded.quantized[l][band * parentLevel.count + p] * step;
          gain += value * value * weight * parentLevel.areas[p] / meanArea;
        }
      }
      unit.gain = gain;
      if (detail) unit.sizes = { raw: packed.length, ...compressedSizes(packed) };
    }
    for (let l = base; l <= finest; l++) images[l] = toRgb(coded.decoded[l], levels[l].count);
    return { ...options, id: `haar-residual-d${delta}${precision === 1 ? "" : `-p${precision}`}`, residual, tile, units, grids: layout.grids, images, coded };
  }

  if (options.kind === "haar-replacement") {
    const { delta, chroma = 2 } = options;
    const decodedPlanes = new Array(finest + 1);
    for (let l = base; l <= finest; l++) decodedPlanes[l] = new Float32Array(levels[l].count * 3);
    for (const unit of units) {
      const level = levels[unit.level];
      const parts = [];
      for (const chart of unit.chart < 0 ? Array.from({ length: charts }, (_, c) => c) : [unit.chart]) {
        const planes = extractPlanes(analysis.values[unit.level], level, chart, unit.x0, unit.y0, unit.x1, unit.y1);
        const coded = codeAlone(planes, extractAreas(level, chart, unit.x0, unit.y0, unit.x1, unit.y1), unit.x1 - unit.x0, unit.y1 - unit.y0, delta, chroma);
        parts.push(coded.bytes);
        insertPlanes(decodedPlanes[unit.level], level, chart, unit.x0, unit.y0, unit.x1, unit.y1, coded.decoded);
      }
      const packed = Buffer.concat(parts);
      unit.bytes = deflate(packed);
      if (detail) unit.sizes = { raw: packed.length, ...compressedSizes(packed) };
    }
    for (let l = base; l <= finest; l++) images[l] = toRgb(decodedPlanes[l], levels[l].count);
    return { ...options, id: `haar-replacement-d${delta}`, residual, tile, units, grids: layout.grids, images };
  }

  const codec = IMAGE_CODECS[options.codec];
  if (!codec) throw new Error(`unknown scheme ${JSON.stringify(options)}`);
  for (let l = base; l <= finest; l++) images[l] = new Uint8Array(levels[l].count * 3);
  // The coarse sphere is one image of every chart, the same for both kinds.
  const coarse = codec.encode(atlasImage(exact(base), levels[base], charts), options.quality);
  units[0].bytes = coarse.length;
  fromAtlas(codec.decode(coarse), levels[base], charts, images[base]);
  for (let l = base + 1; l <= finest; l++) {
    const level = levels[l], original = exact(l);
    for (const unit of units) {
      if (unit.level !== l) continue;
      const image = extractImage(original, level, unit.chart, unit.x0, unit.y0, unit.x1, unit.y1);
      if (!residual) {
        const bytes = codec.encode(image, options.quality);
        unit.bytes = bytes.length;
        insertImage(images[l], level, unit.chart, unit.x0, unit.y0, codec.decode(bytes));
      } else {
        const prediction = predictTile(images[l - 1], levels[l - 1], unit.chart, unit.x0, unit.y0, unit.x1, unit.y1);
        const difference = new Uint8Array(image.rgb.length);
        for (let i = 0; i < difference.length; i++) { const d = image.rgb[i] - prediction[i] + 128; difference[i] = d < 0 ? 0 : d > 255 ? 255 : d; }
        const bytes = codec.encode({ width: image.width, height: image.height, rgb: difference }, options.quality);
        unit.bytes = bytes.length;
        const decoded = codec.decode(bytes).rgb;
        for (let i = 0; i < decoded.length; i++) { const value = prediction[i] + decoded[i] - 128; decoded[i] = value < 0 ? 0 : value > 255 ? 255 : value; }
        insertImage(images[l], level, unit.chart, unit.x0, unit.y0, { width: image.width, height: image.height, rgb: decoded });
      }
    }
  }
  return { ...options, id: `${options.codec}-${residual ? "residual" : "replacement"}-q${options.quality}`, residual, tile, units, grids: layout.grids, images };
}

/** Zeroth-order entropy and sparsity of one transition's quantized details, luma and chroma apart. */
export function detailStatistics(quantized, parents) {
  const luma = quantized.subarray(0, parents * 3), chroma = quantized.subarray(parents * 3);
  const describe = values => {
    let zero = 0, small = 0, sumAbsolute = 0, largest = 0;
    for (let i = 0; i < values.length; i++) {
      const a = Math.abs(values[i]);
      if (a === 0) zero++;
      if (a <= 1) small++;
      sumAbsolute += a; if (a > largest) largest = a;
    }
    return { coefficients: values.length, zeroFraction: zero / values.length, withinOneFraction: small / values.length, meanAbsolute: sumAbsolute / values.length, largest, entropyBitsPerCoefficient: entropyBits(values) / values.length };
  };
  const histogram = new Array(33).fill(0);
  for (let i = 0; i < luma.length; i++) histogram[Math.max(-16, Math.min(16, luma[i])) + 16]++;
  return { luma: describe(luma), chroma: describe(chroma), lumaHistogram: { from: -16, to: 16, fraction: histogram.map(count => count / luma.length) } };
}
