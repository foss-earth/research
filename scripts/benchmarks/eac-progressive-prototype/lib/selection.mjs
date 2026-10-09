/**
 * Which tiles a view needs, and at what level: geometry only, no fetching.
 *
 * The camera is `{ yaw, pitch, roll }` in degrees (yaw 0 looks along +Y,
 * positive yaw turns right, positive pitch looks up: Phase 1's lib/views.mjs).
 * The viewport is the drawing buffer in device pixels, `{ width, height,
 * verticalFovDeg }`: the field of view is the vertical one, and the horizontal
 * one follows from the aspect. A page gets the drawing buffer from the CSS
 * size times the device pixel ratio.
 *
 * **Coverage is exact.** A tile's outline and a view's outline are both made
 * of great-circle arcs, so whether they overlap is decided exactly
 * (lib/cones.mjs), from the six faces down the quadtree to the finest level's
 * tiles, the "cells". A first version sampled the view with rays and missed
 * slivers of tiles at its border; tests/ compare the selection with every
 * pixel's own tile and must find no miss.
 *
 * **Level.** A pixel's angle is taken along the radius of the image, where a
 * perspective pixel is smallest: pitch / (1 + r²). A texel's angle is the
 * larger of its two sides (tiling.texelAngle). The level is the coarsest whose
 * texel is no larger than `detailRatio` pixels, so `detailRatio: 1` never
 * shows a texel wider than a pixel where a finer level exists, and both
 * choices err toward more detail.
 *
 * **What is approximate** is the level, not the coverage. Scout rays on a
 * regular grid over the image plane each ask for a level, and a cell takes the
 * finest any of its rays asked for; a cell no ray landed in is given the level
 * its own middle needs. The grid's spacing is `scoutFraction` (½ by default)
 * of the narrowest tile of the finest level. A pixel can therefore need one
 * level more than its cell was given; tests/ count how many do. The number of
 * scout rays in a tile is also its share of the view, used to rank requests.
 *
 * **Margin.** `marginDeg` widens the view on every side. Tiles only the margin
 * touches are returned apart, so a scheduler can rank them below the view.
 */
import { overlap, region } from "./cones.mjs";

const RAD = Math.PI / 180;

/** Phase 1's camera frame: forward, right and up in the image's axes. */
export function viewBasis({ yaw, pitch, roll = 0 }) {
  const cy = Math.cos(yaw * RAD), sy = Math.sin(yaw * RAD), cp = Math.cos(pitch * RAD), sp = Math.sin(pitch * RAD);
  const forward = [cp * sy, cp * cy, sp], right0 = [cy, -sy, 0], up0 = [-sy * sp, -cy * sp, cp];
  const cr = Math.cos(roll * RAD), sr = Math.sin(roll * RAD);
  return { forward, right: right0.map((value, i) => value * cr + up0[i] * sr), up: up0.map((value, i) => value * cr - right0[i] * sr) };
}

/** Half extents of the image plane at distance 1. */
export function planeExtents(viewport) {
  const tanV = Math.tan(viewport.verticalFovDeg * RAD / 2);
  return { tanH: tanV * viewport.width / viewport.height, tanV };
}

/** The narrowest edge of any tile of a level, as an angle in radians. The six faces are alike, so one is measured. */
export function narrowestTile(tiling, level) {
  const n = tiling.tilesPerSide(level), a = [0, 0, 0], b = [0, 0, 0];
  let narrowest = Infinity;
  const edge = (u0, v0, u1, v1) => {
    tiling.direction(0, u0, v0, a); tiling.direction(0, u1, v1, b);
    narrowest = Math.min(narrowest, 2 * Math.asin(Math.min(1, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 2)));
  };
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    if (x < n) edge(x / n, y / n, (x + 1) / n, y / n);
    if (y < n) edge(x / n, y / n, x / n, (y + 1) / n);
  }
  return narrowest;
}

export function createSelector(tiling, { detailRatio = 1, marginDeg = 5, scoutFraction = 0.5, maxLevel = tiling.maxLevel } = {}) {
  const C = tiling.cells, cellCount = tiling.roots * C * C, finest = Math.min(maxLevel, tiling.maxLevel);
  const spacing = narrowestTile(tiling, tiling.maxLevel) * scoutFraction;
  const place = [0, 0, 0];
  let cached = null;

  /**
   * `levelCap` lowers every level to at most that, for a client short of
   * memory. Returns `{ key, cells, visible, margin, centre, rays }`:
   * `cells[c]` is the level cell c needs (−1 outside the view and its margin),
   * `inView[c]` whether the view itself touches it, `visible` and `margin` map
   * a wanted tile to the number of scout rays in it.
   */
  function select(camera, viewport, levelCap = finest) {
    const key = `${camera.yaw.toFixed(3)}/${camera.pitch.toFixed(3)}/${(camera.roll ?? 0).toFixed(3)}/${viewport.width}x${viewport.height}/${viewport.verticalFovDeg}/${levelCap}`;
    if (cached?.key === key) return cached;
    const { forward, right, up } = viewBasis(camera), { tanH, tanV } = planeExtents(viewport);
    const pixel = 2 * tanV / viewport.height;
    const ray = (a, b) => { const x = forward[0] + a * right[0] + b * up[0], y = forward[1] + a * right[1] + b * up[1], z = forward[2] + a * right[2] + b * up[2], length = Math.hypot(x, y, z); return [x / length, y / length, z / length]; };
    const outline = (h, v) => region([ray(-h, v), ray(h, v), ray(h, -v), ray(-h, -v)]);
    // The margin is an angle, so the plane grows by more than it near a wide view's edge.
    const widen = half => Math.tan(Math.min(89 * RAD, Math.atan(half) + marginDeg * RAD));
    const outerH = widen(tanH), outerV = widen(tanV), view = outline(tanH, tanV), wide = marginDeg > 0 ? outline(outerH, outerV) : view;
    const levelAt = (face, u, v, a, b) => Math.max(0, Math.min(levelCap, Math.ceil(Math.log2(tiling.texelAngle(face, u, v) / (pixel / (1 + a * a + b * b) * detailRatio)))));

    // Coverage, exactly: down the quadtree, keeping every tile whose outline overlaps the view's.
    const cells = new Int8Array(cellCount).fill(-1), inView = new Uint8Array(cellCount), rayCount = new Uint16Array(cellCount);
    const descend = (tile, insideView) => {
      const shape = region(tiling.corners(tile));
      if (!overlap(shape, wide)) return;
      const seen = insideView && overlap(shape, view);
      if (tiling.level(tile) < tiling.maxLevel) { for (const child of tiling.children(tile)) descend(child, seen); return; }
      const { face, x, y } = tiling.address(tile), cell = (face * C + y) * C + x;
      inView[cell] = seen ? 1 : 0;
      // The level this cell's middle needs, judged at the nearest point of the view if the middle is outside it.
      const centre = tiling.centre(tile, place), depth = centre[0] * forward[0] + centre[1] * forward[1] + centre[2] * forward[2];
      const clampTo = (value, limit) => Math.max(-limit, Math.min(limit, value));
      const a = depth > 1e-6 ? clampTo((centre[0] * right[0] + centre[1] * right[1] + centre[2] * right[2]) / depth, tanH) : tanH;
      const b = depth > 1e-6 ? clampTo((centre[0] * up[0] + centre[1] * up[1] + centre[2] * up[2]) / depth, tanV) : tanV;
      cells[cell] = levelAt(face, (x + 0.5) / C, (y + 0.5) / C, a, b);
    };
    for (let root = 0; root < tiling.roots; root++) descend(root, true);

    // Levels and shares of the view, from scout rays.
    const columns = Math.max(2, Math.ceil(2 * tanH / spacing) + 1), rows = Math.max(2, Math.ceil(2 * tanV / spacing) + 1);
    for (let j = 0; j < rows; j++) {
      const b = tanV - 2 * tanV * j / (rows - 1);
      for (let i = 0; i < columns; i++) {
        const a = -tanH + 2 * tanH * i / (columns - 1), d = ray(a, b);
        tiling.locate(d[0], d[1], d[2], place);
        const cx = Math.min(C - 1, Math.floor(place[1] * C)), cy = Math.min(C - 1, Math.floor(place[2] * C)), cell = (place[0] * C + cy) * C + cx;
        const level = levelAt(place[0], place[1], place[2], a, b);
        if (level > cells[cell]) cells[cell] = level;
        inView[cell] = 1;
        rayCount[cell]++;
      }
    }
    const visible = new Map(), margin = new Map();
    for (let cell = 0; cell < cellCount; cell++) {
      if (cells[cell] < 0) continue;
      const face = Math.floor(cell / (C * C)), shift = tiling.maxLevel - cells[cell];
      const tile = tiling.id(face, cells[cell], (cell % C) >> shift, (Math.floor(cell / C) % C) >> shift);
      if (inView[cell]) visible.set(tile, (visible.get(tile) ?? 0) + rayCount[cell]);
      else margin.set(tile, margin.get(tile) ?? 0);
    }
    for (const tile of visible.keys()) margin.delete(tile);
    cached = { key, cells, inView, visible, margin, centre: forward, rays: rows * columns, spacingRad: spacing, levelCap };
    return cached;
  }

  /**
   * The selection for a client that can hold only `capacity` tiles under the
   * view: the level cap drops until the view's tiles fit. Memory pressure
   * costs detail everywhere at once; it never leaves part of the view without
   * its tiles.
   */
  function selectWithin(camera, viewport, capacity) {
    let cap = finest, selection = select(camera, viewport, cap);
    while (selection.visible.size > capacity && cap > 0) selection = select(camera, viewport, --cap);
    return selection;
  }

  return { select, selectWithin, spacingRad: spacing, cellCount, finest };
}

/** The tile every pixel of a view falls in at a level: the independent check of a selection. */
export function tilesUnderPixels(tiling, camera, viewport, level, stride = 1) {
  const { forward, right, up } = viewBasis(camera), { tanH, tanV } = planeExtents(viewport), found = new Set();
  for (let py = 0; py < viewport.height; py += stride) {
    const b = (1 - 2 * (py + 0.5) / viewport.height) * tanV;
    for (let px = 0; px < viewport.width; px += stride) {
      const a = (2 * (px + 0.5) / viewport.width - 1) * tanH;
      const x = forward[0] + a * right[0] + b * up[0], y = forward[1] + a * right[1] + b * up[1], z = forward[2] + a * right[2] + b * up[2];
      const length = Math.hypot(x, y, z);
      found.add(tiling.tileAt(x / length, y / length, z / length, level));
    }
  }
  return found;
}
