import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";

export const VIEWPORT = Object.freeze({ width: 1280, height: 720 });
// Freeze these before calibration. Coordinates are fractions of the viewport.
// Review the masks on both apps; a mask cannot establish landmark/detail parity.
export const IMAGE_POLICY = Object.freeze({ space: "render-canvas", threshold: 0.995, holdMs: 2000, tolerance: 8,
  minimumIncludedFraction: .1, include: Object.freeze({ left: 0.20, top: 0.30, right: 0.80, bottom: 0.78 }), exclude: Object.freeze([]) });

function rectangle(value) {
  if (!value || ![value.left, value.top, value.right, value.bottom].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
    || value.left >= value.right || value.top >= value.bottom) throw new Error("Invalid image mask rectangle");
  return Object.fromEntries(["left", "top", "right", "bottom"].map(key => [key, value[key]]));
}

/** One common mask per view, declared before capture; thresholds cannot be tuned. */
export function withImageMask(mask = {}) {
  if (!mask || typeof mask !== "object" || Array.isArray(mask) || Object.keys(mask).some(key => !["include", "exclude"].includes(key))) throw new Error("Mask accepts only include and exclude");
  const include = rectangle(mask.include ?? IMAGE_POLICY.include), exclude = mask.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.length > 100) throw new Error("Invalid mask exclusions");
  return { ...IMAGE_POLICY, include, exclude: exclude.map(value => {
    if (!["ui", "labels", "animation"].includes(value?.kind)) throw new Error("Each exclusion needs kind ui, labels or animation");
    return { ...rectangle(value), kind: value.kind };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

export function checkedImagePolicy(policy) {
  const canonical = withImageMask({ include: policy?.include, exclude: policy?.exclude });
  for (const key of ["space", "threshold", "holdMs", "tolerance", "minimumIncludedFraction"]) if (policy?.[key] !== IMAGE_POLICY[key]) throw new Error("Image policy differs from fixed W0 thresholds or coordinate space");
  return canonical;
}

export function imagePolicyDigest(policy) {
  return createHash("sha256").update(JSON.stringify(checkedImagePolicy(policy))).digest("hex");
}

export function imageMask(width, height, policy = IMAGE_POLICY) {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error("Invalid image size");
  const legacy = !policy.include, { left, top, right, bottom } = rectangle(legacy ? policy : policy.include);
  const mask = new Uint8Array(width * height);
  for (let y = Math.ceil(top * height); y < Math.floor(bottom * height); y++) {
    mask.fill(1, y * width + Math.ceil(left * width), y * width + Math.floor(right * width));
  }
  for (const excluded of policy.exclude ?? []) {
    const { left, top, right, bottom } = rectangle(excluded);
    // Include any touched pixel in the exclusion, including its boundary.
    for (let y = Math.floor(top * height); y < Math.ceil(bottom * height); y++) mask.fill(0, y * width + Math.floor(left * width), y * width + Math.ceil(right * width));
  }
  if (!legacy && mask.reduce((sum, bit) => sum + bit, 0) / mask.length < IMAGE_POLICY.minimumIncludedFraction) throw new Error("Mask includes less than 10% of the render canvas");
  return mask;
}

/** Public DOM UI is additional evidence, never proof that canvas labels are gone. */
export function maskUiReasons(info, geometry, policy) {
  if (!geometry?.valid || !Array.isArray(info?.uiRects)) return ["Public UI rectangles are unavailable"];
  const width = Math.round(geometry.rect.width * geometry.viewport?.devicePixelRatio), height = Math.round(geometry.rect.height * geometry.viewport?.devicePixelRatio);
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0) || width * height > 20_000_000) return ["Invalid render-mask pixel dimensions"];
  const mask = imageMask(width, height, policy), reasons = [];
  if (info.uiRectsTruncated !== false) reasons.push("Public UI rectangle inventory is incomplete");
  if (info.occlusionProbeAvailable !== true) reasons.push("Public render hit testing is unavailable");
  for (const item of info.uiRects) {
    const r = item.rect, canvas = geometry.rect;
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) { reasons.push("Invalid public UI rectangle"); continue; }
    const left = Math.max(0, Math.floor((r.x - canvas.x) / canvas.width * width));
    const right = Math.min(width, Math.ceil((r.x + r.width - canvas.x) / canvas.width * width));
    const top = Math.max(0, Math.floor((r.y - canvas.y) / canvas.height * height));
    const bottom = Math.min(height, Math.ceil((r.y + r.height - canvas.y) / canvas.height * height));
    let hit = false;
    for (let y = top; y < bottom && !hit; y++) for (let x = left; x < right; x++) if (mask[y * width + x]) { hit = true; break; }
    if (hit) reasons.push("Visible public UI intersects the included render mask");
  }
  for (const sample of info.canvases?.[geometry.canvasIndex]?.occlusionSamples ?? []) {
    const x = Math.floor((sample.x - geometry.rect.x) / geometry.rect.width * width);
    const y = Math.floor((sample.y - geometry.rect.y) / geometry.rect.height * height);
    if (x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] && sample.status !== "canvas") reasons.push("Included render mask has an occluded or unknown public hit-test sample");
  }
  return [...new Set(reasons)];
}

/** Histories, URLs and traces never receive a credential in an output file. */
export function redact(value, secrets = []) {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets.filter(Boolean)) {
      for (const form of new Set([secret, encodeURIComponent(secret)])) text = text.split(form).join("[REDACTED]");
    }
    return text.replace(/((?:gkey|key|session|token|api_key|GOOGLE_3D_TILES_KEY|FOSS_EARTH_GOOGLE_KEY)(?:=|%3[dD]))[^\s&#"'<>\\]*/gi, "$1[REDACTED]")
      .replace(/(Bearer\s+)[\w.+/=-]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(gkey|key|session|token|apiKey|googleKey|GOOGLE_3D_TILES_KEY|FOSS_EARTH_GOOGLE_KEY)$/i.test(key) ? "[REDACTED]" : redact(item, secrets)]));
  return value;
}

export function readGoogleKey(env = process.env, read = readFileSync) {
  const names = ["GOOGLE_3D_TILES_KEY", "FOSS_EARTH_GOOGLE_KEY"];
  for (const name of names) if (env[name]?.trim()) return env[name].trim();
  let legacy = null;
  for (const file of ["/Users/felg/gh/foss-earth/app/.env.local", "/Users/felg/gh/UMN-VR/tour/.env.local", "/Users/felg/gh/0sfs/fly/.env.local"]) {
    let contents;
    try { contents = read(file, "utf8"); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of names) {
      const match = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^#\\r\\n]*))`, "m").exec(contents);
      const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
      if (!value) continue;
      if (name === names[0]) return value;
      legacy ??= value;
    }
  }
  if (legacy) return legacy;
  throw new Error("GOOGLE_3D_TILES_KEY is unavailable in the environment and the three ignored .env.local files (FOSS_EARTH_GOOGLE_KEY is a legacy fallback)");
}

export function settingsScript(key, origin) {
  if (!origin || new URL(origin).origin !== origin) throw new Error("Settings injection needs an exact app origin");
  return `if (location.origin === ${JSON.stringify(origin)}) localStorage.setItem('foss-earth.settings.v1', ${JSON.stringify(JSON.stringify({ version: 1,
    values: { "map.source.googleKey": key, "map.source.basemap": "google" } }))});`;
}

export function runOrder(repeat, targets = ["google-earth", "published", "local"]) {
  if (!Number.isInteger(repeat) || repeat < 0) throw new Error("Invalid repeat");
  return repeat % 2 ? [...targets].reverse() : [...targets];
}

export function qualificationReasons(record, { powerMode, brightness, idleBaseline, imagePolicy = IMAGE_POLICY } = {}) {
  const reasons = [];
  if (!record?.cameraMatched) reasons.push("camera overlay has not been approved");
  if (!record?.maskReviewed) reasons.push("UI/labels/animated sky mask has not been reviewed");
  if (!record?.landmarks || !record?.detail) reasons.push("expected landmarks/detail have not been verified");
  if (!record?.source || !record?.reviewer || !record?.evidence) reasons.push("source/reviewer/evidence is missing");
  for (const field of ["renderGeometryMatched", "labelsExcluded", "animationExcluded"]) if (record?.[field] !== true) reasons.push(`${field} has not been reviewed`);
  if (record?.imagePolicySha256 !== imagePolicyDigest(imagePolicy)) reasons.push("Review does not identify the predeclared common image mask");
  if (powerMode === "battery" && (!brightness || !Number.isFinite(idleBaseline))) reasons.push("battery run needs fixed brightness and an idle baseline");
  return reasons;
}

/** A header-free Pages-shaped server; outside origins are never intercepted. */
export async function serveBuild(directory) {
  const root = realpathSync(directory);
  const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/app/")) { response.writeHead(404).end(); return; }
      const relative = decodeURIComponent(url.pathname.slice(5));
      const candidate = path.resolve(root, relative || "index.html");
      const real = realpathSync(candidate);
      if (!real.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const bytes = readFileSync(real);
      response.writeHead(200, { "content-type": mime[path.extname(real)] ?? "application/octet-stream", "cache-control": "public, max-age=3600" });
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/app/`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
