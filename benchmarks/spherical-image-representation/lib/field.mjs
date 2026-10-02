/**
 * A panorama held in a representation: 8-bit sRGB samples, one per cell (two
 * for triangle cells), and the two operations every experiment needs.
 *
 * - `resample`: source → samples. Each sample is the mean of its cell, taken
 *   in linear light from 16 taps spread over the cell (24 over a hexagon),
 *   read from the source pyramid level whose texels match the tap spacing. The
 *   same rule for every representation.
 * - `sampleView`: samples → colours along rays, by nearest sample or by the
 *   lattice's own linear interpolation (bilinear in a chart; barycentric
 *   between centroids for triangle cells), in linear light.
 *
 * Interpolation across chart edges reads a one-cell border around each chart,
 * filled from the neighbouring chart. `buildGutter` finds the neighbour the
 * same way for every representation, by reflecting through the edge on the
 * sphere, so no representation gets a hand-written seam rule.
 */
import { sampleCount } from "./representations.mjs";
import { TO_LINEAR, encodeSrgb, levelForPitch, tapLinear } from "./source.mjs";

const TAU = 2 * Math.PI;

/** Local positions of the 16 taps in a unit right triangle (corner at the origin): the centroids of its 16 sub-triangles. */
const TRIANGLE_TAPS = (() => {
  const taps = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i + j < 4; i++) {
    taps.push([(i + 1 / 3) / 4, (j + 1 / 3) / 4]);
    if (i + j < 3) taps.push([(i + 2 / 3) / 4, (j + 2 / 3) / 4]);
  }
  return taps;
})();
const QUAD_TAPS = (() => {
  const taps = [];
  for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) taps.push([(a + 0.5) / 4, (b + 0.5) / 4]);
  return taps;
})();

/**
 * Taps over the hexagon around a sample of a triangular lattice, as offsets from the sample in
 * chart cells: the centroids of 24 equal triangles. The hexagon's corners are the centroids of
 * the six lattice triangles around the sample.
 */
const HEXAGON_TAPS = (() => {
  const corners = [[1 / 3, 1 / 3], [-1 / 3, 2 / 3], [-2 / 3, 1 / 3], [-1 / 3, -1 / 3], [1 / 3, -2 / 3], [2 / 3, -1 / 3]];
  const taps = [];
  for (let k = 0; k < 6; k++) {
    const o = [0, 0], a = corners[k], b = corners[(k + 1) % 6];
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const oa = mid(o, a), ab = mid(a, b), bo = mid(b, o);
    for (const [p, q, r] of [[o, oa, bo], [a, ab, oa], [b, bo, ab], [oa, ab, bo]]) taps.push([(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3]);
  }
  return taps;
})();

export function fieldShape(rep, N) {
  const W = rep.chartWidth(N), H = rep.chartHeight(N), perCell = rep.triangleCells ? 2 : 1;
  return { W, H, perCell, charts: rep.charts, count: sampleCount(rep, N) };
}

/**
 * Resamples every source into `rep` at resolution N. Returns one
 * `{ rep, N, W, H, perCell, charts, count, rgb }` per source, `rgb` being sRGB
 * bytes indexed `((chart·H + j)·W + i)·perCell + k`.
 */
export function resample(rep, N, sources) {
  const shape = fieldShape(rep, N);
  const { W, H, perCell, charts, count } = shape;
  const fields = sources.map(() => ({ rep, N, ...shape, rgb: new Uint8Array(count * 3) }));
  // Taps are a quarter of the mean sample pitch apart.
  const pitch = Math.sqrt(4 * Math.PI / count) / 4;
  const levels = sources.map(source => source.levels[levelForPitch(source, pitch)]);
  const out = [0, 0, 0];
  let above = new Float64Array((W + 1) * 3), below = new Float64Array((W + 1) * 3);
  const cornerRow = (chart, j, row) => {
    for (let i = 0; i <= W; i++) { rep.toDir(chart, i / W, j / H, out); row[i * 3] = out[0]; row[i * 3 + 1] = out[1]; row[i * 3 + 2] = out[2]; }
  };
  const sums = new Float64Array(sources.length * 3);
  const planar = Boolean(rep.recursive), hexagon = Boolean(rep.hexagonCells);
  const tapCount = hexagon ? HEXAGON_TAPS.length : 16;
  for (let chart = 0; chart < charts; chart++) {
    cornerRow(chart, 0, above);
    for (let j = 0; j < H; j++) {
      cornerRow(chart, j + 1, below);
      for (let i = 0; i < W; i++) {
        const a = i * 3, b = a + 3;
        for (let k = 0; k < perCell; k++) {
          sums.fill(0);
          const taps = hexagon ? HEXAGON_TAPS : perCell === 2 ? TRIANGLE_TAPS : QUAD_TAPS;
          for (let tap = 0; tap < taps.length; tap++) {
            let s = taps[tap][0], t = taps[tap][1];
            let w00, w10, w01, w11;
            if (hexagon) {
              // The hexagon reaches into the neighbouring cells: extend the cell's own plane, from
              // its centre (the middle of the P10–P01 diagonal) along its two edge directions.
              w10 = 0.5 + s; w01 = 0.5 + t; w00 = -(s + t) / 2; w11 = (s + t) / 2;
              w10 -= w11; w01 -= w11;
            } else if (perCell === 2) {
              // A triangle is flat: barycentric from its own three corners.
              if (k === 0) { w00 = 1 - s - t; w10 = s; w01 = t; w11 = 0; }
              else { w11 = 1 - s - t; w01 = s; w10 = t; w00 = 0; }
            } else if (planar) {
              // A recursive cell is two flat triangles meeting on the P10–P01 diagonal.
              if (s + t <= 1) { w00 = 1 - s - t; w10 = s; w01 = t; w11 = 0; }
              else { w11 = s + t - 1; w01 = 1 - s; w10 = 1 - t; w00 = 0; }
            } else { w00 = (1 - s) * (1 - t); w10 = s * (1 - t); w01 = (1 - s) * t; w11 = s * t; }
            const x = w00 * above[a] + w10 * above[b] + w01 * below[a] + w11 * below[b];
            const y = w00 * above[a + 1] + w10 * above[b + 1] + w01 * below[a + 1] + w11 * below[b + 1];
            const z = w00 * above[a + 2] + w10 * above[b + 2] + w01 * below[a + 2] + w11 * below[b + 2];
            const u = 0.5 + Math.atan2(x, y) / TAU;
            const v = 0.5 - Math.asin(z / Math.sqrt(x * x + y * y + z * z)) / Math.PI;
            for (let p = 0; p < sources.length; p++) tapLinear(levels[p], u, v, sums, p * 3);
          }
          const at = (((chart * H + j) * W + i) * perCell + k) * 3;
          for (let p = 0; p < sources.length; p++) {
            const rgb = fields[p].rgb;
            rgb[at] = encodeSrgb(sums[p * 3] / tapCount); rgb[at + 1] = encodeSrgb(sums[p * 3 + 1] / tapCount); rgb[at + 2] = encodeSrgb(sums[p * 3 + 2] / tapCount);
          }
        }
      }
      const swap = above; above = below; below = swap;
    }
  }
  return fields;
}

/**
 * For every border cell just outside a chart, the sample that lies there on
 * the sphere. The border position is reflected through the nearest point of
 * the chart's edge: the mirror image, inside the chart, is rotated half a turn
 * about that edge point, which lands in the neighbouring cell. Returns
 * `Int32Array` pairs (padded sample index, source sample index).
 */
export function buildGutter(rep, N) {
  const { W, H, perCell, charts } = fieldShape(rep, N);
  const pairs = [];
  const edge = [0, 0, 0], inside = [0, 0, 0], place = [0, 0, 0];
  for (let chart = 0; chart < charts; chart++) {
    for (let j = -1; j <= H; j++) for (let i = -1; i <= W; i++) {
      if (i >= 0 && i < W && j >= 0 && j < H) continue;
      for (let k = 0; k < perCell; k++) {
        const offset = perCell === 2 ? (k === 0 ? 1 / 3 : 2 / 3) : 0.5;
        const gu = (i + offset) / W, gv = (j + offset) / H;
        const bu = Math.min(1, Math.max(0, gu)), bv = Math.min(1, Math.max(0, gv));
        rep.toDir(chart, bu, bv, edge);
        rep.toDir(chart, 2 * bu - gu, 2 * bv - gv, inside);
        const dot = 2 * (edge[0] * inside[0] + edge[1] * inside[1] + edge[2] * inside[2]);
        rep.fromDir(dot * edge[0] - inside[0], dot * edge[1] - inside[1], dot * edge[2] - inside[2], place);
        const x = place[1] * W, y = place[2] * H;
        const ci = Math.min(W - 1, Math.floor(x)), cj = Math.min(H - 1, Math.floor(y));
        const ck = perCell === 2 && (x - ci) + (y - cj) > 1 ? 1 : 0;
        pairs.push(((chart * (H + 2) + j + 1) * (W + 2) + i + 1) * perCell + k, ((place[0] * H + cj) * W + ci) * perCell + ck);
      }
    }
  }
  return Int32Array.from(pairs);
}

/** The field's samples with a one-cell border around every chart, as sRGB bytes. */
export function padField(field, gutter) {
  const { W, H, perCell, charts, rgb } = field;
  const padded = new Uint8Array(charts * (W + 2) * (H + 2) * perCell * 3);
  const rowBytes = W * perCell * 3;
  for (let chart = 0; chart < charts; chart++) for (let j = 0; j < H; j++) {
    const from = (chart * H + j) * rowBytes;
    padded.set(rgb.subarray(from, from + rowBytes), ((chart * (H + 2) + j + 1) * (W + 2) + 1) * perCell * 3);
  }
  for (let g = 0; g < gutter.length; g += 2) {
    const to = gutter[g] * 3, from = gutter[g + 1] * 3;
    padded[to] = rgb[from]; padded[to + 1] = rgb[from + 1]; padded[to + 2] = rgb[from + 2];
  }
  return padded;
}

/**
 * For triangle cells: at every lattice vertex of every chart, the mean of the
 * six triangles around it, in linear light. The linear reconstruction
 * interpolates between two centroids and this mean.
 */
export function triangleVertexMeans(field, padded) {
  const { W, H, charts } = field;
  const means = new Float32Array(charts * (W + 1) * (H + 1) * 3);
  const sample = (chart, i, j, k) => (((chart * (H + 2) + j + 1) * (W + 2) + i + 1) * 2 + k) * 3;
  for (let chart = 0; chart < charts; chart++) for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) {
    const around = [sample(chart, i, j, 0), sample(chart, i - 1, j, 1), sample(chart, i - 1, j, 0), sample(chart, i - 1, j - 1, 1), sample(chart, i, j - 1, 0), sample(chart, i, j - 1, 1)];
    const at = ((chart * (H + 1) + j) * (W + 1) + i) * 3;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (const p of around) sum += TO_LINEAR[padded[p + c]];
      means[at + c] = sum / 6;
    }
  }
  return means;
}

/** Chart positions of a set of unit rays: `{ chart: Uint8Array, u: Float32Array, v: Float32Array }`. */
export function mapRays(rep, rays) {
  const count = rays.length / 3;
  const chart = new Uint8Array(count), u = new Float32Array(count), v = new Float32Array(count);
  const place = [0, 0, 0];
  for (let r = 0; r < count; r++) {
    rep.fromDir(rays[r * 3], rays[r * 3 + 1], rays[r * 3 + 2], place);
    chart[r] = place[0]; u[r] = place[1]; v[r] = place[2];
  }
  return { chart, u, v, count };
}

/**
 * Colours along mapped rays, in linear light, written to `out` (Float32, 3 per
 * ray). `filter` is "nearest" or "linear". `field` supplies the shape,
 * `padded` the bordered samples, `vertexMeans` the triangle-cell means.
 */
export function sampleRays(field, padded, mapping, filter, out, vertexMeans = null) {
  const { W, H, perCell } = field;
  const { chart, u, v, count } = mapping;
  const row = (W + 2) * perCell * 3, chartBytes = (H + 2) * row;
  if (field.rep.hexagonCells) {
    // The lattice's own triangles: the cell-centre grid split along the P10–P01 direction.
    const nearest = filter === "nearest";
    for (let r = 0; r < count; r++) {
      const fx = u[r] * W - 0.5, fy = v[r] * H - 0.5;
      const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
      const p = chart[r] * chartBytes + (j + 1) * row + (i + 1) * 3, q = p + row;
      let a, b, c, wa, wb, wc;
      if (tx + ty <= 1) { a = p; b = p + 3; c = q; wa = 1 - tx - ty; wb = tx; wc = ty; }
      else { a = q + 3; b = q; c = p + 3; wa = tx + ty - 1; wb = 1 - tx; wc = 1 - ty; }
      if (nearest) { if (wa >= wb && wa >= wc) { wa = 1; wb = 0; wc = 0; } else if (wb >= wc) { wa = 0; wb = 1; wc = 0; } else { wa = 0; wb = 0; wc = 1; } }
      out[r * 3] = TO_LINEAR[padded[a]] * wa + TO_LINEAR[padded[b]] * wb + TO_LINEAR[padded[c]] * wc;
      out[r * 3 + 1] = TO_LINEAR[padded[a + 1]] * wa + TO_LINEAR[padded[b + 1]] * wb + TO_LINEAR[padded[c + 1]] * wc;
      out[r * 3 + 2] = TO_LINEAR[padded[a + 2]] * wa + TO_LINEAR[padded[b + 2]] * wb + TO_LINEAR[padded[c + 2]] * wc;
    }
  } else if (perCell === 1 && filter === "nearest") {
    for (let r = 0; r < count; r++) {
      const i = Math.min(W - 1, Math.floor(u[r] * W)), j = Math.min(H - 1, Math.floor(v[r] * H));
      const p = chart[r] * chartBytes + (j + 1) * row + (i + 1) * 3;
      out[r * 3] = TO_LINEAR[padded[p]]; out[r * 3 + 1] = TO_LINEAR[padded[p + 1]]; out[r * 3 + 2] = TO_LINEAR[padded[p + 2]];
    }
  } else if (perCell === 1) {
    for (let r = 0; r < count; r++) {
      const fx = u[r] * W - 0.5, fy = v[r] * H - 0.5;
      const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
      const p = chart[r] * chartBytes + (j + 1) * row + (i + 1) * 3, q = p + row;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      out[r * 3] = TO_LINEAR[padded[p]] * w00 + TO_LINEAR[padded[p + 3]] * w10 + TO_LINEAR[padded[q]] * w01 + TO_LINEAR[padded[q + 3]] * w11;
      out[r * 3 + 1] = TO_LINEAR[padded[p + 1]] * w00 + TO_LINEAR[padded[p + 4]] * w10 + TO_LINEAR[padded[q + 1]] * w01 + TO_LINEAR[padded[q + 4]] * w11;
      out[r * 3 + 2] = TO_LINEAR[padded[p + 2]] * w00 + TO_LINEAR[padded[p + 5]] * w10 + TO_LINEAR[padded[q + 2]] * w01 + TO_LINEAR[padded[q + 5]] * w11;
    }
  } else if (filter === "nearest") {
    for (let r = 0; r < count; r++) {
      const x = u[r] * W, y = v[r] * H;
      const i = Math.min(W - 1, Math.floor(x)), j = Math.min(H - 1, Math.floor(y));
      const p = chart[r] * chartBytes + (j + 1) * row + (i + 1) * 6 + ((x - i) + (y - j) > 1 ? 3 : 0);
      out[r * 3] = TO_LINEAR[padded[p]]; out[r * 3 + 1] = TO_LINEAR[padded[p + 1]]; out[r * 3 + 2] = TO_LINEAR[padded[p + 2]];
    }
  } else {
    const vertexRow = (W + 1) * 3, vertexChart = (H + 1) * vertexRow;
    for (let r = 0; r < count; r++) {
      const x = u[r] * W, y = v[r] * H;
      const i = Math.min(W - 1, Math.floor(x)), j = Math.min(H - 1, Math.floor(y));
      let s = x - i, t = y - j;
      const upper = s + t > 1;
      if (upper) { s = 1 - s; t = 1 - t; }
      // In the triangle's own frame its corner A is the origin, B is (1, 0), C is (0, 1) and its
      // centroid is (⅓, ⅓). The nearest edge names the neighbouring triangle; the nearer end of
      // that edge names the vertex.
      const a = 1 - s - t;
      const cell = chart[r] * chartBytes + (j + 1) * row + (i + 1) * 6;
      const own = cell + (upper ? 3 : 0);
      // Steps to the neighbouring cell and vertex are mirrored for an upper triangle.
      const stepI = upper ? 6 : -6, stepJ = upper ? row : -row;
      const vertexBase = chart[r] * vertexChart + (upper ? (j + 1) * vertexRow + (i + 1) * 3 : j * vertexRow + i * 3);
      const vertexI = upper ? -3 : 3, vertexJ = upper ? -vertexRow : vertexRow;
      let other, gx, gy, vertex, vx, vy;
      if (a <= s && a <= t) { other = cell + (upper ? 0 : 3); gx = 2 / 3; gy = 2 / 3; if (s >= t) { vertex = vertexBase + vertexI; vx = 1; vy = 0; } else { vertex = vertexBase + vertexJ; vx = 0; vy = 1; } }
      else if (t <= s) { other = cell + stepJ + (upper ? 0 : 3); gx = 2 / 3; gy = -1 / 3; if (a >= s) { vertex = vertexBase; vx = 0; vy = 0; } else { vertex = vertexBase + vertexI; vx = 1; vy = 0; } }
      else { other = cell + stepI + (upper ? 0 : 3); gx = -1 / 3; gy = 2 / 3; if (a >= t) { vertex = vertexBase; vx = 0; vy = 0; } else { vertex = vertexBase + vertexJ; vx = 0; vy = 1; } }
      // p = V + α (G − V) + β (G′ − V), G the own centroid and G′ the neighbour's.
      const ax = 1 / 3 - vx, ay = 1 / 3 - vy, bx = gx - vx, by = gy - vy, px = s - vx, py = t - vy;
      const det = ax * by - ay * bx;
      let alpha = (px * by - py * bx) / det, beta = (ax * py - ay * px) / det;
      if (alpha < 0) alpha = 0;
      if (beta < 0) beta = 0;
      let rest = 1 - alpha - beta;
      if (rest < 0) { const scale = 1 / (alpha + beta); alpha *= scale; beta *= scale; rest = 0; }
      out[r * 3] = TO_LINEAR[padded[own]] * alpha + TO_LINEAR[padded[other]] * beta + vertexMeans[vertex] * rest;
      out[r * 3 + 1] = TO_LINEAR[padded[own + 1]] * alpha + TO_LINEAR[padded[other + 1]] * beta + vertexMeans[vertex + 1] * rest;
      out[r * 3 + 2] = TO_LINEAR[padded[own + 2]] * alpha + TO_LINEAR[padded[other + 2]] * beta + vertexMeans[vertex + 2] * rest;
    }
  }
}

/** Averages `perPixel` consecutive rays into each pixel and encodes to sRGB bytes. */
export function resolvePixels(linear, perPixel, out) {
  const pixels = linear.length / 3 / perPixel;
  for (let p = 0; p < pixels; p++) {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < perPixel; k++) { const at = (p * perPixel + k) * 3; r += linear[at]; g += linear[at + 1]; b += linear[at + 2]; }
    out[p * 3] = encodeSrgb(r / perPixel); out[p * 3 + 1] = encodeSrgb(g / perPixel); out[p * 3 + 2] = encodeSrgb(b / perPixel);
  }
  return out;
}
