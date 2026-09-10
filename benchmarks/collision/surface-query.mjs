// CPU only; no browser/server, fixture downloads or GPU work.
import { MeshBuilder, NullEngine, Scene, Engine } from "@babylonjs/core";
import { createSurfaceQuery } from "../../src/terrain/surfaceQuery.ts";
import { createSurfaceQuery as createBaselineSurfaceQuery } from "../../src/terrain/surfaceQuery.ts?baseline";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import assert from "node:assert/strict";

const hash = value => createHash("sha256").update(value).digest("hex");
const sourcePath = "src/terrain/surfaceQuery.ts";
const origin = { x: 0.17, y: 10, z: 0.23 }, direction = { x: 0, y: -1, z: 0 };
const results = [];
for (const scenario of ["distant-miss", "distant-with-local-hit", "dense-local-hit-control"]) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const denseCount = scenario === "dense-local-hit-control" ? 1 : 8;
  for (let i = 0; i < denseCount; i++) {
    const mesh = MeshBuilder.CreateGround(`dense-${i}`, { width: 1000, height: 1000, subdivisions: 128 }, scene);
    mesh.position.y = scenario === "dense-local-hit-control" ? 7 : -100 * (i + 1);
    mesh.computeWorldMatrix(true);
  }
  if (scenario === "distant-with-local-hit") {
    const mesh = MeshBuilder.CreateBox("local", { size: 2 }, scene);
    mesh.position.y = 6;
    mesh.computeWorldMatrix(true);
  }
  const queries = {
    baseline: createBaselineSurfaceQuery(scene, () => null, () => true),
    current: createSurfaceQuery(scene, () => null, () => true),
  };
  const expectHit = scenario !== "distant-miss";
  for (const query of Object.values(queries)) {
    const hit = query.raycast(origin, direction, 5);
    assert.equal(Boolean(hit), expectHit);
    if (hit) assert.ok(Math.abs(hit.distanceMeters - 3) < 1e-9);
  }
  assert.deepEqual(queries.current.raycast(origin, direction, 5), queries.baseline.raycast(origin, direction, 5));
  // Warm both code paths, then alternate order to limit timing/order bias.
  for (let i = 0; i < 100; i++) for (const query of Object.values(queries)) query.raycast(origin, direction, 5);
  const timings = { baseline: [], current: [] };
  let checksum = 0;
  for (let round = 0; round < 21; round++) {
    const order = round % 2 ? ["current", "baseline"] : ["baseline", "current"];
    for (const name of order) {
      const start = performance.now();
      for (let i = 0; i < 10; i++) checksum += queries[name].raycast(origin, direction, 5)?.distanceMeters ?? 0;
      timings[name].push((performance.now() - start) / 10);
    }
  }
  const summarize = values => {
    values.sort((a, b) => a - b);
    return { medianMs: values[10], p95Ms: values[19], meanMs: values.reduce((a, b) => a + b) / values.length };
  };
  const timing = { baseline: summarize(timings.baseline), current: summarize(timings.current) };
  const result = { scenario, denseMeshes: denseCount, denseTriangles: denseCount * 32768, rayLengthMeters: 5,
    timing, medianRatio: timing.baseline.medianMs / timing.current.medianMs, checksum };
  results.push(result);
  console.log(JSON.stringify(result));
  engine.dispose();
}
const report = {
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, babylon: Engine.Version, platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model },
  source: { baselineCommit: __BASELINE_COMMIT__, baselineSha256: hash(__BASELINE_SOURCE__),
    currentCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), currentPath: sourcePath,
    currentSha256: hash(readFileSync(sourcePath)), workingTreeMayBeDirty: true },
  method: { warmupQueriesPerPath: 100, rounds: 21, queriesPerRound: 10, alternatingOrder: true,
    percentileDescription: "P95 of 21 batch-average per-query times; not per-frame or individual-query latency." },
  limitations: "Synthetic visible geometry isolates finite-ray rejection. NullEngine measures CPU only; no GPU rendering, browser frame pacing, streaming, watts or FPS. Dense local triangles remain on Babylon's exact picker. No inference of whole-game speedup.",
  results,
};
writeFileSync(process.argv[2] ?? "benchmarks/collision/results.json", `${JSON.stringify(report, null, 2)}\n`);
