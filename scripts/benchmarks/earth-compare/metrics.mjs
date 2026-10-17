/** Pure W0 reductions. Missing measurements stay null; no app FPS counters are used. */
import { quantile } from "../ai-framegen-upscale/lib/stats.mjs";

export function quantiles(values) {
  const list = Array.from(values);
  if (list.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error("quantiles need finite numbers");
  return {
    count: list.length,
    min: list.length ? Math.min(...list) : null,
    p50: list.length ? quantile(list, 0.5) : null,
    p95: list.length ? quantile(list, 0.95) : null,
    p99: list.length ? quantile(list, 0.99) : null,
    max: list.length ? Math.max(...list) : null,
  };
}

// DrawFrame and BeginFrame do not prove presentation. Without an explicit
// presentation event, the result must be unavailable rather than a proxy FPS.
const PRESENTED = ["Display::FrameDisplayed", "FramePresented", "CompositorFramePresented", "FrameDisplayed"];

/**
 * Trace timestamps are microseconds. Use one event family and one process /
 * thread stream so multiple compositor stages cannot masquerade as frames.
 * Supply pid/tid when the trace includes more than the measured page.
 */
export function frameIntervals(traceEvents, { pid, tid, eventName } = {}) {
  if (eventName !== undefined && !PRESENTED.includes(eventName)) throw new Error("eventName must identify presented frames");
  const events = Array.isArray(traceEvents) ? traceEvents : traceEvents?.traceEvents;
  if (!Array.isArray(events)) throw new Error("traceEvents must be an array or a trace object");
  const families = eventName ? [eventName] : PRESENTED;
  let selected = [], selectedName = null;
  for (const name of families) {
    const candidates = events.filter(event => event?.name === name && Number.isFinite(event.ts)
      && (pid === undefined || event.pid === pid) && (tid === undefined || event.tid === tid)
      && event.ph !== "B" && event.ph !== "E");
    if (candidates.length) { selected = candidates; selectedName = name; break; }
  }
  const streams = new Map();
  for (const event of selected) {
    const key = JSON.stringify([event.pid ?? null, event.tid ?? null]);
    if (!streams.has(key)) streams.set(key, new Set());
    streams.get(key).add(event.ts);
  }
  const ranked = [...streams].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  const timestampsMs = ranked.length ? [...ranked[0][1]].sort((a, b) => a - b).map(value => value / 1000) : [];
  const intervalsMs = timestampsMs.slice(1).map((value, index) => value - timestampsMs[index]);
  const [selectedPid, selectedTid] = ranked.length ? JSON.parse(ranked[0][0]) : [pid ?? null, tid ?? null];
  const warnings = [];
  if (selectedName && selectedName !== "Display::FrameDisplayed" && (pid === undefined || tid === undefined)) warnings.push("Presentation scope is unverified; this event family may describe browser UI rather than the measured page.");
  if (ranked.length > 1) warnings.push("Multiple presentation streams; selected the stream with the most distinct timestamps. Supply pid/tid to scope the measured page.");
  if (!intervalsMs.length) warnings.push("Insufficient presented frames; frame timing is unavailable.");
  return { eventName: selectedName, scope: { pid: selectedPid, tid: selectedTid }, timestampsMs, intervalsMs, ...quantiles(intervalsMs), warnings };
}

const failure = (reason, extra = {}) => ({ status: "failed", reason, timeMs: null, heldUntilMs: null, ...extra });

function comparisonOptions(options = {}) {
  const resolved = { threshold: 0.995, holdMs: 2000, tolerance: 8, mask: null, finalQuality: null,
    maxGapMs: 1000, eventDriven: false, captureComplete: false, observedUntilMs: null };
  for (const [key, value] of Object.entries(options)) if (value !== undefined) resolved[key] = value;
  const { threshold, holdMs, tolerance, maxGapMs } = resolved;
  if (!(threshold > 0 && threshold <= 1) || !Number.isFinite(holdMs) || holdMs < 0
      || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 255
      || !(maxGapMs > 0)) throw new Error("invalid visual-completion comparison parameters");
  return resolved;
}

function comparisonGeometry(final, { mask }) {
  const width = final?.width, height = final?.height;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) return failure("invalid-dimensions");
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(pixels * 4)) return failure("invalid-dimensions");
  if (mask !== null && (typeof mask?.length !== "number" || mask.length !== pixels)) return failure("invalid-mask");
  let comparedPixels = 0, firstOffset = null;
  for (let pixel = 0; pixel < pixels; pixel++) if (mask === null || mask[pixel]) {
    if (firstOffset === null) firstOffset = pixel * 4;
    comparedPixels++;
  }
  return comparedPixels ? { width, height, pixels, comparedPixels, firstOffset } : failure("empty-mask");
}

function validFrame(frame, geometry, previousTimestamp = null) {
  if (frame?.width !== geometry.width || frame?.height !== geometry.height || frame?.data?.length !== geometry.pixels * 4
      || typeof frame.data[Symbol.iterator] !== "function" || !Number.isFinite(frame.timestampMs)
      || (previousTimestamp !== null && frame.timestampMs <= previousTimestamp)) return false;
  // Typed byte storage already enforces integer channel values in [0,255].
  if (frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) return true;
  if (!(frame.data instanceof Uint8Array) && !(frame.data instanceof Uint8ClampedArray)) {
    for (const value of frame.data) if (!Number.isInteger(value) || value < 0 || value > 255) return false;
  }
  return true;
}

function finalHasDetail(final, geometry, { mask, tolerance }) {
  const first = geometry.firstOffset;
  for (let pixel = 0; pixel < geometry.pixels; pixel++) {
    if (mask !== null && !mask[pixel]) continue;
    const offset = pixel * 4;
    if (final.data[offset + 3] > tolerance
        && (Math.abs(final.data[offset] - final.data[first]) > tolerance
          || Math.abs(final.data[offset + 1] - final.data[first + 1]) > tolerance
          || Math.abs(final.data[offset + 2] - final.data[first + 2]) > tolerance)) return true;
  }
  return false;
}

function agreement(frame, final, geometry, { mask, tolerance }) {
  let matched = 0;
  for (let pixel = 0; pixel < geometry.pixels; pixel++) {
    if (mask !== null && !mask[pixel]) continue;
    const offset = pixel * 4;
    let equal = true;
    for (let channel = 0; channel < 4; channel++) if (Math.abs(frame.data[offset + channel] - final.data[offset + channel]) > tolerance) { equal = false; break; }
    if (equal) matched++;
  }
  return matched / geometry.comparedPixels;
}

function finishVisualComparison(frames, agreements, hasDetail, geometry, options) {
  const { threshold, holdMs, tolerance, maxGapMs, finalQuality, eventDriven, captureComplete, observedUntilMs } = options;
  const final = frames.at(-1);
  if (eventDriven && (captureComplete !== true || !Number.isFinite(observedUntilMs) || observedUntilMs < final.timestampMs)) return failure("unverified-capture-continuity");
  if (frames.length < 2) return failure("insufficient-frames");
  if (!finalQuality || finalQuality.verified !== true || finalQuality.landmarks !== true || finalQuality.detail !== true) return failure("unverified-final-quality");
  if (finalQuality.failed === true || finalQuality.coarse === true || finalQuality.blank === true) return failure("failed-final-quality");
  if (!hasDetail) return failure("blank-final-frame");
  let start = frames.length - 1;
  while (start > 0 && agreements[start - 1] >= threshold
    && (eventDriven || frames[start].timestampMs - frames[start - 1].timestampMs <= maxGapMs)) start--;
  const heldUntilMs = eventDriven ? observedUntilMs : final.timestampMs;
  const elapsed = heldUntilMs - frames[start].timestampMs;
  const detail = { framesCompared: frames.length, comparedPixels: geometry.comparedPixels, threshold, tolerance, holdMs, maxGapMs, eventDriven, agreements };
  if (elapsed < holdMs) return failure("insufficient-final-hold", { ...detail, observedHoldMs: elapsed });
  return { status: "complete", reason: null, timeMs: frames[start].timestampMs, heldUntilMs, observedHoldMs: elapsed, ...detail };
}

/**
 * Earliest captured frame whose entire remaining suffix matches the final
 * frame, with at least holdMs of observed evidence. A late change invalidates
 * an earlier apparent hold. mask has width*height entries; truthy means INCLUDE.
 * finalQuality is an explicit reviewed gate: {verified,landmarks,detail} must
 * all be true. A stable blank/coarse/error image never counts as completion.
 * maxGapMs prevents sparse sampled screenshots from proving a continuous hold.
 * CDP screencasts are event driven: with eventDriven:true, captureComplete:true
 * and observedUntilMs, a frame persists until the next event/end of capture.
 */
export function visuallyComplete(frames, options = {}) {
  const resolved = comparisonOptions(options);
  if (!Array.isArray(frames) || !frames.length) return failure("missing-frames");
  const final = frames.at(-1), geometry = comparisonGeometry(final, resolved);
  if (geometry.status === "failed") return geometry;
  for (let index = 0; index < frames.length; index++) {
    if (!validFrame(frames[index], geometry, index ? frames[index - 1].timestampMs : null)) return failure("invalid-frame-data", { frameIndex: index });
  }
  return finishVisualComparison(frames, frames.map(frame => agreement(frame, final, geometry, resolved)), finalHasDetail(final, geometry, resolved), geometry, resolved);
}

/**
 * Memory-bounded equivalent: decode(metadata,index) returns {width,height,data}
 * (or a promise). Metadata supplies timestampMs and may contain a file path.
 * Decode the final frame once, then each earlier frame once, sequentially. Only
 * final + current RGBA data are retained; the returned result contains numbers.
 * The decoder must not cache decoded buffers. Decode failures fail the run.
 */
export async function visuallyCompleteStream(frames, decode, options = {}) {
  const resolved = comparisonOptions(options);
  if (!Array.isArray(frames) || !frames.length) return failure("missing-frames");
  if (typeof decode !== "function") throw new Error("decode must be a function");
  const lastIndex = frames.length - 1;
  let final;
  try { final = { ...await decode(frames[lastIndex], lastIndex), timestampMs: frames[lastIndex]?.timestampMs }; }
  catch { return failure("frame-decode-failed", { frameIndex: lastIndex }); }
  const geometry = comparisonGeometry(final, resolved);
  if (geometry.status === "failed") return geometry;
  const finalValid = validFrame(final, geometry, lastIndex ? frames[lastIndex - 1]?.timestampMs : null);
  const agreements = [];
  for (let index = 0; index <= lastIndex; index++) {
    let decoded;
    try { decoded = index === lastIndex ? final : { ...await decode(frames[index], index), timestampMs: frames[index]?.timestampMs }; }
    catch { return failure("frame-decode-failed", { frameIndex: index }); }
    if (!validFrame(decoded, geometry, index ? frames[index - 1]?.timestampMs : null)) return failure("invalid-frame-data", { frameIndex: index });
    // Preserve the array API's first-invalid-frame ordering, even if the final
    // decode has bad bytes: do not compare against it before all validation.
    if (finalValid) agreements.push(agreement(decoded, final, geometry, resolved));
    decoded = null;
  }
  return finishVisualComparison(frames, agreements, finalHasDetail(final, geometry, resolved), geometry, resolved);
}

/** Numeric medians/ranges across runs, recursively, with missing values counted. */
export function aggregate(rows) {
  if (!Array.isArray(rows)) throw new Error("aggregate needs an array of runs");
  const summarize = values => {
    const present = values.filter(value => typeof value === "number" && Number.isFinite(value));
    const min = present.length ? Math.min(...present) : null, max = present.length ? Math.max(...present) : null;
    return { count: present.length, missing: values.length - present.length, median: present.length ? quantile(present, 0.5) : null, min, max, range: [min, max] };
  };
  const visit = values => {
    const objects = values.filter(value => value && typeof value === "object" && !Array.isArray(value));
    if (!objects.length) return summarize(values);
    const result = {};
    for (const key of new Set(objects.flatMap(Object.keys))) {
      const children = values.map(value => value?.[key]);
      if (children.some(value => typeof value === "number" || (value && typeof value === "object" && !Array.isArray(value)))) result[key] = visit(children);
    }
    return result;
  };
  return visit(rows);
}
