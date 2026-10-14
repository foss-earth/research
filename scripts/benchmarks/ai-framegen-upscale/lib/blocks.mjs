/**
 * Paired, seeded timing blocks for the ai-framegen-upscale screen
 * (DESIGN.md section 9, acceptance rule I in
 * build/ai-framegen-upscale/notes/acceptance-rules.md, and
 * docs/validation/benchmark-interference.md).
 *
 * - TIMING_PARAMETERS: every budget and threshold as a named parameter with
 *   unit, bounds, default and reason; resolveTimingParameters() validates
 *   overrides and lists them, so a results file records exactly what differed.
 * - roundOrder(): one round = every variant plus `<variant>-again` for the A/A
 *   variants, shuffled with mulberry32(orderSeed + round).
 * - evaluateBlock(): rule I on the telemetry record of one block (from
 *   telemetry.mjs blockTelemetry()): disturbed or not, with every reason and the
 *   numbers it used. A required signal that could not be read disturbs the
 *   block ("missing:<signal>"): missing is not zero.
 * - stopReason(): stop at maximumPairs rounds or before a round that would end
 *   after maximumRunSeconds.
 * - qualifyVariant() / compareVariants(): accepted rounds, median of block
 *   medians, A/A within 5 %, paired per-round differences with an
 *   order-statistic interval, and whether the result qualifies.
 *
 * A block, as the timing script records it:
 *   { round: 0, position: 3, name: "model-fp32-again", disturbed: false,
 *     reasons: [], summary: { modelSpanMs: 4.21, totalGpuMs: 6.02, ... } }
 * `summary` holds that block's median per metric (over its iterations).
 */
import { mulberry32 } from "../../spherical-image-representation/lib/random.mjs";
import { median, medianConfidenceInterval, pairedSummary } from "./stats.mjs";

export const AGAIN_SUFFIX = "-again";

/**
 * Named parameters (docs/validation/benchmark-interference.md, "Parameters and
 * retained evidence"). Defaults are acceptance rule I; changing one is an
 * override that results must record.
 */
export const TIMING_PARAMETERS = {
  blockIterations: { unit: "iterations", default: 30, minimum: 1, maximum: 1000, integer: true, reason: "Rule I: 30 iterations = 1 s of 30->60 FG or 0.5 s of SR at 60 Hz; short enough to interleave, long enough to amortize the per-block telemetry." },
  maximumWarmupSeconds: { unit: "s", default: 5, minimum: 0, maximum: 120, reason: "Rule I: bounded warmup after the separately recorded cold first run; bounds pre-measurement work and its thermal effect." },
  minimumPairs: { unit: "accepted rounds", default: 11, minimum: 3, maximum: 1000, integer: true, reason: "Rule I / interference policy default: enough repetitions to expose unstable comparisons; n = 11 gives a 98.8 % order-statistic interval for the median." },
  maximumPairs: { unit: "rounds", default: 33, minimum: 3, maximum: 1000, integer: true, reason: "Rule I / interference policy default: bounds retries as well as accepted rounds (at least minimumPairs)." },
  maximumRunSeconds: { unit: "s", default: 120, minimum: 1, maximum: 3600, reason: "Rule I: per (candidate, profile) comparison; exhaustion keeps the evidence and ends qualification." },
  orderSeed: { unit: "unsigned 32-bit integer", default: 0, minimum: 0, maximum: 2 ** 32 - 1, integer: true, reason: "Rule I: reproduces the block order; round r uses mulberry32(orderSeed + r)." },
  requiredMemoryPressureLevel: { unit: "kern.memorystatus_vm_pressure_level (1 normal, 2 warning, 4 critical)", default: 1, minimum: 1, maximum: 4, integer: true, reason: "Rule I: memory pressure level != 1 at either end disturbs the block." },
  maximumSwapoutPages: { unit: "pages (vm_stat Swapouts delta)", default: 0, minimum: 0, maximum: 1e9, integer: true, reason: "Rule I: any swapout disturbs the block." },
  maximumCompressedMiB: { unit: "MiB (vm_stat Compressions delta x page size)", default: 16, minimum: 0, maximum: 16384, reason: "Rule I: more than 16 MiB compressed during the block disturbs it (the quiet.mjs/timing.md guard)." },
  maximumThermalState: { unit: "ProcessInfo.ThermalState (0 nominal, 1 fair, 2 serious, 3 critical)", default: 0, minimum: 0, maximum: 3, integer: true, reason: "Rule I: thermal state above nominal at either end disturbs the block." },
  maximumOtherProcessCores: { unit: "cores (average over the block)", default: 1.5, minimum: 0, maximum: 1024, reason: "Rule I: other processes' aggregate CPU above 1.5 cores on average disturbs the block." },
  maximumIdleGpuUtilizationPercent: { unit: "% (IOAccelerator Device Utilization, idle sample before the block)", default: 10, minimum: 0, maximum: 100, reason: "Rule I: GPU busy above 10 % before the block means another client was using the GPU." },
  maximumAaDifferencePercent: { unit: "% of the candidate's median of block medians", default: 5, minimum: 0, maximum: 100, reason: "Rule I: candidate-again within 5 % of the candidate, or the comparison does not qualify." },
  confidence: { unit: "probability", default: 0.95, minimum: 0.5, maximum: 0.999, reason: "Requested coverage of the order-statistic interval for the median; the achieved (discrete) coverage is reported." },
};

/** The default value of every parameter. */
export const defaultTimingParameters = () => Object.fromEntries(Object.entries(TIMING_PARAMETERS).map(([name, spec]) => [name, spec.default]));

/**
 * Defaults with `overrides` applied and checked against the bounds.
 * Returns `{ values, overrides, table }`: `overrides` lists only the names
 * whose value differs from the default; `table` is TIMING_PARAMETERS with the
 * value used, for the results file.
 */
export function resolveTimingParameters(overrides = {}) {
  const values = defaultTimingParameters(), changed = {};
  for (const [name, value] of Object.entries(overrides)) {
    const spec = TIMING_PARAMETERS[name];
    if (!spec) throw new Error(`unknown timing parameter ${name}`);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number, got ${value}`);
    if (spec.integer && !Number.isInteger(value)) throw new Error(`${name} must be an integer, got ${value}`);
    if (value < spec.minimum || value > spec.maximum) throw new Error(`${name} must be in [${spec.minimum}, ${spec.maximum}] ${spec.unit}, got ${value}`);
    values[name] = value;
    if (value !== spec.default) changed[name] = value;
  }
  if (values.maximumPairs < values.minimumPairs) throw new Error(`maximumPairs (${values.maximumPairs}) must be at least minimumPairs (${values.minimumPairs})`);
  const table = Object.fromEntries(Object.entries(TIMING_PARAMETERS).map(([name, spec]) => [name, { ...spec, value: values[name] }]));
  return { values, overrides: changed, table };
}

export const againName = variant => `${variant}${AGAIN_SUFFIX}`;
/** "model-fp32-again" -> "model-fp32"; other names unchanged. */
export const baseVariant = name => (name.endsWith(AGAIN_SUFFIX) ? name.slice(0, -AGAIN_SUFFIX.length) : name);

/**
 * The block order of one round: `variants` plus `<variant>-again` for each of
 * `again` (the model variants), shuffled by Fisher-Yates (from the last
 * position down, j = floor(random() * (i + 1))) with mulberry32(orderSeed + round).
 * Rounds count from 0. The same arguments always give the same order.
 */
export function roundOrder({ variants, again = [], round, orderSeed = 0 }) {
  if (!Array.isArray(variants) || variants.length === 0) throw new Error("a round needs at least one variant");
  if (new Set(variants).size !== variants.length) throw new Error("variant names must be unique");
  for (const name of again) if (!variants.includes(name)) throw new Error(`A/A variant ${name} is not among the variants`);
  if (!Number.isInteger(round) || round < 0) throw new Error(`round must be a non-negative integer, got ${round}`);
  const order = [...variants, ...again.map(againName)];
  const random = mulberry32((orderSeed + round) >>> 0);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** The orders of rounds 0 .. count - 1. */
export const planRounds = (count, options) => Array.from({ length: count }, (_, round) => roundOrder({ ...options, round }));

const present = value => typeof value === "number" && Number.isFinite(value);

/**
 * Rule I for one block. `record` is telemetry.mjs blockTelemetry(before, after):
 *   memory:  { pressureBefore, pressureAfter, swapoutPages, compressedPages, pageBytes, ... }
 *   thermal: { stateBefore, stateAfter, pressureLevelBefore, pressureLevelAfter }
 *   processCpu: { otherCores, ... }
 *   gpu: { idleBefore: { deviceUtilization, ... } }
 *   input: { secondsSinceInputAfter }, intervalSeconds, power: { before, after }
 * Returns `{ disturbed, reasons, diagnostics, values }`. Reasons, exactly rule I:
 *   memory-pressure    pressure level != 1 at either end
 *   swapout            any page swapped out during the block (vm_stat Swapouts delta > 0)
 *   compressed         more than 16 MiB compressed during the block (vm_stat Compressions
 *                      delta x page size, as quiet.mjs and docs/validation/timing.md)
 *   thermal            ProcessInfo.thermalState above nominal (0) at either end
 *   other-process-cpu  other processes' CPU above 1.5 cores averaged over the block
 *   gpu-busy-before    Device Utilization above 10 % in the idle sample before the block
 *   missing:<signal>   a required signal could not be read (missing is not zero)
 * Thresholds are strict ("above"): exactly 1.5 cores, exactly 10 % GPU or
 * exactly 16 MiB do not disturb. Keyboard/pointer input, the OS thermal
 * pressure level, Low Power Mode and the power source are diagnostics only.
 */
export function evaluateBlock(record, parameters = defaultTimingParameters()) {
  const reasons = [], diagnostics = [], values = {};
  const memory = record?.memory ?? null;
  if (!memory || !present(memory.pressureBefore) || !present(memory.pressureAfter) || !present(memory.swapoutPages) || !present(memory.compressedPages) || !present(memory.pageBytes)) {
    reasons.push("missing:memory");
  } else {
    const compressedBytes = memory.compressedPages * memory.pageBytes;
    Object.assign(values, { pressureBefore: memory.pressureBefore, pressureAfter: memory.pressureAfter, swapoutPages: memory.swapoutPages, compressedMiB: compressedBytes / 2 ** 20 });
    if (memory.pressureBefore !== parameters.requiredMemoryPressureLevel || memory.pressureAfter !== parameters.requiredMemoryPressureLevel) reasons.push("memory-pressure");
    if (memory.swapoutPages > parameters.maximumSwapoutPages) reasons.push("swapout");
    if (compressedBytes > parameters.maximumCompressedMiB * 2 ** 20) reasons.push("compressed");
  }

  const thermal = record?.thermal ?? null;
  if (!thermal || !present(thermal.stateBefore) || !present(thermal.stateAfter)) {
    reasons.push("missing:thermal");
  } else {
    Object.assign(values, { thermalStateBefore: thermal.stateBefore, thermalStateAfter: thermal.stateAfter });
    if (thermal.stateBefore > parameters.maximumThermalState || thermal.stateAfter > parameters.maximumThermalState) reasons.push("thermal");
    // The OS thermal pressure level (0 nominal) is recorded beside it as a diagnostic: rule I names the thermal
    // state (ProcessInfo.thermalState, which macOS derives from this level), so the level alone never disturbs a block.
    if (present(thermal.pressureLevelBefore) && present(thermal.pressureLevelAfter)) {
      Object.assign(values, { thermalPressureBefore: thermal.pressureLevelBefore, thermalPressureAfter: thermal.pressureLevelAfter });
      if (thermal.pressureLevelBefore > 0 || thermal.pressureLevelAfter > 0) diagnostics.push("thermal-pressure-above-nominal");
    } else diagnostics.push("thermal-pressure-unavailable");
  }

  const cpu = record?.processCpu ?? null;
  if (!cpu || !present(cpu.otherCores)) reasons.push("missing:process-cpu");
  else {
    values.otherProcessCores = cpu.otherCores;
    if (cpu.otherCores > parameters.maximumOtherProcessCores) reasons.push("other-process-cpu");
  }

  const gpu = record?.gpu?.idleBefore ?? null;
  if (!gpu || !present(gpu.deviceUtilization)) reasons.push("missing:gpu");
  else {
    values.idleGpuUtilizationPercent = gpu.deviceUtilization;
    if (gpu.deviceUtilization > parameters.maximumIdleGpuUtilizationPercent) reasons.push("gpu-busy-before");
  }

  const input = record?.input ?? null;
  if (!input || !present(input.secondsSinceInputAfter) || !present(record?.intervalSeconds)) diagnostics.push("input-unavailable");
  else {
    values.secondsSinceInputAfter = input.secondsSinceInputAfter;
    if (input.secondsSinceInputAfter < record.intervalSeconds) diagnostics.push("input-during-block");
  }
  const power = record?.power ?? null;
  if (power?.before?.lowPowerMode || power?.after?.lowPowerMode) diagnostics.push("low-power-mode");
  if (power?.before?.source && power.before.source !== "AC Power") diagnostics.push("not-on-ac-power");
  if (power?.before && power?.after && (power.before.source !== power.after.source || power.before.lowPowerMode !== power.after.lowPowerMode)) diagnostics.push("power-changed");

  return { disturbed: reasons.length > 0, reasons, diagnostics, values };
}

/**
 * Whether to start another round, checked before each round (a round that has
 * started is finished, so a comparison never ends between a candidate and its
 * control): "maximumPairs" once that many rounds have started,
 * "maximumRunSeconds" once `elapsedSeconds` plus `projectedRoundSeconds` (the
 * caller's estimate of the next round, e.g. the longest round so far; 0 when
 * unknown) would exceed the budget, else null. `elapsedSeconds` counts from the
 * start of the comparison, warmup included.
 *
 * minimumPairs is a qualification threshold, not a stopping criterion
 * (DESIGN.md section 9): every comparison runs until one of the two bounds, so
 * the decision to stop never depends on the results seen so far.
 */
export function stopReason({ roundsStarted, elapsedSeconds, projectedRoundSeconds = 0 }, parameters = defaultTimingParameters()) {
  if (!Number.isInteger(roundsStarted) || roundsStarted < 0) throw new Error(`roundsStarted must be a non-negative integer, got ${roundsStarted}`);
  if (!(elapsedSeconds >= 0) || !(projectedRoundSeconds >= 0)) throw new Error("elapsedSeconds and projectedRoundSeconds must be non-negative numbers");
  if (roundsStarted >= parameters.maximumPairs) return "maximumPairs";
  if (elapsedSeconds + projectedRoundSeconds > parameters.maximumRunSeconds) return "maximumRunSeconds";
  return null;
}

/** `metric` is a key of block.summary or a function of the block. */
export function blockValue(block, metric) {
  const value = typeof metric === "function" ? metric(block) : block?.summary?.[metric];
  return present(value) ? value : null;
}

/**
 * Rounds in which every block named in `names` exists, is undisturbed and has
 * a finite `metric`. Returns `{ rounds, excluded }`; `excluded` says, for every
 * other round, which block failed and why.
 */
export function acceptedRounds(blocks, names, metric) {
  const byRound = new Map();
  for (const block of blocks) {
    if (!byRound.has(block.round)) byRound.set(block.round, new Map());
    byRound.get(block.round).set(block.name, block);
  }
  const rounds = [], excluded = [];
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const inRound = byRound.get(round), problems = [];
    for (const name of names) {
      const block = inRound.get(name);
      if (!block) problems.push({ name, reason: "missing block" });
      else if (block.disturbed) problems.push({ name, reason: `disturbed: ${(block.reasons ?? []).join(", ") || "unspecified"}` });
      else if (blockValue(block, metric) === null) problems.push({ name, reason: "no value" });
    }
    if (problems.length) excluded.push({ round, problems });
    else rounds.push(round);
  }
  return { rounds, excluded };
}

function valuesFor(blocks, name, rounds, metric) {
  const byRound = new Map(blocks.filter(block => block.name === name).map(block => [block.round, block]));
  return rounds.map(round => blockValue(byRound.get(round), metric));
}

/** The A/A check on aligned per-round values: median of block medians of each, ratio and |difference| in %. */
export function aaCheck(candidateValues, againValues, parameters = defaultTimingParameters()) {
  const candidate = median(candidateValues), again = median(againValues);
  const within = Number.isFinite(candidate) && Number.isFinite(again) && candidate > 0
    && Math.abs(again - candidate) * 100 <= parameters.maximumAaDifferencePercent * candidate;
  return {
    candidateMedian: candidate, againMedian: again, ratio: again / candidate,
    differencePercent: 100 * Math.abs(again - candidate) / candidate,
    limitPercent: parameters.maximumAaDifferencePercent, within,
    paired: pairedSummary(againValues, candidateValues, parameters.confidence),
  };
}

/**
 * Rule I qualification and the label of what may be claimed. Only GPU timestamp
 * metrics can qualify, and only as conditional observations on this machine
 * when the timer was validated; CPU-time and elapsed metrics stay unqualified.
 */
function qualification({ metricKind, timerValidated, accepted, aa }, parameters) {
  const reasons = [];
  if (metricKind !== "gpu") reasons.push(`a ${metricKind} metric cannot qualify: effective CPU frequency and cluster residency are unobservable without root (rule I)`);
  if (timerValidated !== true) reasons.push("GPU timer validation not supplied or failed");
  if (accepted < parameters.minimumPairs) reasons.push(`${accepted} accepted rounds, fewer than minimumPairs ${parameters.minimumPairs}`);
  if (!aa) reasons.push("no A/A control (candidate-again) for this variant");
  else if (!aa.within) reasons.push(`A/A differs by ${Number.isFinite(aa.differencePercent) ? aa.differencePercent.toFixed(2) : "?"} %, more than ${parameters.maximumAaDifferencePercent} %`);
  const qualified = reasons.length === 0;
  return { qualified, claim: qualified ? "conditional observation on this machine" : "unqualified", reasons };
}

/**
 * One measured variant against its A/A repeat: rounds where `variant` and
 * `<variant>-again` are both undisturbed, the median of block medians,
 * and whether it qualifies (>= minimumPairs rounds, A/A within the limit,
 * GPU metric with a validated timer).
 */
export function qualifyVariant(blocks, variant, { metric, metricKind = "gpu", timerValidated = null }, parameters = defaultTimingParameters()) {
  const hasAgain = blocks.some(block => block.name === againName(variant));
  const names = hasAgain ? [variant, againName(variant)] : [variant];
  const { rounds, excluded } = acceptedRounds(blocks, names, metric);
  const values = valuesFor(blocks, variant, rounds, metric);
  const aa = hasAgain ? aaCheck(values, valuesFor(blocks, againName(variant), rounds, metric), parameters) : null;
  return {
    variant, metric: typeof metric === "function" ? metric.name || "custom" : metric, metricKind,
    acceptedRounds: rounds.length, rounds, excluded,
    medianOfBlockMedians: median(values), interval: medianConfidenceInterval(values, parameters.confidence),
    aa, ...qualification({ metricKind, timerValidated, accepted: rounds.length, aa }, parameters),
  };
}

/**
 * A candidate against a control, paired by round: rounds where the candidate,
 * the control and (if it was run) candidate-again are all undisturbed. Reports
 * the per-round differences candidate - control and ratios candidate / control
 * with order-statistic intervals for their medians, the A/A check on the same
 * rounds, and qualification.
 */
export function compareVariants(blocks, candidate, control, { metric, metricKind = "gpu", timerValidated = null }, parameters = defaultTimingParameters()) {
  const hasAgain = blocks.some(block => block.name === againName(candidate));
  const names = hasAgain ? [candidate, control, againName(candidate)] : [candidate, control];
  const { rounds, excluded } = acceptedRounds(blocks, names, metric);
  const candidateValues = valuesFor(blocks, candidate, rounds, metric), controlValues = valuesFor(blocks, control, rounds, metric);
  const aa = hasAgain ? aaCheck(candidateValues, valuesFor(blocks, againName(candidate), rounds, metric), parameters) : null;
  return {
    candidate, control, metric: typeof metric === "function" ? metric.name || "custom" : metric, metricKind,
    acceptedRounds: rounds.length, rounds, excluded,
    candidateMedian: median(candidateValues), controlMedian: median(controlValues),
    paired: pairedSummary(candidateValues, controlValues, parameters.confidence),
    aa, ...qualification({ metricKind, timerValidated, accepted: rounds.length, aa }, parameters),
  };
}
