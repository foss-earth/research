/**
 * Where the ai-framegen-upscale node scripts write, and what every results
 * file says it was produced with: research commit, runtime, machine, power
 * state, browser and GPU (supplied by the caller), the script's own hash and
 * the hashes of every file of this benchmark (the tree is uncommitted while it
 * is developed, so a commit alone does not identify the code).
 *
 *   import { runDirectory, environment, writeResults, writeCsv } from "./lib/environment.mjs";
 *   const run = runDirectory("timing");              // build/benchmarks/ai-framegen-upscale/timing/<stamp>/
 *   const env = await environment({ browser, gpu });  // capture at the start of a run
 *   await writeResults(run.results, "timing-rife-4.25-lite-720p", import.meta.url, configuration, { environment: env, blocks });
 *
 * Only task-relevant machine facts are recorded (docs/validation/benchmark-interference.md):
 * no host name, account name, serial number, other applications or environment dump.
 * `pmset -g` names applications that hold power assertions, so only the keys
 * parsed below are kept, never its text.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { newOutputDirectory } from "../../../lib/outputDirectory.mjs";
import { buildRoot, outputPath, repositoryRoot, resultOverride } from "../../../lib/researchPaths.mjs";

export { buildRoot, repositoryRoot };
const execFileAsync = promisify(execFile);

/** scripts/benchmarks/ai-framegen-upscale/ (with a trailing separator). */
export const benchmarkRoot = fileURLToPath(new URL("../", import.meta.url));
export const AREA = ["benchmarks", "ai-framegen-upscale"];
/** Same variable and default as export/common.py work_dir(). */
export const WORK_ENV = "FOSS_EARTH_AI_FRAMEGEN_WORK";
export const defaultWorkDirectory = path.join(buildRoot, ...AREA, "work");

/** `directory` as an absolute path, created, refused unless it stays inside research/build/ (symlinks included). */
export function insideBuild(directory) {
  const absolute = path.resolve(directory);
  if (!absolute.startsWith(buildRoot + path.sep)) throw new Error(`output must stay inside ${buildRoot}: ${absolute}`);
  const checked = outputPath(path.relative(buildRoot, absolute));
  mkdirSync(checked, { recursive: true });
  return checked;
}

/** --work, else $FOSS_EARTH_AI_FRAMEGEN_WORK, else build/benchmarks/ai-framegen-upscale/work. */
export function workDirectory(override = null) {
  return insideBuild(override || process.env[WORK_ENV] || defaultWorkDirectory);
}

/**
 * TMPDIR and tool caches under <work>/cache for child processes (the same keys
 * as export/common.py scratch_env). Only the overrides: merge with process.env.
 */
export function scratchEnvironment(work) {
  const cache = path.join(work, "cache");
  return {
    TMPDIR: path.join(cache, "tmp"), XDG_CACHE_HOME: path.join(cache, "xdg"), TORCH_HOME: path.join(cache, "torch"),
    HF_HOME: path.join(cache, "hf"), MPLCONFIGDIR: path.join(cache, "mpl"), npm_config_cache: path.join(cache, "npm"),
    UV_CACHE_DIR: path.join(cache, "uv"), PIP_CACHE_DIR: path.join(cache, "pip"),
    CLANG_MODULE_CACHE_PATH: path.join(cache, "clang-modules"), SWIFT_MODULE_CACHE_PATH: path.join(cache, "swift-modules"),
    PYTHONPYCACHEPREFIX: path.join(cache, "pycache"),
  };
}

/**
 * A new folder for one run: build/benchmarks/ai-framegen-upscale/<kind>/<YYYY-MM-DD_HHMMSS>[-N]/
 * with results/ and logs/. `--results=<dir>` (or `override`) names the results
 * folder instead; it must be inside research/build/, and logs go beside it.
 */
export function runDirectory(kind, override = resultOverride) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(kind)) throw new Error(`bad run kind ${JSON.stringify(kind)}`);
  const results = override ? insideBuild(override) : insideBuild(path.join(newOutputDirectory(...AREA, kind), "results"));
  const root = path.dirname(results);
  return { root, results, logs: insideBuild(path.join(root, "logs")) };
}

export const sha256 = data => createHash("sha256").update(data).digest("hex");
export const sha256File = file => sha256(readFileSync(file));
const toPath = location => (location instanceof URL || String(location).startsWith("file:") ? fileURLToPath(location) : path.resolve(String(location)));
/** `{ path, sha256 }` of a file, the path relative to research/ when inside it. */
export function scriptReceipt(location) {
  const file = toPath(location);
  const relative = path.relative(repositoryRoot, file);
  return { path: relative.startsWith("..") ? file : relative, sha256: sha256File(file) };
}

/**
 * sha256 of every file of this benchmark (scripts/benchmarks/ai-framegen-upscale/,
 * without __pycache__ and .DS_Store), sorted by path, and one combined hash over
 * the "path<TAB>sha256" lines.
 */
export function benchmarkSources(root = benchmarkRoot) {
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name === "__pycache__" || entry.name === ".DS_Store") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push({ path: path.relative(repositoryRoot, full), sha256: sha256File(full) });
    }
  };
  walk(root);
  return { files, combinedSha256: sha256(files.map(file => `${file.path}\t${file.sha256}\n`).join("")) };
}

function run(command, args) {
  try { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

/** Low Power Mode from `pmset -g` ("lowpowermode 0|1"), or null. */
export function parsePmset(text) {
  const match = /^\s*lowpowermode\s+(\d+)/m.exec(text ?? "");
  return match ? { lowPowerMode: Number(match[1]) === 1 } : null;
}

/**
 * Power source and battery state from `pmset -g batt`:
 * "Now drawing from 'AC Power'" / "'Battery Power'", then "80%; discharging; ...".
 * The battery's id and the time estimate are not kept.
 */
export function parsePmsetBattery(text) {
  const source = /Now drawing from '([^']+)'/.exec(text ?? "")?.[1] ?? null;
  if (source === null) return null;
  const battery = /\t?(\d+)%;\s*([^;]+);/.exec(text);
  return { source, batteryPercent: battery ? Number(battery[1]) : null, batteryState: battery ? battery[2].trim() : null };
}

/**
 * The power state now (macOS): `{ source, batteryPercent, batteryState, lowPowerMode }`,
 * or null when pmset cannot be read. Never changes any setting.
 */
export async function readPower() {
  if (process.platform !== "darwin") return null;
  try {
    const [general, battery] = await Promise.all([execFileAsync("pmset", ["-g"]), execFileAsync("pmset", ["-g", "batt"])]);
    const mode = parsePmset(general.stdout), supply = parsePmsetBattery(battery.stdout);
    if (mode === null && supply === null) return null;
    return { source: supply?.source ?? null, batteryPercent: supply?.batteryPercent ?? null, batteryState: supply?.batteryState ?? null, lowPowerMode: mode?.lowPowerMode ?? null };
  } catch { return null; }
}

/**
 * The node-side environment record. `browser` (e.g. { product, revision,
 * userAgent, flags } from CDP Browser.getVersion) and `gpu` (adapter info,
 * features, limits from the page) are whatever the caller passes; they are
 * copied as given.
 */
export async function environment({ browser = null, gpu = null, ...extra } = {}) {
  const lines = (run("sysctl", ["-n", "hw.model", "machdep.cpu.brand_string", "hw.ncpu", "hw.memsize", "hw.nperflevels"]) ?? "").split("\n");
  const levels = Number(lines[4]);
  const performanceLevels = Number.isInteger(levels) && levels > 0
    ? Array.from({ length: levels }, (_, index) => {
      const [name, logicalCpu] = (run("sysctl", ["-n", `hw.perflevel${index}.name`, `hw.perflevel${index}.logicalcpu`]) ?? "").split("\n");
      return { level: index, name: name || null, logicalCpu: Number(logicalCpu) || null };
    })
    : null;
  const status = run("git", ["-C", repositoryRoot, "status", "--porcelain"]);
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    research: { commit: run("git", ["-C", repositoryRoot, "rev-parse", "HEAD"]), workingTreeDirty: status === null ? null : status !== "" },
    node: process.version, v8: process.versions.v8,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    os: { productVersion: run("sw_vers", ["-productVersion"]), buildVersion: run("sw_vers", ["-buildVersion"]) },
    hardware: {
      model: lines[0] || null, cpu: lines[1] || os.cpus()[0]?.model || null,
      logicalCores: Number(lines[2]) || os.cpus().length, performanceLevels,
      memoryBytes: Number(lines[3]) || os.totalmem(), memoryGiB: Math.round((Number(lines[3]) || os.totalmem()) / 2 ** 30),
    },
    power: await readPower(),
    browser, gpu, ...extra,
  };
}

/**
 * JSON with two-space indentation, except that arrays of numbers, strings,
 * booleans or nulls stay on one line (per-iteration series would otherwise
 * take a line per value). NaN and infinities become null, as in JSON.stringify.
 */
export function formatJson(value) {
  const flat = item => item === null || typeof item !== "object";
  const write = (item, indent) => {
    if (item && typeof item.toJSON === "function") item = item.toJSON();
    if (Array.isArray(item)) {
      if (item.length === 0) return "[]";
      if (item.every(flat)) return `[${item.map(entry => JSON.stringify(entry ?? null) ?? "null").join(", ")}]`;
      const inner = indent + "  ";
      return `[\n${item.map(entry => inner + (write(entry, inner) ?? "null")).join(",\n")}\n${indent}]`;
    }
    if (item !== null && typeof item === "object") {
      const entries = Object.entries(item).map(([key, entry]) => [key, write(entry, indent + "  ")]).filter(([, text]) => text !== undefined);
      if (entries.length === 0) return "{}";
      const inner = indent + "  ";
      return `{\n${entries.map(([key, text]) => `${inner}${JSON.stringify(key)}: ${text}`).join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(item);
  };
  return `${write(value, "")}\n`;
}

/** Writes `text` to `file` through a sibling temporary file and a rename, so a reader never sees half a file. */
function writeAtomically(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, file);
  return file;
}

/**
 * Writes `<directory>/<name>.json`: schema, environment (`data.environment` when
 * the caller captured it at the start of the run, else captured now), the
 * script's receipt, the benchmark's source hashes, the configuration and the data.
 */
export async function writeResults(directory, name, scriptUrl, configuration, data = {}) {
  const { environment: captured, ...rest } = data;
  const file = path.join(insideBuild(directory), `${name}.json`);
  return writeAtomically(file, formatJson({
    schema: 1,
    environment: captured ?? await environment(),
    script: scriptReceipt(scriptUrl), sources: benchmarkSources(),
    configuration, ...rest,
  }));
}

/** Writes `<directory>/<name>.json` as it is, compactly: bulky series that need no provenance of their own. */
export function writeJson(directory, name, data) {
  return writeAtomically(path.join(insideBuild(directory), `${name}.json`), `${JSON.stringify(data)}\n`);
}

/** One CSV cell: numbers to 7 significant digits, quoting when needed, null/undefined/NaN empty. */
export function csvCell(value) {
  if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) return "";
  const text = typeof value === "number" ? String(Number.isInteger(value) ? value : Number(value.toPrecision(7))) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** CSV text from flat objects; the columns are the union of the rows' keys in first-seen order. */
export function toCsv(rows) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return `${columns.join(",")}\n${rows.map(row => columns.map(column => csvCell(row[column])).join(",")).join("\n")}${rows.length ? "\n" : ""}`;
}

/** Writes `<directory>/<name>.csv` from an array of flat objects. */
export function writeCsv(directory, name, rows) {
  return writeAtomically(path.join(insideBuild(directory), `${name}.csv`), toCsv(rows));
}

/**
 * `--name=value` options over `defaults` (numbers, booleans and comma lists
 * typed like their defaults). `--results` is read by researchPaths for every
 * script and skipped here.
 */
export function parseArguments(defaults, argv = process.argv.slice(2)) {
  const options = { ...defaults };
  for (const argument of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`unexpected argument ${argument}`);
    if (match[1] === "results") continue;
    if (!(match[1] in defaults)) throw new Error(`unknown option --${match[1]}; known: ${Object.keys(defaults).map(key => `--${key}`).join(" ")}`);
    const value = match[2] ?? "true", initial = defaults[match[1]];
    options[match[1]] = typeof initial === "number" ? Number(value) : typeof initial === "boolean" ? value !== "false" : Array.isArray(initial) ? value.split(",").filter(Boolean) : value;
    if (typeof initial === "number" && !Number.isFinite(options[match[1]])) throw new Error(`--${match[1]} needs a number, got ${value}`);
  }
  return options;
}
