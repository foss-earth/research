/** Reading results back and the few derived quantities the plots and the report share. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resultsDirectory } from "./environment.mjs";
import { parseCsv } from "./svg.mjs";

export const readCsv = name => (existsSync(path.join(resultsDirectory, `${name}.csv`)) ? parseCsv(readFileSync(path.join(resultsDirectory, `${name}.csv`), "utf8")) : null);
export const readJson = name => (existsSync(path.join(resultsDirectory, `${name}.json`)) ? JSON.parse(readFileSync(path.join(resultsDirectory, `${name}.json`), "utf8")) : null);

/** Short names for charts and tables. */
export const NAMES = {
  equirect: "Equirectangular", cube: "Cubemap", eac: "Equi-angular cube", qsc: "QSC cube", oct: "Octahedral (L1)", "oct-ea": "Octahedral equal-area",
  toast: "TOAST", healpix: "HEALPix", "ico-rhombus": "Icosahedral rhombus", "ico-hex": "Icosahedral hexagon", "ico-tri": "Icosahedral triangle",
};
export const ORDER = Object.keys(NAMES);

/**
 * One colour per representation wherever it appears. Equirectangular, the
 * control, is the quiet grey. Seven have a palette slot; the three that appear
 * only beside their own family share the last slot and are always labelled.
 */
export const SLOT = { equirect: "quiet", cube: 1, eac: 2, healpix: 3, "oct-ea": 4, toast: 5, "ico-rhombus": 6, "ico-hex": 7, qsc: 8, oct: 8, "ico-tri": 8 };

export function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) { const k = typeof key === "function" ? key(row) : row[key]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(row); }
  return groups;
}
export const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

/** y at x on a curve of [x, y] points, linear in log x between its neighbours; null outside the curve. */
export function atLogX(points, x) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  if (x < sorted[0][0] || x > sorted.at(-1)[0]) return null;
  for (let i = 1; i < sorted.length; i++) {
    if (x <= sorted[i][0]) {
      const t = (Math.log(x) - Math.log(sorted[i - 1][0])) / (Math.log(sorted[i][0]) - Math.log(sorted[i - 1][0]));
      return sorted[i - 1][1] + t * (sorted[i][1] - sorted[i - 1][1]);
    }
  }
  return sorted.at(-1)[1];
}

/** x at which a rising curve of [x, y] points reaches y, linear in log x; null if it never does. */
export function logXAt(points, y) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++) {
    const [x0, y0] = sorted[i - 1], [x1, y1] = sorted[i];
    if ((y0 <= y && y <= y1) || (y1 <= y && y <= y0)) {
      if (y1 === y0) return x0;
      return Math.exp(Math.log(x0) + (y - y0) / (y1 - y0) * (Math.log(x1) - Math.log(x0)));
    }
  }
  return null;
}

/** The upper edge of a cloud of [x, y] points: those no other point beats in both fewer x and more y. */
export function upperEnvelope(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || b[1] - a[1]), kept = [];
  for (const point of sorted) if (!kept.length || point[1] > kept.at(-1)[1]) kept.push(point);
  return kept;
}

export const kib = bytes => bytes / 1024;
export const formatSamples = value => (value >= 1e6 ? `${Number((value / 1e6).toPrecision(2))}M` : `${Math.round(value / 1e3)}k`);

/**
 * From rows of one delivery (one panorama, representation, scheme and order,
 * one row per byte budget): the row in force after `budget` bytes, which is
 * the one with the largest budget not above it. A delivery that needs fewer
 * bytes than the budget has finished, and its last row stands.
 */
export function stateAt(rows, budget) {
  let best = null;
  for (const row of rows) if (row.budget <= budget && (!best || row.budget > best.budget)) best = row;
  return best;
}
