/**
 * The projection-specific half of the prototype: how directions map to faces,
 * how a face is cut into a quadtree of tiles, and which tile is whose parent.
 *
 * Everything else (selection, scheduling, caching, logging) sees a tiling only
 * through this object: integer tile ids, `parent`, `children`, `level`,
 * `locate`, `direction` and `texelAngle`. Nothing outside this file knows there
 * are six faces, so another hierarchy (HEALPix's twelve, say) could stand in.
 *
 * The maps themselves are Phase 1's, imported and not copied: the cube face
 * table and the equi-angular warp of
 * ../../spherical-image-representation/lib/representations.mjs, which
 * verify.mjs there checks. Axes are FOSS Earth's image-local ones: X right,
 * Y forward, Z up, right-handed. On a face u runs right and v down; texel
 * (i, j) of an F × F face has its centre at ((i + ½)/F, (j + ½)/F).
 *
 * Levels: level l has faces of `tile · 2^l` texels, cut into 2^l × 2^l tiles of
 * `tile` logical texels. Level 0 is one tile per face. A stored tile carries
 * `gutter` more texels on every side, sampled at the face's own coordinates
 * extended past its edge (see preprocess/build-dataset.mjs).
 */
import { representation } from "../../spherical-image-representation/lib/representations.mjs";

export const PROJECTIONS = ["eac", "cube"];
/** Face names in id order, with the frame the format's manifest records. */
export const FACES = [
  { name: "px", forward: [1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
  { name: "nx", forward: [-1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
  { name: "py", forward: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { name: "ny", forward: [0, -1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  { name: "pz", forward: [0, 0, 1], right: [1, 0, 0], up: [0, -1, 0] },
  { name: "nz", forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },
];

/**
 * `{ projection, tile, maxLevel, gutter }` → the tiling. `maxLevel` is the
 * finest level, so the full face is `tile · 2^maxLevel` texels.
 */
export function makeTiling({ projection, tile, maxLevel, gutter = 1 }) {
  if (!PROJECTIONS.includes(projection)) throw new Error(`unknown projection ${projection}; known: ${PROJECTIONS.join(", ")}`);
  const rep = representation(projection), roots = rep.charts;
  // Tiles are numbered level by level, then face, row, column.
  const offsets = [0];
  for (let l = 0; l <= maxLevel; l++) offsets.push(offsets[l] + roots * 4 ** l);
  const count = offsets[maxLevel + 1];
  const levelOf = new Uint8Array(count);
  for (let l = 0; l <= maxLevel; l++) levelOf.fill(l, offsets[l], offsets[l + 1]);
  const scratch = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];

  const tiling = {
    projection, tile, maxLevel, gutter, stored: tile + 2 * gutter, roots, count,
    /** Tiles along a face side at a level, and the face's size in texels. */
    tilesPerSide: level => 1 << level,
    faceSize: level => tile << level,
    /** Cells along a face side of the display table: the finest level's tiles. */
    cells: 1 << maxLevel,
    levelCount: level => roots * 4 ** level,
    firstOfLevel: level => offsets[level],
    id(face, level, x, y) { return offsets[level] + ((face << level) + y << level) + x; },
    level: id => levelOf[id],
    address(id) {
      const level = levelOf[id], n = 1 << level, local = id - offsets[level];
      return { face: Math.floor(local / (n * n)), level, x: local % n, y: Math.floor(local / n) % n };
    },
    /** −1 for a level-0 tile: its fallback is the bootstrap. */
    parent(id) {
      const level = levelOf[id];
      if (level === 0) return -1;
      const { face, x, y } = tiling.address(id);
      return tiling.id(face, level - 1, x >> 1, y >> 1);
    },
    children(id) {
      const level = levelOf[id];
      if (level === maxLevel) return [];
      const { face, x, y } = tiling.address(id);
      return [0, 1, 2, 3].map(k => tiling.id(face, level + 1, 2 * x + (k & 1), 2 * y + (k >> 1)));
    },
    /** The ancestor of a tile at a coarser level (or the tile itself). */
    ancestor(id, level) {
      const { face, level: own, x, y } = tiling.address(id), shift = own - level;
      return tiling.id(face, level, x >> shift, y >> shift);
    },
    /** A unit direction → `out = [face, u, v]`. */
    locate(x, y, z, out) { rep.fromDir(x, y, z, out); return out; },
    /** `(face, u, v)` → a unit direction. u and v may lie a little outside 0–1: the gutter. */
    direction(face, u, v, out) { rep.toDir(face, u, v, out); return out; },
    /** The tile of a level under a direction. */
    tileAt(x, y, z, level) {
      rep.fromDir(x, y, z, scratch);
      const n = 1 << level;
      return tiling.id(scratch[0], level, Math.min(n - 1, Math.floor(scratch[1] * n)), Math.min(n - 1, Math.floor(scratch[2] * n)));
    },
    /**
     * The angle, in radians, that one level-0 texel subtends at (face, u, v):
     * the larger of its two sides, so a level chosen from it is never too
     * coarse along either axis. Level l's texel is 2^l times smaller.
     */
    texelAngle(face, u, v) {
      const step = 1 / (tile * 8);
      rep.toDir(face, u - step, v, a); rep.toDir(face, u + step, v, b);
      const alongU = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      rep.toDir(face, u, v - step, a); rep.toDir(face, u, v + step, b);
      const alongV = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      return Math.max(alongU, alongV) * 4;
    },
    /**
     * A tile's outline: its four corners in order round it. The edges between
     * them are great-circle arcs in both cube projections (`edges`), which is
     * what lets lib/cones.mjs test a tile against a view exactly.
     */
    edges: "great-circle",
    corners(id) {
      const { face, level, x, y } = tiling.address(id), n = 1 << level;
      return [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([cx, cy]) => { const corner = [0, 0, 0]; rep.toDir(face, cx / n, cy / n, corner); return corner; });
    },
    /** The middle of a tile, as a unit direction. */
    centre(id, out) {
      const { face, level, x, y } = tiling.address(id), n = 1 << level;
      rep.toDir(face, (x + 0.5) / n, (y + 0.5) / n, out);
      return out;
    },
    /**
     * The tiles of the same level across each of a tile's four edges (left,
     * right, top, bottom), found on the sphere by stepping a hair past the
     * middle of the edge, so a face boundary needs no table.
     */
    neighbours(id) {
      const { face, level, x, y } = tiling.address(id), n = 1 << level, e = 1e-4 / n;
      return [[x / n - e, (y + 0.5) / n], [(x + 1) / n + e, (y + 0.5) / n], [(x + 0.5) / n, y / n - e], [(x + 0.5) / n, (y + 1) / n + e]].map(([u, v]) => {
        rep.toDir(face, u, v, a);
        return tiling.tileAt(a[0], a[1], a[2], level);
      });
    },
    /** `t/{face}/{level}/{x}/{y}.jpg`: the address every backend and policy shares. */
    path(id, kind = "t") {
      const { face, level, x, y } = tiling.address(id);
      return `${kind}/${FACES[face].name}/${level}/${x}/${y}.jpg`;
    },
  };
  return tiling;
}

/** The tiling a manifest describes. */
export const tilingFromManifest = manifest => makeTiling({ projection: manifest.projection, tile: manifest.tile.logical, maxLevel: manifest.maxLevel, gutter: manifest.tile.gutter });
