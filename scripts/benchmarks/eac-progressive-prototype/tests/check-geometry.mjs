/**
 * Correctness gates for the geometry: addressing, orientation, coverage,
 * tile selection and gutters. Run with
 *
 *   node --test benchmarks/eac-progressive-prototype/tests/check-*.mjs
 *
 * Each check compares the prototype with something that does not go through
 * the code under test: a formula written out again here, the diagnostic
 * pattern's closed form, or every pixel's own ray. The numbers the report
 * cites are written to results/correctness-geometry.json.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mulberry32, randomDirection } from "../../spherical-image-representation/lib/random.mjs";
import { TO_LINEAR, encodeSrgb } from "../../spherical-image-representation/lib/source.mjs";
import { FACES, makeTiling } from "../lib/tiling.mjs";
import { createSelector, planeExtents, tilesUnderPixels, viewBasis } from "../lib/selection.mjs";
import { patternColour } from "../lib/pattern.mjs";
import { makeShader, openDataset, uniformTable } from "../lib/render-cpu.mjs";
import { STARTS } from "../lib/traces.mjs";
import { viewportOf } from "../lib/config.mjs";
import { defaultDataset, loadConfig, statistics, writeResults } from "../lib/paths.mjs";

const config = loadConfig(), viewport = viewportOf(config);
const record = {};
after(() => { console.log(writeResults("correctness-geometry", import.meta.url, { viewport }, record)); });
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test("tile ids, parents and children are one consistent quadtree", () => {
  for (const tile of [96, 192, 384]) {
    const tiling = makeTiling({ projection: "eac", tile, maxLevel: Math.log2(1536 / tile) });
    assert.equal(tiling.count, 6 * (4 ** (tiling.maxLevel + 1) - 1) / 3);
    for (let id = 0; id < tiling.count; id++) {
      const { face, level, x, y } = tiling.address(id);
      assert.equal(tiling.id(face, level, x, y), id);
      assert.equal(tiling.level(id), level);
      for (const child of tiling.children(id)) assert.equal(tiling.parent(child), id);
      if (level > 0) assert.ok(tiling.children(tiling.parent(id)).includes(id));
      assert.equal(tiling.ancestor(id, 0), tiling.id(face, 0, 0, 0));
    }
  }
});

test("every direction is in exactly one tile of each level, and levels nest", () => {
  const random = mulberry32(7), d = [0, 0, 0], place = [0, 0, 0], back = [0, 0, 0];
  for (const projection of ["eac", "cube"]) {
    const tiling = makeTiling({ projection, tile: 192, maxLevel: 3 });
    let worst = 0;
    for (let k = 0; k < 200000; k++) {
      randomDirection(random, d);
      tiling.locate(d[0], d[1], d[2], place);
      assert.ok(place[1] >= 0 && place[1] <= 1 && place[2] >= 0 && place[2] <= 1);
      tiling.direction(place[0], place[1], place[2], back);
      worst = Math.max(worst, Math.acos(Math.min(1, dot(d, back))));
      let below = tiling.tileAt(d[0], d[1], d[2], 3);
      for (let level = 2; level >= 0; level--) { const here = tiling.tileAt(d[0], d[1], d[2], level); assert.equal(tiling.parent(below), here); below = here; }
    }
    assert.ok(worst < 1e-6, `round trip off by ${worst} rad`);
    record[`${projection} round trip worst rad`] = worst;
  }
});

test("faces, axes and the equi-angular warp match a derivation written out here", () => {
  // Written from the definition, not from the representation's code: the face is the axis of largest
  // magnitude; along a face's `right` the position is the angle from `forward`, a quarter turn across the face.
  const eac = makeTiling({ projection: "eac", tile: 192, maxLevel: 3 }), cube = makeTiling({ projection: "cube", tile: 192, maxLevel: 3 });
  const random = mulberry32(11), d = [0, 0, 0], place = [0, 0, 0];
  let worst = 0;
  for (let k = 0; k < 100000; k++) {
    randomDirection(random, d);
    const magnitude = d.map(Math.abs), axis = magnitude.indexOf(Math.max(...magnitude)), face = axis * 2 + (d[axis] > 0 ? 0 : 1), frame = FACES[face];
    const f = dot(d, frame.forward), r = dot(d, frame.right), t = dot(d, frame.up);
    eac.locate(d[0], d[1], d[2], place);
    assert.equal(place[0], face);
    worst = Math.max(worst, Math.abs(place[1] - (0.5 + Math.atan2(r, f) / (Math.PI / 2))), Math.abs(place[2] - (0.5 - Math.atan2(t, f) / (Math.PI / 2))));
    cube.locate(d[0], d[1], d[2], place);
    worst = Math.max(worst, Math.abs(place[1] - (0.5 + r / f / 2)), Math.abs(place[2] - (0.5 - t / f / 2)));
  }
  assert.ok(worst < 1e-9);
  // Orientation: forward is +Y, turning right goes to +X, looking up goes to +Z.
  const at = camera => { const { forward } = viewBasis(camera); return eac.locate(forward[0], forward[1], forward[2], [0, 0, 0]); };
  assert.deepEqual(at({ yaw: 0, pitch: 0 }).map(value => Number(value.toFixed(6))), [2, 0.5, 0.5]);
  assert.equal(at({ yaw: 90, pitch: 0 })[0], 0);
  assert.equal(at({ yaw: 180, pitch: 0 })[0], 3);
  assert.equal(at({ yaw: -90, pitch: 0 })[0], 1);
  assert.equal(at({ yaw: 0, pitch: 89 })[0], 4);
  assert.equal(at({ yaw: 0, pitch: -89 })[0], 5);
  assert.ok(at({ yaw: 10, pitch: 0 })[1] > 0.5, "turning right moves right on the face");
  assert.ok(at({ yaw: 0, pitch: 10 })[2] < 0.5, "looking up moves up the face");
  // Equal angles: equal steps of u along a face's midline are equal angles.
  const a = [0, 0, 0], b = [0, 0, 0], steps = [];
  for (let i = 0; i < 16; i++) { eac.direction(2, i / 16, 0.5, a); eac.direction(2, (i + 1) / 16, 0.5, b); steps.push(Math.acos(dot(a, b))); }
  assert.ok(Math.max(...steps) - Math.min(...steps) < 1e-12);
  assert.ok(Math.abs(steps[0] - Math.PI / 32) < 1e-12);
});

test("the full face size holds the source's detail and no more", () => {
  // The source is 6144 texels around; a texel at the horizon is 2π/6144. An equi-angular face of 1536 has the same.
  const eac = makeTiling({ projection: "eac", tile: 192, maxLevel: 3 }), cube = makeTiling({ projection: "cube", tile: 192, maxLevel: 3 }), source = 2 * Math.PI / 6144;
  const finest = tiling => (face, u, v) => tiling.texelAngle(face, u, v) / 2 ** tiling.maxLevel;
  record.texelAngleOverSource = {
    "eac face centre": finest(eac)(2, 0.5, 0.5) / source, "eac edge middle": finest(eac)(2, 1, 0.5) / source, "eac corner": finest(eac)(2, 1, 1) / source,
    "cube face centre": finest(cube)(2, 0.5, 0.5) / source, "cube edge middle": finest(cube)(2, 1, 0.5) / source, "cube corner": finest(cube)(2, 1, 1) / source,
  };
  assert.ok(Math.abs(record.texelAngleOverSource["eac face centre"] - 1) < 1e-3);
});

test("the selection covers every pixel's own tile, at a level no coarser than the pixel needs", () => {
  const random = mulberry32(3), d = [0, 0, 0];
  const cameras = [...STARTS.map(start => ({ yaw: start.yaw, pitch: start.pitch, roll: 0 })), { yaw: 0, pitch: 90, roll: 0 }, { yaw: 0, pitch: -90, roll: 0 }];
  for (let k = 0; k < 24; k++) { randomDirection(random, d); cameras.push({ yaw: Math.atan2(d[0], d[1]) * 180 / Math.PI, pitch: Math.asin(d[2]) * 180 / Math.PI, roll: random() * 360 }); }
  const viewports = [viewport, { width: 412, height: 915, verticalFovDeg: 75 }, { width: 1920, height: 1080, verticalFovDeg: 75 }, { width: 600, height: 600, verticalFovDeg: 110 }];
  const summary = [];
  for (const projection of ["eac", "cube"]) for (const tile of [96, 192, 384]) {
    const tiling = makeTiling({ projection, tile, maxLevel: Math.log2(1536 / tile) }), C = tiling.cells, place = [0, 0, 0];
    const selector = createSelector(tiling, { detailRatio: 1, marginDeg: 0 });
    let missed = 0, tooCoarse = 0, checked = 0, rays = 0, wanted = 0;
    for (const size of viewports) for (const camera of cameras) {
      const selection = selector.select(camera, size);
      rays += selection.rays; wanted += selection.visible.size;
      // Every pixel's tile at the finest level must lie under a cell the selection marked as in view.
      for (const id of tilesUnderPixels(tiling, camera, size, tiling.maxLevel, 3)) {
        const { face, x, y } = tiling.address(id), cell = (face * C + y) * C + x;
        checked++;
        if (!selection.inView[cell]) missed++;
      }
      // And the level each pixel needs, from its own ray, must not exceed its cell's.
      const { forward, right, up } = viewBasis(camera), { tanH, tanV } = planeExtents(size), pixel = 2 * tanV / size.height;
      for (let py = 0; py < size.height; py += 37) for (let px = 0; px < size.width; px += 37) {
        const a = (2 * (px + 0.5) / size.width - 1) * tanH, b = (1 - 2 * (py + 0.5) / size.height) * tanV;
        const x = forward[0] + a * right[0] + b * up[0], y = forward[1] + a * right[1] + b * up[1], z = forward[2] + a * right[2] + b * up[2], length = Math.hypot(x, y, z);
        tiling.locate(x / length, y / length, z / length, place);
        const need = Math.max(0, Math.min(tiling.maxLevel, Math.ceil(Math.log2(tiling.texelAngle(place[0], place[1], place[2]) / (pixel / (1 + a * a + b * b))))));
        const cell = (place[0] * C + Math.min(C - 1, Math.floor(place[2] * C))) * C + Math.min(C - 1, Math.floor(place[1] * C));
        // A cell is one level for all its pixels; a pixel needing one more than the scouts found is the grid's approximation.
        if (selection.cells[cell] < need) tooCoarse++;
      }
    }
    summary.push({ projection, tile, views: cameras.length * viewports.length, tilesChecked: checked, tilesMissed: missed, pixelsNeedingAFinerLevelThanChosen: tooCoarse, meanScoutRays: Math.round(rays / cameras.length / viewports.length), meanTilesWanted: Number((wanted / cameras.length / viewports.length).toFixed(1)) });
    assert.equal(missed, 0, `${projection} ${tile}: ${missed} tiles under the view were not selected`);
  }
  record.selection = summary;
});

test("a tile's gutter holds the image that lies there, inside a face, across an edge and at a corner", () => {
  // The pattern is known in closed form, so a stored texel can be compared with the mean of the pattern over its
  // own cell, wherever the texel is: inside the tile, or in its gutter on another face.
  const dataset = openDataset(path.join(defaultDataset, "pattern", "eac-t192")), { tiling } = dataset, S = tiling.stored, T = tiling.tile, g = tiling.gutter;
  const d = [0, 0, 0], colour = [0, 0, 0];
  const truth = (face, level, x, y, i, j) => {
    const F = tiling.faceSize(level), sum = [0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      tiling.direction(face, (x * T - g + i + (sx + 0.5) / 4) / F, (y * T - g + j + (sy + 0.5) / 4) / F, d);
      patternColour(d[0], d[1], d[2], colour);
      for (let c = 0; c < 3; c++) sum[c] += TO_LINEAR[colour[c]];
    }
    return sum.map(value => encodeSrgb(value / 16));
  };
  const errors = { interior: [], "gutter inside a face": [], "gutter across a face edge": [], "gutter at a cube corner": [] };
  const n = tiling.tilesPerSide(3);
  for (const [face, x, y] of [[2, 3, 3], [2, n - 1, 3], [2, n - 1, 0], [4, 0, 0], [5, n - 1, n - 1], [0, 0, 4], [1, 4, n - 1], [3, 0, n - 1]]) {
    const texels = dataset.replacementTexels(tiling.id(face, 3, x, y));
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const outsideX = (i < g && x === 0) || (i >= g + T && x === n - 1), outsideY = (j < g && y === 0) || (j >= g + T && y === n - 1);
      const inGutter = i < g || j < g || i >= g + T || j >= g + T;
      if (!inGutter && (i + j) % 7) continue; // a sample of the interior is enough
      const expected = truth(face, 3, x, y, i, j), at = (j * S + i) * 3;
      const error = (Math.abs(texels[at] - expected[0]) + Math.abs(texels[at + 1] - expected[1]) + Math.abs(texels[at + 2] - expected[2])) / 3;
      errors[!inGutter ? "interior" : outsideX && outsideY ? "gutter at a cube corner" : outsideX || outsideY ? "gutter across a face edge" : "gutter inside a face"].push(error);
    }
  }
  record.gutterErrorAgainstPattern = Object.fromEntries(Object.entries(errors).map(([where, list]) => [where, statistics(list)]));
  const interior = statistics(errors.interior).mean;
  for (const [where, list] of Object.entries(errors)) {
    assert.ok(list.length > 0, `no texels checked: ${where}`);
    assert.ok(statistics(list).mean < Math.max(2 * interior, interior + 2), `${where}: mean error ${statistics(list).mean.toFixed(2)} against ${interior.toFixed(2)} inside`);
  }
});

test("crossing a tile boundary, a face edge or a cube corner changes the picture no more than moving inside a tile", () => {
  // Two directions a hair apart, one on each side of a boundary. Bilinear filtering is continuous inside a tile,
  // so any step across the boundary is what the two tiles disagree about.
  const summary = {};
  for (const [panorama, variant] of [["pattern", "eac-t192"], ["northrop-mall", "eac-t192"], ["northrop-mall", "cube-t192"], ["superblock", "eac-t96"]]) {
    const dataset = openDataset(path.join(defaultDataset, panorama, variant)), { tiling } = dataset, n = tiling.tilesPerSide(tiling.maxLevel);
    const bootstrap = dataset.bootstrap(48), random = mulberry32(5), a = [0, 0, 0], b = [0, 0, 0], ca = [0, 0, 0], cb = [0, 0, 0], e = 1e-7;
    const step = (table, face, u0, v0, u1, v1) => {
      tiling.direction(face, u0, v0, a); tiling.direction(face, u1, v1, b);
      const shade = makeShader(dataset, table, { bootstrap });
      shade(a[0], a[1], a[2], ca); shade(b[0], b[1], b[2], cb);
      return Math.max(Math.abs(ca[0] - cb[0]), Math.abs(ca[1] - cb[1]), Math.abs(ca[2] - cb[2]));
    };
    const finest = uniformTable(tiling, tiling.maxLevel);
    // Mixed levels: a checkerboard of the finest level and the one below, and of the finest level and the bootstrap.
    const mixed = finest.map((id, cell) => ((cell + Math.floor(cell / tiling.cells)) & 1 ? id : tiling.parent(id)));
    const withBootstrap = finest.map((id, cell) => ((cell + Math.floor(cell / tiling.cells)) & 1 ? id : -1));
    const texel = 0.5 / tiling.faceSize(tiling.maxLevel);
    const lists = { "inside a tile": [], "one texel apart inside a tile": [], "tile boundary inside a face": [], "face edge": [], "cube corner": [], "finest level beside the level below": [], "finest level beside the bootstrap": [] };
    for (let k = 0; k < 4000; k++) {
      const face = Math.floor(random() * 6), along = random(), line = (1 + Math.floor(random() * (n - 1))) / n, vertical = random() < 0.5;
      const inside = (Math.floor(random() * n) + 0.5) / n;
      lists["inside a tile"].push(vertical ? step(finest, face, inside - e, along, inside + e, along) : step(finest, face, along, inside - e, along, inside + e));
      lists["one texel apart inside a tile"].push(vertical ? step(finest, face, inside - texel, along, inside + texel, along) : step(finest, face, along, inside - texel, along, inside + texel));
      lists["tile boundary inside a face"].push(vertical ? step(finest, face, line - e, along, line + e, along) : step(finest, face, along, line - e, along, line + e));
      const side = random() < 0.5 ? 0 : 1;
      lists["face edge"].push(vertical ? step(finest, face, side - e, along, side + e, along) : step(finest, face, along, side - e, along, side + e));
      lists["cube corner"].push(step(finest, face, side + (side ? -1 : 1) * 2 * e * random(), side ? 1 - e : e, side + (side ? 1 : -1) * 2 * e * random(), side ? 1 + e : -e));
      lists["finest level beside the level below"].push(vertical ? step(mixed, face, line - e, along, line + e, along) : step(mixed, face, along, line - e, along, line + e));
      lists["finest level beside the bootstrap"].push(vertical ? step(withBootstrap, face, line - e, along, line + e, along) : step(withBootstrap, face, along, line - e, along, line + e));
    }
    summary[`${panorama} ${variant}`] = Object.fromEntries(Object.entries(lists).map(([where, list]) => { const s = statistics(list); return [where, { mean: Number(s.mean.toFixed(2)), p95: Number(s.p95.toFixed(1)), p99: Number(s.p99.toFixed(1)), max: Number(s.max.toFixed(1)) }]; }));
    const result = summary[`${panorama} ${variant}`];
    record.seamStepBytes = summary;
    assert.ok(result["inside a tile"].max < 0.5, "bilinear filtering inside a tile is continuous");
    // Tiles are separate JPEGs, so two of them disagree at their shared edge by about their coding error. The gate
    // is that this is less than the picture changes over one texel anyway: a seam no stronger than the texture.
    for (const where of ["tile boundary inside a face", "face edge", "cube corner"]) {
      assert.ok(result[where].mean < result["one texel apart inside a tile"].mean, `${panorama} ${variant}, ${where}: mean step ${result[where].mean} against ${result["one texel apart inside a tile"].mean} a texel apart`);
    }
  }
  record.seamStepBytes = summary;
});

test("near a face edge the picture is no further from the truth than elsewhere in the same detail", () => {
  // A seam both sides share (a band, not a step) would not show in the step test above. The pattern's closed form
  // says what every pixel should be; the error is binned by distance to the nearest face edge, in finest texels.
  // The views are of an edge middle and a cube corner, where the pattern's fine checker is, so the far bins are a
  // fair comparison only up to 16 texels; beyond that the views reach smoother parts of the pattern.
  // (The pattern's own checker changes character on the plane x = y, which is a cube edge: a crop shows a dashed
  // line there that is in the pattern, not in the tiles.)
  const summary = {};
  for (const variant of ["eac-t192", "cube-t192"]) {
    const dataset = openDataset(path.join(defaultDataset, "pattern", variant)), { tiling } = dataset, F = tiling.faceSize(tiling.maxLevel);
    const shade = makeShader(dataset, uniformTable(tiling, tiling.maxLevel)), place = [0, 0, 0], colour = [0, 0, 0], truth = [0, 0, 0], bins = {};
    for (const camera of [{ yaw: 45, pitch: 35.264, roll: 0 }, { yaw: 45, pitch: 0, roll: 0 }]) {
      const { forward, right, up } = viewBasis(camera), { tanH, tanV } = planeExtents(viewport);
      for (let py = 0; py < viewport.height; py += 2) for (let px = 0; px < viewport.width; px += 2) {
        const a = (2 * (px + 0.5) / viewport.width - 1) * tanH, b = (1 - 2 * (py + 0.5) / viewport.height) * tanV;
        const x = forward[0] + a * right[0] + b * up[0], y = forward[1] + a * right[1] + b * up[1], z = forward[2] + a * right[2] + b * up[2], length = Math.hypot(x, y, z);
        shade(x / length, y / length, z / length, colour); patternColour(x / length, y / length, z / length, truth);
        tiling.locate(x / length, y / length, z / length, place);
        const edge = Math.min(place[1], 1 - place[1], place[2], 1 - place[2]) * F;
        const bin = edge < 1 ? "within 1 texel" : edge < 2 ? "1 to 2 texels" : edge < 4 ? "2 to 4 texels" : edge < 16 ? "4 to 16 texels" : null;
        if (!bin) continue;
        (bins[bin] ??= []).push((Math.abs(colour[0] - truth[0]) + Math.abs(colour[1] - truth[1]) + Math.abs(colour[2] - truth[2])) / 3);
      }
    }
    summary[variant] = Object.fromEntries(Object.entries(bins).map(([bin, list]) => [bin, { meanError: Number(statistics(list).mean.toFixed(2)), pixels: list.length }]));
    assert.ok(summary[variant]["within 1 texel"].meanError < 1.25 * summary[variant]["4 to 16 texels"].meanError, `${variant}: ${JSON.stringify(summary[variant])}`);
  }
  record.errorByDistanceFromFaceEdge = summary;
});
