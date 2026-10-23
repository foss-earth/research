import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { newOutputDirectory } from "../scripts/lib/outputDirectory.mjs";
import { parseOptions, waitForQuiet } from "../scripts/benchmarks/earth-compare/run.mjs";
import { imageMask, redact, settingsScript, readGoogleKey, runOrder, qualificationReasons, serveBuild, IMAGE_POLICY, imagePolicyDigest, withImageMask, maskUiReasons } from "../scripts/benchmarks/earth-compare/support.mjs";

test("comparison CLI is bounded and rejects ambiguous/unknown actions", () => {
  assert.equal(parseOptions(["--plan"]).runs, 3);
  for (const args of [[], ["--plan", "--capture"], ["--plan", "--runs=4"], ["--plan", "--runs=NaN"], ["--plan", "--runs=1.5"], ["--plan", "--idle-seconds=0"], ["--plan", "--view=wrong"], ["--plan", "--oops"], ["--plan", "--plan"]]) assert.throws(() => parseOptions(args));
  assert.deepEqual(runOrder(1), [...runOrder(0)].reverse());
  assert.equal(parseOptions(["--capture", "--runs=1", "--repeat-start=2"])['repeat-start'], 2);
  assert.throws(() => parseOptions(["--capture", "--repeat-start=1"]), /Repeat ids/);
  assert.throws(() => parseOptions(["--capture", "--runs=1", "--repeat-start=-1"]), /Repeat ids/);
});

test("credentials are injected as values and redacted recursively, including encoded traces", () => {
  const secret = "test'\"key/ +\\x", storage = new Map();
  const source = settingsScript(secret, "https://app.test");
  vm.runInNewContext(source, { location: { origin: "https://app.test" }, localStorage: { setItem: (key, value) => storage.set(key, value) } });
  assert.equal(JSON.parse(storage.get("foss-earth.settings.v1")).values["map.source.googleKey"], secret);
  vm.runInNewContext(source, { location: { origin: "https://third-party.test" }, localStorage: { setItem: () => assert.fail("Key crossed app origin") } });
  const safe = redact({ nested: [`https://example.test/?gkey=${encodeURIComponent(secret)}&session=abc`, secret, `Bearer abc.xyz`], googleKey: secret }, [secret]);
  assert.ok(!JSON.stringify(safe).includes(secret));
  assert.ok(!JSON.stringify(safe).includes("session=abc"));
  assert.ok(!JSON.stringify(safe).includes("Bearer abc.xyz"));
  assert.equal(safe.googleKey, "[REDACTED]");
  assert.deepEqual(redact({ gkey: "query-secret", GOOGLE_3D_TILES_KEY: "env-secret" }), { gkey: "[REDACTED]", GOOGLE_3D_TILES_KEY: "[REDACTED]" });
  assert.doesNotMatch(redact("?gkey=query-secret GOOGLE_3D_TILES_KEY=env-secret"), /query-secret|env-secret/);
});

test("key lookup reads only the agreed named variable and follows source priority", () => {
  let reads = 0;
  const noRead = () => { throw new Error("should not read"); };
  assert.equal(readGoogleKey({ GOOGLE_3D_TILES_KEY: " canonical-env ", FOSS_EARTH_GOOGLE_KEY: "legacy-env" }, noRead), "canonical-env");
  assert.equal(readGoogleKey({ GOOGLE_3D_TILES_KEY: " ", FOSS_EARTH_GOOGLE_KEY: "legacy-env" }, noRead), "legacy-env");
  assert.equal(readGoogleKey({}, () => { reads++; return 'UNRELATED_SECRET=never-use\nexport GOOGLE_3D_TILES_KEY="from-file" # local\n'; }), "from-file");
  assert.equal(reads, 1);
  assert.equal(readGoogleKey({}, file => file.includes("foss-earth/app") ? "FOSS_EARTH_GOOGLE_KEY=legacy-first\n" : "GOOGLE_3D_TILES_KEY=canonical-later\n"), "canonical-later");
  assert.equal(readGoogleKey({}, file => file.includes("foss-earth/app") ? "GOOGLE_3D_TILES_KEY=first\n" : "GOOGLE_3D_TILES_KEY=later\n"), "first");
  assert.equal(readGoogleKey({}, () => "GOOGLE_3D_TILES_KEY= \nFOSS_EARTH_GOOGLE_KEY='legacy-file'\n"), "legacy-file");
  assert.throws(() => readGoogleKey({}, () => "OTHER_KEY=never-use"), /unavailable/);
});

test("masks exclude UI margins and power/quality evidence cannot be omitted", () => {
  const mask = imageMask(100, 100);
  assert.equal(mask[0], 0); assert.equal(mask[50 * 100 + 50], 1); assert.equal(mask[99 * 100 + 99], 0);
  assert.throws(() => imageMask(100, 100, { left: .8, right: .2, top: 0, bottom: 1 }));
  const review = { cameraMatched: true, maskReviewed: true, landmarks: true, detail: true, source: "provider", reviewer: "local", evidence: "overlay.png",
    renderGeometryMatched: true, labelsExcluded: true, animationExcluded: true, imagePolicySha256: imagePolicyDigest(IMAGE_POLICY) };
  assert.deepEqual(qualificationReasons(review), []);
  assert.ok(qualificationReasons(review, { powerMode: "battery" }).length > 0);
});

test("common render-canvas masks explicitly exclude labels and animation without changing thresholds", () => {
  const policy = withImageMask({ include: { left: 0, top: 0, right: 1, bottom: 1 }, exclude: [
    { left: 0, top: 0, right: 1, bottom: .2, kind: "animation" },
    { left: .4, top: .4, right: .6, bottom: .6, kind: "labels" }] });
  const mask = imageMask(100, 100, policy);
  assert.equal(mask[0], 0); assert.equal(mask[50 * 100 + 50], 0); assert.equal(mask[80 * 100 + 50], 1);
  assert.throws(() => withImageMask({ tolerance: 255 }));
  assert.throws(() => withImageMask({ exclude: [{ left: 0, top: 0, right: 1, bottom: .9 }] }));
  assert.throws(() => imageMask(100, 100, withImageMask({ include: { left: 0, top: 0, right: .01, bottom: .01 } })), /10%/);
  assert.notEqual(imagePolicyDigest(policy), imagePolicyDigest(IMAGE_POLICY));
  const geometry = { valid: true, canvasIndex: 0, viewport: { devicePixelRatio: 1 }, rect: { x: 0, y: 10, width: 100, height: 100 } };
  const info = { uiRects: [{ rect: { x: 45, y: 55, width: 10, height: 10 } }], uiRectsTruncated: false, occlusionProbeAvailable: true, canvases: [{}] };
  assert.deepEqual(maskUiReasons(info, geometry, policy), []);
  assert.ok(maskUiReasons(info, geometry, IMAGE_POLICY).length);
  info.uiRects = []; info.uiRectsTruncated = true;
  assert.ok(maskUiReasons(info, geometry, policy).length);
  // A small overlap beyond an exclusion must use retina pixels, not a
  // coarser auxiliary mask where outward rounding could hide the overlap.
  const retina = { valid: true, canvasIndex: 0, viewport: { devicePixelRatio: 2 }, rect: { x: 0, y: 0, width: 1280, height: 720 } };
  const edgePolicy = withImageMask({ include: { left: 0, top: 0, right: 1, bottom: 1 }, exclude: [{ left: 0, top: 0, right: .1001, bottom: 1, kind: "ui" }] });
  const edgeInfo = { uiRects: [{ rect: { x: 128.6, y: 10, width: .2, height: 10 } }], uiRectsTruncated: false, occlusionProbeAvailable: true, canvases: [{}] };
  assert.ok(maskUiReasons(edgeInfo, retina, edgePolicy).length);
});

test("an unavailable idle reading cannot start a benchmark", async () => {
  await assert.rejects(waitForQuiet(1, 1, async () => null), /unavailable/);
  await waitForQuiet(1, 1, async () => 10);
});

test("Pages-shaped server serves only its build and follows no escaped symlink", async () => {
  const root = newOutputDirectory("validation", "earth-compare-server"), dist = path.join(root, "dist");
  mkdirSync(dist); writeFileSync(path.join(dist, "index.html"), "fixture");
  writeFileSync(path.join(root, "outside.txt"), "private"); symlinkSync(path.join(root, "outside.txt"), path.join(dist, "escape.txt"));
  const server = await serveBuild(dist);
  try {
    const response = await fetch(server.url);
    assert.equal(await response.text(), "fixture");
    assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), null);
    assert.equal((await fetch(server.url + "escape.txt")).status, 403);
    assert.equal((await fetch(server.url + "../outside.txt")).status, 404);
  } finally { await server.close(); rmSync(root, { recursive: true }); }
});
