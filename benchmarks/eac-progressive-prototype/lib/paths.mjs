/** Where this benchmark reads and writes, and how a result records what made it. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { environment, repositoryRoot, sha256File } from "../../spherical-image-representation/lib/environment.mjs";

export { repositoryRoot };
export const benchmarkRoot = fileURLToPath(new URL("../", import.meta.url));
export const resultsDirectory = path.join(benchmarkRoot, "results");
export const plotsDirectory = path.join(benchmarkRoot, "plots");
export const configDirectory = path.join(benchmarkRoot, "config");
/** Gitignored: generated tiles, bundles, Chrome profiles, captures. Nothing here is source. */
export const scratchDirectory = path.join(repositoryRoot, "build/benchmarks/eac-progressive-prototype");
export const defaultDataset = path.join(scratchDirectory, "dataset");

export const readJson = file => JSON.parse(readFileSync(file, "utf8"));
export const loadConfig = (name = "default") => readJson(path.join(configDirectory, `${name}.json`));

/** Writes `results/<name>.json` with the environment, the script's hash and its configuration. */
export function writeResults(name, scriptUrl, configuration, data, { compact = false } = {}) {
  mkdirSync(resultsDirectory, { recursive: true });
  const script = fileURLToPath(scriptUrl), file = path.join(resultsDirectory, `${name}.json`);
  const body = { environment: environment(), script: { path: path.relative(repositoryRoot, script), sha256: sha256File(script) }, configuration, ...data };
  writeFileSync(file, `${compact ? JSON.stringify(body) : JSON.stringify(body, null, 1)}\n`);
  return file;
}

/** Writes `results/<name>.csv` from flat objects. */
export function writeCsv(name, rows) {
  mkdirSync(resultsDirectory, { recursive: true });
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "number" ? String(Number.isInteger(value) ? value : Number(value.toPrecision(6))) : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const file = path.join(resultsDirectory, `${name}.csv`);
  writeFileSync(file, `${columns.join(",")}\n${rows.map(row => columns.map(column => cell(row[column])).join(",")).join("\n")}\n`);
  return file;
}

/** Median, tails and spread of a list; p99 only where there are at least 100 values. */
export function statistics(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95), p99: sorted.length >= 100 ? at(0.99) : null, max: sorted.at(-1), mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length };
}
