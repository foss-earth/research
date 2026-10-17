/** Offline W0 review. Raw captures are immutable; only analysis.json is written. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aggregate, frameIntervals, visuallyCompleteStream } from "./metrics.mjs";
import { IMAGE_POLICY, redact, checkedImagePolicy, imageMask, imagePolicyDigest, qualificationReasons, maskUiReasons } from "./support.mjs";
import { renderGeometry, compareRenderGeometry, cropRenderImage } from "./renderGeometry.mjs";
import { earthPolicyReasons } from "./earthUi.mjs";

const owner = fileURLToPath(new URL("../../../", import.meta.url));
const defaultBuildRoot = path.join(owner, "build");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const isText = value => typeof value === "string" && value.trim().length > 0;
const numeric = value => typeof value === "number" && Number.isFinite(value);
const json = file => JSON.parse(readFileSync(file, "utf8"));

/** Reject redirected ancestors as well as '..' and sibling-prefix escapes. */
export function checkedBuildPath(input, { buildRoot = defaultBuildRoot, file = false } = {}) {
  const root = path.resolve(buildRoot), candidate = path.resolve(input);
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) throw new Error("Research build is redirected");
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Analysis paths must remain under this research build/");
  let current = root;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || realpathSync(current) !== current) throw new Error("Analysis cannot follow symlinks or redirected ancestors");
    if (index < parts.length - 1 || !file) {
      if (!stat.isDirectory()) throw new Error("Analysis directory is not a directory");
    } else if (!stat.isFile()) throw new Error("Analysis input is not a regular file");
  }
  return candidate;
}

function relativePath(root, value, options) {
  if (!isText(value) || path.isAbsolute(value) || value.includes("\\") || value.split("/").some(part => part === ".." || part === "." || part === "")) throw new Error("Invalid relative capture path");
  return checkedBuildPath(path.join(root, value), options);
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Final frame is not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function reviewReasons(review, finalSha256) {
  const reasons = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) return ["Missing per-observation review"];
  for (const field of ["reviewer", "source", "evidence"]) if (!isText(review[field])) reasons.push(`Review needs ${field}`);
  for (const field of ["cameraMatched", "maskReviewed", "landmarks", "detail"]) if (review[field] !== true) reasons.push(`Review has not approved ${field}`);
  if (typeof review.finalSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(review.finalSha256)
    || review.finalSha256.toLowerCase() !== finalSha256) reasons.push("Review finalSha256 does not identify this exact final PNG");
  return reasons;
}

function powerReasons(record) {
  if (record.powerMode !== "battery" && !record.power) return [];
  const value = record.power, reasons = [];
  if (!value || value.status !== "ok" || !numeric(value.coverage) || value.coverage < 0.95
    || value.rejectedSamples !== 0 || !numeric(value.coveredMs) || !numeric(record.durationMs)
    || value.coveredMs < record.durationMs * 0.95 || !numeric(value.wholeMachineWatts)
    || !numeric(value.idleWatts) || value.idleWatts < 0 || !numeric(value.wattsOverIdle)) reasons.push("Power is missing, incomplete, or lacks an idle baseline");
  if (!Array.isArray(record.batteries) || record.batteries.length < 2
    || record.batteries.some(sample => sample?.valid !== true || sample.power?.source !== "Battery Power" || sample.power?.lowPowerMode !== true)) reasons.push("Battery samples do not continuously confirm discharge and Low Power Mode");
  return reasons;
}

/** indexRecord supplies only a directory; observation.json is the raw authority. */
export async function analyzeObservation(runDirectory, indexRecord, review, options = {}) {
  const { buildRoot = defaultBuildRoot, decodePng: injectedDecoder, expectedImagePolicy = IMAGE_POLICY } = options;
  const checked = { buildRoot }, run = checkedBuildPath(runDirectory, checked);
  const directory = relativePath(run, indexRecord?.directory, checked);
  if (!directory.startsWith(run + path.sep)) throw new Error("Observation directory escaped its run");
  const record = json(checkedBuildPath(path.join(directory, "observation.json"), { ...checked, file: true }));
  if (record.directory !== indexRecord.directory) throw new Error("Observation index and raw directory disagree");
  if (!Array.isArray(record.frames) || !record.frames.length) throw new Error("Observation has no final frame");
  const frames = record.frames.map(frame => {
    if (!isText(frame.file) || !frame.file.startsWith("frames/")) throw new Error("Captured image must be a frames/ subpath");
    const file = relativePath(directory, frame.file, { ...checked, file: true });
    if (!file.startsWith(directory + path.sep)) throw new Error("Frame escaped its observation");
    return { ...frame, absoluteFile: file };
  });
  const final = readFileSync(frames.at(-1).absoluteFile), finalSha256 = hash(final);
  const reasons = reviewReasons(review, finalSha256);
  if (record.finalSha256 !== finalSha256) reasons.push("Raw finalSha256 does not match the retained final PNG");
  if (!Array.isArray(record.problems)) reasons.push("Raw capture problems are missing");
  else reasons.push(...record.problems.map(problem => `Capture: ${String(problem)}`));
  if (record.contention !== "exclusive" || record.headed !== true || record.visualCapture !== true) reasons.push("W0 requires exclusive headed visual capture");
  if (!Array.isArray(record.disturbances) || record.disturbances.length) reasons.push("Machine-state disturbance evidence is missing or not clean");
  if (!["adapter", "battery"].includes(record.powerMode)) reasons.push("Diagnostic power mode cannot qualify W0");
  if (record.powerMode === "adapter" && [record.telemetryBefore, record.telemetryAfter].some(sample => sample?.power?.source !== "AC Power")) reasons.push("Adapter power is not confirmed at both boundaries");
  let imagePolicy = expectedImagePolicy;
  try {
    imagePolicy = checkedImagePolicy(record.imagePolicy);
    if (imagePolicyDigest(imagePolicy) !== imagePolicyDigest(expectedImagePolicy)) reasons.push("Image policy differs from the predeclared method");
    reasons.push(...qualificationReasons(review, { imagePolicy }));
  } catch (error) { reasons.push(error.message); imagePolicy = checkedImagePolicy(expectedImagePolicy); }
  if (!numeric(record.encodedBytes) || record.encodedBytes < 0) reasons.push("Downloaded-byte measurement is unavailable");
  if (!numeric(record.taskDurationMs) || record.taskDurationMs < 0) reasons.push("Main-thread task duration is unavailable");
  if (!numeric(record.jsHeapBytes) || record.jsHeapBytes <= 0) reasons.push("JavaScript heap is unavailable");
  if (!Array.isArray(record.processes) || !record.processes.length || record.processes.some(process => !numeric(process.cpuMs) || process.cpuMs < 0
    || !numeric(process.rssBeforeBytes) || !numeric(process.rssAfterBytes) || process.rssBeforeBytes < 0 || process.rssAfterBytes < 0)) reasons.push("Per-process CPU or resident memory is unavailable");
  reasons.push(...powerReasons(record));
  const dimensions = pngDimensions(final);
  if (record.dimensions && (record.dimensions.width !== dimensions.width || record.dimensions.height !== dimensions.height)) reasons.push("Recorded render dimensions differ from final PNG");
  const geometry = renderGeometry(record.renderInfo), referenceGeometry = renderGeometry(record.referenceRenderInfo);
  const geometryComparison = compareRenderGeometry(referenceGeometry, geometry);
  if (!geometryComparison.matched) reasons.push(...geometryComparison.reasons.map(reason => `Render geometry: ${reason}`));
  reasons.push(...maskUiReasons(record.renderInfo, geometry, imagePolicy));
  if (record.target === "google-earth" && (record.earthPolicy?.policyVerified !== true
    || record.earthPolicy?.reasons?.length !== 0 || earthPolicyReasons(record.earthPolicy?.evidence).length)) reasons.push("Google public Clean/Satellite/3D/animation policy is unverified");
  const trace = json(checkedBuildPath(path.join(directory, "trace.json"), { ...checked, file: true }));
  const kind = record.kind ?? (record.phase === "idle" ? "idle" : "load");
  let intervalTrace = trace;
  if (kind === "motion" && numeric(record.motionDurationMs)) {
    if (!numeric(record.traceStartUs) || !numeric(record.actionEndMs)) reasons.push("Motion trace clocks are unavailable");
    else intervalTrace = (trace.traceEvents ?? trace).filter(event => event.ts <= record.traceStartUs + record.actionEndMs * 1000);
  }
  const intervals = frameIntervals(intervalTrace);
  if (!["load", "settle", "motion", "idle"].includes(kind)) reasons.push("Unknown observation kind");
  if (intervals.count === 0 && kind !== "idle") reasons.push("Presented-frame timing is unavailable");
  if (intervals.count > 0 && intervals.warnings.length) reasons.push("Presented-frame stream is ambiguous");
  if (kind === "motion" && record.pathComparison?.matched !== true) reasons.push("Sampled camera motion is unmatched");
  if (kind !== "motion" && record.cameraComparison?.matched !== true) reasons.push("Measured camera pose is unmatched or unavailable");
  if (kind === "motion" && (!compareRenderGeometry(renderGeometry(record.renderInfoBefore), geometry).matched
    || JSON.stringify(renderGeometry(record.renderInfoBefore).rect) !== JSON.stringify(geometry.rect))) reasons.push("Render geometry changed during motion or its initial evidence is missing");
  let decode = injectedDecoder;
  if (!decode) ({ decodePng: decode } = await import("@foss-earth/images/node"));
  const approved = reviewReasons(review, finalSha256).length === 0;
  const cropped = image => geometry.valid ? cropRenderImage(image, geometry) : image;
  const referenceImage = cropped(await decode(final, { maxPixels: 20_000_000 }));
  const mask = imageMask(referenceImage.width, referenceImage.height, imagePolicy);
  const visual = await visuallyCompleteStream(frames, async frame => {
    const image = await decode(readFileSync(frame.absoluteFile), { maxPixels: 20_000_000 });
    return cropped({ width: image.width, height: image.height, data: image.rgba ?? image.data });
  }, { ...imagePolicy, mask, finalQuality: { verified: approved, landmarks: approved, detail: approved },
    eventDriven: true, captureComplete: !record.problems?.some(problem => String(problem).startsWith("screencast")), observedUntilMs: record.durationMs });
  if (visual.status !== "complete" && (kind !== "motion" || visual.reason !== "insufficient-final-hold")) reasons.push(`Visual completion: ${visual.reason}`);
  if (kind === "motion" && numeric(record.motionDurationMs) && visual.status !== "complete") reasons.push("Settling did not complete within the observed window");
  return { directory: record.directory, target: record.target, view: record.view, repeat: record.repeat, phase: record.phase,
    kind, powerMode: record.powerMode, finalSha256, review: review ?? null, qualified: reasons.length === 0, reasons,
    imagePolicy, imagePolicySha256: imagePolicyDigest(imagePolicy), dimensions, renderGeometry: geometry, geometryComparison, visual, frameIntervals: intervals,
    metrics: { encodedBytes: record.encodedBytes, visuallyCompleteMs: kind === "motion" ? null : visual.timeMs,
      settlingMs: kind === "settle" ? visual.timeMs : kind === "motion" && numeric(record.motionDurationMs) && visual.status === "complete" && numeric(record.actionEndMs)
        ? Math.max(0, visual.timeMs - record.actionEndMs) : null,
      taskDurationMs: record.taskDurationMs, jsHeapBytes: record.jsHeapBytes,
      cpuMs: record.processes?.reduce((total, process) => numeric(process.cpuMs) && total !== null ? total + process.cpuMs : null, 0) ?? null,
      rssAfterBytes: record.processes?.reduce((total, process) => numeric(process.rssAfterBytes) && total !== null ? total + process.rssAfterBytes : null, 0) ?? null,
      frameP50: intervals.p50, frameP95: intervals.p95, frameP99: intervals.p99, wattsOverIdle: record.power?.wattsOverIdle ?? null },
  };
}

/** Only this new analysis artifact is written; captures and reviews stay untouched. */
export async function analyzeRun(directory, reviews, options = {}) {
  const run = checkedBuildPath(directory, { buildRoot: options.buildRoot ?? defaultBuildRoot });
  const index = json(checkedBuildPath(path.join(run, "observations.json"), { buildRoot: options.buildRoot ?? defaultBuildRoot, file: true }));
  if (!Array.isArray(index)) throw new Error("observations.json must contain an observation array");
  if (!reviews || typeof reviews !== "object" || Array.isArray(reviews)) throw new Error("Reviews must be an object keyed by relative observation directory");
  const observations = [];
  const method = json(checkedBuildPath(path.join(run, "method.json"), { buildRoot: options.buildRoot ?? defaultBuildRoot, file: true }));
  if (method.schema !== 2 || !method.imagePolicies) throw new Error("Missing predeclared render-canvas image policies");
  const seen = new Set();
  for (const record of index) {
    if (seen.has(record.directory)) throw new Error("Duplicate observation directory");
    seen.add(record.directory);
    const rawDirectory = relativePath(run, record.directory, { buildRoot: options.buildRoot ?? defaultBuildRoot });
    const raw = json(checkedBuildPath(path.join(rawDirectory, "observation.json"), { buildRoot: options.buildRoot ?? defaultBuildRoot, file: true }));
    if (!method.imagePolicies[raw.view]) throw new Error("Observation has no predeclared common view mask");
    observations.push(await analyzeObservation(run, record, reviews[record.directory], { ...options, expectedImagePolicy: method.imagePolicies[raw.view] }));
  }
  const groups = {};
  for (const record of observations) (groups[`${record.powerMode}/${record.view}/${record.target}/${record.phase}`] ??= []).push(record);
  const summary = Object.fromEntries(Object.entries(groups).map(([key, records]) => [key,
    { accepted: records.filter(record => record.qualified).length, observations: records.length,
      statistics: aggregate(records.filter(record => record.qualified).map(record => record.metrics)) }]));
  const result = { schema: 2, generatedAt: new Date().toISOString(), method: "Per-observation final PNG and common render-canvas mask review; raw captures unchanged", observations, summary };
  const output = path.join(run, "analysis.json");
  // Refuse an existing redirected output, including a dangling symlink.
  try { if (!lstatSync(output).isFile() || realpathSync(output) !== output) throw new Error("Analysis output is redirected"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  writeFileSync(output, JSON.stringify(redact(result), null, 2) + "\n");
  return result;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) { console.log("Usage: node scripts/benchmarks/earth-compare/analyze.mjs --directory=<run under research/build> --reviews=<reviews.json under research/build>\nReviews are keyed by each observation's relative directory and include finalSha256, reviewer, source, evidence, cameraMatched, maskReviewed, landmarks and detail."); return; }
  const values = {};
  for (const arg of args) {
    const match = /^--(directory|reviews)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("Use --directory=<run> --reviews=<json>; no other options");
    values[match[1]] = match[2];
  }
  if (!values.directory || !values.reviews) throw new Error("Both --directory and --reviews are required");
  const reviews = json(checkedBuildPath(values.reviews, { file: true }));
  const result = await analyzeRun(values.directory, reviews);
  console.log(JSON.stringify({ output: path.join(path.resolve(values.directory), "analysis.json"), accepted: result.observations.filter(record => record.qualified).length, observations: result.observations.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
