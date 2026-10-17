/** Full projection rectangles only. Cropping may translate pixels; it never rescales a camera. */
const EPSILON = 1e-7;
const MAX_PIXELS = 20_000_000;
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const finite = value => typeof value === "number" && Number.isFinite(value);
const backingSize = value => Number.isSafeInteger(value) && value > 0;
const rectangle = value => value && finite(value.x) && finite(value.y) && positive(value.width) && positive(value.height)
  && Number.isFinite(value.x + value.width) && Number.isFinite(value.y + value.height);
const viewportSize = value => value && positive(value.width) && positive(value.height) && positive(value.devicePixelRatio)
  && Number.isFinite(value.width * value.height);
const copyRect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height });
const same = (a, b, tolerance = EPSILON) => Math.abs(a - b) <= tolerance;

/**
 * Requires a unique visible backed canvas occupying at least half the viewport.
 * Canvas identity is never guessed among overlapping large map/label canvases.
 * geometryWarnings must explicitly attest that exposed ancestor effects were
 * inspected; an absent field or any warning leaves geometry unverified.
 */
export function renderGeometry(info) {
  const result = { valid: false, reasons: [], canvasIndex: null, viewport: null, rect: null, backingWidth: null, backingHeight: null };
  if (!viewportSize(info?.viewport)) { result.reasons.push("Viewport size or device pixel ratio is missing or invalid"); return result; }
  result.viewport = { width: info.viewport.width, height: info.viewport.height, devicePixelRatio: info.viewport.devicePixelRatio };
  if (!Array.isArray(info.canvases)) { result.reasons.push("Canvas evidence is missing"); return result; }
  const minimumArea = result.viewport.width * result.viewport.height / 2;
  const candidates = info.canvases.map((canvas, index) => ({ canvas, index })).filter(({ canvas }) =>
    canvas?.visible === true && backingSize(canvas.backingWidth) && backingSize(canvas.backingHeight)
    && rectangle(canvas.rect) && canvas.rect.width * canvas.rect.height >= minimumArea);
  if (candidates.length !== 1) {
    result.reasons.push(candidates.length ? "Multiple dominant canvases; the world projection is ambiguous" : "No visible backed canvas occupies at least half the viewport");
    return result;
  }
  const { canvas, index } = candidates[0];
  result.canvasIndex = Number.isSafeInteger(canvas.index) && canvas.index >= 0 ? canvas.index : index;
  result.rect = copyRect(canvas.rect);
  result.backingWidth = canvas.backingWidth; result.backingHeight = canvas.backingHeight;
  if (canvas.transform !== "none") result.reasons.push("Canvas CSS transform is present or unverified");
  if (canvas.clipPath !== "none") result.reasons.push("Canvas clip path is present or unverified");
  if (!Array.isArray(canvas.geometryWarnings)) result.reasons.push("Ancestor geometry effects have not been inspected");
  else if (canvas.geometryWarnings.length) result.reasons.push("Ancestor geometry effects are unsupported or unverified");
  const clipped = canvas.clippedRect;
  if (!rectangle(clipped) || !["x", "y", "width", "height"].every(field => same(canvas.rect[field], clipped[field]))) result.reasons.push("The full canvas projection is clipped or clipping is unverified");
  const { x, y, width, height } = canvas.rect;
  if (x < -EPSILON || y < -EPSILON || x + width > result.viewport.width + EPSILON
      || y + height > result.viewport.height + EPSILON) result.reasons.push("The full canvas projection is outside the viewport");
  result.valid = result.reasons.length === 0;
  return result;
}

function usable(geometry) {
  return geometry?.valid === true && viewportSize(geometry.viewport) && rectangle(geometry.rect)
    && backingSize(geometry.backingWidth) && backingSize(geometry.backingHeight)
    && geometry.rect.x >= -EPSILON && geometry.rect.y >= -EPSILON
    && geometry.rect.x + geometry.rect.width <= geometry.viewport.width + EPSILON
    && geometry.rect.y + geometry.rect.height <= geometry.viewport.height + EPSILON;
}

/** CSS translations are safe to crop; different dimensions or projection aspects are not. */
export function compareRenderGeometry(expected, actual) {
  const reasons = [];
  if (!usable(expected)) reasons.push("Expected render geometry is invalid or unverified");
  if (!usable(actual)) reasons.push("Actual render geometry is invalid or unverified");
  if (reasons.length) return { matched: false, reasons };
  if (!same(expected.rect.width, actual.rect.width, 0.5) || !same(expected.rect.height, actual.rect.height, 0.5)) reasons.push("Full canvas CSS dimensions differ by more than half a pixel");
  if (!same(expected.rect.width / expected.rect.height, actual.rect.width / actual.rect.height, 1e-9)) reasons.push("Full canvas projection aspect ratios differ");
  if (expected.backingWidth !== actual.backingWidth || expected.backingHeight !== actual.backingHeight) reasons.push("Canvas backing dimensions differ");
  if (!same(expected.viewport.devicePixelRatio, actual.viewport.devicePixelRatio, 1e-9)) reasons.push("Captured device pixel ratios differ");
  return { matched: reasons.length === 0, reasons };
}

/**
 * Integer pixel crop of the entire measured canvas in a full viewport PNG.
 * Screenshot scale must equal captured DPR on both axes. Partial pixels,
 * resampling, aspect correction and inferred missing geometry are rejected.
 */
export function cropRenderImage(image, geometry) {
  if (!usable(geometry)) throw new Error("Cannot crop invalid or unverified render geometry");
  const width = image?.width, height = image?.height, source = image?.data ?? image?.rgba;
  if (!backingSize(width) || !backingSize(height) || !Number.isSafeInteger(width * height) || width * height > MAX_PIXELS) throw new Error("Invalid screenshot dimensions or screenshot exceeds 20 million pixels");
  if (!source || source.length !== width * height * 4 || typeof source[Symbol.iterator] !== "function") throw new Error("Screenshot needs complete RGBA data");
  if (!(source instanceof Uint8Array) && !(source instanceof Uint8ClampedArray)) {
    for (const value of source) if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error("Screenshot RGBA channels must be bytes");
  }
  const scaleX = width / geometry.viewport.width, scaleY = height / geometry.viewport.height;
  const dpr = geometry.viewport.devicePixelRatio;
  if (!same(scaleX, scaleY, 1e-9) || !same(scaleX, dpr, 1e-9) || !same(scaleY, dpr, 1e-9)) throw new Error("Screenshot scale differs from captured viewport/device pixel ratio");
  const { x, y, width: cssWidth, height: cssHeight } = geometry.rect;
  const edges = [x * scaleX, y * scaleY, (x + cssWidth) * scaleX, (y + cssHeight) * scaleY];
  if (!edges.every(value => same(value, Math.round(value)))) throw new Error("Canvas crop edges do not fall on integer screenshot pixels");
  const [left, top, right, bottom] = edges.map(Math.round);
  if (left < 0 || top < 0 || right > width || bottom > height || left >= right || top >= bottom) throw new Error("Canvas crop is outside the screenshot or empty");
  const croppedWidth = right - left, croppedHeight = bottom - top;
  const data = new Uint8Array(croppedWidth * croppedHeight * 4);
  for (let row = 0; row < croppedHeight; row++) {
    const start = ((top + row) * width + left) * 4, destination = row * croppedWidth * 4;
    if (typeof source.subarray === "function") data.set(source.subarray(start, start + croppedWidth * 4), destination);
    else for (let index = 0; index < croppedWidth * 4; index++) data[destination + index] = source[start + index];
  }
  return { width: croppedWidth, height: croppedHeight, data };
}
