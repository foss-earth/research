import assert from "node:assert/strict";
import test from "node:test";
import { createLayout, queryFor, randomPoints } from "./layouts.mjs";

const kinds = ["square", "square-alternating", "hex", "hex90"];
for (const kind of kinds) {
  test(`${kind}: affine height fields and tile boundary samples`, () => {
    const plane = (x, y) => 20 + 3 * x - 5 * y;
    const p = createLayout(kind, 32, plane), query = queryFor(p);
    const points = [...randomPoints(300), 0, 0, 0, 1, 1, 0, 1, 1];
    for (let i = 0; i < points.length; i += 2) {
      assert.ok(Math.abs(query(p, points[i], points[i + 1]) - plane(points[i], points[i + 1])) < 4e-6);
    }
    assert.equal(p.indices.length % 3, 0);
    assert.ok(Math.max(...p.indices) < p.heights.length);
  });

  test(`${kind}: direct lookup matches independently evaluated indexed triangles`, () => {
    const p = createLayout(kind, 12, (x, y) => Math.sin(x * 33) * 70 + Math.cos(y * 17) * 80);
    const query = queryFor(p), points = randomPoints(100, 923);
    for (let q = 0; q < points.length; q += 2) {
      const x = points[q], y = points[q + 1];
      let found = null;
      for (let i = 0; i < p.indices.length; i += 3) {
        const a = p.indices[i] * 3, b = p.indices[i + 1] * 3, c = p.indices[i + 2] * 3, v = p.positions;
        const det = (v[b + 2] - v[c + 2]) * (v[a] - v[c]) + (v[c] - v[b]) * (v[a + 2] - v[c + 2]);
        const u = ((v[b + 2] - v[c + 2]) * (x - v[c]) + (v[c] - v[b]) * (y - v[c + 2])) / det;
        const w = ((v[c + 2] - v[a + 2]) * (x - v[c]) + (v[a] - v[c]) * (y - v[c + 2])) / det;
        if (u >= 0 && w >= 0 && u + w <= 1) {
          found = u * v[a + 1] + w * v[b + 1] + (1 - u - w) * v[c + 1];
          break;
        }
      }
      assert.notEqual(found, null);
      assert.ok(Math.abs(query(p, x, y) - found) < 0.0002, `${query(p, x, y)} versus ${found}`);
    }
  });
}
