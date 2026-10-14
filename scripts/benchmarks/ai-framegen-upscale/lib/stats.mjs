/**
 * Order statistics for the ai-framegen-upscale timing blocks: medians,
 * quantiles, the median of block medians, paired per-round differences and a
 * distribution-free confidence interval for a median.
 *
 * Pure functions on arrays of numbers; nothing here reads a clock or a file.
 * Inputs are never modified (sorting works on a copy). An empty input gives
 * NaN (written as null in JSON): a missing statistic is never zero.
 *
 *   import { median, quantile, medianConfidenceInterval } from "./lib/stats.mjs";
 *   medianConfidenceInterval([3, 1, 2, 5, 4, 6, 7, 9, 8, 10, 11]);
 *   // { count: 11, median: 6, lower: 2, upper: 10, lowerRank: 2, upperRank: 10,
 *   //   requestedConfidence: 0.95, achievedConfidence: 0.98828125, meetsRequested: true }
 */

const ascending = (a, b) => a - b;

function finiteSorted(values) {
  const sorted = Array.from(values, Number).sort(ascending);
  if (sorted.some(value => !Number.isFinite(value))) throw new Error("statistics need finite numbers");
  return sorted;
}

/**
 * The p-quantile of `values` (0 <= p <= 1) by linear interpolation between
 * order statistics: Hyndman and Fan type 7, as R's quantile() and NumPy's
 * default. h = (n - 1) p; x[floor h] + (h - floor h)(x[floor h + 1] - x[floor h]).
 */
export function quantile(values, p) {
  if (!(p >= 0 && p <= 1)) throw new Error(`quantile probability must be in [0, 1], got ${p}`);
  const sorted = finiteSorted(values);
  return quantileSorted(sorted, p);
}

function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * p, low = Math.floor(h), high = Math.min(low + 1, n - 1);
  return sorted[low] + (h - low) * (sorted[high] - sorted[low]);
}

/** The middle value; the mean of the two middle values for an even count. */
export const median = values => quantile(values, 0.5);

export const mean = values => {
  const list = Array.from(values, Number);
  return list.length === 0 ? NaN : list.reduce((sum, value) => sum + value, 0) / list.length;
};

/** Count, extremes, mean and type-7 quantiles (p5, median, p95) of one series. */
export function summary(values) {
  const sorted = finiteSorted(values);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0] : NaN,
    p5: quantileSorted(sorted, 0.05),
    median: quantileSorted(sorted, 0.5),
    p95: quantileSorted(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : NaN,
    mean: mean(sorted),
  };
}

/**
 * A block's summary: the median of each per-iteration series of
 * `seriesByMetric` ({ modelSpanMs: [...], rafIntervalMs: [...] } ->
 * { modelSpanMs: 4.2, rafIntervalMs: 16.67 }). null/undefined entries (an
 * iteration without that reading) are skipped and counted in `missing`.
 */
export function seriesMedians(seriesByMetric) {
  const medians = {}, missing = {};
  for (const [metric, series] of Object.entries(seriesByMetric)) {
    const present = Array.from(series).filter(value => value !== null && value !== undefined);
    medians[metric] = median(present);
    if (present.length !== series.length) missing[metric] = series.length - present.length;
  }
  return { medians, missing };
}

/**
 * The median of each block's median: `blocks` is an array of per-iteration
 * series (one per block). Each block counts once whatever its length, so a
 * long block cannot outvote the others.
 */
export function medianOfBlockMedians(blocks) {
  return median(blocks.map(block => median(block)));
}

/**
 * Per-round differences a[i] - b[i] of two series aligned by round. Pairs where
 * either side is missing (null, undefined or NaN) are dropped and counted, not
 * replaced: `{ differences, rounds, dropped }` where `rounds` are the kept indices.
 */
export function pairedDifferences(a, b) {
  if (a.length !== b.length) throw new Error(`paired series differ in length: ${a.length} and ${b.length}`);
  const differences = [], rounds = [];
  for (let index = 0; index < a.length; index++) {
    if (!Number.isFinite(a[index]) || !Number.isFinite(b[index])) continue;
    differences.push(a[index] - b[index]); rounds.push(index);
  }
  return { differences, rounds, dropped: a.length - differences.length };
}

/** Per-round ratios a[i] / b[i], with the same pairing and dropping as pairedDifferences. */
export function pairedRatios(a, b) {
  if (a.length !== b.length) throw new Error(`paired series differ in length: ${a.length} and ${b.length}`);
  const ratios = [], rounds = [];
  for (let index = 0; index < a.length; index++) {
    if (!Number.isFinite(a[index]) || !Number.isFinite(b[index]) || b[index] === 0) continue;
    ratios.push(a[index] / b[index]); rounds.push(index);
  }
  return { ratios, rounds, dropped: a.length - ratios.length };
}

/**
 * P(X <= k) for X ~ Binomial(n, 1/2): the binomial coefficients are summed
 * exactly in BigInt, scaled by 2^(64 - n) and converted to a double once, so
 * the result is the exact probability rounded once (exact for n <= 53), and
 * the coverage comparisons below are not decided by accumulated rounding.
 */
export function binomialHalfCdf(k, n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`n must be a non-negative integer, got ${n}`);
  if (k < 0) return 0;
  if (k >= n) return 1;
  let coefficient = 1n, total = 1n; // C(n, 0)
  for (let i = 1; i <= k; i++) {
    coefficient = coefficient * BigInt(n - i + 1) / BigInt(i);
    total += coefficient;
  }
  return Number((total << 64n) >> BigInt(n)) / 2 ** 64;
}

/**
 * Distribution-free confidence interval for the population median from order
 * statistics (binomial/sign-test interval; e.g. Conover, Practical
 * Nonparametric Statistics, 3rd ed., sec. 3.2). With the sorted sample
 * x(1) <= ... <= x(n), the interval [x(k), x(n+1-k)] covers the median with
 * probability 1 - 2 P(Binomial(n, 1/2) <= k - 1) for any continuous
 * distribution. The largest k whose coverage reaches `confidence` is used, and
 * the coverage it actually achieves is returned (it is discrete, so usually
 * above the request: n = 11 gives 98.8 % at k = 2, 93.5 % at k = 3).
 *
 * When even k = 1 (the sample range) falls short (n <= 5 for 95 %), the range
 * is returned with `meetsRequested: false` and its lower coverage stated.
 */
export function medianConfidenceInterval(values, confidence = 0.95) {
  if (!(confidence > 0 && confidence < 1)) throw new Error(`confidence must be in (0, 1), got ${confidence}`);
  const sorted = finiteSorted(values), n = sorted.length;
  const result = { count: n, median: quantileSorted(sorted, 0.5), lower: NaN, upper: NaN, lowerRank: null, upperRank: null, requestedConfidence: confidence, achievedConfidence: 0, meetsRequested: false };
  if (n === 0) return result;
  const coverage = k => 1 - 2 * binomialHalfCdf(k - 1, n);
  let rank = 1;
  // Coverage falls as k grows; take the largest k (narrowest interval) that still reaches the request.
  while (rank + 1 <= Math.floor((n + 1) / 2) && coverage(rank + 1) >= confidence) rank++;
  return {
    ...result,
    lower: sorted[rank - 1], upper: sorted[n - rank], lowerRank: rank, upperRank: n + 1 - rank,
    achievedConfidence: coverage(rank), meetsRequested: coverage(rank) >= confidence,
  };
}

/**
 * The summary a paired comparison reports: per-round differences (a - b) and
 * ratios (a / b), their medians, and the order-statistic interval for the
 * median difference and median ratio.
 */
export function pairedSummary(a, b, confidence = 0.95) {
  const { differences, rounds, dropped } = pairedDifferences(a, b);
  const { ratios } = pairedRatios(a, b);
  return {
    pairs: differences.length, rounds, dropped,
    difference: medianConfidenceInterval(differences, confidence),
    ratio: medianConfidenceInterval(ratios, confidence),
  };
}
