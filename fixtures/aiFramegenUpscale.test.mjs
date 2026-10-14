// Fixture for the ai-framegen-upscale node libraries (scripts/benchmarks/ai-framegen-upscale/lib/):
// order statistics, seeded block order, acceptance rule I on synthetic telemetry, the rule G/B/C/D/E/F/H
// gate formulas against hand-computed cases, the telemetry text parsers, and the u8/255 model-input rule
// against a hash computed by export/common.py to_model_input. Pure functions only: no browser, GPU,
// network or child processes. Run with `npm --prefix research run test:source`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  binomialHalfCdf, mean, median, medianConfidenceInterval, medianOfBlockMedians, pairedDifferences, pairedRatios,
  pairedSummary, quantile, seriesMedians, summary,
} from "../scripts/benchmarks/ai-framegen-upscale/lib/stats.mjs";
import {
  TIMING_PARAMETERS, aaCheck, acceptedRounds, againName, baseVariant, compareVariants, defaultTimingParameters,
  evaluateBlock, planRounds, qualifyVariant, resolveTimingParameters, roundOrder, stopReason,
} from "../scripts/benchmarks/ai-framegen-upscale/lib/blocks.mjs";
import {
  THRESHOLDS, checkDeviceParity, checkExportParity, checkFgQuality, checkFullPath, checkInjection, checkMemory,
  checkPlacement, checkSrQuality, combinedScreen, fgQualityEntries, fgScreen, fgScreens, srBreakEven, srQualityInput, srScreen, termBounds,
} from "../scripts/benchmarks/ai-framegen-upscale/lib/gates.mjs";
import {
  blockTelemetry, parseCpuTime, parseGpuStatistics, parseProcessTable, parseSwapUsage, pidsFromProcessInfo, processCpuDelta, sampleRecord,
} from "../scripts/benchmarks/ai-framegen-upscale/lib/telemetry.mjs";
import { csvCell, formatJson, parseArguments, parsePmset, parsePmsetBattery, toCsv } from "../scripts/benchmarks/ai-framegen-upscale/lib/environment.mjs";

const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// ─── stats ───────────────────────────────────────────────────────────────

test("quantiles are Hyndman-Fan type 7 (numpy 2.4.6 np.quantile values) and leave the input alone", () => {
  const values = [2.5, 10, 4, 1];
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  close(quantile(values, 0.05), 1.225); assert.equal(quantile(values, 0.5), 3.25); close(quantile(values, 0.95), 9.1);
  close(quantile(Array.from({ length: 10 }, (_, i) => i + 1), 0.95), 9.549999999999999);
  assert.deepEqual(values, [2.5, 10, 4, 1]);
  assert.equal(median([7, 1, 4]), 4); assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.ok(Number.isNaN(median([]))); assert.ok(Number.isNaN(mean([])));
  assert.throws(() => median([1, NaN]), /finite/); assert.throws(() => quantile([1], 1.5), /\[0, 1\]/);
  const s = summary([3, 1, 2]);
  assert.deepEqual([s.count, s.min, s.median, s.max, s.mean], [3, 1, 2, 3, 2]);
});

test("block summaries take each series' median and count missing iterations", () => {
  assert.deepEqual(seriesMedians({ modelSpanMs: [4, 2, 3], rafIntervalMs: [16.6, null, 16.8, 16.7] }), { medians: { modelSpanMs: 3, rafIntervalMs: 16.7 }, missing: { rafIntervalMs: 1 } });
  // Every block counts once, whatever its length.
  assert.equal(medianOfBlockMedians([[1, 1, 1, 1, 1, 100], [5], [7, 9]]), 5);
});

test("the binomial(n, 1/2) CDF is exact", () => {
  assert.equal(binomialHalfCdf(1, 11), 12 / 2048);
  assert.equal(binomialHalfCdf(2, 11), 67 / 2048);
  assert.equal(binomialHalfCdf(-1, 11), 0); assert.equal(binomialHalfCdf(11, 11), 1);
  assert.equal(binomialHalfCdf(16, 33), 0.5); // symmetric, odd n
});

test("the median interval uses binomial order statistics and states the confidence achieved", () => {
  // Reference ranks and coverages from exact fractions (Python fractions.Fraction, comb):
  // n = 6: k 1, 31/32; n = 11: k 2, 253/256; n = 12: k 3, 1969/2048; n = 20: k 6, 125647/131072;
  // n = 33: k 11, 2072145555/2147483648.
  const cases = [[6, 1, 31 / 32], [11, 2, 253 / 256], [12, 3, 1969 / 2048], [20, 6, 125647 / 131072], [33, 11, 2072145555 / 2147483648]];
  for (const [n, k, coverage] of cases) {
    const values = Array.from({ length: n }, (_, i) => (i * 7919) % n + 1); // 1..n shuffled
    const interval = medianConfidenceInterval(values);
    assert.deepEqual([interval.lowerRank, interval.upperRank, interval.lower, interval.upper], [k, n + 1 - k, k, n + 1 - k], `n = ${n}`);
    assert.equal(interval.achievedConfidence, coverage, `n = ${n}`);
    assert.equal(interval.meetsRequested, true);
  }
  // n = 5: even the sample range covers only 15/16 < 95 %; it is returned and says so.
  const five = medianConfidenceInterval([5, 3, 1, 2, 4]);
  assert.deepEqual([five.lower, five.upper, five.achievedConfidence, five.meetsRequested], [1, 5, 15 / 16, false]);
  assert.equal(medianConfidenceInterval([]).meetsRequested, false);
});

test("paired differences align by round and drop incomplete pairs without filling them", () => {
  assert.deepEqual(pairedDifferences([5, null, 7, 9], [1, 2, NaN, 4]), { differences: [4, 5], rounds: [0, 3], dropped: 2 });
  assert.deepEqual(pairedRatios([6, 1], [3, 0]), { ratios: [2], rounds: [0], dropped: 1 });
  assert.throws(() => pairedDifferences([1], [1, 2]), /length/);
  const paired = pairedSummary([11, 12, 13, 14, 15, 16], [10, 10, 10, 10, 10, 10]);
  assert.deepEqual([paired.pairs, paired.difference.median, paired.difference.lower, paired.difference.upper], [6, 3.5, 1, 6]);
});

// ─── blocks: parameters, order, stopping ─────────────────────────────────

test("timing parameter defaults are acceptance rule I and overrides are listed", () => {
  const defaults = defaultTimingParameters();
  assert.deepEqual(
    [defaults.blockIterations, defaults.maximumWarmupSeconds, defaults.minimumPairs, defaults.maximumPairs, defaults.maximumRunSeconds, defaults.orderSeed],
    [30, 5, 11, 33, 120, 0]);
  assert.deepEqual(
    [defaults.requiredMemoryPressureLevel, defaults.maximumSwapoutPages, defaults.maximumCompressedMiB, defaults.maximumThermalState, defaults.maximumOtherProcessCores, defaults.maximumIdleGpuUtilizationPercent, defaults.maximumAaDifferencePercent],
    [1, 0, 16, 0, 1.5, 10, 5]);
  for (const spec of Object.values(TIMING_PARAMETERS)) assert.ok(spec.unit && spec.reason && spec.default >= spec.minimum && spec.default <= spec.maximum);
  assert.deepEqual(resolveTimingParameters({ orderSeed: 7, minimumPairs: 11 }).overrides, { orderSeed: 7 });
  assert.throws(() => resolveTimingParameters({ maximumPairs: 5 }), /at least minimumPairs/);
  assert.throws(() => resolveTimingParameters({ blockIterations: 2.5 }), /integer/);
  assert.throws(() => resolveTimingParameters({ warmup: 1 }), /unknown/);
});

test("round order is a seeded shuffle of the variants plus A/A repeats, reproducible per round", () => {
  const options = { variants: ["native60", "repeat", "blend", "plumbing", "model-fp32", "model-fp16"], again: ["model-fp32", "model-fp16"], orderSeed: 0 };
  // Pinned: mulberry32(0 + 0), Fisher-Yates from the last position down.
  assert.deepEqual(roundOrder({ ...options, round: 0 }), ["model-fp32", "model-fp16-again", "plumbing", "model-fp16", "model-fp32-again", "repeat", "native60", "blend"]);
  const rounds = planRounds(4, options);
  assert.deepEqual(planRounds(4, options), rounds);
  for (const order of rounds) assert.deepEqual([...order].sort(), [...options.variants, "model-fp32-again", "model-fp16-again"].sort());
  assert.notDeepEqual(rounds[0], rounds[1]);
  // Round r uses seed orderSeed + r.
  assert.deepEqual(roundOrder({ ...options, round: 3 }), roundOrder({ ...options, orderSeed: 1, round: 2 }));
  assert.equal(againName("model-fp16"), "model-fp16-again"); assert.equal(baseVariant("model-fp16-again"), "model-fp16");
  assert.throws(() => roundOrder({ ...options, again: ["bilinear"], round: 0 }), /not among/);
});

test("the stopping rule bounds rounds and run time, not accepted pairs", () => {
  assert.equal(stopReason({ roundsStarted: 32, elapsedSeconds: 60 }), null);
  assert.equal(stopReason({ roundsStarted: 33, elapsedSeconds: 60 }), "maximumPairs");
  assert.equal(stopReason({ roundsStarted: 5, elapsedSeconds: 120 }), null); // 120 s used, nothing more projected
  assert.equal(stopReason({ roundsStarted: 5, elapsedSeconds: 120.001 }), "maximumRunSeconds");
  assert.equal(stopReason({ roundsStarted: 5, elapsedSeconds: 111, projectedRoundSeconds: 9 }), null);
  assert.equal(stopReason({ roundsStarted: 5, elapsedSeconds: 111, projectedRoundSeconds: 9.5 }), "maximumRunSeconds");
  assert.throws(() => stopReason({ roundsStarted: -1, elapsedSeconds: 0 }), /non-negative/);
});

// ─── rule I on synthetic telemetry ───────────────────────────────────────

const PAGE = 16384; // bytes per page on Apple silicon
/** A telemetry sample as telemetry.mjs sample() returns it, with synthetic values (no real process data). */
function fakeSample({ atMs = 0, pressure = 1, compressions = 50000, swapouts = 900, thermalState = 0, pressureLevel = 0, gpu = 0, input = 60, lowPowerMode = false, source = "AC Power", table = [[100, 1, 0]] } = {}) {
  return {
    schema: 1, wallClock: new Date(Date.UTC(2026, 9, 13, 6) + atMs).toISOString(), atMs, costMs: 13, componentMs: {},
    memory: { pressure, pageBytes: PAGE, compressions, swapouts, swapins: 10, compressorBytesUsed: 3e8, swapUsedBytes: 4e8 },
    thermal: { schema: 1, thermalState, thermalPressureLevel: pressureLevel, lowPowerMode },
    gpu: { deviceUtilization: gpu, rendererUtilization: gpu, tilerUtilization: 0, accelerators: 1 },
    power: { source, batteryPercent: 80, batteryState: "charging", lowPowerMode },
    secondsSinceInput: input,
    processes: { atMs, spanMs: 4, count: table.length, table: new Map(table.map(([pid, ppid, cpuMs]) => [pid, { ppid, cpuMs }])) },
    cpus: null,
  };
}
/** One 1 s block (own pid 100) whose other process (pid 500) used `otherMs` of CPU; `change` edits the after sample. */
function block({ before = {}, after = {}, otherMs = 100 } = {}) {
  const first = fakeSample({ table: [[100, 1, 0], [500, 1, 1000]], ...before });
  const second = fakeSample({ atMs: 1000, input: 61, table: [[100, 1, 900], [500, 1, 1000 + otherMs]], ...after });
  return evaluateBlock(blockTelemetry(first, second, { ownPid: 100 }));
}

test("rule I: a quiet block is undisturbed", () => {
  const verdict = block();
  assert.deepEqual([verdict.disturbed, verdict.reasons, verdict.diagnostics], [false, [], []]);
  assert.equal(verdict.values.otherProcessCores, 0.1);
});

test("rule I: memory pressure, swapouts and the 16 MiB compression boundary", () => {
  assert.deepEqual(block({ after: { pressure: 2 } }).reasons, ["memory-pressure"]);
  assert.deepEqual(block({ before: { pressure: 4 } }).reasons, ["memory-pressure"]);
  assert.deepEqual(block({ after: { swapouts: 901 } }).reasons, ["swapout"]);
  // 1024 pages of 16 KiB = exactly 16 MiB: not above the limit. One more page is.
  const exactly = block({ after: { compressions: 50000 + 1024 } });
  assert.deepEqual([exactly.disturbed, exactly.values.compressedMiB], [false, 16]);
  assert.deepEqual(block({ after: { compressions: 50000 + 1025 } }).reasons, ["compressed"]);
});

test("rule I: thermal state above nominal at either end; the pressure level alone is a diagnostic", () => {
  assert.deepEqual(block({ before: { thermalState: 1 } }).reasons, ["thermal"]);
  assert.deepEqual(block({ after: { thermalState: 2 } }).reasons, ["thermal"]);
  const pressure = block({ after: { pressureLevel: 1 } });
  assert.deepEqual([pressure.disturbed, pressure.diagnostics], [false, ["thermal-pressure-above-nominal"]]);
});

test("rule I: other-process CPU boundary at exactly 1.5 cores", () => {
  const exactly = block({ otherMs: 1500 });
  assert.deepEqual([exactly.disturbed, exactly.values.otherProcessCores], [false, 1.5]);
  assert.deepEqual(block({ otherMs: 1501 }).reasons, ["other-process-cpu"]);
});

test("rule I: GPU utilization boundary at exactly 10 % in the idle sample before the block", () => {
  assert.equal(block({ before: { gpu: 10 } }).disturbed, false);
  assert.deepEqual(block({ before: { gpu: 11 } }).reasons, ["gpu-busy-before"]);
  // The sample after the block (taken right after GPU work) is not the rule's signal.
  assert.equal(block({ after: { gpu: 95 } }).disturbed, false);
});

test("rule I: input, Low Power Mode and the power source are diagnostics only", () => {
  const verdict = block({ after: { input: 0.2, lowPowerMode: true }, before: { source: "Battery Power" } });
  assert.equal(verdict.disturbed, false);
  assert.deepEqual(verdict.diagnostics.sort(), ["input-during-block", "low-power-mode", "not-on-ac-power", "power-changed"]);
});

test("rule I: a signal that could not be read disturbs the block (missing is not zero)", () => {
  const first = fakeSample(), second = fakeSample({ atMs: 1000 });
  for (const sampled of [first, second]) { sampled.memory = null; sampled.thermal = null; sampled.processes = null; }
  first.gpu = null;
  const verdict = evaluateBlock(blockTelemetry(first, second, { ownPid: 100 }));
  assert.deepEqual(verdict.reasons, ["missing:memory", "missing:thermal", "missing:process-cpu", "missing:gpu"]);
  assert.deepEqual(evaluateBlock({}).reasons, ["missing:memory", "missing:thermal", "missing:process-cpu", "missing:gpu"]);
  const several = block({ before: { thermalState: 1, gpu: 50 }, after: { swapouts: 1000 }, otherMs: 4000 });
  assert.deepEqual(several.reasons, ["swapout", "thermal", "other-process-cpu", "gpu-busy-before"]);
});

// ─── blocks: qualification ───────────────────────────────────────────────

/** Twelve rounds of native / model-fp32 / model-fp32-again blocks with a synthetic GPU metric. */
function syntheticBlocks({ againFactor = 1.01, disturbedRounds = [5] } = {}) {
  const blocks = [];
  for (let round = 0; round < 12; round++) {
    const model = 10 + round / 100;
    blocks.push({ round, name: "native", disturbed: false, reasons: [], summary: { totalGpuMs: 8 } });
    blocks.push({ round, name: "model-fp32", disturbed: disturbedRounds.includes(round), reasons: disturbedRounds.includes(round) ? ["swapout"] : [], summary: { totalGpuMs: model } });
    blocks.push({ round, name: "model-fp32-again", disturbed: false, reasons: [], summary: { totalGpuMs: model * againFactor } });
  }
  return blocks;
}

test("a disturbed block removes its whole round from every comparison that uses it", () => {
  const { rounds, excluded } = acceptedRounds(syntheticBlocks(), ["native", "model-fp32"], "totalGpuMs");
  assert.equal(rounds.length, 11); assert.ok(!rounds.includes(5));
  assert.deepEqual(excluded, [{ round: 5, problems: [{ name: "model-fp32", reason: "disturbed: swapout" }] }]);
});

test("qualification: 11 accepted rounds, A/A within 5 %, a validated GPU timer", () => {
  const blocks = syntheticBlocks();
  const comparison = compareVariants(blocks, "model-fp32", "native", { metric: "totalGpuMs", timerValidated: true });
  assert.equal(comparison.acceptedRounds, 11); assert.equal(comparison.qualified, true);
  assert.equal(comparison.claim, "conditional observation on this machine");
  assert.equal(comparison.paired.pairs, 11);
  close(comparison.paired.difference.median, 2.06, 1e-9); // model 10.06 (round 6, the 6th of 11 accepted) - 8
  assert.equal(comparison.paired.difference.achievedConfidence, 253 / 256);
  close(comparison.aa.differencePercent, 1, 1e-9);
  assert.equal(qualifyVariant(blocks, "model-fp32", { metric: "totalGpuMs", timerValidated: true }).qualified, true);
  // Fewer than minimumPairs accepted rounds.
  const short = compareVariants(syntheticBlocks({ disturbedRounds: [1, 2] }), "model-fp32", "native", { metric: "totalGpuMs", timerValidated: true });
  assert.deepEqual([short.acceptedRounds, short.qualified], [10, false]);
  // A CPU metric or an unvalidated timer never qualifies.
  assert.equal(compareVariants(blocks, "model-fp32", "native", { metric: "totalGpuMs", metricKind: "cpu", timerValidated: true }).qualified, false);
  assert.equal(compareVariants(blocks, "model-fp32", "native", { metric: "totalGpuMs" }).qualified, false);
});

test("A/A boundary: exactly 5 % apart is within, more is not", () => {
  assert.equal(aaCheck([100, 100, 100], [105, 105, 105]).within, true);
  assert.equal(aaCheck([100, 100, 100], [94.9, 94.9, 94.9]).within, false);
  const drifting = compareVariants(syntheticBlocks({ againFactor: 1.06 }), "model-fp32", "native", { metric: "totalGpuMs", timerValidated: true });
  assert.equal(drifting.qualified, false); assert.match(drifting.reasons.join("; "), /A\/A differs by 6\.00 %/);
});

// ─── gates ───────────────────────────────────────────────────────────────

test("rule G FG: W_FG = Cin + G + Cout + 2P and R_budget = 0.8 T - W_FG, hand-computed", () => {
  // Cin 1, G 10, Cout 1, P 0.5: W_FG = 13. T = 1000/30: R_budget = 26.666... - 13 = 13.666...;
  // T = 1000/60: R_budget = 13.333... - 13 = 0.333...
  const both = fgScreens({ Cin: 1, G: 10, Cout: 1, P: 0.5, R_est: null });
  assert.equal(both["30->60"].conservative.W_FG, 13);
  close(both["30->60"].conservative.R_budget, 0.8 * 1000 / 30 - 13); close(both["30->60"].conservative.R_budget, 13.666666666666668, 1e-12);
  close(both["60->120"].conservative.R_budget, 1 / 3, 1e-12);
  assert.deepEqual([both["30->60"].verdict, both["60->120"].verdict], ["advance", "advance"]);
  assert.equal(both["60->120"].rKnown, false); assert.match(both["60->120"].note, /R is unknown/);
  assert.match(both["60->120"].evaluation, /T = 16\.67 ms; 60->120 cannot be presented/);
  // With R_est known: R_budget >= R_est.
  assert.equal(fgScreen({ sourceFps: 30, Cin: 1, G: 10, Cout: 1, P: 0.5, R_est: 5 }).verdict, "advance");
  // Plain numbers are exact measurements: the verdict says so instead of naming a bound.
  assert.deepEqual([fgScreen({ sourceFps: 60, Cin: 1, G: 10, Cout: 1, P: 0.5, R_est: 5 }).verdict, fgScreen({ sourceFps: 60, Cin: 1, G: 10, Cout: 1, P: 0.5, R_est: 5 }).bound], ["stop", "exact"]);
  // Boundary (T = 40 ms so 0.8 T = 32 exactly): W_FG = 2 + 28 + 1 + 2 x 0.5 = 32, R_budget = 0.
  assert.equal(fgScreen({ sourceFps: 25, Cin: 2, G: 28, Cout: 1, P: 0.5 }).conservative.R_budget, 0);
  assert.equal(fgScreen({ sourceFps: 25, Cin: 2, G: 28, Cout: 1, P: 0.5 }).verdict, "stop"); // R unknown: needs > 0
  assert.equal(fgScreen({ sourceFps: 25, Cin: 2, G: { upper: 28 }, Cout: 1, P: 0.5 }).verdict, "stop at upper bound");
  assert.equal(fgScreen({ sourceFps: 25, Cin: 2, G: 28, Cout: 1, P: 0.5, R_est: 0 }).verdict, "advance"); // R known: >= R_est
});

test("rule G FG: G_span (upper) decides an advance; a stop needs G_kernels (lower) to fail too", () => {
  const G = (upper, lower) => ({ upper, lower, upperEstimate: "G_span", lowerEstimate: "G_kernels" });
  // 60 -> 120, 0.8 T = 13.333...: W = 0.7 + G.
  const inconclusive = fgScreen({ sourceFps: 60, Cin: 0.3, G: G(13, 11), Cout: 0.2, P: 0.1 });
  assert.deepEqual([inconclusive.verdict, inconclusive.bound, inconclusive.reliedOn], ["inconclusive", "between", null]);
  close(inconclusive.conservative.W_FG, 13.7); close(inconclusive.optimistic.W_FG, 11.7);
  const stop = fgScreen({ sourceFps: 60, Cin: 0.3, G: G(14, 13.5), Cout: 0.2, P: 0.1 });
  assert.deepEqual([stop.verdict, stop.bound, stop.reliedOn], ["stop", "lower", { G: { bound: "lower", value: 13.5, estimate: "G_kernels" } }]);
  const advance = fgScreen({ sourceFps: 30, Cin: 0.3, G: G(13, 11), Cout: 0.2, P: 0.1 });
  assert.deepEqual([advance.verdict, advance.bound, advance.reliedOn], ["advance", "upper", { G: { bound: "upper", value: 13, estimate: "G_span" } }]);
  const upperOnly = fgScreen({ sourceFps: 60, Cin: 0.3, G: { upper: 14, upperEstimate: "G_span" }, Cout: 0.2, P: 0.1 });
  assert.deepEqual([upperOnly.verdict, upperOnly.bound, upperOnly.optimistic], ["stop at upper bound", "upper", null]);
  assert.throws(() => termBounds({ upper: 1, lower: 2 }, "G"), /exceeds/);
});

test("rule G SR: W_SR, the benefit inequality and R_native_min at rho 0.25 and 0.5, hand-computed", () => {
  // Cin 0.5, U 6, Cout 0.5, P_out 1: W_SR = 8. R_native_min = (8 - 0.9) / (0.9 - rho):
  // rho 0.25 -> 7.1 / 0.65 = 10.923076923...; rho 0.5 -> 7.1 / 0.4 = 17.75.
  // Benefit with R_low 3, R_native 12: 3 + 8 = 11 <= 0.9 (12 + 1) = 11.7.
  const terms = { Cin: 0.5, U: 6, Cout: 0.5, P_out: 1, R_low: 3, R_native: 12 };
  const screen = srScreen({ ...terms, representative: { R_native: 11, gpuBound: true, source: "hand case" } });
  assert.equal(screen.conservative.W_SR, 8);
  close(screen.conservative.R_native_min[0.25], 7.1 / 0.65); close(screen.conservative.R_native_min[0.25], 10.923076923076923);
  close(screen.conservative.R_native_min[0.5], 17.75);
  assert.equal(srBreakEven(8, 1, 0.25), screen.conservative.R_native_min[0.25]);
  assert.equal(screen.conservative.benefit.left, 11); close(screen.conservative.benefit.right, 11.7);
  assert.equal(screen.conservative.benefit.pass, true); assert.equal(screen.conservative.benefit.rho, 0.25);
  assert.deepEqual([screen.verdict, screen.bound], ["advance", "exact"]);
  assert.equal(srScreen({ ...terms, representative: { R_native: 10, gpuBound: true } }).verdict, "stop");
  assert.equal(srScreen({ ...terms, U: { upper: 6, upperEstimate: "U_span" }, representative: { R_native: 10, gpuBound: true } }).verdict, "stop at upper bound");
  assert.equal(srScreen({ ...terms, representative: { R_native: 30, gpuBound: false } }).verdict, "no evidence");
  assert.equal(srScreen(terms).verdict, "no evidence");
  // Benefit fails: 3 + 8 = 11 > 0.9 (10 + 1) = 9.9.
  assert.equal(srScreen({ ...terms, R_native: 10 }).conservative.benefit.pass, false);
  // U as bounds: the conservative break-even uses U's upper end, the optimistic its lower end.
  const bounded = srScreen({ ...terms, U: { upper: 8, lower: 5, upperEstimate: "U_span", lowerEstimate: "U_kernels" }, representative: { R_native: 12, gpuBound: true } });
  close(bounded.conservative.R_native_min[0.25], 9.1 / 0.65); close(bounded.optimistic.R_native_min[0.25], 6.1 / 0.65);
  assert.deepEqual([bounded.verdict, bounded.bound], ["inconclusive", "between"]); // 12 < 14.0 but >= 9.38
  const stopped = srScreen({ ...terms, U: { upper: 8, lower: 7.5, upperEstimate: "U_span", lowerEstimate: "U_kernels" }, representative: { R_native: 12, gpuBound: true } });
  assert.deepEqual([stopped.verdict, stopped.reliedOn], ["stop", { U: { bound: "lower", value: 7.5, estimate: "U_kernels" } }]); // 12 < 8.6 / 0.65 = 13.23
});

test("rule G combined FG->SR screen is information only", () => {
  // R_low 3 + G_low 8 + 2 x 6 + 2 x 0.5 + C 1 = 25: < 33.33 at 30 fps, not < 16.67 at 60 fps.
  const at30 = combinedScreen({ sourceFps: 30, R_low: 3, G_low: 8, U: 6, P: 0.5, C: 1 });
  assert.deepEqual([at30.informationOnly, at30.conservative.total, at30.conservative.pass], [true, 25, true]);
  assert.equal(combinedScreen({ sourceFps: 60, R_low: 3, G_low: 8, U: 6, P: 0.5, C: 1 }).conservative.pass, false);
  assert.ok(!("verdict" in at30));
});

test("rules A and B: limits are inclusive, PSNR may be infinite", () => {
  assert.equal(checkExportParity({ precision: "fp32", maxAbs: 1e-3, meanAbs: 1e-5 }).pass, true);
  assert.equal(checkExportParity({ precision: "fp16", maxAbs: 5.01e-2, meanAbs: 1e-4 }).pass, false);
  assert.equal(checkDeviceParity({ precision: "fp32", maxAbs: 2e-2, meanAbs: 1e-3, psnrDb: 50 }).pass, true);
  assert.equal(checkDeviceParity({ precision: "fp32", maxAbs: 2.01e-2, meanAbs: 1e-3, psnrDb: 60 }).pass, false);
  assert.equal(checkDeviceParity({ precision: "fp32", maxAbs: 0, meanAbs: 0, psnrDb: Infinity }).pass, true);
  assert.equal(checkDeviceParity({ precision: "fp16", maxAbs: 6e-2, meanAbs: 4e-3, psnrDb: 39.99 }).pass, false);
  assert.equal(checkDeviceParity({ precision: "fp16", maxAbs: 0.01, meanAbs: null, psnrDb: 45 }).pass, false); // missing fails
  assert.throws(() => checkDeviceParity({ precision: "bf16", maxAbs: 0, meanAbs: 0, psnrDb: 99 }), /no limits/);
  assert.deepEqual(THRESHOLDS.B.fp16, { maxAbs: 6e-2, meanAbs: 4e-3, psnrDb: 40 });
});

test("rule C compares counts exactly; rules D, E, F", () => {
  assert.equal(checkFullPath({ precision: "fp32", withinOne: 995, total: 1000, maxDifference: 8 }).pass, true);
  assert.equal(checkFullPath({ precision: "fp32", withinOne: 994, total: 1000, maxDifference: 8 }).pass, false);
  assert.equal(checkFullPath({ precision: "fp32", withinOne: 1000, total: 1000, maxDifference: 9 }).pass, false);
  assert.equal(checkFullPath({ precision: "fp16", withinOne: 980, total: 1000, maxDifference: 16 }).pass, true);
  assert.equal(checkFullPath({ precision: "fp16", withinOneFraction: 0.979, maxDifference: 1 }).pass, false);
  assert.deepEqual([checkPlacement({ cpuNodes: null }).status, checkPlacement({ cpuNodes: null }).pass], ["UNVERIFIED", false]);
  assert.equal(checkPlacement({ cpuNodes: 0, statement: "All nodes placed on [WebGpuExecutionProvider]" }).pass, true);
  assert.equal(checkPlacement({ cpuNodes: 3 }).pass, false);
  const injected = { sameDevice: true, gpuInputsAccepted: true, outputConsumed: true, scopeErrors: 0, uncapturedErrors: 0, deviceLost: false, proof: "output consumed by unpack" };
  assert.equal(checkInjection(injected).pass, true);
  assert.equal(checkInjection({ ...injected, deviceLost: null }).pass, false);
  assert.equal(checkInjection({ ...injected, scopeErrors: 1 }).pass, false);
  assert.equal(checkMemory({ peakIncrementalBytes: 256 * 2 ** 20 }).pass, true);
  assert.equal(checkMemory({ peakIncrementalBytes: 256 * 2 ** 20 + 1 }).pass, false);
});

test("rule H: the model must strictly beat every control; SR flicker at most 1.10 x bicubic", () => {
  const fg = checkFgQuality([
    { sequence: "pan-slow", model: { psnr: 35, ssim: 0.95 }, repeat: { psnr: 30, ssim: 0.9 }, blend: { psnr: 32, ssim: 0.93 } },
    { sequence: "cut", model: { psnr: 30, ssim: 0.9 }, repeat: { psnr: 30, ssim: 0.8 }, blend: { psnr: 25, ssim: 0.85 } },
  ]);
  assert.deepEqual([fg.pass, fg.sequences[0].pass, fg.sequences[1].pass], [false, true, false]); // a tie is not "exceed"
  assert.equal(checkFgQuality([]).pass, false);
  const entry = (flicker, bicubicFlicker) => ({ model: { psnr: 33, ssim: 0.92, flicker }, bilinear: { psnr: 30, ssim: 0.9 }, bicubic: { psnr: 31, ssim: 0.91, flicker: bicubicFlicker } });
  assert.equal(checkSrQuality({ overall: entry(1.1, 1) }).pass, true); // ratio exactly 1.10
  assert.equal(checkSrQuality({ overall: entry(1.1000001, 1) }).pass, false);
  assert.equal(checkSrQuality({ overall: entry(0, 0) }).pass, false); // ratio undefined
  assert.equal(checkSrQuality({ overall: entry(1, 1), sequences: [{ sequence: "zoom", ...entry(2, 1) }] }).pass, false);
});

test("rule H inputs from quality.py summaries (summarize_fg / summarize_sr shapes)", () => {
  const fgRegime = { k: 4, sequences: {
    "pan-slow": { pairs: 57, medians: { psnr_model: 36.1, psnr_repeat: 30.2, psnr_blend: 33.3, ssim_model: 0.97, ssim_repeat: 0.9, ssim_blend: 0.95 } },
    "pan-fast": { pairs: 57, medians: { psnr_model: 28.0, psnr_repeat: 24.0, psnr_blend: 28.0, ssim_model: 0.9, ssim_repeat: 0.8, ssim_blend: 0.85 } },
  } };
  const entries = fgQualityEntries(fgRegime);
  assert.deepEqual(entries[0], { sequence: "pan-slow", pairs: 57, model: { psnr: 36.1, ssim: 0.97 }, repeat: { psnr: 30.2, ssim: 0.9 }, blend: { psnr: 33.3, ssim: 0.95 } });
  const fg = checkFgQuality(entries);
  assert.deepEqual([fg.pass, fg.sequences.map(sequence => sequence.pass)], [false, [true, false]]); // pan-fast ties blend PSNR
  const part = (psnr, flicker) => ({ medians: { psnr_model: psnr, psnr_bilinear: 30, psnr_bicubic: 31, ssim_model: 0.95, ssim_bilinear: 0.9, ssim_bicubic: 0.91 }, flicker: { model: flicker, bilinear: 0.004, bicubic: 0.005 } });
  const sr = srQualityInput({ pooled: part(33, 0.005), sequences: { zoom: part(32, 0.0054), cut: part(null, 0.005) } });
  assert.deepEqual(sr.overall.bicubic, { psnr: 31, ssim: 0.91, flicker: 0.005 });
  const verdict = checkSrQuality(sr);
  assert.deepEqual([verdict.overall.pass, verdict.sequences.map(sequence => sequence.pass), verdict.pass], [true, [true, false], false]); // null PSNR fails
});

// ─── telemetry parsers ───────────────────────────────────────────────────

test("ps cputime parses minutes beyond 59, hours and days", () => {
  assert.equal(parseCpuTime("0:00.01"), 10);
  assert.equal(parseCpuTime("402:25.26"), 402 * 60000 + 25260);
  assert.equal(parseCpuTime("1:02:03.50"), 3723500);
  assert.equal(parseCpuTime("2-01:00:00.00"), 49 * 3600000);
  assert.equal(parseCpuTime("garbage"), null);
  const table = parseProcessTable("    1     0  12:54.13\n  104     1   4:09.75\nnot a line\n");
  assert.deepEqual([...table], [[1, { ppid: 0, cpuMs: 774130 }], [104, { ppid: 1, cpuMs: 249750 }]]);
});

test("other-process CPU excludes this run's processes and their descendants", () => {
  const tableOf = rows => new Map(rows.map(([pid, ppid, cpuMs]) => [pid, { ppid, cpuMs }]));
  // pid 100 this node, 200 Chrome (its child), 300 a Chrome helper, 400 a pid named by CDP (parent 1) with child 401.
  const before = { atMs: 0, table: tableOf([[1, 0, 1000], [100, 1, 500], [200, 100, 1000], [300, 200, 2000], [400, 1, 100], [401, 400, 50], [500, 1, 10000], [501, 500, 20], [700, 1, 300], [800, 1, 5000]]) };
  const after = { atMs: 2000, table: tableOf([[1, 0, 1100], [100, 1, 800], [200, 100, 1400], [300, 200, 3000], [400, 1, 150], [401, 400, 90], [500, 1, 11000], [501, 500, 520], [600, 1, 250], [800, 1, 80], [900, 300, 60]]) };
  const delta = processCpuDelta(before, after, [100, 400]);
  // other: 100 (pid 1) + 1000 (500) + 500 (501) + 250 (600, new) + 80 (800, reused pid) = 1930 ms over 2000 ms.
  assert.deepEqual([delta.otherCpuMs, delta.otherCores], [1930, 0.965]);
  // own: 300 + 400 + 1000 + 50 + 40 + 60 (900, a new helper) = 1850 ms.
  assert.deepEqual([delta.ownCpuMs, delta.ownCores], [1850, 0.925]);
  assert.deepEqual([delta.started, delta.exited, delta.reused], [{ own: 1, other: 1 }, { own: 0, other: 1 }, { own: 0, other: 1 }]);
  assert.deepEqual(delta.excludedPids, [100, 400]);
  assert.deepEqual(pidsFromProcessInfo({ processInfo: [{ type: "browser", id: 400, cpuTime: 1 }, { type: "GPU", id: 300, cpuTime: 2 }, { type: "renderer", id: 400, cpuTime: 0 }] }), [300, 400]);
  assert.deepEqual(pidsFromProcessInfo(undefined), []);
});

test("GPU, swap and power text parsers", () => {
  const ioreg = '  | |   "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=1593688064,"Tiler Utilization %"=3,"recoveryCount"=0,"Renderer Utilization %"=7,"Device Utilization %"=12,"In use system memory"=285392896}\n';
  assert.deepEqual(parseGpuStatistics(ioreg), { deviceUtilization: 12, rendererUtilization: 7, tilerUtilization: 3, inUseSystemMemoryBytes: 285392896, allocSystemMemoryBytes: 1593688064, accelerators: 1 });
  assert.equal(parseGpuStatistics("no accelerator"), null);
  assert.equal(parseSwapUsage("total = 2048.00M  used = 384.50M  free = 1663.50M  (encrypted)"), 403177472);
  assert.deepEqual(parsePmset("System-wide power settings:\n lowpowermode         0\n"), { lowPowerMode: false });
  assert.deepEqual(parsePmsetBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging; 1:04 remaining present: true\n"), { source: "AC Power", batteryPercent: 80, batteryState: "charging" });
  assert.equal(parsePmsetBattery(""), null);
});

test("a stored sample keeps no per-process table", () => {
  const record = sampleRecord(fakeSample({ table: [[100, 1, 0], [500, 1, 10]] }));
  assert.deepEqual(record.processes, { atMs: 0, spanMs: 4, count: 2 });
  assert.ok(!("cpus" in record));
  assert.doesNotMatch(formatJson(record), /"table"/);
});

// ─── environment writers ─────────────────────────────────────────────────

test("CSV and JSON writers", () => {
  assert.equal(toCsv([{ a: 1, b: "x,y" }, { a: 0.1234567891, c: null }]), 'a,b,c\n1,"x,y",\n0.1234568,,\n');
  assert.equal(csvCell(NaN), ""); assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(formatJson({ series: [1, 2, NaN], nested: [{ a: 1 }] }), '{\n  "series": [1, 2, null],\n  "nested": [\n    {\n      "a": 1\n    }\n  ]\n}\n');
  assert.deepEqual(parseArguments({ rounds: 3, gpu: true, profiles: ["720p"] }, ["--rounds=5", "--gpu=false", "--profiles=720p,1080p"]), { rounds: 5, gpu: false, profiles: ["720p", "1080p"] });
  assert.throws(() => parseArguments({ rounds: 3 }, ["--round=5"]), /unknown option/);
});

// ─── u8/255 model input ──────────────────────────────────────────────────

// DESIGN.md section 6: the page rebuilds the padded NCHW float32 input from the .rgba8 file as Math.fround(v / 255)
// and must reproduce sha256F32, which export/common.py to_model_input computes as float32(u8) / float32(255).
// Case: a 10x13 RGB image with value (7 x index) mod 256 over (y, x, channel), so all 256 byte values occur,
// zero-padded to 12x16. Hashes from build/ai-framegen-upscale/node-libs/tensor_hash.py run on common.py
// (numpy 2.4.6, 2026-10-13): rgba8 520 B, float32 2,304 B little-endian.
const TENSOR_CASE = { width: 13, height: 10, paddedWidth: 16, paddedHeight: 12, rgba8Sha256: "632be5f6d66757bd1eee76106a1392e8a94f3af0e7c95cb44600763ed67a0288", f32Sha256: "0a190f00015169bbf17e5e8067cbc40e952b63e9dda8fcfe92ccf44ce082852c" };

function caseRgba8({ width, height }) {
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++) rgba[pixel * 4 + channel] = (7 * (pixel * 3 + channel)) % 256;
    rgba[pixel * 4 + 3] = 255;
  }
  return rgba;
}
/** The rule itself: NCHW, RGB, Math.fround(v / 255), zeros right and bottom. */
function modelInputRule(rgba, width, height, paddedWidth, paddedHeight) {
  const out = new Float32Array(3 * paddedWidth * paddedHeight);
  for (let channel = 0; channel < 3; channel++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    out[(channel * paddedHeight + y) * paddedWidth + x] = Math.fround(rgba[(y * width + x) * 4 + channel] / 255);
  }
  return out;
}
const littleEndian = floats => { const view = new DataView(new ArrayBuffer(floats.length * 4)); floats.forEach((value, index) => view.setFloat32(index * 4, value, true)); return new Uint8Array(view.buffer); };

test("u8/255 model input: Math.fround(v / 255) reproduces common.py to_model_input bit for bit", () => {
  const { width, height, paddedWidth, paddedHeight } = TENSOR_CASE;
  const rgba = caseRgba8(TENSOR_CASE);
  assert.equal(new Set(Array.from({ length: 256 }, (_, i) => (7 * i) % 256)).size, 256);
  assert.equal(sha256(rgba), TENSOR_CASE.rgba8Sha256);
  const tensor = modelInputRule(rgba, width, height, paddedWidth, paddedHeight);
  assert.equal(tensor.length * 4, 2304);
  assert.equal(sha256(littleEndian(tensor)), TENSOR_CASE.f32Sha256);
});

// The page's own builder and the request router belong to the harness agent (lib/serve.mjs, harness/*.mjs).
// requests.md (2026-10-13 00:36) asks for pure exports; until they exist these cases are skipped with that reason.
const harnessModule = relative => fileURLToPath(new URL(`../scripts/benchmarks/ai-framegen-upscale/${relative}`, import.meta.url));
const pendingHarness = file => (existsSync(harnessModule(file)) ? false : `${file} does not exist yet (requests.md, 2026-10-13 00:36)`);

// The harness agent exports the builder from harness/wgsl.mjs (pure, no browser globals at import).
test("u8/255 model input: the page's builder matches the stored hash", { skip: pendingHarness("harness/wgsl.mjs") }, async t => {
  const module = await import(harnessModule("harness/wgsl.mjs"));
  if (typeof module.modelInputFromRgba8 !== "function") { t.skip("harness/wgsl.mjs has no modelInputFromRgba8 export yet (requests.md)"); return; }
  const { width, height, paddedWidth, paddedHeight } = TENSOR_CASE;
  const rgba = caseRgba8(TENSOR_CASE);
  const tensor = module.modelInputFromRgba8(rgba, width, height, paddedWidth, paddedHeight);
  assert.ok(tensor instanceof Float32Array);
  assert.equal(tensor.length, 3 * paddedWidth * paddedHeight);
  assert.equal(sha256(littleEndian(tensor)), TENSOR_CASE.f32Sha256);
  assert.deepEqual(tensor, modelInputRule(rgba, width, height, paddedWidth, paddedHeight));
});

test("serve route resolution rejects traversal, absolute and unknown paths", { skip: pendingHarness("lib/serve.mjs") }, async t => {
  const { harnessRoutes, resolveRoute } = await import(harnessModule("lib/serve.mjs"));
  if (typeof resolveRoute !== "function" || typeof harnessRoutes !== "function") { t.skip("lib/serve.mjs lacks resolveRoute/harnessRoutes (requests.md)"); return; }
  // Synthetic folders; the existence check is injected, so nothing is read but browser-dependencies.json.
  const routes = harnessRoutes({ models: "/fixture/work/models", references: "/fixture/work/references", ortDist: "/fixture/ort/dist", media: { "northrop-mall.jpg": "/fixture/media/6144.jpg" }, harness: "/fixture/harness" });
  const resolve = (url, exists = () => true) => resolveRoute(routes, url, exists);
  const served = {
    "https://foss-earth.test/": ["/fixture/harness/index.html", "text/html; charset=utf-8"],
    "https://foss-earth.test/main.mjs?run=1": ["/fixture/harness/main.mjs", "text/javascript"],
    "https://foss-earth.test/ort/ort-wasm-simd-threaded.asyncify.wasm": ["/fixture/ort/dist/ort-wasm-simd-threaded.asyncify.wasm", "application/wasm"],
    "https://foss-earth.test/models/rife-4.25-lite/720p/fp32.onnx": ["/fixture/work/models/rife-4.25-lite/720p/fp32.onnx", "application/octet-stream"],
    "https://foss-earth.test/references/rt4ksr-x2/small/natural/out.f32": ["/fixture/work/references/rt4ksr-x2/small/natural/out.f32", "application/octet-stream"],
    "https://foss-earth.test/media/northrop-mall.jpg": ["/fixture/media/6144.jpg", "image/jpeg"],
  };
  for (const [url, [file, contentType]] of Object.entries(served)) {
    const result = resolve(url);
    assert.deepEqual([result.status, result.file, result.contentType], [200, file, contentType], url);
  }
  const refused = [
    "https://foss-earth.test/../x.mjs", "https://foss-earth.test/%2e%2e/x.mjs", "https://foss-earth.test/%2E%2e/%2e%2e/x.mjs",
    "https://foss-earth.test/models/../../secret.onnx", "https://foss-earth.test/models/%2e%2e/%2e%2e/x.onnx", "https://foss-earth.test/models/./a.onnx",
    "https://foss-earth.test/models/a%2f..%2fb.onnx", "https://foss-earth.test/models/a%5c..%5cb.onnx", "https://foss-earth.test/models/a\\..\\b.onnx",
    "https://foss-earth.test//etc/passwd.mjs", "https://foss-earth.test/models//x.onnx", "/etc/passwd", "file:///etc/passwd",
    "https://example.com/index.html", "https://foss-earth.test.example.com/index.html", "https://foss-earth.test@example.com/index.html",
    "https://foss-earth.test/ort/ort.all.min.mjs", "https://foss-earth.test/ort/sub/ort.webgpu.min.mjs", "https://foss-earth.test/harness/main.mjs",
    "https://foss-earth.test/main.py", "https://foss-earth.test/models/x.pth", "https://foss-earth.test/media/other.jpg", "https://foss-earth.test/media/../6144.jpg",
    "https://foss-earth.test/models/a%00.onnx", "https://foss-earth.test/models/%E0%A4%A.onnx", null,
  ];
  for (const url of refused) {
    const result = resolve(url);
    assert.equal(result.status, 404, `${url} -> ${JSON.stringify(result)}`);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
  }
  assert.deepEqual(resolve("https://foss-earth.test/index.html", () => false), { status: 404, reason: "no such file" });
});

test("timing admission refuses a missing/failed reference case and CPU fallback", async () => {
  const { admittedProfiles } = await import("../scripts/benchmarks/ai-framegen-upscale/run-timing.mjs");
  const profile = { candidate: "rt4ksr-x2", profile: "720p", precision: "fp32", status: "completed", graph: { gateA: { pass: true } }, gateD: { pass: true }, staticOpSupport: { pass: true },
    runtimeBuild: { nativeAsyncifyFilesObserved: true, jsepFilesObserved: false }, cases: ["synthetic", "natural"].map(name => ({ case: name, gateB: { pass: true }, gateC: { pass: true }, gateE: { pass: true }, conversionSelfTest: { pass: true } })) };
  const options = { candidates: ["rt4ksr-x2"], profiles: ["720p"], precisions: ["fp32"] };
  assert.equal(admittedProfiles({ profiles: [profile] }, options).selected.length, 1);
  const missing = structuredClone(profile); missing.cases.pop();
  assert.equal(admittedProfiles({ profiles: [missing] }, options).selected.length, 0);
  const failed = structuredClone(profile); failed.cases[1].gateC.pass = false;
  assert.equal(admittedProfiles({ profiles: [failed] }, options).selected.length, 0);
  const cpu = structuredClone(profile); cpu.gateD.pass = false;
  assert.equal(admittedProfiles({ profiles: [cpu] }, options).selected.length, 0);
});

test("callback cadence reports skipped opportunities as an elapsed proxy only", async () => {
  const { callbackCadence } = await import("../scripts/benchmarks/ai-framegen-upscale/run-timing.mjs");
  const result = callbackCadence([{ rafTimestamp: 0, callbackNow: 1 }, { rafTimestamp: 16, callbackNow: 17 }, { rafTimestamp: 48, callbackNow: 49 }], 16);
  assert.equal(result.inferredSkippedCallbackOpportunities, 1);
  assert.equal(result.intervalsAbove125Percent, 1);
  assert.equal(result.intervalsAbove200Percent, 0);
  assert.match(result.qualification, /^unqualified elapsed/);
});

test("gate G qualification follows every W-term metric", async () => {
  const { summarizeBlocks } = await import("../scripts/benchmarks/ai-framegen-upscale/run-timing.mjs");
  const { resolveTimingParameters } = await import("../scripts/benchmarks/ai-framegen-upscale/lib/blocks.mjs");
  const parameters = resolveTimingParameters().values;
  const blocks = [];
  for (let round = 0; round < 11; round++) {
    for (const name of ["model-fp32", "model-fp32-again"]) {
      const model = name.endsWith("again") ? 2 : 1;
      const summary = { cinGpuMs: 1, modelSpanMs: model, coutGpuMs: 1, presentGpuMs: 1, totalGpuMs: 10 };
      const series = Object.fromEntries(Object.entries(summary).map(([metric, value]) => [metric, [value]]));
      blocks.push({ round, name, disturbed: false, reasons: [], summary, series });
    }
  }
  const drifted = summarizeBlocks(blocks, ["model-fp32"], { validated: true }, parameters, false);
  assert.equal(drifted.variants["model-fp32"].totalGpuMs.qualified, true);
  assert.equal(drifted.screens["model-fp32"].qualification.qualified, false);
  assert.ok(drifted.screens["model-fp32"].qualification.aa.differencePercent > 5);
  for (const block of blocks) if (block.name.endsWith("again")) {
    block.summary.modelSpanMs = 1;
    block.series.modelSpanMs = [1];
  }
  const stable = summarizeBlocks(blocks, ["model-fp32"], { validated: true }, parameters, false);
  assert.equal(stable.screens["model-fp32"].qualification.qualified, true);
  assert.equal(stable.screens["model-fp32"].qualification.acceptedRounds, 11);
});

test("gate G A/A is scored on the rounds that enter the stage p95", async () => {
  const { summarizeBlocks } = await import("../scripts/benchmarks/ai-framegen-upscale/run-timing.mjs");
  const { resolveTimingParameters } = await import("../scripts/benchmarks/ai-framegen-upscale/lib/blocks.mjs");
  const parameters = resolveTimingParameters().values;
  const blocks = [];
  for (let round = 0; round < 31; round++) {
    const inCost = round < 11;
    for (const name of ["model-fp32", "model-fp32-again"]) {
      const summary = {
        cinGpuMs: inCost ? 1 : NaN, coutGpuMs: inCost ? 1 : NaN, presentGpuMs: inCost ? 1 : NaN, totalGpuMs: 10,
        modelSpanMs: name.endsWith("again") && inCost ? 2 : 1,
      };
      const series = Object.fromEntries(Object.entries(summary).map(([metric, value]) => [metric, Number.isFinite(value) ? [value] : []]));
      blocks.push({ round, name, disturbed: false, reasons: [], summary, series });
    }
  }
  const screen = summarizeBlocks(blocks, ["model-fp32"], { validated: true }, parameters, false).screens["model-fp32"];
  assert.deepEqual(screen.qualification.rounds, [...Array(11).keys()]);
  assert.equal(screen.qualification.qualified, false);
  assert.ok(screen.qualification.aa.perMetric.modelSpanMs > 5);
  assert.equal(screen.values.verdict === "advance" && screen.qualification.qualified, false);
});

test("captured admission requires unchanged upload and packed hashes", async () => {
  const { capturedProfileMatches } = await import("../scripts/benchmarks/ai-framegen-upscale/run-timing.mjs");
  const one = (name, hash) => ({ case: name, gateB: { pass: true }, gateC: { pass: true }, gateE: { pass: true }, conversionSelfTest: { pass: true, inputs: [{ input: "input", packedSha256: hash, expectedSha256: hash }] },
    deviceParity: { inputHashes: [{ name: "input", sha256: hash, uploadedSha256: hash, verified: true }] } });
  const normal = { modelSha256: "abc", enableGraphCapture: false, gateD: { pass: true }, cases: [one("synthetic", "h1"), one("natural", "h2")] };
  const captured = { modelSha256: "abc", enableGraphCapture: true, gateD: { pass: true }, cases: [one("synthetic", "h1"), one("natural", "h2")] };
  assert.equal(capturedProfileMatches(normal, captured), true);
  const uploaded = structuredClone(captured); uploaded.cases[0].deviceParity.inputHashes[0].uploadedSha256 = "other";
  assert.equal(capturedProfileMatches(normal, uploaded), false);
  const packed = structuredClone(captured); packed.cases[1].conversionSelfTest.inputs[0].packedSha256 = "other";
  assert.equal(capturedProfileMatches(normal, packed), false);
  const bare = structuredClone(captured); delete bare.cases[0].deviceParity.inputHashes;
  assert.equal(capturedProfileMatches(normal, bare), false);
});

test("quality table cannot promote supplementary, partial or development H", async () => {
  const { qualityRows, qualityPublication } = await import("../scripts/benchmarks/ai-framegen-upscale/make-tables.mjs");
  const part = { sequences: { synthetic: { medians: { psnr_model: 40, psnr_repeat: 20, psnr_blend: 25, ssim_model: 0.9, ssim_repeat: 0.3, ssim_blend: 0.5 } } } };
  const q = { mode: "final", completedAt: "2026-10-13", screenCoverage: { complete: true }, fg: { "rife-4.25-lite": { "720p": { fp32: { "30->60": part }, fp16: { "30->60": part } } } },
    verdicts: [{ candidate: "rife-4.25-lite", profile: "720p", precision: "fp32", part: "FG 30->60", verdict: "pass", status: "gate", gateA: true, failingSequences: [] }] };
  assert.equal(qualityRows(q)[0].cpuQualityGatePass, true);
  assert.equal(qualityPublication(qualityRows(q)[0]).admitted, "yes");
  const half = structuredClone(q); Object.assign(half.verdicts[0], { precision: "fp16", status: "supplementary" });
  assert.equal(qualityRows(half)[0].cpuQualityGatePass, false);
  assert.equal(qualityPublication(qualityRows(half)[0]).admitted, "no");
  assert.equal(qualityPublication(qualityRows(half)[0]).status, "supplementary");
  const partial = structuredClone(q); delete partial.completedAt;
  assert.equal(qualityRows(partial)[0].cpuQualityGatePass, false);
  const development = structuredClone(q); development.mode = "development";
  assert.equal(qualityRows(development)[0].cpuQualityGatePass, false);
  const failedA = structuredClone(q); failedA.verdicts[0].gateA = false;
  assert.equal(qualityPublication(qualityRows(failedA)[0]).admitted, "no");
});
