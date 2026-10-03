/**
 * Correctness gates for the residual payload (lib/residual.mjs): the integer
 * prediction against a float formula written out here, a synthetic chain of
 * four levels with known targets through the real encoder, and what happens
 * when the client's JPEG decoder is not the encoder's.
 *
 *   node --test benchmarks/eac-progressive-prototype/tests/check-*.mjs
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeJpeg, encodeJpeg } from "../../spherical-image-representation/lib/codecs.mjs";
import { decodePng } from "../../../scripts/lib/panoramaImage.mjs";
import { mulberry32 } from "../../spherical-image-representation/lib/random.mjs";
import { addDifference, encodeDifference, predictChild } from "../lib/residual.mjs";
import { openDataset } from "../lib/render-cpu.mjs";
import { defaultDataset, scratchDirectory, writeResults } from "../lib/paths.mjs";

const record = {};
after(() => { console.log(writeResults("correctness-residual", import.meta.url, {}, record)); });
const psnr = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2; return sum ? 10 * Math.log10(255 * 255 * a.length / sum) : 100; };

test("the integer prediction is bilinear enlargement, written independently", () => {
  const random = mulberry32(1);
  for (const [tile, gutter] of [[8, 1], [16, 2], [192, 1]]) {
    const stored = tile + 2 * gutter, parent = Uint8Array.from({ length: stored * stored * 3 }, () => Math.floor(random() * 256));
    for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const out = predictChild(parent, 3, tile, gutter, qx, qy, new Uint8Array(stored * stored * 3), 3);
      for (let j = 0; j < stored; j++) for (let i = 0; i < stored; i++) {
        // A child texel's centre, in the parent's stored texels: half the child's face position, shifted by the gutters.
        const px = (qx * tile + i - gutter + 0.5) / 2 - 0.5 + gutter, py = (qy * tile + j - gutter + 0.5) / 2 - 0.5 + gutter;
        const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
        assert.ok(x0 >= 0 && y0 >= 0 && x0 + 1 < stored && y0 + 1 < stored, "every tap is inside the parent's stored tile");
        for (let c = 0; c < 3; c++) {
          const at = (y, x) => parent[(y * stored + x) * 3 + c];
          const value = (1 - fy) * ((1 - fx) * at(y0, x0) + fx * at(y0, x0 + 1)) + fy * ((1 - fx) * at(y0 + 1, x0) + fx * at(y0 + 1, x0 + 1));
          assert.equal(out[(j * stored + i) * 3 + c], Math.floor(value + 0.5));
        }
      }
    }
  }
});

test("a four-level chain through the real encoder: error does not build up, except where a difference is clipped", () => {
  const tile = 64, gutter = 1, stored = tile + 2 * gutter, levels = 4;
  // Images as functions of the face position (0–1); each level's stored tile is the box mean of its texels.
  const images = {
    "smooth gradient": (x, y) => [128 + 100 * Math.sin(3 * x + 1), 128 + 90 * Math.cos(4 * y), 60 + 150 * x * y],
    "hard edges": (x, y) => { const on = (Math.floor(x * 37) + Math.floor(y * 23)) & 1; return [on ? 230 : 20, on ? 200 : 40, 120 + 100 * Math.sin(9 * x)]; },
    // Single bright texels of the finest level, one in sixteen, on black: the parent predicts nearly black.
    "detail only the finest level resolves": (x, y) => { const finest = tile << (levels - 1), on = Math.floor(x * finest) % 4 === 1 && Math.floor(y * finest) % 4 === 1; return on ? [255, 255, 255] : [0, 0, 0]; },
  };
  const summary = {};
  for (const [name, image] of Object.entries(images)) {
    const target = (level, qx, qy) => {
      // The chain follows quadrant (qx, qy) at every level, so its tile at level l starts at q·tile·(2^l − 1).
      const face = tile << level, x0 = qx * tile * ((1 << level) - 1), y0 = qy * tile * ((1 << level) - 1), rgb = new Uint8Array(stored * stored * 3);
      for (let j = 0; j < stored; j++) for (let i = 0; i < stored; i++) {
        const sum = [0, 0, 0];
        for (let s = 0; s < 16; s++) { const value = image((x0 + i - gutter + ((s & 3) + 0.5) / 4) / face, (y0 + j - gutter + ((s >> 2) + 0.5) / 4) / face); for (let c = 0; c < 3; c++) sum[c] += value[c]; }
        for (let c = 0; c < 3; c++) rgb[(j * stored + i) * 3 + c] = Math.max(0, Math.min(255, Math.round(sum[c] / 16)));
      }
      return rgb;
    };
    const rows = [];
    for (const [qx, qy] of [[0, 0], [1, 1]]) {
      let parent = null, clipped = 0, values = 0;
      for (let level = 0; level < levels; level++) {
        const goal = target(level, qx, qy), replacement = decodeJpeg(encodeJpeg({ width: stored, height: stored, rgb: goal }, 80)).rgb;
        let reconstructed = replacement;
        if (level > 0) {
          const prediction = predictChild(parent, 3, tile, gutter, qx, qy, new Uint8Array(stored * stored * 3), 3), difference = new Uint8Array(goal.length);
          clipped += encodeDifference(goal, prediction, 3, difference); values += difference.length;
          reconstructed = addDifference(prediction, 3, decodeJpeg(encodeJpeg({ width: stored, height: stored, rgb: difference }, 80)).rgb, 3);
        }
        rows.push({ quadrant: `${qx},${qy}`, level, replacementPsnr: Number(psnr(replacement, goal).toFixed(2)), residualPsnr: Number(psnr(reconstructed, goal).toFixed(2)), clippedShare: values ? Number((clipped / values).toFixed(4)) : 0 });
        parent = reconstructed;
      }
    }
    summary[name] = rows;
    const deepest = rows.filter(row => row.level === levels - 1);
    if (name !== "detail only the finest level resolves") {
      // Each level is coded against the reconstruction of the one below, so its error is its own coding error, not a sum.
      for (const row of deepest) assert.ok(row.residualPsnr > row.replacementPsnr - 1.5, `${name}: residual ${row.residualPsnr} dB against replacement ${row.replacementPsnr} dB at the deepest level`);
    } else {
      assert.ok(deepest.some(row => row.clippedShare > 0), "a full-swing pattern the parent cannot see is clipped");
    }
  }
  record.syntheticChain = summary;
});

test("a client whose JPEG decoder differs from the encoder's drifts, and by how much", () => {
  // The encoder predicts from libjpeg-turbo's decode of the parent. macOS's own decoder (ImageIO, through sips),
  // as Safari would use, is a different implementation; the prediction then starts from slightly different texels.
  const dataset = openDataset(path.join(defaultDataset, "northrop-mall", "eac-t192")), { tiling } = dataset;
  const scratch = path.join(scratchDirectory, "sips-decode");
  mkdirSync(scratch, { recursive: true });
  const sipsDecode = bytes => {
    const from = path.join(scratch, "in.jpg"), to = path.join(scratch, "out.png");
    writeFileSync(from, bytes);
    execFileSync("sips", ["-s", "format", "png", from, "--out", to], { stdio: "ignore" });
    const png = decodePng(readFileSync(to)), rgb = new Uint8Array(png.width * png.height * 3);
    for (let i = 0; i < png.width * png.height; i++) { rgb[i * 3] = png.rgba[i * 4]; rgb[i * 3 + 1] = png.rgba[i * 4 + 1]; rgb[i * 3 + 2] = png.rgba[i * 4 + 2]; }
    return { width: png.width, height: png.height, rgb };
  };
  const rows = [];
  try {
    for (const tile of [tiling.id(2, 3, 3, 3), tiling.id(4, 3, 5, 2), tiling.id(0, 3, 7, 7)]) {
      for (let level = 0; level <= tiling.maxLevel; level++) {
        const step = tiling.ancestor(tile, level);
        const turbo = dataset.residualTexels(step), apple = dataset.residualTexels(step, sipsDecode), replacement = dataset.replacementTexels(step);
        let largest = 0;
        for (let i = 0; i < turbo.length; i++) largest = Math.max(largest, Math.abs(turbo[i] - apple[i]));
        rows.push({ tile, level, psnrBetweenDecoders: Number(psnr(turbo, apple).toFixed(2)), largestDifference: largest, psnrAgainstReplacementTile: Number(psnr(turbo, replacement).toFixed(2)) });
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  record.decoderMismatch = { decoders: "libjpeg-turbo 3.2.0 (djpeg) against macOS ImageIO (sips)", rows };
  // Recorded, not gated: the point is the size of the drift.
  assert.ok(rows.length > 0);
});
