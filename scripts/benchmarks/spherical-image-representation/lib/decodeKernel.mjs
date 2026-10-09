/**
 * The client's side of the residual scheme, as the tight loops a viewer would
 * run for one tile: bytes → integers → children → RGBA. No Node APIs, so the
 * same file is timed in Node and bundled into the browser benchmark.
 *
 * A tile is `width` × `height` parents and twice that in children. Planes are
 * Y′, Cb, Cr one after another. Details are the nine bands of lib/hierarchy.mjs,
 * each `width · height` integers, row by row.
 */

/** The inverse of `packIntegers`: zigzag bytes with a 255 escape to 32 bits. Returns the bytes consumed. */
export function unpackIntegers(bytes, values) {
  let at = 0;
  for (let i = 0; i < values.length; i++) {
    let z = bytes[at++];
    if (z === 255) { z = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0; at += 4; }
    values[i] = z & 1 ? -((z + 1) / 2) : z / 2;
  }
  return at;
}

/**
 * Parents and quantized details → children, for cells of equal area: every
 * weight is ½, so the client needs nothing but the data. `steps` holds the
 * nine bands' quantization steps.
 */
export function inverseHaarEqual(parent, details, width, height, steps, out) {
  const parents = width * height, childWidth = width * 2, children = parents * 4;
  for (let plane = 0; plane < 3; plane++) {
    const band = plane * 3 * parents, s0 = steps[plane * 3] / 2, s1 = steps[plane * 3 + 1] / 2, s2 = steps[plane * 3 + 2] / 2;
    const from = plane * parents, to = plane * children;
    for (let y = 0; y < height; y++) {
      let p = y * width, c = to + 2 * y * childWidth;
      for (let x = 0; x < width; x++, p++, c += 2) {
        const value = parent[from + p], half = details[band + 2 * parents + p] * s2;
        const top = value + half, bottom = value - half;
        const a = details[band + p] * s0, b = details[band + parents + p] * s1;
        out[c] = top + a; out[c + 1] = top - a;
        out[c + childWidth] = bottom + b; out[c + childWidth + 1] = bottom - b;
      }
    }
  }
}

/**
 * The same for cells of unequal area: `areas` holds the solid angle of every
 * child, which the client must compute or be sent.
 */
export function inverseHaarWeighted(parent, details, width, height, steps, areas, out) {
  const parents = width * height, childWidth = width * 2, children = parents * 4;
  for (let plane = 0; plane < 3; plane++) {
    const band = plane * 3 * parents, s0 = steps[plane * 3], s1 = steps[plane * 3 + 1], s2 = steps[plane * 3 + 2];
    const from = plane * parents, to = plane * children;
    for (let y = 0; y < height; y++) {
      let p = y * width, k = 2 * y * childWidth;
      for (let x = 0; x < width; x++, p++, k += 2) {
        const a00 = areas[k], a10 = areas[k + 1], a01 = areas[k + childWidth], a11 = areas[k + childWidth + 1];
        const upper = a00 + a10, lower = a01 + a11;
        const value = parent[from + p], d2 = details[band + 2 * parents + p] * s2;
        const top = value + lower / (upper + lower) * d2, bottom = value - upper / (upper + lower) * d2;
        const d0 = details[band + p] * s0, d1 = details[band + parents + p] * s1;
        const c = to + k;
        out[c] = top + a10 / upper * d0; out[c + 1] = top - a00 / upper * d0;
        out[c + childWidth] = bottom + a11 / lower * d1; out[c + childWidth + 1] = bottom - a01 / lower * d1;
      }
    }
  }
}

/** Y′CbCr planes → RGBA bytes ready for a texture upload. */
export function yccToRgba(planes, count, rgba) {
  for (let i = 0, o = 0; i < count; i++, o += 4) {
    const y = planes[i], cb = planes[count + i] - 128, cr = planes[2 * count + i] - 128;
    const r = y + 1.402 * cr, g = y - 0.344136 * cb - 0.714136 * cr, b = y + 1.772 * cb;
    rgba[o] = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0;
    rgba[o + 1] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0;
    rgba[o + 2] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
    rgba[o + 3] = 255;
  }
}

/** Copies a `size` × `size` RGBA tile into an atlas `atlasWidth` wide at (x, y). */
export function placeTile(tile, size, atlas, atlasWidth, x, y) {
  for (let row = 0; row < size; row++) atlas.set(tile.subarray(row * size * 4, (row + 1) * size * 4), ((y + row) * atlasWidth + x) * 4);
}
