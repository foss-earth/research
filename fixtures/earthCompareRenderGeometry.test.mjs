// Pure projection/crop fixtures. No browser, file, screenshot, or live measurement.
import assert from "node:assert/strict";
import test from "node:test";
import { compareRenderGeometry, cropRenderImage, renderGeometry } from "../scripts/benchmarks/earth-compare/renderGeometry.mjs";

function info({ width = 100, height = 80, dpr = 2, x = 10, y = 10, canvasWidth = 80, canvasHeight = 50 } = {}) {
  const rect = { x, y, width: canvasWidth, height: canvasHeight };
  return { viewport: { width, height, devicePixelRatio: dpr }, canvases: [{ index: 3, visible: true,
    backingWidth: canvasWidth * dpr, backingHeight: canvasHeight * dpr, rect, clippedRect: { ...rect },
    transform: "none", clipPath: "none", geometryWarnings: [], clippingAncestors: [] }] };
}

function patchCanvas(change) {
  const value = info(); Object.assign(value.canvases[0], change); return value;
}

test("selects one explicit dominant world canvas and preserves its full projection", () => {
  const value = info();
  value.canvases.unshift({ index: 0, visible: true, backingWidth: 10, backingHeight: 10, rect: { x: 0, y: 0, width: 10, height: 10 } });
  value.canvases.push({ ...value.canvases[1], index: 4, visible: false });
  assert.deepEqual(renderGeometry(value), { valid: true, reasons: [], canvasIndex: 3,
    viewport: { width: 100, height: 80, devicePixelRatio: 2 }, rect: { x: 10, y: 10, width: 80, height: 50 }, backingWidth: 160, backingHeight: 100 });
});

test("ambiguous overlapping maps, too-small canvases, and unknown backing/visibility fail", () => {
  const duplicate = info(); duplicate.canvases.push({ ...duplicate.canvases[0], index: 4 });
  assert.match(renderGeometry(duplicate).reasons.join(" "), /ambiguous/);
  for (const value of [info({ canvasWidth: 79 }), patchCanvas({ visible: null }), patchCanvas({ visible: false }),
    patchCanvas({ backingWidth: 0 }), patchCanvas({ backingHeight: 1.5 }), { viewport: info().viewport }, { ...info(), canvases: [] }]) {
    assert.equal(renderGeometry(value).valid, false);
  }
});

test("unknown or invalid viewport, DPR, canvas bounds, and backing dimensions fail", () => {
  for (const change of [{ width: 0 }, { width: Infinity }, { height: NaN }, { devicePixelRatio: null }, { devicePixelRatio: 0 }, { devicePixelRatio: "2" }]) {
    const value = info(); Object.assign(value.viewport, change); assert.equal(renderGeometry(value).valid, false);
  }
  for (const change of [{ rect: null }, { rect: { x: NaN, y: 0, width: 80, height: 50 } },
    { backingWidth: Number.MAX_SAFE_INTEGER + 1 }, { rect: { x: 0, y: 0, width: -80, height: 50 } }]) {
    assert.equal(renderGeometry(patchCanvas(change)).valid, false);
  }
});

test("partial clipping, transformed/unknown canvas styles, and ancestor uncertainty fail", () => {
  const clipped = info(); clipped.canvases[0].clippedRect.width -= 1;
  for (const value of [clipped, patchCanvas({ clippedRect: null }), info({ x: 25 }), info({ y: -1 }),
    patchCanvas({ transform: "matrix(1, 0, 0, 1, 10, 0)" }), patchCanvas({ transform: undefined }),
    patchCanvas({ clipPath: "inset(1px)" }), patchCanvas({ clipPath: undefined }),
    patchCanvas({ geometryWarnings: ["Ancestor CSS mask is present"] }), patchCanvas({ geometryWarnings: undefined })]) {
    assert.equal(renderGeometry(value).valid, false);
  }
});

test("comparison permits translation but rejects changed CSS projection, backing, DPR or invalid evidence", () => {
  const expected = renderGeometry(info());
  assert.deepEqual(compareRenderGeometry(expected, renderGeometry(info({ x: 0, y: 0 }))), { matched: true, reasons: [] });
  for (const value of [info({ canvasWidth: 81 }), info({ canvasWidth: 80.1 }), info({ dpr: 1 }), patchCanvas({ backingWidth: 161 }), patchCanvas({ geometryWarnings: undefined })]) {
    assert.equal(compareRenderGeometry(expected, renderGeometry(value)).matched, false);
  }
  assert.equal(compareRenderGeometry(null, expected).matched, false);
  assert.equal(compareRenderGeometry({ valid: true }, expected).matched, false);
  // Half-pixel dimension tolerance does not grant permission to alter aspect.
  const proportional = info({ canvasWidth: 80.4, canvasHeight: 50.25 });
  proportional.canvases[0].backingWidth = 160; proportional.canvases[0].backingHeight = 100;
  assert.equal(compareRenderGeometry(expected, renderGeometry(proportional)).matched, true);
});

function screenshot(width = 20, height = 16) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x, y, (x + y) % 256, (x * y) % 256], (y * width + x) * 4);
  return { width, height, data };
}
const smallGeometry = () => renderGeometry(info({ width: 10, height: 8, x: 1, y: 1, canvasWidth: 8, canvasHeight: 5 }));

test("crop copies exact RGBA pixels at DPR scale without resize, warp, or source mutation", () => {
  const image = screenshot(), original = image.data.slice(), geometry = smallGeometry();
  const result = cropRenderImage(image, geometry);
  assert.equal(result.width, 16); assert.equal(result.height, 10); assert.equal(result.data.length, 640);
  for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
    assert.deepEqual(result.data.slice((y * result.width + x) * 4, (y * result.width + x + 1) * 4),
      image.data.slice(((y + 2) * image.width + x + 2) * 4, ((y + 2) * image.width + x + 3) * 4));
  }
  assert.deepEqual(image.data, original); assert.notEqual(result.data.buffer, image.data.buffer);
  assert.deepEqual(cropRenderImage({ width: image.width, height: image.height, rgba: image.data }, geometry), result);
  assert.deepEqual(cropRenderImage({ ...image, data: [...image.data] }, geometry), result);
});

test("cropping different screen translations yields the same corresponding projection pixels", () => {
  const left = renderGeometry(info({ width: 10, height: 8, x: 0, y: 0, canvasWidth: 8, canvasHeight: 5 }));
  const right = smallGeometry(), a = screenshot(), b = screenshot();
  for (let y = 0; y < 10; y++) for (let x = 0; x < 16; x++) b.data.set(a.data.subarray((y * 20 + x) * 4, (y * 20 + x + 1) * 4), ((y + 2) * 20 + x + 2) * 4);
  assert.equal(compareRenderGeometry(left, right).matched, true);
  assert.deepEqual(cropRenderImage(a, left), cropRenderImage(b, right));
});

test("fractional pixel edges and mismatched screenshot DPR/aspect fail instead of resampling", () => {
  const fractional = renderGeometry(info({ width: 10, height: 8, x: 0.25, y: 1, canvasWidth: 8, canvasHeight: 5 }));
  assert.equal(fractional.valid, true);
  assert.throws(() => cropRenderImage(screenshot(), fractional), /integer screenshot pixels/);
  assert.throws(() => cropRenderImage(screenshot(10, 8), smallGeometry()), /scale/);
  assert.throws(() => cropRenderImage(screenshot(20, 15), smallGeometry()), /scale/);
  assert.throws(() => cropRenderImage(screenshot(), { ...smallGeometry(), viewport: { width: 10, height: 8, devicePixelRatio: 1 } }), /scale/);
});

test("crop refuses missing evidence, malformed channels/dimensions and images over 20M pixels", () => {
  assert.throws(() => cropRenderImage(screenshot(), renderGeometry(patchCanvas({ geometryWarnings: undefined }))), /unverified/);
  assert.throws(() => cropRenderImage(screenshot(), { valid: true }), /unverified/);
  for (const image of [{ width: 0, height: 16 }, { width: 20.5, height: 16 }, { width: 5000, height: 5000 },
    { ...screenshot(), data: null }, { ...screenshot(), data: [1] }, { ...screenshot(), data: Array(1280).fill(NaN) },
    { ...screenshot(), data: Array(1280).fill(256) }, { ...screenshot(), data: { length: 1280 } }]) {
    assert.throws(() => cropRenderImage(image, smallGeometry()));
  }
});
