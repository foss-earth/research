/**
 * Pure W0 camera mapping. GlobeViewState's pitch is down from the horizon;
 * Earth URL tilt is away from nadir. Distances are target-to-eye metres.
 * GlobeViewState omits target altitude and FOV: only a live navigation
 * snapshot supplies these. In the app the target follows ground + its offset,
 * so an ellipsoid-zero default would silently compare different cameras.
 */
const DEG = 180 / Math.PI;
const A = 6378137, F = 1 / 298.257223563, B = A * (1 - F), E2 = F * (2 - F);
const baseFields = ["latDeg", "lonDeg", "headingDeg", "pitchDeg", "zoomMeters"];
const optionalFields = ["targetHeightMeters", "fovDeg", "rollDeg"];
const defaults = Object.freeze({ latDeg: 0.00001, lonDeg: 0.00001, headingDeg: 0.05,
  pitchDeg: 0.05, zoomMeters: 1, targetHeightMeters: 1, fovDeg: 0.05, rollDeg: 0.05 });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const wrap = value => value >= 0 && value < 360 ? value : ((value % 360) + 360) % 360;
const longitude = value => value >= -180 && value < 180 ? value : ((value + 180) % 360 + 360) % 360 - 180;
const angularDelta = (from, to) => longitude(to - from);

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function basePose(pose) {
  if (!pose || typeof pose !== "object") throw new TypeError("A camera pose is required");
  const result = {
    latDeg: finite(pose.latDeg, "latDeg"), lonDeg: longitude(finite(pose.lonDeg, "lonDeg")),
    headingDeg: wrap(finite(pose.headingDeg, "headingDeg")),
    pitchDeg: finite(pose.pitchDeg ?? (own(pose, "tiltDeg") ? 90 - pose.tiltDeg : undefined), "pitchDeg"),
    zoomMeters: finite(pose.zoomMeters ?? pose.distanceMeters, "zoomMeters"),
  };
  if (Math.abs(result.latDeg) > 90) throw new RangeError("latDeg must be within -90..90");
  if (result.pitchDeg < 0 || result.pitchDeg > 90) throw new RangeError("pitchDeg must be within 0..90");
  if (result.zoomMeters <= 0) throw new RangeError("zoomMeters must be positive");
  for (const field of optionalFields) if (own(pose, field)) result[field] = finite(pose[field], field);
  if (own(result, "fovDeg") && (result.fovDeg <= 0 || result.fovDeg >= 180)) throw new RangeError("fovDeg must be between 0 and 180");
  return result;
}

/** Returns the requested pose unchanged in precision; it never clamps 90 to 89. */
export function toFossView(view) {
  const pose = basePose(view);
  return Object.fromEntries(baseFields.map(field => [field, pose[field]]));
}

/** Requires measured target height and vertical FOV; only level roll is mapped. */
export function toEarthUrl(pose) {
  const value = basePose(pose);
  finite(value.targetHeightMeters, "targetHeightMeters"); finite(value.fovDeg, "fovDeg");
  if ((value.rollDeg ?? 0) !== 0) throw new RangeError("W0 camera mapping requires zero roll");
  const number = n => String(Object.is(n, -0) ? 0 : n);
  return "https://earth.google.com/web/@" + [
    number(value.latDeg), number(value.lonDeg), `${number(value.targetHeightMeters)}a`,
    `${number(value.zoomMeters)}d`, `${number(value.fovDeg)}y`, `${number(value.headingDeg)}h`,
    `${number(90 - value.pitchDeg)}t`, "0r",
  ].join(",");
}

/** Strict supported Earth URL grammar; unsupported/malformed poses fail explicitly. */
export function parseEarthUrl(address) {
  let url;
  try { url = new URL(address); } catch { throw new TypeError("Invalid Google Earth URL"); }
  if (url.protocol !== "https:" || url.hostname !== "earth.google.com" || url.username || url.password
    || url.port || !url.pathname.startsWith("/web/@")) throw new TypeError("Expected an https://earth.google.com/web/@ camera URL");
  const number = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)";
  const expression = new RegExp(`^/web/@${number},${number},${number}a,${number}d,${number}y,${number}h,${number}t,${number}r(?:/.*)?$`);
  const match = expression.exec(url.pathname);
  if (!match) throw new TypeError("Google Earth URL lacks the complete supported camera pose");
  const [latDeg, lonDeg, targetHeightMeters, zoomMeters, fovDeg, headingDeg, tiltDeg, rollDeg] = match.slice(1).map(Number);
  const pose = basePose({ latDeg, lonDeg, targetHeightMeters, zoomMeters, fovDeg, headingDeg, pitchDeg: 90 - tiltDeg, rollDeg });
  if (rollDeg !== 0) throw new RangeError("W0 camera mapping requires zero roll");
  return { ...pose, tiltDeg, distanceMeters: zoomMeters };
}

// Iterative WGS84 ECEF inversion, including the poles. This is camera math,
// not an elevation lookup: ellipsoid-coordinate height comes from the snapshot.
function geodetic(center) {
  if (!center || typeof center !== "object") throw new TypeError("snapshot.camera.center is required");
  const x = finite(center.x, "center.x"), y = finite(center.y, "center.y"), z = finite(center.z, "center.z");
  const p = Math.hypot(x, y);
  if (Math.hypot(p, z) === 0) throw new RangeError("ECEF origin has no geographic camera target");
  if (p < 1e-8) return { latDeg: Math.sign(z) * 90, lonDeg: 0, targetHeightMeters: Math.abs(z) - B };
  let latitude = Math.atan2(z, p * (1 - E2));
  for (let index = 0; index < 12; index++) {
    const sin = Math.sin(latitude), n = A / Math.sqrt(1 - E2 * sin * sin);
    const next = Math.atan2(z + E2 * n * sin, p);
    if (Math.abs(next - latitude) < 1e-14) { latitude = next; break; }
    latitude = next;
  }
  const sin = Math.sin(latitude), cos = Math.cos(latitude), n = A / Math.sqrt(1 - E2 * sin * sin);
  const height = Math.abs(cos) > 0.5 ? p / cos - n : z / sin - n * (1 - E2);
  return { latDeg: latitude * DEG, lonDeg: longitude(Math.atan2(y, x) * DEG), targetHeightMeters: height };
}

/**
 * Reads actual camera fields, not snapshot.view (whose pitch can be clamped).
 * A requested 90-degree pose that actually became 89 remains detectable.
 */
export function cameraPose(snapshot) {
  if (!snapshot?.camera) throw new TypeError("A live navigation snapshot with camera fields is required");
  const camera = snapshot.camera;
  const pose = basePose({ ...geodetic(camera.center),
    headingDeg: finite(camera.yaw, "camera.yaw") * DEG,
    pitchDeg: 90 - finite(camera.pitch, "camera.pitch") * DEG,
    zoomMeters: finite(camera.radius, "camera.radius"), fovDeg: finite(camera.fov, "camera.fov") * DEG,
    rollDeg: 0,
  });
  return { ...pose, tiltDeg: 90 - pose.pitchDeg, distanceMeters: pose.zoomMeters };
}

/** Compare every authored field; omitted height/FOV are unknown, never zero. */
export function comparePoses(expected, actual, tolerances = {}) {
  const left = basePose(expected), right = basePose(actual), limits = { ...defaults, ...tolerances };
  const differences = {}, failures = [];
  for (const field of [...baseFields, ...optionalFields.filter(field => own(left, field))]) {
    const tolerance = finite(limits[field], `tolerance.${field}`);
    if (tolerance < 0) throw new RangeError(`tolerance.${field} must be nonnegative`);
    const difference = own(right, field) ? Math.abs(field === "lonDeg" || field === "headingDeg" || field === "rollDeg"
      ? angularDelta(left[field], right[field]) : right[field] - left[field]) : null;
    differences[field] = difference;
    if (difference === null || difference > tolerance) failures.push(field);
  }
  return { matched: failures.length === 0, differences, failures,
    ...(failures.length ? { reason: `Camera differs in ${failures.join(", ")}` } : {}) };
}

/** Linear geographic/height/FOV interpolation; shortest wrap for heading/lon. */
export function interpolatePose(from, to, t) {
  const left = basePose(from), right = basePose(to);
  finite(t, "t");
  if (t < 0 || t > 1) throw new RangeError("t must be within 0..1");
  const result = {};
  for (const field of [...baseFields, ...optionalFields.filter(field => own(left, field) || own(right, field))]) {
    if (!own(left, field) || !own(right, field)) throw new TypeError(`Both poses must supply ${field}`);
    const angular = field === "lonDeg" || field === "headingDeg" || field === "rollDeg";
    result[field] = left[field] + (angular ? angularDelta(left[field], right[field]) : right[field] - left[field]) * t;
  }
  result.lonDeg = longitude(result.lonDeg); result.headingDeg = wrap(result.headingDeg);
  return result;
}

/**
 * Samples are {timeMs, pose}; {atMs, ...pose} is accepted for telemetry.
 * All measured timestamps from both paths are checked, including interiors.
 * Sparse addresses/endpoints, a stopped shortcut, gaps, and partial coverage
 * are unqualified observations rather than camera-motion equivalence.
 */
export function comparePaths(expected, actual, options = {}) {
  const { minSamples = 3, maxGapMs = 1000, timeToleranceMs = 50, durationMs = null,
    requireMotion = true, tolerances = {} } = options;
  if (!Number.isInteger(minSamples) || minSamples < 3) throw new RangeError("minSamples must be at least 3");
  if (!Number.isFinite(maxGapMs) || maxGapMs <= 0 || !Number.isFinite(timeToleranceMs) || timeToleranceMs < 0) throw new RangeError("Invalid path sampling thresholds");
  if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0)) throw new RangeError("durationMs must be positive");
  const reasons = [], normalize = (path, label) => {
    if (!Array.isArray(path) || path.length < minSamples) { reasons.push(`${label} needs at least ${minSamples} measured samples including interiors`); return []; }
    return path.map((sample, index) => {
      const timeMs = finite(sample.timeMs ?? sample.atMs, `${label}[${index}].timeMs`);
      if (index && timeMs <= (path[index - 1].timeMs ?? path[index - 1].atMs)) reasons.push(`${label} timestamps are not strictly increasing`);
      return { timeMs, pose: basePose(sample.pose ?? sample) };
    });
  };
  let left, right;
  try { left = normalize(expected, "expected"); right = normalize(actual, "actual"); }
  catch (error) { return { matched: false, samples: 0, reasons: [error.message], reason: error.message, failures: [] }; }
  if (reasons.length) return { matched: false, samples: 0, reasons, reason: reasons.join("; "), failures: [] };
  for (const [label, path] of [["expected", left], ["actual", right]]) {
    if (path.some((sample, index) => index && sample.timeMs - path[index - 1].timeMs > maxGapMs)) reasons.push(`${label} has a measured sample gap over ${maxGapMs} ms`);
    if (durationMs !== null && (Math.abs(path[0].timeMs) > timeToleranceMs || Math.abs(path.at(-1).timeMs - durationMs) > timeToleranceMs)) reasons.push(`${label} does not cover the requested ${durationMs} ms motion`);
    if (requireMotion && !path.some(sample => !comparePoses(path[0].pose, sample.pose, tolerances).matched)) reasons.push(`${label} has no observed camera motion`);
    if (requireMotion && new Set(path.map(sample => JSON.stringify(baseFields.map(field => sample.pose[field])))).size < minSamples) reasons.push(`${label} needs fresh interior camera poses; repeated endpoint addresses cannot prove motion`);
  }
  if (Math.abs(left[0].timeMs - right[0].timeMs) > timeToleranceMs || Math.abs(left.at(-1).timeMs - right.at(-1).timeMs) > timeToleranceMs) reasons.push("Paths have different time coverage");
  if (reasons.length) return { matched: false, samples: 0, reasons, reason: reasons.join("; "), failures: [] };
  const start = Math.max(left[0].timeMs, right[0].timeMs), end = Math.min(left.at(-1).timeMs, right.at(-1).timeMs);
  const times = [...new Set([...left, ...right].map(sample => sample.timeMs).filter(time => time >= start && time <= end))].sort((a, b) => a - b);
  const at = (path, time) => {
    const index = path.findIndex(sample => sample.timeMs >= time);
    if (path[index].timeMs === time) return path[index].pose;
    return interpolatePose(path[index - 1].pose, path[index].pose, (time - path[index - 1].timeMs) / (path[index].timeMs - path[index - 1].timeMs));
  };
  const failures = times.map(timeMs => ({ timeMs, ...comparePoses(at(left, timeMs), at(right, timeMs), tolerances) })).filter(item => !item.matched);
  return { matched: failures.length === 0, samples: times.length, reasons: failures.length ? ["Sampled camera paths differ"] : [],
    ...(failures.length ? { reason: "Sampled camera paths differ" } : {}), failures };
}
