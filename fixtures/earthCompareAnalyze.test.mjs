import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeObservation, analyzeRun, checkedBuildPath } from "../scripts/benchmarks/earth-compare/analyze.mjs";
import { withImageMask, imagePolicyDigest } from "../scripts/benchmarks/earth-compare/support.mjs";

const owner = fileURLToPath(new URL("../", import.meta.url)), buildRoot = path.join(owner, "build");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const policy = withImageMask({ include: { left: 0, top: 0, right: 1, bottom: 1 } });
function fixture() {
  mkdirSync(buildRoot, { recursive: true });
  const run = mkdtempSync(path.join(buildRoot, "earth-analysis-fixture-")), relative = "view-0-local/cold", directory = path.join(run, relative);
  mkdirSync(path.join(directory, "frames"), { recursive: true });
  const bytes = Buffer.alloc(25); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.write("IHDR", 12); bytes.writeUInt32BE(2, 16); bytes.writeUInt32BE(1, 20);
  for (const name of ["00000.png", "00001.png"]) writeFileSync(path.join(directory, "frames", name), bytes);
  const record = { directory: relative, kind: "load", powerMode: "adapter", target: "local", view: "view", repeat: 0, phase: "cold",
    contention: "exclusive", headed: true, visualCapture: true, disturbances: [], telemetryBefore: { power: { source: "AC Power" } }, telemetryAfter: { power: { source: "AC Power" } },
    durationMs: 3000, taskDurationMs: 10, jsHeapBytes: 5000, encodedBytes: 100, problems: [], imagePolicy: policy, finalSha256: sha256(bytes),
    processes: [{ pid: 1, cpuMs: 10, rssBeforeBytes: 100, rssAfterBytes: 120 }],
    frames: [{ timestampMs: 0, file: "frames/00000.png" }, { timestampMs: 3000, file: "frames/00001.png" }] };
  const rect = { x: 0, y: 0, width: 2, height: 1 };
  record.renderInfo = { viewport: { width: 2, height: 1, devicePixelRatio: 1 }, uiRects: [], uiRectsTruncated: false, occlusionProbeAvailable: true,
    canvases: [{ index: 0, rect, clippedRect: rect, backingWidth: 2, backingHeight: 1, visible: true,
      transform: "none", clipPath: "none", geometryWarnings: [], occlusionSamples: [] }] };
  record.referenceRenderInfo = record.renderInfo;
  record.renderInfoBefore = record.renderInfo;
  record.cameraComparison = { matched: true };
  const review = { finalSha256: record.finalSha256, reviewer: "test reviewer", source: "synthetic", evidence: "synthetic fixture",
    cameraMatched: true, maskReviewed: true, landmarks: true, detail: true,
    renderGeometryMatched: true, labelsExcluded: true, animationExcluded: true, imagePolicySha256: imagePolicyDigest(policy) };
  const save = () => { writeFileSync(path.join(directory, "observation.json"), JSON.stringify(record)); writeFileSync(path.join(run, "observations.json"), JSON.stringify([{ directory: relative }])); };
  save();
  writeFileSync(path.join(run, "method.json"), JSON.stringify({ schema: 2, imagePolicies: { view: policy } }));
  writeFileSync(path.join(directory, "trace.json"), JSON.stringify({ traceEvents: [0, 16667, 33334].map(ts => ({ name: "Display::FrameDisplayed", pid: 1, tid: 1, ts, ph: "I" })) }));
  const options = { buildRoot, expectedImagePolicy: policy, decodePng: () => ({ width: 2, height: 1, rgba: Uint8Array.from([0, 20, 40, 255, 100, 120, 140, 255]) }) };
  return { run, relative, directory, record, review, save, options, close: () => rmSync(run, { recursive: true, force: true }) };
}

test("offline analysis requires an exact final PNG review and keeps raw captures unchanged", async () => {
  const f = fixture();
  try {
    const raw = readFileSync(path.join(f.directory, "observation.json"));
    const accepted = await analyzeRun(f.run, { [f.relative]: f.review }, f.options);
    assert.equal(accepted.observations[0].qualified, true);
    assert.equal(accepted.summary["adapter/view/local/cold"].accepted, 1);
    assert.equal(accepted.summary["adapter/view/local/cold"].statistics.taskDurationMs.median, 10);
    assert.deepEqual(readFileSync(path.join(f.directory, "observation.json")), raw);
    const rejected = await analyzeObservation(f.run, { directory: f.relative }, { ...f.review, finalSha256: "0".repeat(64) }, f.options);
    assert.equal(rejected.qualified, false); assert.ok(rejected.reasons.some(reason => reason.includes("exact final PNG")));
    const missing = await analyzeObservation(f.run, { directory: f.relative }, null, f.options);
    assert.equal(missing.qualified, false);
  } finally { f.close(); }
});

test("paths reject traversal, sibling prefixes, frame escapes, and symlink ancestors", async () => {
  const f = fixture();
  try {
    assert.throws(() => checkedBuildPath(path.join(buildRoot, "..", "package.json"), { buildRoot, file: true }), /remain under/);
    await assert.rejects(analyzeObservation(f.run, { directory: "../outside" }, f.review, f.options), /relative/);
    f.record.frames[0].file = "frames/../../outside.png"; f.save();
    await assert.rejects(analyzeObservation(f.run, { directory: f.relative }, f.review, f.options), /relative/);
    f.record.frames[0].file = "frames/redirect.png"; symlinkSync(path.join(f.directory, "frames", "00001.png"), path.join(f.directory, "frames", "redirect.png")); f.save();
    await assert.rejects(analyzeObservation(f.run, { directory: f.relative }, f.review, f.options), /symlink/);
    symlinkSync(path.join(f.run, "observations.json"), path.join(f.run, "analysis.json"));
    f.record.frames[0].file = "frames/00000.png"; f.save();
    await assert.rejects(analyzeRun(f.run, { [f.relative]: f.review }, f.options), /redirected/);
  } finally { f.close(); }
});

test("new analysis rejects raw disturbances, unavailable core metrics and incomplete power", async () => {
  const f = fixture();
  try {
    f.record.problems = ["thermal-state"]; f.record.taskDurationMs = null;
    f.record.powerMode = "battery"; f.record.power = { status: "ok", coverage: 0.5, coveredMs: 1500, rejectedSamples: 0, wholeMachineWatts: 10, idleWatts: 5, wattsOverIdle: 5 };
    f.save(); const result = await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options);
    assert.equal(result.qualified, false);
    assert.ok(result.reasons.some(reason => reason.includes("thermal-state")));
    assert.ok(result.reasons.some(reason => reason.includes("task duration")));
    assert.ok(result.reasons.some(reason => reason.includes("Power")));
  } finally { f.close(); }
});

test("idle can have no presentation frames, while motion needs matched sampled poses", async () => {
  const f = fixture();
  try {
    f.record.kind = "idle"; f.record.phase = "idle"; f.save();
    writeFileSync(path.join(f.directory, "trace.json"), JSON.stringify({ traceEvents: [] }));
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options)).qualified, true);
    f.record.kind = "motion"; f.record.pathComparison = { matched: false }; f.save();
    const failed = await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options);
    assert.equal(failed.qualified, false); assert.ok(failed.reasons.some(reason => reason.includes("motion is unmatched")));
  } finally { f.close(); }
});

test("motion needs valid images and an exact review, but can finish without a final hold", async () => {
  const f = fixture();
  try {
    f.record.kind = "motion"; f.record.pathComparison = { matched: true }; f.record.durationMs = 1000;
    f.record.frames[1].timestampMs = 1000; f.save();
    const result = await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options);
    assert.equal(result.visual.reason, "insufficient-final-hold"); assert.equal(result.qualified, true);
    const blank = await analyzeObservation(f.run, { directory: f.relative }, f.review, { ...f.options,
      decodePng: () => ({ width: 2, height: 1, rgba: Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 255]) }) });
    assert.equal(blank.qualified, false); assert.ok(blank.reasons.some(reason => reason.includes("blank-final-frame")));
  } finally { f.close(); }
});

test("one continuous motion/settling capture scopes intervals and requires its clocks", async () => {
  const f = fixture();
  try {
    Object.assign(f.record, { kind: "motion", pathComparison: { matched: true }, motionDurationMs: 1000, actionEndMs: 1000, traceStartUs: 0 }); f.save();
    writeFileSync(path.join(f.directory, "trace.json"), JSON.stringify({ traceEvents: [0, 16667, 33334, 2000000].map(ts => ({ name: "Display::FrameDisplayed", pid: 1, tid: 1, ts, ph: "I" })) }));
    const result = await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options);
    assert.equal(result.qualified, true); assert.equal(result.frameIntervals.count, 2);
    assert.equal(result.metrics.settlingMs, 0);
    delete f.record.traceStartUs; f.save();
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options)).qualified, false);
  } finally { f.close(); }
});

test("a final PNG approval cannot replace geometry, camera, UI or common-mask evidence", async () => {
  const f = fixture();
  try {
    delete f.record.renderInfo; f.save();
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options)).qualified, false);
    f.record.renderInfo = f.record.referenceRenderInfo;
    f.record.cameraComparison = null; f.save();
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options)).qualified, false);
    f.record.cameraComparison = { matched: true };
    f.record.renderInfo.uiRects = [{ rect: { x: 0, y: 0, width: 1, height: 1 } }]; f.save();
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options)).qualified, false);
    f.record.renderInfo.uiRects = []; f.record.target = "google-earth"; f.save();
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options)).qualified, false);
    f.record.target = "local"; f.save();
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, { ...f.review, imagePolicySha256: "0".repeat(64) }, f.options)).qualified, false);
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, { ...f.review, labelsExcluded: false }, f.options)).qualified, false);
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, { ...f.review, animationExcluded: false }, f.options)).qualified, false);
    f.record.imagePolicy = { ...policy, tolerance: 255 }; f.save();
    assert.equal((await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options)).qualified, false);
  } finally { f.close(); }
});

test("shared, unconfirmed power, headless and nonvisual diagnostics cannot qualify W0", async () => {
  const f = fixture();
  try {
    for (const change of [{ contention: "shared" }, { powerMode: "observe" }, { headed: false }, { visualCapture: false },
      { disturbances: ["other-program-active"] }, { telemetryAfter: { power: { source: "Battery Power" } } }]) {
      const original = { ...f.record }; Object.assign(f.record, change); f.save();
      assert.equal((await analyzeObservation(f.run, { directory: f.relative }, f.review, f.options)).qualified, false);
      Object.assign(f.record, original);
    }
  } finally { f.close(); }
});
