#!/usr/bin/env node
/**
 * The offline preprocessor: one equirectangular panorama in, a static tile
 * pyramid out, in the equi-angular cube or the ordinary cubemap.
 *
 *   node benchmarks/eac-progressive-prototype/preprocess/build-dataset.mjs
 *     [--panoramas=northrop-mall,bookstore,superblock,pattern] [--projections=eac,cube]
 *     [--tiles=192] [--face=1536] [--quality=80] [--chroma=2x2] [--bootstrap=24,48,96,192]
 *     [--residual=true] [--measure-gutter=true] [--out=build/benchmarks/eac-progressive-prototype/dataset]
 *     [--corpus-root=<folder holding <id>/6144.jpg>]
 *
 * Writes `<out>/<panorama>/<projection>-t<tile>/`:
 *
 *   manifest.json                       the versioned description a client needs
 *   tiles.json                          every tile's byte length, by tile id (optional for a client)
 *   boot-<size>.jpg                     the whole sphere, six faces in one image
 *   t/<face>/<level>/<x>/<y>.jpg        replacement tiles: each decodes alone
 *   r/<face>/<level>/<x>/<y>.jpg        residual tiles, levels 1 and up: the difference from the enlarged parent
 *
 * Everything is a plain file a static host can serve.
 *
 * **One pipeline for both projections.** The source, the resampling rule, the
 * colour handling, the tile cutter and the encoder are the same code for
 * `eac` and `cube`; only the face warp differs (lib/tiling.mjs).
 *
 * **Resampling** is Phase 1's (`resample`): each texel is the mean of its own
 * cell, in linear light, from 16 taps of the source. Every level is resampled
 * from the source by that rule, not reduced from the level below.
 *
 * **Gutters.** A face of F texels is resampled on an (F + 2g)² grid whose
 * extra texels lie at the face's own coordinates continued past its edge:
 * u = −½/F, 1 + ½/F and so on, which are directions on the neighbouring face.
 * A tile is a crop of that grid, so its gutter is the neighbouring tile's own
 * texels inside a face, and the same image continued across a face edge or a
 * cube corner. A tile needs nothing from any other tile to be filtered.
 *
 * **The face size** defaults to 1536: the source is 6144 texels around, and an
 * equi-angular face spans a quarter turn at a constant rate, so 1536 texels
 * give it exactly the source's density at the horizon. A larger face would
 * hold no more detail than the source has; a smaller one would lose some.
 *
 * `pattern` is a synthetic panorama for the correctness tests: its colour is a
 * known function of direction (lib/pattern.mjs), so a rendered pixel can be
 * checked against the truth without trusting any of this code.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { representation } from "../../spherical-image-representation/lib/representations.mjs";
import { CORPUS, TO_LINEAR, defaultCorpusRoot, encodeSrgb, loadSource } from "../../spherical-image-representation/lib/source.mjs";
import { resample } from "../../spherical-image-representation/lib/field.mjs";
import { codecVersions, decodeJpeg, encodeJpeg } from "../../spherical-image-representation/lib/codecs.mjs";
import { environment, parseArguments, sha256 } from "../../spherical-image-representation/lib/environment.mjs";
import { FACES, makeTiling } from "../lib/tiling.mjs";
import { addDifference, encodeDifference, predictChild } from "../lib/residual.mjs";
import { patternColour } from "../lib/pattern.mjs";
import { defaultDataset, repositoryRoot } from "../lib/paths.mjs";

const options = parseArguments({
  panoramas: ["northrop-mall", "bookstore", "superblock"], projections: ["eac", "cube"], tiles: ["192"], face: 1536, quality: 80, chroma: "2x2",
  bootstrap: ["24", "48", "96", "192"], residual: true, "measure-gutter": true, out: defaultDataset, "corpus-root": defaultCorpusRoot,
});
const GUTTER = 1;
const tileSizes = options.tiles.map(Number), bootSizes = options.bootstrap.map(Number);
for (const tile of tileSizes) if (!Number.isInteger(Math.log2(options.face / tile))) throw new Error(`--face=${options.face} is not --tiles=${tile} times a power of two`);

/** The synthetic panorama, as a source pyramid the same shape as a real one. */
function patternSource() {
  const width = 6144, height = 3072, rgb = new Uint8Array(width * height * 3), colour = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    const lat = (0.5 - (y + 0.5) / height) * Math.PI, c = Math.cos(lat), z = Math.sin(lat);
    for (let x = 0; x < width; x++) {
      const lon = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      patternColour(c * Math.sin(lon), c * Math.cos(lon), z, colour);
      rgb.set(colour, (y * width + x) * 3);
    }
  }
  const levels = [{ width, height, rgb }];
  while (levels.at(-1).width > 96) {
    const from = levels.at(-1), w = from.width >> 1, h = from.height >> 1, out = new Uint8Array(w * h * 3), stride = from.width * 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      const s = (2 * y * from.width + 2 * x) * 3 + c;
      out[(y * w + x) * 3 + c] = encodeSrgb((TO_LINEAR[from.rgb[s]] + TO_LINEAR[from.rgb[s + 3]] + TO_LINEAR[from.rgb[s + stride]] + TO_LINEAR[from.rgb[s + stride + 3]]) / 4);
    }
    levels.push({ width: w, height: h, rgb: out });
  }
  return { id: "pattern", panorama: null, content: "synthetic: colour is a known function of direction", file: null, sha256: sha256(Buffer.from(rgb.buffer)), width, height, levels };
}

/** A projection with its faces continued `GUTTER` texels past every edge: chart (u, v) 0–1 covers the padded face. */
function padded(rep, face) {
  const scale = (face + 2 * GUTTER) / face, shift = GUTTER / face;
  return { ...rep, toDir: (chart, u, v, out) => rep.toDir(chart, u * scale - shift, v * scale - shift, out) };
}

/** Faces of `size` texels with their gutter: `{ size, side, rgb }`, `rgb` indexed `((face·side + j)·side + i)·3` with `side = size + 2·GUTTER`. */
function resampleFaces(rep, size, source) {
  const side = size + 2 * GUTTER;
  return { size, side, rgb: resample(padded(rep, size), side, [source])[0].rgb };
}

function crop(faces, face, x0, y0, width, height) {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const from = ((face * faces.side + y0 + y) * faces.side + x0) * 3;
    out.set(faces.rgb.subarray(from, from + width * 3), y * width * 3);
  }
  return { width, height, rgb: out };
}

const encode = image => encodeJpeg(image, options.quality, { chroma: options.chroma });
function writeFile(file, bytes) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); }

const summary = [];
for (const id of options.panoramas) {
  const started = Date.now();
  const source = id === "pattern" ? patternSource() : loadSource(CORPUS.find(entry => entry.id === id) ?? (() => { throw new Error(`unknown panorama ${id}; known: pattern, ${CORPUS.map(entry => entry.id).join(", ")}`); })(), options["corpus-root"]);
  for (const projection of options.projections) {
    const rep = representation(projection);
    // Every face size any tile size or bootstrap needs, resampled once.
    const sizes = new Set(bootSizes);
    for (const tile of tileSizes) for (let size = tile; size <= options.face; size *= 2) sizes.add(size);
    const faces = new Map([...sizes].sort((a, b) => a - b).map(size => [size, resampleFaces(rep, size, source)]));

    for (const tile of tileSizes) {
      const maxLevel = Math.log2(options.face / tile), tiling = makeTiling({ projection, tile, maxLevel, gutter: GUTTER }), stored = tiling.stored;
      const out = path.join(options.out, id, `${projection}-t${tile}`);
      rmSync(out, { recursive: true, force: true });

      // The whole sphere in one image: px nx py over ny pz nz, each face with its gutter.
      const bootstrap = bootSizes.map(size => {
        const from = faces.get(size), side = from.side, rgb = new Uint8Array(3 * side * 2 * side * 3);
        for (let face = 0; face < 6; face++) for (let y = 0; y < side; y++) {
          const start = ((face * side + y) * side) * 3;
          rgb.set(from.rgb.subarray(start, start + side * 3), ((Math.floor(face / 3) * side + y) * 3 * side + (face % 3) * side) * 3);
        }
        const bytes = encode({ width: 3 * side, height: 2 * side, rgb });
        writeFile(path.join(out, `boot-${size}.jpg`), bytes);
        return { faceSize: size, gutter: GUTTER, width: 3 * side, height: 2 * side, bytes: bytes.length, url: `boot-${size}.jpg` };
      });

      const replacementBytes = new Array(tiling.count).fill(0), residualBytes = new Array(tiling.count).fill(0), withoutGutterBytes = new Array(tiling.count).fill(0);
      let reconstructed = new Map(), clipped = 0, residualValues = 0;
      const prediction = new Uint8Array(stored * stored * 3), difference = new Uint8Array(stored * stored * 3);
      for (let level = 0; level <= maxLevel; level++) {
        const from = faces.get(tiling.faceSize(level)), next = new Map();
        for (let tileId = tiling.firstOfLevel(level); tileId < tiling.firstOfLevel(level + 1); tileId++) {
          const { face, x, y } = tiling.address(tileId);
          const target = crop(from, face, x * tile, y * tile, stored, stored);
          const bytes = encode(target);
          replacementBytes[tileId] = bytes.length;
          writeFile(path.join(out, tiling.path(tileId, "t")), bytes);
          if (options["measure-gutter"]) withoutGutterBytes[tileId] = encode(crop(from, face, x * tile + GUTTER, y * tile + GUTTER, tile, tile)).length;
          if (!options.residual) continue;
          if (level === 0) { next.set(tileId, decodeJpeg(bytes).rgb); continue; }
          // The parent as a client will have it: decoded, never the original.
          predictChild(reconstructed.get(tiling.parent(tileId)), 3, tile, GUTTER, x & 1, y & 1, prediction, 3);
          clipped += encodeDifference(target.rgb, prediction, 3, difference); residualValues += difference.length;
          const residual = encode({ width: stored, height: stored, rgb: difference });
          residualBytes[tileId] = residual.length;
          writeFile(path.join(out, tiling.path(tileId, "r")), residual);
          if (level < maxLevel) next.set(tileId, addDifference(prediction.slice(), 3, decodeJpeg(residual).rgb, 3));
        }
        reconstructed = next;
      }

      const levels = Array.from({ length: maxLevel + 1 }, (_, level) => {
        const ids = Array.from({ length: tiling.levelCount(level) }, (_, k) => tiling.firstOfLevel(level) + k), sum = list => ids.reduce((total, tileId) => total + list[tileId], 0);
        return {
          level, faceSize: tiling.faceSize(level), tilesPerSide: tiling.tilesPerSide(level), tiles: ids.length,
          replacementBytes: sum(replacementBytes), residualBytes: level === 0 || !options.residual ? null : sum(residualBytes),
          replacementBytesWithoutGutter: options["measure-gutter"] ? sum(withoutGutterBytes) : null,
          largestReplacementBytes: Math.max(...ids.map(tileId => replacementBytes[tileId])),
        };
      });
      const manifest = {
        format: "foss-earth.progressive-panorama", version: 1,
        panorama: { id, sourceSha256: source.sha256, sourceWidth: source.width, sourceHeight: source.height },
        projection,
        axes: "image-local, right-handed: X right, Y forward, Z up",
        faces: FACES,
        faceCoordinates: "u runs along `right`, v against `up` (downward), both 0–1 across the face; texel (i, j) of an F-texel face is centred at ((i + ½)/F, (j + ½)/F)",
        warp: projection === "eac" ? "equi-angular: a face position s in −1…1 is the direction forward + tan(s·π/4)·right (and likewise for up)" : "gnomonic: a face position s in −1…1 is the direction forward + s·right (and likewise for up)",
        tile: { logical: tile, gutter: GUTTER, stored },
        gutter: "the face's own coordinates continued past its edge: inside a face the neighbouring tile's texels, across a face edge or corner the image resampled there",
        maxLevel, levels,
        levelNumbering: "level 0 is one tile per face; level l has 2^l × 2^l tiles per face and faces of logical·2^l texels",
        codec: { mimeType: "image/jpeg", encoder: codecVersions().cjpeg, options: `-quality ${options.quality} -optimize -sample ${options.chroma}`, colour: "8-bit sRGB, opaque" },
        paths: { replacement: "t/{face}/{level}/{x}/{y}.jpg", residual: options.residual ? "r/{face}/{level}/{x}/{y}.jpg" : null, tileBytes: "tiles.json" },
        bootstrap,
        reconstruction: "bilinear between texel centres, in sRGB-encoded bytes (no linear-light filtering), within one tile's stored texels; no mipmaps: the level is chosen per tile",
        residual: options.residual ? {
          appliesTo: "levels 1 and up; a level-0 tile is always a replacement tile",
          prediction: "the parent's reconstructed stored tile enlarged ×2 bilinearly: (Σ w·p + 8) >> 4 with weights 9, 3, 3, 1 on 8-bit sRGB bytes, each channel alone",
          stored: "clamp(target − prediction + 128, 0, 255) per channel, then encoded like any tile",
          child: "clamp(prediction + decoded − 128, 0, 255) per channel",
          parentConvention: "the parent as decoded and reconstructed, never the original; the encoder decodes with libjpeg-turbo's djpeg",
          clippedShare: residualValues ? clipped / residualValues : null,
        } : null,
        totals: {
          tiles: tiling.count, replacementBytes: replacementBytes.reduce((a, b) => a + b, 0), residualBytes: options.residual ? residualBytes.reduce((a, b) => a + b, 0) + levels[0].replacementBytes : null,
          replacementBytesWithoutGutter: options["measure-gutter"] ? withoutGutterBytes.reduce((a, b) => a + b, 0) : null,
        },
        generated: { ...environment(), script: path.relative(repositoryRoot, import.meta.filename), resampling: "each texel the mean of its cell in linear light, 16 taps of the source (Phase 1 lib/field.mjs resample)" },
      };
      writeFile(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
      writeFile(path.join(out, "tiles.json"), JSON.stringify({ replacement: replacementBytes, residual: options.residual ? residualBytes : null }));
      const finest = levels.at(-1);
      summary.push({
        panorama: id, projection, tile, levels: maxLevel + 1, tiles: tiling.count,
        "replacement KiB": Math.round(manifest.totals.replacementBytes / 1024), "finest level KiB": Math.round(finest.replacementBytes / 1024),
        "residual chain KiB": manifest.totals.residualBytes === null ? null : Math.round(manifest.totals.residualBytes / 1024),
        "gutter bytes": finest.replacementBytesWithoutGutter ? `+${((finest.replacementBytes / finest.replacementBytesWithoutGutter - 1) * 100).toFixed(1)}%` : null,
        "boot KiB": bootstrap.map(item => (item.bytes / 1024).toFixed(1)).join(" "),
      });
    }
  }
  console.log(`${id}: ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
console.table(summary);
console.log(`Dataset: ${options.out}`);
