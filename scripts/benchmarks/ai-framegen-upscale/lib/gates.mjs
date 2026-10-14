/**
 * The pre-registered acceptance gates of the ai-framegen-upscale screen
 * (build/ai-framegen-upscale/notes/acceptance-rules.md, written 2026-10-12
 * before any WebGPU run) as pure functions. make-tables.mjs maps parity,
 * timing and quality results onto these inputs; every verdict returns the
 * numbers it used, the limits, and (gate G) which bound it relied on.
 *
 * Gate G formulas, verbatim from rule G (all in milliseconds):
 *   FG, per source interval T = 1000 / sourceFps (33.33 ms for 30->60, 16.67 ms for 60->120):
 *     W_FG = Cin + G + Cout + 2P;  R_budget = 0.8 T - W_FG;
 *     advance needs R_budget >= R_est; with R_est unknown, R_budget > 0 (and the report says R is unknown).
 *   SR, per real frame:
 *     W_SR = Cin + U + Cout + P_out;  benefit needs R_low + W_SR <= 0.9 (R_native + P_out);
 *     R_native_min = (W_SR - 0.9 P_out) / (0.9 - rho) for rho = R_low / R_native = 0.25 and 0.5;
 *     advance needs evidence that representative R_native >= R_native_min at rho = 0.25 on a GPU-bound profile.
 *   Combined FG->SR (information only): R_low + G_low + 2U + 2P + C < 1000 / sourceFps.
 *
 * Model-stage costs have two estimates (DESIGN.md section 9): G_span, an upper
 * bound that includes GPU idle while ORT submits, and optionally G_kernels, a
 * lower bound. Pass such a term as `{ upper, lower, upperEstimate: "G_span",
 * lowerEstimate: "G_kernels" }` (lower may be missing); a plain number is an
 * exact measurement (both bounds). The conservative evaluation uses the end of
 * every term that is worse for the candidate (higher costs, lower R_native); an
 * advance needs the conservative evaluation to pass; a stop needs the
 * optimistic one to fail too, otherwise it is "stop at upper bound" (no lower
 * bound) or "inconclusive" (the bounds disagree). Each G verdict states
 * `bound` ("upper", "lower", "between") and `reliedOn`: per bounded term, the
 * end and estimate it used.
 *
 *   import { fgScreens, srScreen, checkDeviceParity } from "./lib/gates.mjs";
 *   fgScreens({ Cin: 0.3, G: { upper: 13, lower: 11, upperEstimate: "G_span", lowerEstimate: "G_kernels" }, Cout: 0.2, P: 0.1, R_est: null });
 *   // { "30->60": { verdict: "advance", bound: "upper", conservative: { W_FG: 13.7, R_budget: 12.97, ... },
 *   //               reliedOn: { G: { bound: "upper", value: 13, estimate: "G_span" } }, ... },
 *   //   "60->120": { verdict: "inconclusive", bound: "between", conservative: { R_budget: -0.37 }, optimistic: { R_budget: 1.63 }, ... } }
 */

/** Rules A-F and H limits. C's percentages are compared exactly when counts are given. */
export const THRESHOLDS = {
  A: { fp32: { maxAbs: 1e-3, meanAbs: 1e-5 }, fp16: { maxAbs: 5e-2, meanAbs: 2e-3 } },
  B: { fp32: { maxAbs: 2e-2, meanAbs: 1e-3, psnrDb: 50 }, fp16: { maxAbs: 6e-2, meanAbs: 4e-3, psnrDb: 40 } },
  // Percent within +-1 code as tenths of a percent (995 = 99.5 %), so counts compare in integers.
  C: { fp32: { withinOnePerMille: 995, maxDifference: 8 }, fp16: { withinOnePerMille: 980, maxDifference: 16 } },
  F: { maximumIncrementalBytes: 256 * 2 ** 20 },
  G: { headroom: 0.8, srFraction: 0.9, rhos: [0.25, 0.5], advanceRho: 0.25 },
  H: { maximumFlickerExcess: 0.1 },
};

const finite = value => typeof value === "number" && Number.isFinite(value);
const check = (name, value, comparison, limit) => {
  const pass = finite(value) || value === Infinity
    ? comparison === "<=" ? value <= limit : comparison === ">=" ? value >= limit : comparison === "<" ? value < limit : value > limit
    : false;
  return { name, value: finite(value) ? value : value === Infinity ? "Infinity" : null, comparison, limit: finite(limit) ? limit : null, pass };
};
const verdict = (gate, fields, checks) => ({ gate, ...fields, pass: checks.length > 0 && checks.every(item => item.pass), checks });
function limitsFor(gate, precision) {
  const limits = THRESHOLDS[gate][precision];
  if (!limits) throw new Error(`gate ${gate} has no limits for precision ${precision}`);
  return limits;
}

/** Rule A: ORT CPU vs PyTorch fp32 on the same padded input. `{ precision, maxAbs, meanAbs }`. */
export function checkExportParity({ precision, maxAbs, meanAbs }) {
  const limits = limitsFor("A", precision);
  return verdict("A", { precision }, [check("maxAbs", maxAbs, "<=", limits.maxAbs), check("meanAbs", meanAbs, "<=", limits.meanAbs)]);
}

/** Rule B: device output vs the stored fp32 reference. `{ precision, maxAbs, meanAbs, psnrDb }` (PSNR with peak 1; Infinity when identical). */
export function checkDeviceParity({ precision, maxAbs, meanAbs, psnrDb }) {
  const limits = limitsFor("B", precision);
  return verdict("B", { precision }, [
    check("maxAbs", maxAbs, "<=", limits.maxAbs), check("meanAbs", meanAbs, "<=", limits.meanAbs), check("psnrDb", psnrDb, ">=", limits.psnrDb),
  ]);
}

/**
 * Rule C: full 8-bit path vs round(clip(reference) * 255). Give
 * `{ precision, withinOne, total, maxDifference }` (counts of RGB values; compared
 * exactly) or `{ precision, withinOneFraction, maxDifference }` (0..1).
 */
export function checkFullPath({ precision, withinOne, total, withinOneFraction, maxDifference }) {
  const limits = limitsFor("C", precision);
  let within;
  if (Number.isInteger(withinOne) && Number.isInteger(total) && total > 0) {
    within = { name: "withinOneCodePercent", value: 100 * withinOne / total, counts: { withinOne, total }, comparison: ">=", limit: limits.withinOnePerMille / 10, pass: withinOne * 1000 >= limits.withinOnePerMille * total };
  } else {
    within = check("withinOneCodePercent", finite(withinOneFraction) ? 100 * withinOneFraction : null, ">=", limits.withinOnePerMille / 10);
  }
  return verdict("C", { precision }, [within, check("maxDifference", maxDifference, "<=", limits.maxDifference)]);
}

/**
 * Rule D: zero nodes on a CPU execution provider, from ORT's own placement
 * diagnostics. `{ cpuNodes, statement }`: cpuNodes null (no parseable
 * statement) is UNVERIFIED and fails.
 */
export function checkPlacement({ cpuNodes, statement = null }) {
  const verified = Number.isInteger(cpuNodes);
  return { gate: "D", status: verified ? (cpuNodes === 0 ? "pass" : "fail") : "UNVERIFIED", pass: verified && cpuNodes === 0, cpuNodes: verified ? cpuNodes : null, statement };
}

/**
 * Rule E: ORT's device is the harness device, GPU-buffer inputs accepted, the
 * output consumed by a harness pass with zero errors. `{ sameDevice,
 * gpuInputsAccepted, outputConsumed, scopeErrors, uncapturedErrors, deviceLost, proof }`.
 */
export function checkInjection({ sameDevice, gpuInputsAccepted, outputConsumed, scopeErrors, uncapturedErrors, deviceLost, proof = null }) {
  const checks = [
    { name: "sameDevice", value: sameDevice ?? null, pass: sameDevice === true },
    { name: "gpuInputsAccepted", value: gpuInputsAccepted ?? null, pass: gpuInputsAccepted === true },
    { name: "outputConsumed", value: outputConsumed ?? null, pass: outputConsumed === true },
    check("scopeErrors", scopeErrors, "<=", 0), check("uncapturedErrors", uncapturedErrors, "<=", 0),
    { name: "deviceLost", value: deviceLost ?? null, pass: deviceLost === false },
  ];
  return verdict("E", { proof }, checks);
}

/** Rule F: accounted peak incremental live bytes <= 256 MiB. `{ peakIncrementalBytes }`. */
export function checkMemory({ peakIncrementalBytes }) {
  return verdict("F", { limitMiB: THRESHOLDS.F.maximumIncrementalBytes / 2 ** 20 }, [check("peakIncrementalBytes", peakIncrementalBytes, "<=", THRESHOLDS.F.maximumIncrementalBytes)]);
}

/**
 * `{ upper, lower, upperEstimate, lowerEstimate, exact }` of a cost term. A
 * number is exact (both bounds). An object `{ upper, lower?, upperEstimate?,
 * lowerEstimate? }` names its estimates, e.g. `{ upper: 4.2, lower: 3.1,
 * upperEstimate: "G_span", lowerEstimate: "G_kernels" }`; a missing lower is null.
 */
export function termBounds(term, name = "term") {
  if (finite(term)) return { upper: term, lower: term, upperEstimate: null, lowerEstimate: null, exact: true };
  if (term && finite(term.upper)) {
    if (finite(term.lower) && term.lower > term.upper) throw new Error(`${name}: lower bound ${term.lower} exceeds upper bound ${term.upper}`);
    return { upper: term.upper, lower: finite(term.lower) ? term.lower : null, upperEstimate: term.upperEstimate ?? null, lowerEstimate: finite(term.lower) ? term.lowerEstimate ?? null : null, exact: false };
  }
  throw new Error(`${name} needs a number or { upper, lower }`);
}

function bounded(terms) {
  const bounds = Object.fromEntries(Object.entries(terms).map(([name, term]) => [name, termBounds(term, name)]));
  const hasLower = Object.values(bounds).every(bound => bound.lower !== null);
  const exact = Object.values(bounds).every(bound => bound.exact);
  return { bounds, hasLower, exact, upper: name => bounds[name].upper, lower: name => bounds[name].lower };
}

/**
 * advance / stop / "stop at upper bound" / inconclusive from the conservative
 * and (optional) optimistic evaluations, and the bound the verdict relied on:
 * "upper" (an advance, or a stop with no lower bound to confirm it), "lower"
 * (a stop the lower bound confirms), "between" (the bounds disagree) or
 * "exact" (every term was a plain number; pass G_span as `{ upper }` so that a
 * stop on it alone is labelled "stop at upper bound").
 */
function decide(conservative, optimistic, exact = false) {
  if (exact) return { verdict: conservative.pass ? "advance" : "stop", bound: "exact" };
  if (conservative.pass) return { verdict: "advance", bound: "upper" };
  if (!optimistic) return { verdict: "stop at upper bound", bound: "upper" };
  return optimistic.pass ? { verdict: "inconclusive", bound: "between" } : { verdict: "stop", bound: "lower" };
}

/**
 * For each cost term among `names` that has bounds (not exact), the end the
 * deciding evaluation used and its estimate name, e.g.
 * `{ G: { bound: "upper", value: 4.2, estimate: "G_span" } }`; null for an
 * inconclusive or undecided verdict.
 */
function reliedOn(bounds, bound, names = Object.keys(bounds)) {
  if (bound !== "upper" && bound !== "lower") return null;
  return Object.fromEntries(names.filter(name => !bounds[name].exact).map(name => {
    const entry = bounds[name], used = entry[bound] === null ? "upper" : bound;
    return [name, { bound: used, value: entry[used], estimate: entry[`${used}Estimate`] }];
  }));
}

const intervalLabel = sourceFps => (sourceFps === 30 ? "30->60" : sourceFps === 60 ? "60->120" : `${sourceFps}->${2 * sourceFps}`);

/**
 * Rule G, frame generation. `{ sourceFps, Cin, G, Cout, P, R_est }` in ms;
 * G usually `{ upper: G_span, lower: G_kernels }`; R_est null when the
 * representative world-render cost is unknown. 60 -> 120 (sourceFps 60) is
 * evaluated from the stage costs measured at 60 Hz presentation and labelled so.
 */
export function fgScreen({ sourceFps, Cin, G, Cout, P, R_est = null }) {
  if (!(sourceFps > 0)) throw new Error("fgScreen needs sourceFps");
  const T = 1000 / sourceFps, { headroom } = THRESHOLDS.G;
  const { bounds, hasLower, exact, upper, lower } = bounded({ Cin, G, Cout, P });
  const known = finite(R_est);
  const evaluate = pick => {
    const W_FG = pick("Cin") + pick("G") + pick("Cout") + 2 * pick("P");
    const R_budget = headroom * T - W_FG;
    return { Cin: pick("Cin"), G: pick("G"), Cout: pick("Cout"), P: pick("P"), W_FG, R_budget, pass: known ? R_budget >= R_est : R_budget > 0 };
  };
  const conservative = evaluate(upper), optimistic = hasLower ? evaluate(lower) : null;
  const decision = decide(conservative, optimistic, exact);
  return {
    gate: "G-FG", interval: intervalLabel(sourceFps), sourceFps, T, headroom,
    formula: "W_FG = Cin + G + Cout + 2P; R_budget = 0.8 T - W_FG; advance needs R_budget >= R_est (R_est unknown: R_budget > 0)",
    inputs: { bounds, R_est: known ? R_est : null }, rKnown: known,
    note: known ? null : "R is unknown: the screen only checks R_budget > 0",
    evaluation: sourceFps === 30 ? "presented: 30 -> 60 on the 60 Hz display" : `computed from the stage costs measured at 60 Hz presentation with T = ${T.toFixed(2)} ms; ${intervalLabel(sourceFps)} cannot be presented by a 60 Hz requestAnimationFrame`,
    conservative, optimistic, ...decision, reliedOn: reliedOn(bounds, decision.bound),
  };
}

/** The source rates rule G names for frame generation: 30 -> 60 (T = 33.33 ms) and 60 -> 120 (T = 16.67 ms). */
export const FG_SOURCE_FPS = [30, 60];

/** fgScreen() for every rate of FG_SOURCE_FPS with the same stage costs, keyed by interval label. */
export const fgScreens = terms => Object.fromEntries(FG_SOURCE_FPS.map(sourceFps => [intervalLabel(sourceFps), fgScreen({ ...terms, sourceFps })]));

/** R_native_min = (W_SR - 0.9 P_out) / (0.9 - rho). */
export const srBreakEven = (W_SR, P_out, rho) => (W_SR - THRESHOLDS.G.srFraction * P_out) / (THRESHOLDS.G.srFraction - rho);

/**
 * Rule G, super-resolution. `{ Cin, U, Cout, P_out }` in ms (U usually
 * `{ upper, lower }`), optional measured `R_low` and `R_native` of this run's
 * renderer for the benefit inequality, and `representative: { R_native,
 * gpuBound, source }`: the evidence the advance condition needs. Without it the
 * verdict is "no evidence" (not an advance); the break-even is still reported.
 */
export function srScreen({ Cin, U, Cout, P_out, R_low = null, R_native = null, representative = null }) {
  const { srFraction, rhos, advanceRho } = THRESHOLDS.G;
  const terms = { Cin, U, Cout, P_out };
  if (finite(R_low) || (R_low && typeof R_low === "object")) terms.R_low = R_low;
  if (finite(R_native) || (R_native && typeof R_native === "object")) terms.R_native = R_native;
  const { bounds, upper } = bounded(terms);
  const measured = "R_low" in terms && "R_native" in terms;
  // The advance decision rests on the break-even, a function of these four costs only.
  const decisionTerms = ["Cin", "U", "Cout", "P_out"];
  const exact = decisionTerms.every(name => bounds[name].exact);
  const costsHaveLower = decisionTerms.every(name => bounds[name].lower !== null);
  // Conservative: costs at their upper ends, R_native at its lower end; optimistic the reverse (a missing
  // lower bound of R_low stays at its upper end).
  const evaluate = (cost, benefit) => {
    const W_SR = cost("Cin") + cost("U") + cost("Cout") + cost("P_out");
    const breakEven = Object.fromEntries(rhos.map(rho => [rho, srBreakEven(W_SR, cost("P_out"), rho)]));
    const result = { Cin: cost("Cin"), U: cost("U"), Cout: cost("Cout"), P_out: cost("P_out"), W_SR, R_native_min: breakEven };
    if (measured) {
      const left = cost("R_low") + W_SR, right = srFraction * (benefit("R_native") + cost("P_out"));
      Object.assign(result, { R_low: cost("R_low"), R_native: benefit("R_native"), benefit: { left, right, pass: left <= right, rho: cost("R_low") / benefit("R_native") } });
    }
    return result;
  };
  const lowerOrUpper = name => bounds[name].lower ?? bounds[name].upper;
  const conservative = evaluate(upper, lowerOrUpper);
  const optimistic = costsHaveLower ? evaluate(lowerOrUpper, upper) : null;

  const rep = representative && finite(representative.R_native) ? representative : null;
  let decision;
  if (!rep || representative.gpuBound !== true) {
    decision = { verdict: "no evidence", bound: null, reason: !rep ? "no representative R_native" : "the representative profile is not shown to be GPU-bound" };
  } else {
    const pass = evaluation => ({ pass: rep.R_native >= evaluation.R_native_min[advanceRho] });
    decision = decide(pass(conservative), optimistic ? pass(optimistic) : null, exact);
  }
  return {
    gate: "G-SR", srFraction, advanceRho,
    formula: "W_SR = Cin + U + Cout + P_out; benefit needs R_low + W_SR <= 0.9 (R_native + P_out); R_native_min = (W_SR - 0.9 P_out) / (0.9 - rho); advance needs representative R_native >= R_native_min at rho = 0.25 on a GPU-bound profile",
    inputs: { bounds, representative: rep ? { R_native: rep.R_native, gpuBound: rep.gpuBound === true, source: rep.source ?? null } : null },
    conservative, optimistic, ...decision, reliedOn: reliedOn(bounds, decision.bound, decisionTerms),
  };
}

/**
 * Combined FG->SR serialized-work screen, information only (Stage 6):
 * R_low + G_low + 2U + 2P + C < 1000 / sourceFps. G_low from RIFE 540p, U from
 * RT4KSR 1080p (DESIGN.md section 9).
 */
export function combinedScreen({ sourceFps, R_low, G_low, U, P, C }) {
  const budget = 1000 / sourceFps;
  const { bounds, hasLower, upper, lower } = bounded({ R_low, G_low, U, P, C });
  const evaluate = pick => {
    const total = pick("R_low") + pick("G_low") + 2 * pick("U") + 2 * pick("P") + pick("C");
    return { total, pass: total < budget };
  };
  return {
    gate: "G-combined", informationOnly: true, sourceFps, budget,
    formula: "R_low + G_low + 2U + 2P + C < 1000 / sourceFps",
    inputs: { bounds }, conservative: evaluate(upper), optimistic: hasLower ? evaluate(lower) : null,
  };
}

const exceedsBoth = (model, controls, key) => controls.map(([name, control]) => check(`${key} > ${name}`, model?.[key], ">", control?.[key]));

/**
 * Rule H, frame generation: for every sequence, the median PSNR and the median
 * SSIM of the model midpoints must exceed (strictly) both the repeat and the
 * blend control. `sequences`: [{ sequence, model: { psnr, ssim }, repeat: {...}, blend: {...} }]
 * (medians over the sequence's pairs, cut-straddling pairs excluded upstream).
 */
export function checkFgQuality(sequences) {
  const results = sequences.map(entry => {
    const checks = ["psnr", "ssim"].flatMap(key => exceedsBoth(entry.model, [["repeat", entry.repeat], ["blend", entry.blend]], key));
    return { sequence: entry.sequence, pass: checks.every(item => item.pass), checks };
  });
  return { gate: "H-FG", pass: results.length > 0 && results.every(result => result.pass), sequences: results };
}

/**
 * Rule H, super-resolution: median PSNR and SSIM against native rendering must
 * exceed bilinear and bicubic of the same half-resolution source, and flicker
 * must not exceed bicubic's by more than 10 %: model flicker / bicubic flicker
 * <= 1.10 (the ratio form quality.py uses; a zero or missing bicubic flicker
 * leaves the ratio undefined, which fails). `{ overall, sequences }`, each
 * entry `{ model: { psnr, ssim, flicker }, bilinear: { psnr, ssim }, bicubic:
 * { psnr, ssim, flicker } }`. The SR bullet names no unit, so, as quality.py,
 * it is applied to the pooled ("overall") medians and to every sequence; all
 * must pass.
 */
export function checkSrQuality({ overall = null, sequences = [] }) {
  const limit = 1 + THRESHOLDS.H.maximumFlickerExcess;
  const judge = entry => {
    const model = entry.model?.flicker, bicubic = entry.bicubic?.flicker;
    const ratio = finite(model) && finite(bicubic) && bicubic > 0 ? model / bicubic : null;
    const checks = [
      ...["psnr", "ssim"].flatMap(key => exceedsBoth(entry.model, [["bilinear", entry.bilinear], ["bicubic", entry.bicubic]], key)),
      { ...check("flicker / bicubic flicker", ratio, "<=", limit), modelFlicker: finite(model) ? model : null, bicubicFlicker: finite(bicubic) ? bicubic : null },
    ];
    return { sequence: entry.sequence ?? null, pass: checks.every(item => item.pass), checks };
  };
  const overallResult = overall ? judge({ sequence: "pooled", ...overall }) : null;
  const results = sequences.map(judge);
  return {
    gate: "H-SR",
    pass: (overallResult !== null || results.length > 0) && (overallResult?.pass ?? true) && results.every(result => result.pass),
    overall: overallResult, sequences: results,
  };
}

/**
 * checkFgQuality() input from one regime of quality.py's results
 * (`fg[candidate][profile][precision][regime]`, i.e. summarize_fg():
 * `{ sequences: { <name>: { pairs, medians: { psnr_model, psnr_repeat, psnr_blend, ssim_model, ... } } } }`).
 * quality.py writes medians rounded to 6 decimals and an infinite PSNR as
 * null, so a verdict recomputed here can differ from quality.py's own at an
 * exact tie or for identical images; report both and flag a disagreement.
 */
export function fgQualityEntries(regime) {
  const pick = (medians, method) => ({ psnr: medians?.[`psnr_${method}`] ?? null, ssim: medians?.[`ssim_${method}`] ?? null });
  return Object.entries(regime?.sequences ?? {}).map(([sequence, entry]) => ({
    sequence, pairs: entry.pairs ?? null, model: pick(entry.medians, "model"), repeat: pick(entry.medians, "repeat"), blend: pick(entry.medians, "blend"),
  }));
}

/**
 * checkSrQuality() input from quality.py's SR summary (`sr[candidate][profile][precision]`,
 * summarize_sr(): `{ pooled, sequences: { <name>: { medians: { psnr_model, ... }, flicker: { model, bilinear, bicubic } } } }`).
 * The same rounding caveat as fgQualityEntries applies (flicker is rounded to 8 decimals).
 */
export function srQualityInput(summary) {
  const entry = part => ({
    model: { psnr: part?.medians?.psnr_model ?? null, ssim: part?.medians?.ssim_model ?? null, flicker: part?.flicker?.model ?? null },
    bilinear: { psnr: part?.medians?.psnr_bilinear ?? null, ssim: part?.medians?.ssim_bilinear ?? null },
    bicubic: { psnr: part?.medians?.psnr_bicubic ?? null, ssim: part?.medians?.ssim_bicubic ?? null, flicker: part?.flicker?.bicubic ?? null },
  });
  return {
    overall: summary?.pooled ? entry(summary.pooled) : null,
    sequences: Object.entries(summary?.sequences ?? {}).map(([sequence, part]) => ({ sequence, ...entry(part) })),
  };
}
