/** What a result was produced with: commit, runtime, machine. Written into every results file. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const benchmarkRoot = fileURLToPath(new URL("../", import.meta.url));
/**
 * Where results are written and read back. `--results=<folder>` on any script
 * points it elsewhere, so a trial run can be kept apart from the results the
 * report cites.
 */
const resultsOverride = process.argv.find(argument => argument.startsWith("--results="))?.slice("--results=".length);
export const resultsDirectory = resultsOverride ? path.resolve(resultsOverride) : path.join(benchmarkRoot, "results");
export const plotsDirectory = path.join(benchmarkRoot, "plots");
/** Gitignored scratch: decoded sources, encoded tiles, logs. */
export const scratchDirectory = path.join(repositoryRoot, "build/benchmarks/spherical-image-representation");

function run(command, args, cwd = repositoryRoot) {
  try { return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

export function environment() {
  return {
    generatedAt: new Date().toISOString(),
    commit: run("git", ["rev-parse", "HEAD"]),
    // The benchmark is written against an uncommitted tree; its own files are hashed below.
    workingTreeDirty: (run("git", ["status", "--porcelain"]) ?? "") !== "",
    node: process.version, v8: process.versions.v8,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    os: run("sw_vers", ["-productVersion"]),
    cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30),
  };
}

export const sha256 = data => createHash("sha256").update(data).digest("hex");
export const sha256File = file => sha256(readFileSync(file));

/** Writes `results/<name>.json` with the environment, the script's own hash and its configuration. */
export function writeResults(name, scriptUrl, configuration, data) {
  mkdirSync(resultsDirectory, { recursive: true });
  const script = fileURLToPath(scriptUrl);
  const file = path.join(resultsDirectory, `${name}.json`);
  writeFileSync(file, `${JSON.stringify({
    environment: environment(),
    script: { path: path.relative(repositoryRoot, script), sha256: sha256File(script) },
    configuration, ...data,
  }, null, 1)}\n`);
  return file;
}

/** Writes `results/<name>.json` as it is, compactly: for bulky series that need no provenance of their own. */
export function writeJson(name, data) {
  mkdirSync(resultsDirectory, { recursive: true });
  const file = path.join(resultsDirectory, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(data)}\n`);
  return file;
}

/** Writes `results/<name>.csv` from an array of flat objects. */
export function writeCsv(name, rows) {
  mkdirSync(resultsDirectory, { recursive: true });
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "number" ? String(Number.isInteger(value) ? value : Number(value.toPrecision(7))) : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const file = path.join(resultsDirectory, `${name}.csv`);
  writeFileSync(file, `${columns.join(",")}\n${rows.map(row => columns.map(column => cell(row[column])).join(",")).join("\n")}\n`);
  return file;
}

export function parseArguments(defaults) {
  const options = { ...defaults };
  for (const argument of process.argv.slice(2)) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`unexpected argument ${argument}`);
    if (match[1] === "results") continue; // read above, for every script
    if (!(match[1] in defaults)) throw new Error(`unknown option --${match[1]}; known: ${Object.keys(defaults).map(key => `--${key}`).join(" ")}`);
    const value = match[2] ?? "true", kind = typeof defaults[match[1]];
    options[match[1]] = kind === "number" ? Number(value) : kind === "boolean" ? value !== "false" : Array.isArray(defaults[match[1]]) ? value.split(",") : value;
  }
  return options;
}
