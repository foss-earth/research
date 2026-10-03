/**
 * The picture on the CPU, in Node: the same rule the shader follows, written
 * apart from it, and the reference view from the source.
 *
 * It serves three purposes: it is the independent check of what the GPU
 * draws (run-gpu-checks.mjs compares the two), it lets the simulator judge
 * quality without a browser, and its tile store is the encoder-side decoder
 * of the residual chain.
 *
 * **The display rule** (`makeShader`). One ray through each pixel's centre. The ray's face
 * position picks a cell; the display table names the tile the cell shows, or
 * −1 for the bootstrap; the colour is the bilinear mix of that tile's stored
 * texels, gutter included, in sRGB-encoded bytes. No neighbouring tile is
 * ever read.
 *
 * **The reference** is Phase 1's: the view drawn straight from the source,
 * `supersample`² rays per pixel, in linear light.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { decodeJpeg } from "../../spherical-image-representation/lib/codecs.mjs";
import { resolvePixels } from "../../spherical-image-representation/lib/field.mjs";
import { sampleSource } from "../../spherical-image-representation/lib/views.mjs";
import { addDifference, predictChild } from "./residual.mjs";
import { planeExtents, viewBasis } from "./selection.mjs";
import { tilingFromManifest } from "./tiling.mjs";

/** One dataset variant on disk: its manifest, tiling, byte lists and decoded tiles on demand. */
export function openDataset(directory) {
  if (!existsSync(path.join(directory, "manifest.json"))) throw new Error(`no dataset at ${directory}; run preprocess/build-dataset.mjs`);
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const tiling = tilingFromManifest(manifest), tileBytes = JSON.parse(readFileSync(path.join(directory, "tiles.json"), "utf8"));
  const stored = tiling.stored, replacement = new Map(), residual = new Map(), boots = new Map();
  const dataset = {
    directory, manifest, tiling, tileBytes,
    /** A replacement tile's stored texels, RGB. */
    replacementTexels(tile) {
      if (!replacement.has(tile)) replacement.set(tile, decodeJpeg(readFileSync(path.join(directory, tiling.path(tile, "t")))).rgb);
      return replacement.get(tile);
    },
    /** A tile as the residual chain reconstructs it: level 0 decoded, every level above predicted from its parent and corrected. */
    residualTexels(tile, decode = decodeJpeg) {
      if (decode === decodeJpeg && residual.has(tile)) return residual.get(tile);
      let texels;
      if (tiling.level(tile) === 0) texels = decode(readFileSync(path.join(directory, tiling.path(tile, "t")))).rgb;
      else {
        const { x, y } = tiling.address(tile);
        texels = predictChild(dataset.residualTexels(tiling.parent(tile), decode), 3, tiling.tile, tiling.gutter, x & 1, y & 1, new Uint8Array(stored * stored * 3), 3);
        addDifference(texels, 3, decode(readFileSync(path.join(directory, tiling.path(tile, "r")))).rgb, 3);
      }
      if (decode === decodeJpeg) residual.set(tile, texels);
      return texels;
    },
    texels: (tile, payload = "replacement") => (payload === "residual" ? dataset.residualTexels(tile) : dataset.replacementTexels(tile)),
    /** A bootstrap atlas: `{ faceSize, side, width, rgb }`. */
    bootstrap(faceSize) {
      if (!boots.has(faceSize)) {
        const entry = manifest.bootstrap.find(item => item.faceSize === faceSize), image = decodeJpeg(readFileSync(path.join(directory, entry.url)));
        boots.set(faceSize, { faceSize, side: faceSize + 2 * entry.gutter, gutter: entry.gutter, width: image.width, rgb: image.rgb, bytes: entry.bytes });
      }
      return boots.get(faceSize);
    },
    forget() { replacement.clear(); residual.clear(); },
  };
  return dataset;
}

/** The pixels a view is judged on: every `stride`-th in each direction. */
export function viewSize(viewport, stride = 1) {
  return { width: Math.ceil(viewport.width / stride), height: Math.ceil(viewport.height / stride) };
}

/**
 * The colour the shader gives a direction: `shade(x, y, z, out)` writes three
 * floats, 0–255. `bootstrap` is `dataset.bootstrap(size)` or null (then −1
 * cells are `blank`); `payload` chooses which decode of a tile is shown.
 */
export function makeShader(dataset, table, { bootstrap = null, payload = "replacement", blank = [255, 0, 255] } = {}) {
  const { tiling } = dataset, C = tiling.cells, T = tiling.tile, g = tiling.gutter, S = tiling.stored, place = [0, 0, 0];
  return function shade(x, y, z, out) {
    tiling.locate(x, y, z, place);
    const face = place[0], u = place[1], v = place[2];
    const tile = table[(face * C + Math.min(C - 1, Math.floor(v * C))) * C + Math.min(C - 1, Math.floor(u * C))];
    let texels, side, fx, fy;
    if (tile >= 0) {
      const n = 1 << tiling.level(tile);
      const tx = Math.min(n - 1, Math.floor(u * n)), ty = Math.min(n - 1, Math.floor(v * n));
      texels = dataset.texels(tile, payload); side = S;
      fx = g + (u * n - tx) * T - 0.5; fy = g + (v * n - ty) * T - 0.5;
    } else if (bootstrap) {
      // Faces sit three to a row, each with its gutter.
      texels = bootstrap.rgb; side = bootstrap.width;
      fx = (face % 3) * bootstrap.side + bootstrap.gutter + u * bootstrap.faceSize - 0.5; fy = Math.floor(face / 3) * bootstrap.side + bootstrap.gutter + v * bootstrap.faceSize - 0.5;
    } else { out[0] = blank[0]; out[1] = blank[1]; out[2] = blank[2]; return tile; }
    const i = Math.floor(fx), j = Math.floor(fy), wx = fx - i, wy = fy - j;
    const p = (j * side + i) * 3, q = p + side * 3;
    const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy;
    out[0] = texels[p] * w00 + texels[p + 3] * w10 + texels[q] * w01 + texels[q + 3] * w11;
    out[1] = texels[p + 1] * w00 + texels[p + 4] * w10 + texels[q + 1] * w01 + texels[q + 4] * w11;
    out[2] = texels[p + 2] * w00 + texels[p + 5] * w10 + texels[q + 2] * w01 + texels[q + 5] * w11;
    return tile;
  };
}

/** Draws a view from a display table as the shader does, into RGB bytes: one ray through each judged pixel's centre. */
export function renderView(dataset, table, camera, viewport, { stride = 1, out, ...shading } = {}) {
  const { forward, right, up } = viewBasis(camera), { tanH, tanV } = planeExtents(viewport), size = viewSize(viewport, stride);
  const pixels = out ?? new Uint8Array(size.width * size.height * 3), shade = makeShader(dataset, table, shading), colour = [0, 0, 0];
  let at = 0;
  for (let py = 0; py < viewport.height; py += stride) {
    const b = (1 - 2 * (py + 0.5) / viewport.height) * tanV;
    for (let px = 0; px < viewport.width; px += stride, at += 3) {
      const a = (2 * (px + 0.5) / viewport.width - 1) * tanH;
      const x = forward[0] + a * right[0] + b * up[0], y = forward[1] + a * right[1] + b * up[1], z = forward[2] + a * right[2] + b * up[2];
      const length = Math.hypot(x, y, z);
      shade(x / length, y / length, z / length, colour);
      pixels[at] = colour[0] + 0.5; pixels[at + 1] = colour[1] + 0.5; pixels[at + 2] = colour[2] + 0.5;
    }
  }
  return pixels;
}

/** Unit rays of the judged pixels, `supersample`² per pixel on a regular sub-grid. */
export function judgedRays(camera, viewport, stride, supersample) {
  const { forward, right, up } = viewBasis(camera), { tanH, tanV } = planeExtents(viewport), size = viewSize(viewport, stride), n = supersample;
  const rays = new Float32Array(size.width * size.height * n * n * 3);
  let at = 0;
  for (let py = 0; py < viewport.height; py += stride) for (let px = 0; px < viewport.width; px += stride) for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
    const a = (2 * (px + (sx + 0.5) / n) / viewport.width - 1) * tanH, b = (1 - 2 * (py + (sy + 0.5) / n) / viewport.height) * tanV;
    const x = forward[0] + a * right[0] + b * up[0], y = forward[1] + a * right[1] + b * up[1], z = forward[2] + a * right[2] + b * up[2];
    const length = 1 / Math.hypot(x, y, z);
    rays[at++] = x * length; rays[at++] = y * length; rays[at++] = z * length;
  }
  return rays;
}

/** The same pixels drawn straight from the source (a Phase 1 `loadSource` result), as RGB bytes. */
export function referenceView(source, camera, viewport, { stride = 1, supersample = 2 } = {}) {
  const rays = judgedRays(camera, viewport, stride, supersample), size = viewSize(viewport, stride);
  return resolvePixels(sampleSource(source, rays, new Float32Array(rays.length)), supersample * supersample, new Uint8Array(size.width * size.height * 3));
}

/** A display table with every cell at one level: the whole sphere at that level. */
export function uniformTable(tiling, level) {
  const C = tiling.cells, table = new Int32Array(tiling.roots * C * C), shift = tiling.maxLevel - level;
  for (let cell = 0; cell < table.length; cell++) table[cell] = level < 0 ? -1 : tiling.id(Math.floor(cell / (C * C)), level, (cell % C) >> shift, (Math.floor(cell / C) % C) >> shift);
  return table;
}
