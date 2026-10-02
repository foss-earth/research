/**
 * The corpus: the UMN tour's source panoramas, the highest-quality copies that
 * exist (6144 × 3072 equirectangular JPEG, YouVisit's largest derivative; the
 * originals are lost, see the tour's .local/youvisit-backup/README.md).
 *
 * A source is held as a pyramid of 8-bit sRGB equirectangular images, each
 * level the 2 × 2 average of the one above taken in linear light, and is read
 * with a bilinear tap in linear light: the same conventions as
 * scripts/lib/panoramaImage.mjs (u right, v down, centre forward).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { repositoryRoot, sha256File } from "./environment.mjs";

/** Six panoramas chosen for different content, by looking at YouVisit's thumbnails. */
export const CORPUS = [
  { id: "northrop-mall", panorama: "363729", content: "outdoor: sky with the sun, lawn, trees, buildings on the horizon" },
  { id: "walter-study", panorama: "365409", content: "indoor: ornate painted ceiling at the zenith, bookshelves, patterned carpet" },
  { id: "bookstore", panorama: "365382", content: "indoor: shop signage and text, smooth ceiling and tiled floor" },
  { id: "gardens", panorama: "363756", content: "outdoor: flowers and foliage, clouds, brick paving" },
  { id: "stadium", panorama: "363732", content: "outdoor: field lines, lettering, stands; large smooth sky" },
  { id: "superblock", panorama: "363760", content: "outdoor: tree canopy overhead, so fine detail at the zenith" },
];

export const defaultCorpusRoot = path.join(repositoryRoot, "../UMN-VR/UMN-VR.github.io/.local/youvisit-backup/snapshot-2026-09-27/media/panoramas");

// ─── sRGB ↔ linear, as tables ──────────────────────────────────────────

export const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** Linear 0–1, as an index 0–65535, to the nearest sRGB byte. */
export const TO_SRGB = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
  const c = i / 65535;
  TO_SRGB[i] = Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
}
export const encodeSrgb = linear => TO_SRGB[linear <= 0 ? 0 : linear >= 1 ? 65535 : (linear * 65535 + 0.5) | 0];

// ─── Loading ───────────────────────────────────────────────────────────

/** Decodes a JPEG with libjpeg-turbo's djpeg to `{ width, height, rgb }`. */
export function decodeJpegFile(file) {
  const ppm = execFileSync("djpeg", ["-ppm", file], { maxBuffer: 1 << 30 });
  return parsePpm(ppm);
}

export function parsePpm(ppm) {
  // "P6\n<width> <height>\n255\n" then RGB bytes.
  let offset = 0;
  const token = () => {
    while (ppm[offset] === 0x23 || ppm[offset] <= 0x20) {
      if (ppm[offset] === 0x23) while (ppm[offset] !== 0x0a) offset++;
      offset++;
    }
    const start = offset;
    while (ppm[offset] > 0x20) offset++;
    return ppm.toString("latin1", start, offset);
  };
  if (token() !== "P6") throw new Error("not a binary PPM");
  const width = Number(token()), height = Number(token());
  if (token() !== "255") throw new Error("PPM is not 8-bit");
  offset++;
  return { width, height, rgb: new Uint8Array(ppm.buffer, ppm.byteOffset + offset, width * height * 3) };
}

function halve(level) {
  const width = level.width >> 1, height = level.height >> 1;
  const rgb = new Uint8Array(width * height * 3), source = level.rgb, stride = level.width * 3;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (2 * y * level.width + 2 * x) * 3, d = (y * width + x) * 3;
    for (let c = 0; c < 3; c++) {
      const sum = TO_LINEAR[source[s + c]] + TO_LINEAR[source[s + 3 + c]] + TO_LINEAR[source[s + stride + c]] + TO_LINEAR[source[s + stride + 3 + c]];
      rgb[d + c] = encodeSrgb(sum / 4);
    }
  }
  return { width, height, rgb };
}

/** The source pyramid of one corpus entry: level 0 is the decoded file. */
export function loadSource(entry, corpusRoot = defaultCorpusRoot) {
  const file = path.join(corpusRoot, entry.panorama, "6144.jpg");
  if (!existsSync(file)) throw new Error(`source panorama missing: ${file}\nPass --corpus-root=<folder holding <id>/6144.jpg>.`);
  const levels = [decodeJpegFile(file)];
  while (levels.at(-1).width > 96) levels.push(halve(levels.at(-1)));
  return { ...entry, file, sha256: sha256File(file), width: levels[0].width, height: levels[0].height, levels };
}

/** Bilinear tap of one level in linear light, longitude wrapping and latitude clamped. Adds into `sum` at `at`. */
export function tapLinear(level, u, v, sum, at) {
  const width = level.width, height = level.height, rgb = level.rgb;
  const fx = u * width - 0.5;
  let fy = v * height - 0.5;
  if (fy < 0) fy = 0; else if (fy > height - 1) fy = height - 1;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  let xa = x0 % width; if (xa < 0) xa += width;
  const xb = xa + 1 === width ? 0 : xa + 1;
  const p00 = (y0 * width + xa) * 3, p10 = (y0 * width + xb) * 3, p01 = (y1 * width + xa) * 3, p11 = (y1 * width + xb) * 3;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  sum[at] += TO_LINEAR[rgb[p00]] * w00 + TO_LINEAR[rgb[p10]] * w10 + TO_LINEAR[rgb[p01]] * w01 + TO_LINEAR[rgb[p11]] * w11;
  sum[at + 1] += TO_LINEAR[rgb[p00 + 1]] * w00 + TO_LINEAR[rgb[p10 + 1]] * w10 + TO_LINEAR[rgb[p01 + 1]] * w01 + TO_LINEAR[rgb[p11 + 1]] * w11;
  sum[at + 2] += TO_LINEAR[rgb[p00 + 2]] * w00 + TO_LINEAR[rgb[p10 + 2]] * w10 + TO_LINEAR[rgb[p01 + 2]] * w01 + TO_LINEAR[rgb[p11 + 2]] * w11;
}

/** The pyramid level whose texels are nearest `pitch` radians at the equator. */
export function levelForPitch(source, pitch) {
  const level = Math.round(Math.log2(pitch / (2 * Math.PI / source.width)));
  return Math.max(0, Math.min(source.levels.length - 1, level));
}
