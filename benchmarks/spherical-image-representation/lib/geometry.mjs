/**
 * Geometry of a representation's cells, measured from its chart map alone:
 * the solid angle of every cell, and the shape of the sample lattice around
 * every sample. No image is involved.
 *
 * Three properties are measured separately because none implies another:
 *
 * - **Area**: the solid angle a cell covers.
 * - **Chart stretch**: the singular values of the chart map, the angular
 *   length of one texel step along the chart's most and least stretched
 *   directions. Their ratio is the cell's aspect in the chart.
 * - **Lattice quality**: how well the samples themselves are spread. The
 *   covering radius R is the largest angle from any direction to its nearest
 *   sample, the worst-case sampling distance. `coveringExcess` is the number of
 *   samples spent per sample an ideal hexagonal lattice would need to reach the
 *   same R: 1 for hexagonal, 1.30 for square, 2 for triangle centroids.
 *   A sheared chart can hold an ideal lattice: rhombus cells have chart stretch
 *   √3 and a covering excess of 1.
 */

const SPHERE = 4 * Math.PI;
/** Area of the Voronoi cell of a hexagonal lattice with covering radius 1. */
const HEX_AREA_PER_R2 = 3 * Math.sqrt(3) / 2;

/** Solid angle of the spherical triangle between three unit vectors (Van Oosterom & Strackee 1983). */
export function triangleSolidAngle(a, ai, b, bi, c, ci) {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], bx = b[bi], by = b[bi + 1], bz = b[bi + 2], cx = c[ci], cy = c[ci + 1], cz = c[ci + 2];
  const triple = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  const denominator = 1 + ax * bx + ay * by + az * bz + bx * cx + by * cy + bz * cz + cx * ax + cy * ay + cz * az;
  return 2 * Math.atan2(Math.abs(triple), denominator);
}

function angleBetween(a, ai, b, bi) {
  const cx = a[ai + 1] * b[bi + 2] - a[ai + 2] * b[bi + 1], cy = a[ai + 2] * b[bi] - a[ai] * b[bi + 2], cz = a[ai] * b[bi + 1] - a[ai + 1] * b[bi];
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2]);
}

/**
 * The covering radius of the planar lattice spanned by two vectors given by
 * their lengths² and dot product: the circumradius of its Delaunay triangle,
 * after Gauss reduction to the shortest basis.
 */
export function latticeCoveringRadius(aa, bb, ab) {
  // Reduce: keep |a| ≤ |b| and |a·b| ≤ |a|²/2.
  for (let step = 0; step < 64; step++) {
    if (aa > bb) { const t = aa; aa = bb; bb = t; }
    const k = Math.round(ab / aa);
    if (k === 0) break;
    bb = bb - 2 * k * ab + k * k * aa;
    ab = ab - k * aa;
  }
  // Make the angle acute; the third side of the Delaunay triangle is a − b.
  const dot = Math.abs(ab);
  const cc = aa + bb - 2 * dot;
  const area2 = Math.sqrt(Math.max(0, aa * bb - dot * dot));
  return area2 > 0 ? Math.sqrt(aa * bb * cc) / (2 * area2) : Infinity;
}

/**
 * Per-cell measurements at resolution N. `subdivide` is how many pieces per
 * side a cell is cut into for its area: cell edges that are not great
 * circles converge as 1/subdivide².
 *
 * Returns typed arrays indexed by sample: `area` (sr), `major` and `minor`
 * (the chart map's singular values, radians per texel), `covering` (radians),
 * and `latitude` (radians, of the sample).
 */
export function measureCells(rep, N, { subdivide = 4 } = {}) {
  const W = rep.chartWidth(N), H = rep.chartHeight(N);
  const perCell = rep.triangleCells ? 2 : 1;
  const count = rep.charts * W * H * perCell;
  const area = new Float64Array(count), major = new Float64Array(count), minor = new Float64Array(count);
  const covering = new Float64Array(count), latitude = new Float64Array(count);
  const m = subdivide, gw = W * m + 1, gh = H * m + 1;
  const grid = new Float64Array(gw * gh * 3);
  const out = [0, 0, 0];
  const centre = new Float64Array(3), east = new Float64Array(3), west = new Float64Array(3), south = new Float64Array(3), north = new Float64Array(3);
  const at = (target, chart, u, v) => { rep.toDir(chart, u, v, out); target[0] = out[0]; target[1] = out[1]; target[2] = out[2]; };
  let index = 0;
  for (let chart = 0; chart < rep.charts; chart++) {
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      rep.toDir(chart, gx / (W * m), gy / (H * m), out);
      grid.set(out, (gy * gw + gx) * 3);
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      // Area: the sub-quads, each as two triangles split along the P10–P01 diagonal, which is the
      // true edge between the two triangles of a recursive cell.
      let lower = 0, upper = 0;
      for (let sj = 0; sj < m; sj++) for (let si = 0; si < m; si++) {
        const p00 = ((j * m + sj) * gw + i * m + si) * 3, p10 = p00 + 3, p01 = p00 + gw * 3, p11 = p01 + 3;
        const first = triangleSolidAngle(grid, p00, grid, p10, grid, p01), second = triangleSolidAngle(grid, p11, grid, p01, grid, p10);
        // In chart cell coordinates the sub-quad lies below the cell's diagonal when si + sj < m − 1.
        if (si + sj < m - 1) lower += first + second;
        else if (si + sj > m - 1) upper += first + second;
        else { lower += first; upper += second; }
      }
      const corner = (jj, ii) => ((j * m + jj * m) * gw + i * m + ii * m) * 3;
      if (!rep.triangleCells) {
        at(centre, chart, (i + 0.5) / W, (j + 0.5) / H);
        // The lattice basis: half a texel each way, so the differences stay inside the cell.
        at(east, chart, (i + 1) / W, (j + 0.5) / H); at(west, chart, i / W, (j + 0.5) / H);
        at(south, chart, (i + 0.5) / W, (j + 1) / H); at(north, chart, (i + 0.5) / W, j / H);
        const ax = east[0] - west[0], ay = east[1] - west[1], az = east[2] - west[2];
        const bx = south[0] - north[0], by = south[1] - north[1], bz = south[2] - north[2];
        const aa = ax * ax + ay * ay + az * az, bb = bx * bx + by * by + bz * bz, ab = ax * bx + ay * by + az * bz;
        const mean = (aa + bb) / 2, spread = Math.sqrt(Math.max(0, ((aa - bb) / 2) ** 2 + ab * ab));
        area[index] = lower + upper;
        major[index] = Math.sqrt(mean + spread); minor[index] = Math.sqrt(Math.max(0, mean - spread));
        covering[index] = latticeCoveringRadius(aa, bb, ab);
        latitude[index] = Math.asin(Math.max(-1, Math.min(1, centre[2])));
        index++;
      } else {
        // Two triangles. Each sample is its triangle's centroid; the deepest hole of the centroid
        // set is at a lattice vertex, so the covering radius is the centroid's distance to its
        // farthest corner.
        const corners = [[corner(0, 0), corner(0, 1), corner(1, 0)], [corner(1, 1), corner(1, 0), corner(0, 1)]];
        for (let k = 0; k < 2; k++) {
          const third = k === 0 ? 1 / 3 : 2 / 3;
          at(centre, chart, (i + third) / W, (j + third) / H);
          let far = 0, near = Infinity;
          for (const c of corners[k]) { const d = angleBetween(centre, 0, grid, c); far = Math.max(far, d); near = Math.min(near, d); }
          const edges = [angleBetween(grid, corners[k][0], grid, corners[k][1]), angleBetween(grid, corners[k][1], grid, corners[k][2]), angleBetween(grid, corners[k][2], grid, corners[k][0])];
          area[index] = k === 0 ? lower : upper;
          major[index] = Math.max(...edges); minor[index] = Math.min(...edges);
          covering[index] = far;
          latitude[index] = Math.asin(Math.max(-1, Math.min(1, centre[2])));
          index++;
        }
      }
    }
  }
  return { count, area, major, minor, covering, latitude };
}

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function describe(values, weights) {
  const sorted = Float64Array.from(values).sort();
  let sum = 0, weighted = 0, weightSum = 0;
  for (let i = 0; i < values.length; i++) { sum += values[i]; weighted += values[i] * weights[i]; weightSum += weights[i]; }
  const mean = sum / values.length;
  let variance = 0;
  for (let i = 0; i < values.length; i++) variance += (values[i] - mean) ** 2;
  return {
    min: sorted[0], p01: quantile(sorted, 0.01), p05: quantile(sorted, 0.05), median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), max: sorted.at(-1),
    mean, standardDeviation: Math.sqrt(variance / values.length), areaWeightedMean: weighted / weightSum,
  };
}

function histogram(values, weights, low, high, bins) {
  const counts = new Array(bins).fill(0), weight = new Array(bins).fill(0);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const bin = Math.min(bins - 1, Math.max(0, Math.floor((values[i] - low) / (high - low) * bins)));
    counts[bin]++; weight[bin] += weights[i]; total += weights[i];
  }
  return { low, high, bins, cellFraction: counts.map(c => c / values.length), sphereFraction: weight.map(w => w / total) };
}

/**
 * Summary statistics of `measureCells`. Normalized quantities are relative to
 * the ideal: area to 4π/samples, lengths to the pitch of a square lattice of
 * that area, covering radius to that of a hexagonal lattice of that area.
 */
export function summarizeCells(cells) {
  const { count, area, major, minor, covering } = cells;
  const idealArea = SPHERE / count, pitch = Math.sqrt(idealArea);
  const idealCovering = Math.sqrt(idealArea / HEX_AREA_PER_R2);
  const relativeArea = area.map(a => a / idealArea);
  const aspect = major.map((value, i) => value / minor[i]);
  const majorPitch = major.map(value => value / pitch), minorPitch = minor.map(value => value / pitch);
  const relativeCovering = covering.map(r => r / idealCovering);
  // Samples spent here per sample of a hexagonal lattice with this covering radius.
  const coveringExcess = covering.map((r, i) => HEX_AREA_PER_R2 * r * r / area[i]);
  let totalArea = 0, worstCovering = 0, coveringSquares = 0;
  for (let i = 0; i < count; i++) {
    totalArea += area[i];
    worstCovering = Math.max(worstCovering, covering[i]);
    coveringSquares += covering[i] * covering[i] * area[i];
  }
  const hexSamplesFor = radius => SPHERE / (HEX_AREA_PER_R2 * radius * radius);
  return {
    samples: count,
    totalAreaOverSphere: totalArea / SPHERE,
    idealAreaSr: idealArea,
    area: { ...describe(relativeArea, area), maxOverMin: Math.max(...iterate(relativeArea)) / Math.min(...iterate(relativeArea)) },
    chartStretchMajor: describe(majorPitch, area),
    chartStretchMinor: describe(minorPitch, area),
    chartAspect: describe(aspect, area),
    coveringRadius: describe(relativeCovering, area),
    coveringExcess: describe(coveringExcess, area),
    // The share of the samples an ideal hexagonal lattice needs for the same worst-case, and the
    // same area-weighted RMS, sampling distance.
    efficiencyAtWorstCovering: hexSamplesFor(worstCovering) / count,
    efficiencyAtRmsCovering: hexSamplesFor(Math.sqrt(coveringSquares / totalArea)) / count,
    histograms: {
      relativeArea: histogram(relativeArea, area, 0, 2.5, 50),
      chartAspect: histogram(aspect, area, 1, 4, 60),
      coveringExcess: histogram(coveringExcess, area, 1, 4, 60),
      relativeCovering: histogram(relativeCovering, area, 0, 2.5, 50),
    },
  };
}

// Math.max(...typedArray) overflows the stack for millions of cells.
function* iterate(values) {
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < values.length; i++) { if (values[i] < low) low = values[i]; if (values[i] > high) high = values[i]; }
  yield low; yield high;
}

/** Means of the relative area and covering excess in latitude bands of equal area, for a polar-waste profile. */
export function latitudeProfile(cells, bands = 18) {
  const idealArea = SPHERE / cells.count;
  const rows = Array.from({ length: bands }, () => ({ cells: 0, area: 0, covering2: 0 }));
  for (let i = 0; i < cells.count; i++) {
    const band = Math.min(bands - 1, Math.floor((Math.sin(cells.latitude[i]) + 1) / 2 * bands));
    rows[band].cells++; rows[band].area += cells.area[i]; rows[band].covering2 += cells.covering[i] ** 2 * cells.area[i];
  }
  return rows.map((row, band) => {
    const sinLow = band / bands * 2 - 1, sinHigh = (band + 1) / bands * 2 - 1;
    return {
      latitudeFromDeg: Math.asin(sinLow) * 180 / Math.PI, latitudeToDeg: Math.asin(sinHigh) * 180 / Math.PI,
      // Samples in this band per sample a uniform distribution would put here.
      sampleDensity: row.cells / cells.count * bands,
      meanRelativeArea: row.cells ? row.area / row.cells / idealArea : null,
      rmsRelativeCovering: row.area ? Math.sqrt(row.covering2 / row.area) / Math.sqrt(idealArea / HEX_AREA_PER_R2) : null,
    };
  });
}
