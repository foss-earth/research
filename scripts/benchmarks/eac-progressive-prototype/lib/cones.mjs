/**
 * Convex regions of the sphere bounded by great-circle arcs: a tile of a cube
 * face and a camera's view are both such regions. Two of them overlap exactly
 * when a corner of one is inside the other or two of their edges cross; no
 * sampling is involved, so a sliver of a tile at the edge of a view counts.
 *
 * A region is `{ corners, normals }`: unit corner directions in order round
 * the boundary, and for each edge the normal of its great circle, pointing in.
 * Regions must be smaller than a hemisphere.
 */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function region(corners) {
  const centre = [0, 0, 0];
  for (const corner of corners) for (let c = 0; c < 3; c++) centre[c] += corner[c];
  const normals = corners.map((corner, k) => {
    const normal = cross(corner, corners[(k + 1) % corners.length]);
    return dot(normal, centre) < 0 ? normal.map(value => -value) : normal;
  });
  return { corners, normals };
}

const EPSILON = 1e-12;
export const contains = (shape, point) => shape.normals.every(normal => dot(normal, point) >= -EPSILON);

/** Whether arc p0–p1 (on the great circle with normal n) holds direction x, itself on that circle. */
function onArc(p0, p1, x) {
  const whole = cross(p0, p1);
  return dot(cross(p0, x), whole) >= -EPSILON && dot(cross(x, p1), whole) >= -EPSILON;
}

export function overlap(a, b) {
  if (a.corners.some(corner => contains(b, corner)) || b.corners.some(corner => contains(a, corner))) return true;
  for (let i = 0; i < a.corners.length; i++) {
    const a0 = a.corners[i], a1 = a.corners[(i + 1) % a.corners.length], na = cross(a0, a1);
    for (let j = 0; j < b.corners.length; j++) {
      const b0 = b.corners[j], b1 = b.corners[(j + 1) % b.corners.length], line = cross(na, cross(b0, b1));
      if (line[0] === 0 && line[1] === 0 && line[2] === 0) continue;
      for (const sign of [1, -1]) {
        const x = [line[0] * sign, line[1] * sign, line[2] * sign];
        if (onArc(a0, a1, x) && onArc(b0, b1, x)) return true;
      }
    }
  }
  return false;
}
