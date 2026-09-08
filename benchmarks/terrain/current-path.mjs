// Uses production code with Babylon's CPU-only NullEngine. Never starts the app.
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import assert from "node:assert/strict";
import { NullEngine, Scene, Ray, Vector3, VertexBuffer } from "@babylonjs/core";
import { createTerrainMesh, benchmarkDesiredTiles, benchmarkSegments } from "../../src/engine/babylon/createRasterTilesRuntime.ts";
import { RASTER_BASE_MAP_SOURCES } from "../../src/engine/babylon/rasterBaseMaps.ts";
import { createSurfaceQuery } from "../../src/terrain/surfaceQuery.ts";
import { advanceRefinement, refineMesh, stitchTerrainEdges } from "../../src/terrain/meshRefinement.ts";
import { geodeticToEcef, ecefToGeodetic, DEG_TO_RAD } from "../../src/camera/cameraMath.ts";
import { measure, randomPoints } from "./layouts.mjs";

const root = `${process.cwd()}/benchmarks/terrain/`;
const manifest = JSON.parse(fs.readFileSync(`${root}.cache/data/manifest.json`, "utf8"));
const results = [];
const points = randomPoints(64, 49201);
const options = { rounds: 7, targetMs: 8 };
const planner = [];
for (const zoomMeters of [500, 1500, 5000]) {
  const view = { latDeg: 34.12, lonDeg: -118.32, headingDeg: 45, pitchDeg: 0, zoomMeters };
  const source = RASTER_BASE_MAP_SOURCES.find(s => s.id === "usgs-imagery-topo");
  const desired = benchmarkDesiredTiles(view, source);
  const timing = measure(() => benchmarkDesiredTiles(view, source).length, options);
  const parents = new Set();
  let triangles = 0, vertices = 0;
  const levels = {};
  for (const tile of desired) {
    const segments = Math.max(benchmarkSegments(tile), tile.z >= 14 ? 128 : 64);
    triangles += 2 * segments ** 2; vertices += (segments + 1) ** 2;
    levels[tile.z] = (levels[tile.z] ?? 0) + 1;
    let { z, x, y } = tile;
    while (z > 2) { z--; x >>= 1; y >>= 1; parents.add(`${z}/${x}/${y}`); }
  }
  planner.push({ zoomMeters, desired_leaves: desired.length, parent_records: parents.size,
    fully_loaded_triangles: triangles, fully_loaded_vertices: vertices, levels, timing,
    note: "Demanded geometry before frustum culling, if all downloads succeed; not observed rendered triangles." });
}
console.log(`Planner: ${JSON.stringify(planner)}`);

// Prototype direct addressing of the existing curved ECEF mesh. Reuses the
// actual triangle positions, performs exact ray/triangle intersections and
// returns height and normal. Adjacent cells cover projection roundoff at edges.
function addressedQuery(mesh, tile) {
  const segments = mesh.metadata.segments, stride = segments + 1;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  const edge1 = new Vector3(), edge2 = new Vector3(), normal = new Vector3();
  const ray = new Ray(new Vector3(), new Vector3(), 40000);
  const hitPoint = new Vector3();
  return (latDeg, lonDeg) => {
    const lat = latDeg * DEG_TO_RAD, lon = lonDeg * DEG_TO_RAD;
    const origin = geodeticToEcef(lat, lon, 20000);
    ray.origin.set(origin.x - mesh.position.x, origin.y - mesh.position.y, origin.z - mesh.position.z);
    ray.direction.set(-Math.cos(lat) * Math.cos(lon), -Math.cos(lat) * Math.sin(lon), -Math.sin(lat));
    const x = (lonDeg + 180) / 360 * 2 ** tile.z;
    const y = (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * 2 ** tile.z;
    const col = Math.min(segments - 1, Math.max(0, Math.floor((x - tile.x) * segments)));
    const row = Math.min(segments - 1, Math.max(0, Math.floor((y - tile.y) * segments)));
    const data = mesh.getVerticesData(VertexBuffer.PositionKind);
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const r = row + dy, c0 = col + dx;
      if (r < 0 || r >= segments || c0 < 0 || c0 >= segments) continue;
      const ia = r * stride + c0, ib = ia + 1, ic = ia + stride, id = ic + 1;
      for (const [i, j, k] of [[ia, ic, ib], [ib, ic, id]]) {
        Vector3.FromArrayToRef(data, i * 3, a); Vector3.FromArrayToRef(data, j * 3, b); Vector3.FromArrayToRef(data, k * 3, c);
        const hit = ray.intersectsTriangle(a, b, c);
        if (!hit || hit.distance < 0 || hit.distance > ray.length) continue;
        ray.direction.scaleToRef(hit.distance, hitPoint);
        hitPoint.addInPlace(ray.origin).addInPlace(mesh.position);
        b.subtractToRef(a, edge1); c.subtractToRef(a, edge2);
        Vector3.CrossToRef(edge1, edge2, normal); normal.normalize();
        return { heightMeters: ecefToGeodetic(hitPoint.x, hitPoint.y, hitPoint.z).altMeters,
          normal: { x: normal.x, y: normal.y, z: normal.z } };
      }
    }
    return null;
  };
}

for (const name of ["lax", "la_hills", "rainier"]) {
  const f = manifest.find(item => item.name === name);
  const buffer = fs.readFileSync(`${root}.cache/data/${name}.f32`);
  const heights = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const engine = new NullEngine({ useHighPrecisionMatrix: true }), scene = new Scene(engine);
  const source = { id: "benchmark", label: "benchmark", urlTemplate: "", attribution: "" };
  const patches = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const tile = { z: f.z, x: f.x + dx, y: f.y + dy };
    // Neighbor data is duplicated for workload sizing, not used as ground truth.
    const mesh = createTerrainMesh({ scene, source, getViewState: () => null }, tile, { ...tile, size: f.size, heights });
    mesh.setEnabled(true); mesh.computeWorldMatrix(true);
    patches.push({ tile, mesh });
  }
  const central = patches[4], query = createSurfaceQuery(scene, () => null, mesh => Boolean(mesh.metadata?.mapSurface));
  const construct = measure(() => {
    const mesh = createTerrainMesh({ scene, source, getViewState: () => null }, central.tile,
      { ...central.tile, size: f.size, heights });
    const count = mesh.getTotalVertices(); mesh.dispose(); return count;
  }, options);
  const direct = addressedQuery(central.mesh, central.tile);
  const coordinates = [];
  for (let i = 0; i < points.length; i += 2) {
    coordinates.push([(Math.atan(Math.sinh(Math.PI * (1 - 2 * (f.y + points[i + 1]) / 2 ** f.z))) / DEG_TO_RAD),
      (f.x + points[i]) / 2 ** f.z * 360 - 180]);
  }
  // Also check points on internal grid edges and either side of them.
  for (const offset of [-1e-9, 0, 1e-9]) for (const u of [0.25, 0.5, 0.75]) {
    coordinates.push([Math.atan(Math.sinh(Math.PI * (1 - 2 * (f.y + u + offset) / 2 ** f.z))) / DEG_TO_RAD,
      (f.x + u + offset) / 2 ** f.z * 360 - 180]);
  }
  let maximumDifference = 0;
  for (const [lat, lon] of coordinates) {
    const original = query.sample(lat, lon), addressed = direct(lat, lon);
    assert.ok(original && addressed, `${name}: missed sample`);
    maximumDifference = Math.max(maximumDifference, Math.abs(original.heightMeters - addressed.heightMeters));
  }
  assert.ok(maximumDifference < 0.002, `Height mismatch: ${maximumDifference}`);
  const batched = fn => () => {
    let sum = 0;
    for (const [lat, lon] of coordinates) sum += fn(lat, lon).heightMeters;
    return sum;
  };
  const original = measure(batched((lat, lon) => query.sample(lat, lon)), options);
  const addressed = measure(batched(direct), options);
  const queryResult = { fixture: name, tiles: patches.length, segments: central.mesh.metadata.segments,
    triangles: patches.reduce((sum, p) => sum + p.mesh.getTotalIndices() / 3, 0),
    original_us_per_query: original.median_ms * 1000 / coordinates.length,
    addressed_us_per_query: addressed.median_ms * 1000 / coordinates.length,
    maximum_height_difference_m: maximumDifference, checked_queries: coordinates.length,
    original, addressed };
  console.log(`Query ${name}: ${JSON.stringify(queryResult)}`);

  const states = patches.map(patch => {
    const target = Array.from(patch.mesh.getVerticesData(VertexBuffer.PositionKind), value => value + 1);
    return refineMesh(patch.mesh, target, 0);
  });
  const morph = measure(() => {
    patches.forEach((p, i) => advanceRefinement(p.mesh, states[i], 600));
    return 0;
  }, options);
  const seam = measure(() => { stitchTerrainEdges(patches); return 0; }, options);
  // Compare the checkpoint's two passes with Stage A1's single pass. Runtime
  // lifecycle tests separately verify the number of actual calls per update.
  const update = () => {
    patches.forEach((p, i) => advanceRefinement(p.mesh, states[i], 600));
    stitchTerrainEdges(patches);
  };
  const twoPass = measure(() => { update(); update(); return 0; }, options);
  const onePass = measure(() => { update(); return 0; }, options);
  const copyOnly = measure(() => {
    central.mesh.updateVerticesData(VertexBuffer.PositionKind, states[4].to, true);
    return 0;
  }, options);
  results.push({ ...queryResult, construct_one_tile: construct, morph_nine_tiles: morph, seam_nine_tiles: seam,
    checkpoint_two_animation_passes: twoPass, single_animation_pass: onePass,
    refinement_reduction_percent: 100 * (1 - onePass.median_ms / twoPass.median_ms), one_tile_buffer_update: copyOnly,
    limitation: "NullEngine: CPU work only; no GPU upload, rendering, texture decode, full scene traversal, tile selection, or browser frame time. Nine adjacent tiles, duplicated neighboring fixture heights." });
  console.log(`Updates ${name}: two passes ${twoPass.median_ms.toFixed(2)} ms, one pass ${onePass.median_ms.toFixed(2)} ms`);
  engine.dispose();
}
const sourceHashes = Object.fromEntries([
  "src/engine/babylon/createRasterTilesRuntime.ts", "src/terrain/meshRefinement.ts", "src/terrain/surfaceQuery.ts",
].map(path => [path, crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex")]));
const output = process.argv[2] ?? `${root}results-current.json`;
fs.writeFileSync(output, JSON.stringify({ date: new Date().toISOString(), environment: { node: process.version, cpu: os.cpus()[0]?.model },
  sourceHashes, planner, results }, null, 2) + "\n");
