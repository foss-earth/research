/** Paired regression evidence on a shared machine; no idle wait or absolute power claim. */
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { newOutputDirectory } from "../../lib/outputDirectory.mjs";
import { mulberry32 } from "../spherical-image-representation/lib/random.mjs";
import { quantile } from "../ai-framegen-upscale/lib/stats.mjs";
import { redact } from "./support.mjs";

const median = values => quantile(values, .5);
const permutations = [["a", "b", "control"], ["a", "control", "b"], ["b", "a", "control"],
  ["b", "control", "a"], ["control", "a", "b"], ["control", "b", "a"]];

/** Complete blocks of six balance variant position and AB/BA order. */
export function sharedSchedule(pairs = 12, seed = 1) {
  if (!Number.isInteger(pairs) || pairs < 6 || pairs > 120 || pairs % 6) throw new Error("pairs must be a multiple of 6, within 6..120");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be a uint32");
  const random = mulberry32(seed), schedule = [];
  while (schedule.length < pairs) {
    const block = [...permutations];
    for (let i = block.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [block[i], block[j]] = [block[j], block[i]]; }
    schedule.push(...block.map(order => [...order]));
  }
  return schedule;
}

function interval(values, random, resamples) {
  if (!values.length) return { median: null, low: null, high: null };
  const sampled = [];
  for (let b = 0; b < resamples; b++) sampled.push(median(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)])));
  return { median: median(values), low: quantile(sampled, .025), high: quantile(sampled, .975) };
}

export function sharedSummary(trials, { minimumPairs = 12, seed = 1, resamples = 2000, controlTolerancePercent = 10 } = {}) {
  if (!Number.isInteger(minimumPairs) || minimumPairs < 12 || !Number.isInteger(resamples) || resamples < 100 || resamples > 10000
    || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
    || !Number.isFinite(controlTolerancePercent) || controlTolerancePercent <= 0) throw new Error("Invalid shared analysis policy");
  const pairs = new Map(), reasons = [];
  for (const row of trials) {
    if (!Number.isInteger(row.pair) || row.pair < 0 || !["a", "b", "control"].includes(row.variant)) throw new Error("Invalid trial identity");
    const pair = pairs.get(row.pair) ?? {};
    if (pair[row.variant]) throw new Error("Duplicate trial identity");
    pair[row.variant] = row; pairs.set(row.pair, pair);
  }
  const complete = [], invalid = [];
  for (const [id, pair] of pairs) {
    const rows = [pair.a, pair.b, pair.control];
    if (rows.some(row => !row || row.valid !== true || !Number.isFinite(row.value) || row.value <= 0 || typeof row.digest !== "string" || !row.digest)) {
      invalid.push({ pair: id, reason: "missing-or-invalid-measurement" }); continue;
    }
    if (new Set(rows.map(row => row.digest)).size !== 1) { invalid.push({ pair: id, reason: "output-parity-failed" }); continue; }
    complete.push({ pair: id, percent: 100 * (pair.b.value - pair.a.value) / pair.a.value,
      controlPercent: 100 * (pair.control.value - pair.a.value) / pair.a.value });
  }
  const random = mulberry32(seed);
  const effect = interval(complete.map(pair => pair.percent), random, resamples);
  const control = interval(complete.map(pair => pair.controlPercent), random, resamples);
  if (complete.length < minimumPairs) reasons.push("insufficient-complete-pairs");
  if (invalid.length) reasons.push("incomplete-or-nonidentical-output-pairs");
  if (control.low === null || Math.max(Math.abs(control.low), Math.abs(control.high)) > controlTolerancePercent) reasons.push("same-build-control-too-noisy");
  if (effect.low === null || effect.low <= 0 && effect.high >= 0) reasons.push("effect-interval-includes-zero");
  const result = reasons.length ? "inconclusive" : effect.high < 0 ? "candidate-faster" : "candidate-slower";
  return { mode: "shared-machine-relative", result, reasons, completePairs: complete.length, invalidPairs: invalid,
    effectPercent: effect, sameBuildControlPercent: control, lowerIsBetter: true,
    uncertainty: { method: "seeded paired bootstrap of the median percentage change", confidence: .95, resamples, seed,
      assumption: "interleaved trial blocks are sufficiently independent; correlated background work can still confound the estimate" },
    policy: { minimumPairs, controlTolerancePercent, disturbanceExclusion: "none; all usable measurements retained" },
    absolutePowerQualified: false, w0Qualified: false };
}

/** measureA/B return {value>0,digest,disturbances?}; control calls A again. */
export async function runSharedComparison({ measureA, measureB, pairs = 12, seed = 1, maximumSeconds = 600, onTrial = () => {}, clock = performance.now.bind(performance) }) {
  if (typeof measureA !== "function" || typeof measureB !== "function" || !Number.isFinite(maximumSeconds) || maximumSeconds <= 0) throw new Error("Need two measurements and a positive time budget");
  const schedule = sharedSchedule(pairs, seed), trials = [], started = clock();
  let budgetExhausted = false;
  for (let pair = 0; pair < schedule.length; pair++) {
    // Finish an in-progress pair: do not select one side by how quickly it ran.
    if (clock() - started >= maximumSeconds * 1000) { budgetExhausted = true; break; }
    for (let position = 0; position < schedule[pair].length; position++) {
      const variant = schedule[pair][position], begin = clock();
      let measurement;
      try { measurement = await (variant === "b" ? measureB : measureA)({ pair, position, variant }); }
      catch { measurement = { valid: false, error: "measurement-failed" }; }
      // Only the benchmark contract is retained, never arbitrary module logs/settings.
      const trial = { pair, position, variant, spanMs: clock() - begin, valid: measurement?.valid !== false,
        value: measurement?.value ?? null, digest: measurement?.digest ?? null,
        disturbances: measurement?.disturbances ?? null, error: measurement?.error ? "measurement-failed" : null };
      trials.push(trial); await onTrial(trial);
    }
  }
  return { schema: 1, configuration: { pairs, seed, maximumSeconds }, budgetExhausted, trials, summary: sharedSummary(trials, { seed }) };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log("Usage: node scripts/benchmarks/earth-compare/shared.mjs --a=<baseline measurement.mjs> --b=<candidate measurement.mjs> [--pairs=12] [--seed=1] [--maximum-seconds=600]\nEach explicitly supplied module exports async measure() returning {value: elapsedMs, digest: outputDigest, disturbances?: data}. Lower values are better. Controls rerun A; no idle wait, power claim, or W0 qualification. Do not benchmark modules with irreversible side effects."); return;
  }
  const options = {};
  for (const arg of args) {
    const match = /^--(a|b|pairs|seed|maximum-seconds)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error("Unknown or duplicate shared benchmark option; use --help");
    options[match[1]] = match[2];
  }
  if (!options.a || !options.b) throw new Error("Both --a and --b measurement modules are required");
  const pairs = Number(options.pairs ?? 12), seed = Number(options.seed ?? 1), maximumSeconds = Number(options["maximum-seconds"] ?? 600);
  sharedSchedule(pairs, seed);
  if (!Number.isFinite(maximumSeconds) || maximumSeconds <= 0 || maximumSeconds > 3600) throw new Error("maximum-seconds must be 0..3600");
  const files = [options.a, options.b].map(file => realpathSync(file));
  const receipts = files.map(file => ({ file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }));
  const [a, b] = await Promise.all(files.map(file => import(pathToFileURL(file).href)));
  const directory = newOutputDirectory("benchmarks", "shared-comparison");
  const report = await runSharedComparison({ measureA: a.measure, measureB: b.measure, pairs, seed, maximumSeconds,
    onTrial: trial => writeFileSync(path.join(directory, `trial-${trial.pair}-${trial.variant}.json`), JSON.stringify(redact(trial), null, 2)) });
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(redact({ ...report, receipts }), null, 2) + "\n");
  console.log(JSON.stringify({ directory, summary: report.summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
