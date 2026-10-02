/**
 * Image and byte codecs, all ones already on this machine: libjpeg-turbo's
 * cjpeg/djpeg, libwebp's cwebp/dwebp, macOS's sips for AVIF and JPEG 2000,
 * and Node's zlib for deflate, Brotli and Zstandard. No codec is built here.
 *
 * Images are `{ width, height, rgb }` with 8-bit sRGB bytes. Every lossy codec
 * is measured by decoding its own output, never by its nominal quality.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { decodePng, encodeJpeg as encodeJpegJs, encodePng } from "../../../scripts/lib/panoramaImage.mjs";
import { scratchDirectory } from "./environment.mjs";
import { parsePpm } from "./source.mjs";

/**
 * Runs a codec with `input` on its standard input. Only for tools that know
 * where their input ends without waiting for the pipe to close (cjpeg reads a
 * sized PPM, djpeg stops at the end-of-image marker): Node sometimes fails to
 * close the pipe, and a tool waiting for that hangs. A stuck call is given up
 * and tried once more.
 */
function run(command, args, input) {
  const options = { input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "ignore"], timeout: 60000 };
  try { return execFileSync(command, args, options); } catch (error) {
    if (error.code !== "ETIMEDOUT") throw error;
    return execFileSync(command, args, options);
  }
}

let fileCounter = 0;
/** A scratch file name for the tools that work on files; one folder per process. */
function scratchFile(extension) {
  const directory = path.join(scratchDirectory, "codec-files", String(process.pid));
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `${fileCounter++}.${extension}`);
}
/** Runs a tool from a file to a file and returns the output file's bytes; both files are removed. */
function runOnFiles(command, args, input, inputExtension, outputExtension) {
  const from = scratchFile(inputExtension), to = scratchFile(outputExtension);
  writeFileSync(from, input);
  try {
    execFileSync(command, args(from, to), { stdio: "ignore", timeout: 60000 });
    return readFileSync(to);
  } finally { rmSync(from, { force: true }); rmSync(to, { force: true }); }
}

export function toPpm({ width, height, rgb }) {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, "latin1"), Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength)]);
}

function versionOf(command, args, pattern) {
  // Some of these print their version on standard error.
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) return null;
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return pattern.exec(text)?.[0] ?? text.trim().split("\n")[0];
}

/** Versions of the codecs used, or null where one is missing. */
export function codecVersions() {
  return {
    cjpeg: versionOf("cjpeg", ["-version"], /libjpeg-turbo version [\d.]+/),
    cwebp: versionOf("cwebp", ["-version"], /^[\d.]+/),
    sips: versionOf("sips", ["--version"], /sips-\d+/),
    zlib: process.versions.zlib, brotli: process.versions.brotli, zstd: process.versions.zstd ?? null,
  };
}

// ─── Image codecs ──────────────────────────────────────────────────────

/** JPEG as a web encoder would write it: 4:2:0 chroma, optimized Huffman tables, baseline. */
export function encodeJpeg(image, quality, { chroma = "2x2", progressive = false } = {}) {
  return run("cjpeg", ["-quality", String(quality), "-optimize", "-sample", chroma, ...(progressive ? ["-progressive"] : [])], toPpm(image));
}
export const decodeJpeg = bytes => parsePpm(run("djpeg", ["-ppm"], bytes));

// cwebp and dwebp read standard input to its end, so they are given files.
export const encodeWebp = (image, quality) => runOnFiles("cwebp", (from, to) => ["-quiet", "-q", String(quality), "-m", "4", from, "-o", to], toPpm(image), "ppm", "webp");
export const decodeWebp = bytes => parsePpm(runOnFiles("dwebp", (from, to) => ["-quiet", "-ppm", from, "-o", to], bytes, "webp", "ppm"));

/** AVIF ("avif") or JPEG 2000 ("jp2") through macOS's sips, which works on files. */
export function encodeSips(image, format, quality) {
  return runOnFiles("sips", (from, to) => ["-s", "format", format, "-s", "formatOptions", String(quality), from, "--out", to], encodePngFast(image), "png", format);
}
export function decodeSips(bytes, format) {
  const decoded = decodePng(runOnFiles("sips", (from, to) => ["-s", "format", "png", from, "--out", to], bytes, format, "png"));
  const rgb = new Uint8Array(decoded.width * decoded.height * 3);
  for (let i = 0; i < decoded.width * decoded.height; i++) { rgb[i * 3] = decoded.rgba[i * 4]; rgb[i * 3 + 1] = decoded.rgba[i * 4 + 1]; rgb[i * 3 + 2] = decoded.rgba[i * 4 + 2]; }
  return { width: decoded.width, height: decoded.height, rgb };
}

/** An unfiltered, lightly compressed PNG: a lossless container for handing pixels to another program. */
export function encodePngFast({ width, height, rgb }) {
  const stride = width * 3, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("sRGB", Buffer.from([0])), chunk("IDAT", zlib.deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Lossless PNG size, with the repository's own encoder (best filter per row, deflate level 9). */
export const pngBytes = image => encodePng({ width: image.width, height: image.height, rgb: Buffer.from(image.rgb.buffer, image.rgb.byteOffset, image.rgb.byteLength) }).length;

export const IMAGE_CODECS = {
  jpeg: { encode: encodeJpeg, decode: decodeJpeg, mimeType: "image/jpeg" },
  // The same encoder without chroma subsampling, as jpeg-js writes the tour's current files.
  jpeg444: { encode: (image, quality) => encodeJpeg(image, quality, { chroma: "1x1" }), decode: decodeJpeg, mimeType: "image/jpeg" },
  // What scripts/prepare-panorama.mjs writes today: jpeg-js, no chroma subsampling, the standard Huffman tables.
  jpegjs: { encode: (image, quality) => encodeJpegJs({ width: image.width, height: image.height, rgb: Buffer.from(image.rgb.buffer, image.rgb.byteOffset, image.rgb.byteLength) }, quality), decode: decodeJpeg, mimeType: "image/jpeg" },
  webp: { encode: encodeWebp, decode: decodeWebp, mimeType: "image/webp" },
  avif: { encode: (image, quality) => encodeSips(image, "avif", quality), decode: bytes => decodeSips(bytes, "avif"), mimeType: "image/avif" },
  jp2: { encode: (image, quality) => encodeSips(image, "jp2", quality), decode: bytes => decodeSips(bytes, "jp2"), mimeType: "image/jp2" },
};

// ─── General-purpose compressors ───────────────────────────────────────

export const BYTE_CODECS = {
  // What a browser can inflate without shipping a decoder: DecompressionStream("deflate-raw").
  deflate: bytes => zlib.deflateRawSync(bytes, { level: 9 }),
  brotli: bytes => zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }),
  zstd: bytes => zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }),
};
export const inflate = bytes => zlib.inflateRawSync(bytes);
