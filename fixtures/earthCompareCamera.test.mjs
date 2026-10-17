import assert from "node:assert/strict";
import test from "node:test";
import { VIEWS, MOTIONS } from "../scripts/benchmarks/earth-compare/views.mjs";
import { toFossView, toEarthUrl, parseEarthUrl, cameraPose, comparePoses, comparePaths, interpolatePose } from "../scripts/benchmarks/earth-compare/camera.mjs";

const pose = { latDeg: 30, lonDeg: -90, headingDeg: 0, pitchDeg: 45, zoomMeters: 8000,
  targetHeightMeters: 1234, fovDeg: 60 };
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
function ecef(latDeg, lonDeg, height) {
  const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180, e2 = 6.6943799901413165e-3;
  const n = 6378137 / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return { x: (n + height) * Math.cos(lat) * Math.cos(lon), y: (n + height) * Math.cos(lat) * Math.sin(lon), z: (n * (1 - e2) + height) * Math.sin(lat) };
}
const snapshot = (target, height) => ({ view: { ...pose, pitchDeg: 89 }, camera: {
  center: ecef(target.latDeg, target.lonDeg, height), yaw: target.headingDeg * Math.PI / 180,
  pitch: (90 - target.pitchDeg) * Math.PI / 180, radius: target.zoomMeters, fov: target.fovDeg * Math.PI / 180,
} });

test("W0 view data is immutable, exact, and shortcuts retain their official source", () => {
  assert.deepEqual(VIEWS.map(item => item.id), ["grand-canyon", "umn-campus", "manhattan", "ksfo-approach", "orbit"]);
  assert.equal(VIEWS.find(item => item.id === "orbit").distanceMeters, 20000000);
  assert.equal(toFossView(VIEWS.find(item => item.id === "orbit")).pitchDeg, 89);
  assert.ok(Object.isFrozen(VIEWS) && VIEWS.every(Object.isFrozen));
  assert.ok(Object.isFrozen(MOTIONS) && MOTIONS.every(motion => Object.isFrozen(motion) && Object.isFrozen(motion.keys[0])));
  assert.deepEqual(MOTIONS.map(motion => [motion.id, motion.durationMs, motion.keys[0].key, motion.keys[0].modifiers]),
    [["pan", 10000, "ArrowRight", 0], ["orbit", 10000, "ArrowRight", 8], ["zoom", 10000, "PageUp", 0]]);
  assert.ok(MOTIONS.every(motion => motion.shortcutVerified && motion.shortcutSource.startsWith("https://developers.google.com/")));
});

test("camera conversion keeps pitch90 exact and detects a clamp to89", () => {
  const requested = toFossView({ ...VIEWS.find(view => view.id === "orbit"), tiltDeg: 0 });
  assert.equal(requested.pitchDeg, 90);
  const comparison = comparePoses(requested, { ...requested, pitchDeg: 89 });
  assert.equal(comparison.matched, false); assert.deepEqual(comparison.failures, ["pitchDeg"]);
  assert.equal(comparison.differences.pitchDeg, 1);
});

test("Earth URL roundtrip preserves measured height, distance, angles and vertical FOV", () => {
  const url = toEarthUrl(pose), parsed = parseEarthUrl(url);
  assert.equal(url, "https://earth.google.com/web/@30,-90,1234a,8000d,60y,0h,45t,0r");
  assert.equal(comparePoses(pose, parsed).matched, true);
  assert.equal(parsed.tiltDeg, 45); assert.equal(parsed.distanceMeters, 8000);
  assert.deepEqual(toFossView(VIEWS[0]), { latDeg: 36.1, lonDeg: -112.14, headingDeg: 0, pitchDeg: 35, zoomMeters: 8000 });
  assert.equal(comparePoses(pose, parseEarthUrl(url + "/data=test?x=1")).matched, true);
});

test("missing target height/FOV, bad domains, malformed fields, roll, and nonfinite inputs fail", () => {
  const { targetHeightMeters, ...noHeight } = pose, { fovDeg, ...noFov } = pose;
  assert.throws(() => toEarthUrl(noHeight), /targetHeightMeters/);
  assert.throws(() => toEarthUrl(noFov), /fovDeg/);
  for (const address of ["nonsense", toEarthUrl(pose).replace("earth.google.com", "earth.google.com.evil.test"),
    toEarthUrl(pose).replace("https:", "http:"), toEarthUrl(pose).replace("1234a,", ""),
    toEarthUrl(pose).replace("60y", "180y"), toEarthUrl(pose).replace("0r", "1r"),
    toEarthUrl(pose).replace("8000d", "-1d")]) assert.throws(() => parseEarthUrl(address));
  assert.throws(() => toFossView({ ...pose, latDeg: NaN }), /finite/);
  assert.throws(() => toEarthUrl({ ...pose, rollDeg: 2 }), /zero roll/);
});

test("actual snapshot ECEF height and FOV prevail over an incomplete/clamped view", () => {
  for (const target of [{ ...pose }, { ...pose, latDeg: 0, lonDeg: 0 }, { ...pose, latDeg: 89.999, lonDeg: 179.999 },
    { ...pose, latDeg: -90, lonDeg: 0 }, { ...pose, pitchDeg: 90 }]) {
    const actual = cameraPose(snapshot(target, 1234));
    near(actual.latDeg, target.latDeg); near(actual.targetHeightMeters, 1234, 1e-6);
    near(actual.fovDeg, target.fovDeg); near(actual.pitchDeg, target.pitchDeg);
    near(actual.zoomMeters, target.zoomMeters);
  }
  assert.throws(() => cameraPose({ view: pose }), /snapshot/);
  assert.throws(() => cameraPose({ camera: { center: { x: 0, y: 0, z: 0 } } }), /origin/);
  const incomplete = snapshot(pose, 1234); delete incomplete.camera.fov;
  assert.throws(() => cameraPose(incomplete), /fov/);
});

test("pose comparison and interpolation use shortest longitude and heading wraps", () => {
  assert.equal(comparePoses({ ...pose, headingDeg: 360, lonDeg: 180 }, { ...pose, headingDeg: 0, lonDeg: -180 }).matched, true);
  const halfway = interpolatePose({ ...pose, lonDeg: 179, headingDeg: 359 }, { ...pose, lonDeg: -179, headingDeg: 1, zoomMeters: 10000 }, 0.5);
  near(halfway.lonDeg, -180); near(halfway.headingDeg, 0); near(halfway.zoomMeters, 9000);
  near(halfway.targetHeightMeters, 1234); assert.throws(() => interpolatePose(pose, pose, 2), /0..1/);
  assert.equal(comparePoses(pose, toFossView(pose)).matched, false);
});

test("whole-path comparison catches interior deviations despite equal endpoints", () => {
  const expected = [0, 500, 1000].map(timeMs => ({ timeMs, pose: { ...pose, headingDeg: timeMs / 50 } }));
  assert.equal(comparePaths(expected, expected, { durationMs: 1000 }).matched, true);
  const different = expected.map((sample, index) => ({ ...sample, pose: { ...sample.pose, pitchDeg: index === 1 ? 50 : 45 } }));
  const result = comparePaths(expected, different);
  assert.equal(result.matched, false); assert.equal(result.failures[0].timeMs, 500);
  const denser = [0, 250, 500, 750, 1000].map(timeMs => ({ atMs: timeMs, ...pose, headingDeg: timeMs / 50 }));
  assert.equal(comparePaths(expected, denser).matched, true);
  denser[1].pitchDeg = 50;
  assert.equal(comparePaths(expected, denser).matched, false);
});

test("endpoints, sparse samples, missing duration, stopped motion and duplicate times cannot qualify", () => {
  const samples = [0, 500, 1000].map(timeMs => ({ timeMs, pose: { ...pose, headingDeg: timeMs / 50 } }));
  assert.equal(comparePaths([samples[0], samples[2]], [samples[0], samples[2]]).matched, false);
  assert.equal(comparePaths(samples, samples, { durationMs: 10000 }).matched, false);
  const sparse = samples.map((sample, index) => ({ ...sample, timeMs: index * 5000 }));
  assert.equal(comparePaths(sparse, sparse).matched, false);
  const stopped = samples.map(sample => ({ ...sample, pose }));
  assert.equal(comparePaths(stopped, stopped).matched, false);
  const repeatedEndpoints = samples.map((sample, index) => ({ ...sample, pose: index < 2 ? samples[0].pose : samples[2].pose }));
  assert.equal(comparePaths(repeatedEndpoints, repeatedEndpoints).matched, false);
  assert.equal(comparePaths(stopped, stopped, { requireMotion: false }).matched, true);
  assert.equal(comparePaths(samples, samples.map(sample => ({ ...sample, timeMs: 0 }))).matched, false);
});
