// A finer density sweep avoids declaring a winner just because sparse density
// choices fall on opposite sides of an arbitrary error threshold. No timings.
import fs from "node:fs";
import { createLayout, queryFor, sourceSample, randomPoints } from "./layouts.mjs";
const root = `${process.cwd()}/benchmarks/terrain/`;
const manifest = JSON.parse(fs.readFileSync(`${root}.cache/data/manifest.json`, "utf8"));
const points = randomPoints(16384, 90123), rows = [];
for (const f of manifest) {
  const buffer = fs.readFileSync(`${root}.cache/data/${f.name}.f32`);
  const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const sample = (x, y) => sourceSample(data, f.size, x, y);
  const reference = Float64Array.from({ length: points.length / 2 }, (_, i) => sample(points[i * 2], points[i * 2 + 1]));
  for (const kind of ["square", "square-alternating", "hex", "hex90"]) {
    for (let n = 8; n <= 128; n += 2) {
      const p = createLayout(kind, n, sample), query = queryFor(p), absolute = new Float64Array(reference.length);
      let squareSum = 0;
      for (let i = 0; i < reference.length; i++) {
        const error = query(p, points[i * 2], points[i * 2 + 1]) - reference[i];
        absolute[i] = Math.abs(error); squareSum += error * error;
      }
      absolute.sort();
      rows.push({ fixture: f.name, kind, density: n, vertices: p.heights.length, triangles: p.indices.length / 3,
        p95_m: absolute[Math.floor(absolute.length * 0.95)], max_sampled_m: absolute.at(-1), rmse_m: Math.sqrt(squareSum / reference.length) });
    }
  }
  console.log(`Quality sweep: ${f.name}`);
}
const matched = [];
for (const f of manifest) for (const limit of [0.25, 1, 3, 5, 10, 25]) {
  const candidates = {};
  for (const kind of ["square", "square-alternating", "hex", "hex90"]) {
    candidates[kind] = rows.filter(r => r.fixture === f.name && r.kind === kind && r.p95_m <= limit)
      .sort((a, b) => a.vertices - b.vertices)[0] ?? null;
  }
  matched.push({ fixture: f.name, p95_limit_m: limit, candidates });
}
fs.writeFileSync(`${root}results-quality.json`, JSON.stringify({ date: new Date().toISOString(),
  method: "61 density choices per layout per fixture, 16,384 common points; source-relative vertical error, not survey accuracy or screen-space visual quality.", rows, matched }, null, 2) + "\n");
