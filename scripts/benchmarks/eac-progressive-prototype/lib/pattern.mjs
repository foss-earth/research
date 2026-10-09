/**
 * The diagnostic panorama: a colour for every direction, known in closed
 * form, so a picture drawn by the prototype can be checked against the truth
 * without going through any of the prototype's own mapping code.
 *
 * - The base colour is 128 + 96·(x, y, z): every direction has its own colour,
 *   so a face that is mirrored, rotated or swapped shows as the wrong colour
 *   everywhere, not only at an edge.
 * - Dark lines where x, y or z is a multiple of ⅛ are great-circle-like curves
 *   that cross every face edge and pass near every cube corner at an angle, so
 *   a seam shows as a broken or doubled line.
 * - A fine checker inside 12° of the (1, 1, 1) corner and of the +X, +Y edge
 *   middle puts texel-scale detail exactly where three faces, and two, meet.
 */
const LINE_HALF_WIDTH = 0.012;
const nearLine = value => { const f = value * 8 - Math.floor(value * 8); return Math.min(f, 1 - f) < LINE_HALF_WIDTH * 8; };

export function patternColour(x, y, z, out) {
  let r = 128 + 96 * x, g = 128 + 96 * y, b = 128 + 96 * z;
  if (nearLine(x) || nearLine(y) || nearLine(z)) { r *= 0.35; g *= 0.35; b *= 0.35; }
  const corner = (x + y + z) / Math.sqrt(3), edge = (x + y) / Math.SQRT2;
  if (corner > 0.978 || edge > 0.978) {
    // About 0.35° squares: six source texels, so the finest level resolves them and coarser ones do not.
    const cell = Math.floor(x * 160) + Math.floor(y * 160) + Math.floor(z * 160);
    if (cell & 1) { r = 255 - r * 0.5; g = 255 - g * 0.5; b = 255 - b * 0.5; }
  }
  out[0] = Math.round(r); out[1] = Math.round(g); out[2] = Math.round(b);
  return out;
}
