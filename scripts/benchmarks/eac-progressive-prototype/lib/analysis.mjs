/** Reading result tables back, and summarising groups of runs, for make-tables.mjs and make-plots.mjs. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseCsv } from "../../spherical-image-representation/lib/svg.mjs";
import { resultsDirectory } from "./paths.mjs";

/** A results CSV as objects, numbers parsed; [] if it has not been made. */
export function readRows(name) {
  const file = path.join(resultsDirectory, `${name}.csv`);
  if (!existsSync(file)) return [];
  // parseCsv already gives numbers, strings, and null for an empty cell.
  return parseCsv(readFileSync(file, "utf8"));
}

export const median = values => {
  const list = values.filter(value => value !== null && value !== undefined && Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
};
export const geometricMean = values => { const list = values.filter(value => value > 0); return list.length ? Math.exp(list.reduce((sum, value) => sum + Math.log(value), 0) / list.length) : null; };

/**
 * A time that some runs never reached: the median counting "never" as later
 * than any time, so a run that never arrives is not dropped from the average.
 * Returns `{ value, never, n }`; value null when half or more never arrived.
 */
export function medianTime(values) {
  const n = values.length, never = values.filter(value => value === null || value === undefined).length;
  if (!n) return { value: null, never: 0, n: 0 };
  const sorted = values.map(value => (value === null || value === undefined ? Infinity : value)).sort((a, b) => a - b);
  const middle = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { value: Number.isFinite(middle) ? middle : null, never, n };
}

export function groupBy(rows, keys) {
  const groups = new Map();
  for (const row of rows) {
    const key = keys.map(k => row[k]).join("|");
    if (!groups.has(key)) groups.set(key, { key: Object.fromEntries(keys.map(k => [k, row[k]])), rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

/** Formats: seconds from milliseconds, KiB from bytes, dB. */
export const seconds = (value, digits = 2) => (value === null || value === undefined ? "never" : (value / 1000).toFixed(digits));
export const kib = value => (value === null || value === undefined ? "–" : String(Math.round(value / 1024)));
export const db = (value, digits = 1) => (value === null || value === undefined ? "–" : value.toFixed(digits));
export const timeCell = summary => (summary.value === null ? `never (${summary.never}/${summary.n})` : `${seconds(summary.value)}${summary.never ? ` (${summary.never}/${summary.n} never)` : ""}`);

/** A markdown table from a header row and rows of cells. */
export function table(header, rows, align = null) {
  const alignment = align ?? header.map((_, i) => (i === 0 ? "---" : "---:"));
  return [`| ${header.join(" | ")} |`, `| ${alignment.join(" | ")} |`, ...rows.map(row => `| ${row.join(" | ")} |`)].join("\n");
}
