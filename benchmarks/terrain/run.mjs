import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createLayout, queryFor, randomPoints, sourceSample, refill, measure } from "./layouts.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(`${root}.cache/data/manifest.json`, "utf8"));
const qualityPoints = randomPoints(16384, 90123), timingPoints = randomPoints(4096, 34912);
const kinds = ["square", "square-alternating", "hex", "hex90"];
const densities = [8, 16, 24, 32, 48, 64, 96, 128];
const rows = [];

function errors(p, reference) {
  const query = queryFor(p), absolute = [], count = qualityPoints.length / 2;
  let squareSum = 0, signedSum = 0;
  for (let i = 0; i < qualityPoints.length; i += 2) {
    const e = query(p, qualityPoints[i], qualityPoints[i + 1]) - reference[i / 2];
    squareSum += e * e; signedSum += e; absolute.push(Math.abs(e));
  }
  absolute.sort((a, b) => a - b);
  return { rmse_m: Math.sqrt(squareSum / count), p95_m: absolute[Math.floor(count * 0.95)],
    max_sampled_m: absolute.at(-1), bias_m: signedSum / count, samples: count };
}

for (let fixtureIndex = 0; fixtureIndex < manifest.length; fixtureIndex++) {
  const fixture = manifest[fixtureIndex], buffer = fs.readFileSync(`${root}.cache/data/${fixture.name}.f32`);
  const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const sample = (x, y) => sourceSample(data, fixture.size, x, y);
  const reference = Float64Array.from({ length: qualityPoints.length / 2 }, (_, i) => sample(qualityPoints[i * 2], qualityPoints[i * 2 + 1]));
  for (const n of densities) {
    // Rotate test order to avoid always measuring one layout first.
    const order = [...kinds.slice(fixtureIndex % kinds.length), ...kinds.slice(0, fixtureIndex % kinds.length)];
    for (const kind of order) {
      const p = createLayout(kind, n, sample), query = queryFor(p);
      const quality = errors(p, reference);
      const options = { rounds: 7, targetMs: 5 };
      const build = measure(() => createLayout(kind, n, sample).heights[50], options);
      const update = measure(() => refill(p, sample), options);
      const lookup = measure(() => {
        let sum = 0;
        for (let i = 0; i < timingPoints.length; i += 2) sum += query(p, timingPoints[i], timingPoints[i + 1]);
        return sum;
      }, options);
      rows.push({ fixture: fixture.name, kind, density: n, vertices: p.heights.length,
        triangles: p.indices.length / 3, height_bytes: p.heights.byteLength,
        position_bytes: p.positions.byteLength, index_bytes: p.indices.byteLength,
        ...quality, build, update, lookup, lookup_queries: timingPoints.length / 2,
        lookup_ns_per_query: lookup.median_ms * 1e6 / (timingPoints.length / 2) });
    }
  }
  console.log(`Completed ${fixture.name}: 32 configurations`);
}

const matchedQuality = [];
for (const fixture of manifest) for (const limit of [0.25, 1, 3, 5, 10, 25]) {
  const candidates = {};
  for (const kind of kinds) {
    candidates[kind] = rows.filter(r => r.fixture === fixture.name && r.kind === kind && r.p95_m <= limit)
      .sort((a, b) => a.vertices - b.vertices)[0] ?? null;
  }
  matchedQuality.push({ fixture: fixture.name, p95_limit_m: limit, candidates });
}
const result = { date: new Date().toISOString(), environment: { node: process.version, platform: process.platform,
  arch: process.arch, cpu: os.cpus()[0]?.model ?? "unavailable", logical_cpus: os.cpus().length },
  method: "Local regular square and staggered equilateral sample lattices; 16,384 common interior points; Float32 heights; triangle interpolation; warmed sequential CPU timings. No browser or GPU measurements; no mixed-LOD or spherical H3 benchmark.",
  fixtures: manifest, rows, matchedQuality };
const output = process.argv[2] ?? `${root}results-layouts.json`;
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(`Saved ${output}`);
