/**
 * Shared by the delivery experiments: the views quality is judged on, their
 * references from the source, and drawing a view from whatever units of a
 * scheme a client holds.
 */
import { buildGutter, mapRays, padField, resolvePixels } from "./field.mjs";
import { TO_LINEAR } from "./source.mjs";
import { sampleSource, standardViews, viewRays } from "./views.mjs";

/** Twelve of the standard views: enough directions to judge a whole panorama at a tenth of the cost. */
export const EVALUATION_VIEW_IDS = [
  "horizon-0", "horizon-120", "horizon-240", "mid-35-30", "mid--35-150", "mid-35-270", "mid--35-270",
  "pole-90-0", "pole--90-0", "random-0", "random-1", "random-2",
];
export const evaluationViews = () => standardViews().filter(view => EVALUATION_VIEW_IDS.includes(view.id));

/** Rays and chart positions of each view for a representation; the same for every panorama. */
export function mapViews(rep, views, { size, fov, supersample }) {
  return views.map(view => {
    const rays = viewRays(view, size, fov, supersample);
    return { view, rays, mapping: mapRays(rep, rays) };
  });
}

/** The views taken straight from the source, as sRGB bytes. */
export function referenceViews(source, mapped, { size, supersample }) {
  const linear = new Float32Array(size * size * supersample * supersample * 3);
  return mapped.map(({ rays }) => resolvePixels(sampleSource(source, rays, linear), supersample * supersample, new Uint8Array(size * size * 3)));
}

const gutters = new Map();
function gutterFor(rep, N) {
  const key = `${rep.id}/${N}`;
  if (!gutters.has(key)) gutters.set(key, buildGutter(rep, N));
  return gutters.get(key);
}

/** A scheme's decoded levels with their chart borders, ready to be read along rays. */
export function makeDisplay(hierarchy, scheme) {
  const { rep, N, levels, finest, base, charts } = hierarchy;
  const padded = new Array(finest + 1).fill(null);
  for (let l = base; l <= finest; l++) {
    const levelN = N / 2 ** (finest - l);
    padded[l] = padField({ W: levels[l].W, H: levels[l].H, perCell: 1, charts, rgb: scheme.images[l] }, gutterFor(rep, levelN));
  }
  return { hierarchy, scheme, padded };
}

/**
 * Linear-light colours along mapped rays. Each ray reads, bilinearly, the
 * finest level whose unit over that ray is in `available` (a byte per unit),
 * falling back to the coarse sphere; `level` instead forces one level
 * everywhere. Returns the number of rays drawn from each level.
 *
 * Bilinear taps at a tile's edge read the neighbouring tile's cells at that
 * level whether or not that tile has arrived; a client would hold a one-cell
 * border with each tile. The benchmark does not charge for that border.
 */
export function renderAvailable(display, mapping, available, out, level = -1) {
  const { hierarchy, scheme, padded } = display, { levels, finest, base } = hierarchy;
  const { chart, u, v, count } = mapping, tile = scheme.tile, grids = scheme.grids;
  const drawn = new Array(finest + 1).fill(0);
  for (let r = 0; r < count; r++) {
    const c = chart[r], ru = u[r], rv = v[r];
    let l = level >= 0 ? level : finest;
    if (level < 0) {
      for (; l > base; l--) {
        const grid = grids[l], W = levels[l].W, H = levels[l].H;
        const tx = Math.min(grid.tilesX - 1, Math.floor(ru * W / tile)), ty = Math.min(grid.tilesY - 1, Math.floor(rv * H / tile));
        if (available[grid.lookup[(c * grid.tilesY + ty) * grid.tilesX + tx]]) break;
      }
    }
    drawn[l]++;
    const W = levels[l].W, H = levels[l].H, image = padded[l], row = (W + 2) * 3;
    const fx = ru * W - 0.5, fy = rv * H - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const p = c * (H + 2) * row + (j + 1) * row + (i + 1) * 3, q = p + row;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    out[r * 3] = TO_LINEAR[image[p]] * w00 + TO_LINEAR[image[p + 3]] * w10 + TO_LINEAR[image[q]] * w01 + TO_LINEAR[image[q + 3]] * w11;
    out[r * 3 + 1] = TO_LINEAR[image[p + 1]] * w00 + TO_LINEAR[image[p + 4]] * w10 + TO_LINEAR[image[q + 1]] * w01 + TO_LINEAR[image[q + 4]] * w11;
    out[r * 3 + 2] = TO_LINEAR[image[p + 2]] * w00 + TO_LINEAR[image[p + 5]] * w10 + TO_LINEAR[image[q + 2]] * w01 + TO_LINEAR[image[q + 5]] * w11;
  }
  return drawn;
}

/** The units of each level that a set of mapped rays touches, with how many rays touch each: `Map(unit → rays)`. */
export function unitsUnderRays(hierarchy, scheme, mapping) {
  const { levels, finest, base } = hierarchy, { chart, u, v, count } = mapping, tile = scheme.tile;
  const touched = new Map();
  for (let l = base + 1; l <= finest; l++) {
    const grid = scheme.grids[l], W = levels[l].W, H = levels[l].H;
    for (let r = 0; r < count; r++) {
      const tx = Math.min(grid.tilesX - 1, Math.floor(u[r] * W / tile)), ty = Math.min(grid.tilesY - 1, Math.floor(v[r] * H / tile));
      const unit = grid.lookup[(chart[r] * grid.tilesY + ty) * grid.tilesX + tx];
      touched.set(unit, (touched.get(unit) ?? 0) + 1);
    }
  }
  return touched;
}
