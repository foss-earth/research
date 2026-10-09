#!/usr/bin/env node
/**
 * Experiment 8: what decoding and reconstruction cost on the CPU, apart from
 * any network.
 *
 * Times the steps a client would run, on real tiles of one panorama, in Node
 * (V8, the engine Chrome uses): inflating a residual tile, unpacking it,
 * the inverse transform in JavaScript and in WebAssembly, conversion to RGBA,
 * a pure-JavaScript JPEG decode for scale, copying a tile into an atlas, each
 * representation's chart maps, and reprojecting a tile from one representation
 * into another. Browser-native image decoding is measured by run-gpu.mjs.
 *
 * Every figure is from this desktop CPU. Nothing here says how a phone behaves.
 *
 *   node benchmarks/spherical-image-representation/run-cpu.mjs
 *     [--rounds=3] [--iterations=300] [--warmup=100] [--idle-seconds=10] [--panorama=northrop-mall]
 *
 * A round is run again if the keyboard or mouse was used during it, or other
 * processes were busy. Writes results/cpu.json and results/cpu.csv.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import jpeg from "jpeg-js";
import { REPRESENTATIONS, representation } from "./lib/representations.mjs";
import { CORPUS, defaultCorpusRoot, loadSource } from "./lib/source.mjs";
import { buildGutter, padField, resample } from "./lib/field.mjs";
import { DELIVERY_RESOLUTION, analyze, cellAreas, makeHierarchy, packDetailBlock, quantizeAndDecode } from "./lib/hierarchy.mjs";
import { encodeJpeg } from "./lib/codecs.mjs";
import { inverseHaarEqual, inverseHaarWeighted, placeTile, unpackIntegers, yccToRgba } from "./lib/decodeKernel.mjs";
import { mulberry32, randomDirection } from "./lib/random.mjs";
import { benchmarkRoot, parseArguments, scratchDirectory, writeCsv, writeResults } from "./lib/environment.mjs";
import { quietRound } from "./lib/quiet.mjs";

const options = parseArguments({ rounds: 3, iterations: 300, warmup: 100, "idle-seconds": 10, retries: 3, panorama: "northrop-mall", delta: 12, "corpus-root": defaultCorpusRoot });
const TILE = 256, HALF = TILE / 2, PARENTS = HALF * HALF, CHILDREN = TILE * TILE;

// ─── Real tiles ────────────────────────────────────────────────────────

const source = loadSource(CORPUS.find(entry => entry.id === options.panorama), options["corpus-root"]);
function tilesOf(rep, TILE = 256) {
  const HALF = TILE / 2, PARENTS = HALF * HALF, CHILDREN = TILE * TILE;
  const N = DELIVERY_RESOLUTION[rep.id], hierarchy = makeHierarchy(rep, N), { levels, finest, charts } = hierarchy;
  const [field] = resample(rep, N, [source]);
  const coded = quantizeAndDecode(hierarchy, analyze(hierarchy, field.rgb), options.delta);
  const child = levels[finest], parent = levels[finest - 1];
  const steps = Float32Array.from(coded.steps[finest - 1].flat());
  const tiles = [];
  for (let chart = 0; chart < charts; chart++) for (let y0 = 0; y0 + TILE <= child.H; y0 += TILE) for (let x0 = 0; x0 + TILE <= child.W; x0 += TILE) {
    const packed = packDetailBlock(coded.quantized[finest - 1], parent, chart, x0 / 2, y0 / 2, x0 / 2 + HALF, y0 / 2 + HALF);
    const parentPlanes = new Float32Array(PARENTS * 3), expected = new Float32Array(CHILDREN * 3), areas = new Float32Array(CHILDREN), rgb = new Uint8Array(CHILDREN * 3);
    for (let plane = 0; plane < 3; plane++) {
      for (let y = 0; y < HALF; y++) for (let x = 0; x < HALF; x++) parentPlanes[plane * PARENTS + y * HALF + x] = coded.decoded[finest - 1][plane * parent.count + (chart * parent.H + y0 / 2 + y) * parent.W + x0 / 2 + x];
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) expected[plane * CHILDREN + y * TILE + x] = coded.decoded[finest][plane * child.count + (chart * child.H + y0 + y) * child.W + x0 + x];
    }
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const cell = (chart * child.H + y0 + y) * child.W + x0 + x;
      areas[y * TILE + x] = child.areas[cell];
      rgb.set(field.rgb.subarray(cell * 3, cell * 3 + 3), (y * TILE + x) * 3);
    }
    tiles.push({ deflated: zlib.deflateRawSync(packed, { level: 9 }), packedBytes: packed.length, parentPlanes, expected, areas, jpeg: TILE === 256 ? encodeJpeg({ width: TILE, height: TILE, rgb }, 80) : null });
    if (tiles.length >= 64) return { rep, N, steps, tiles, field, size: TILE };
  }
  return { rep, N, steps, tiles, field, size: TILE };
}
const equal = tilesOf(representation("healpix")), weighted = tilesOf(representation("cube"));

// ─── WebAssembly ───────────────────────────────────────────────────────

function loadWasm() {
  const file = path.join(scratchDirectory, "wasm/decode_kernel.wasm");
  let emcc = null;
  try { emcc = execFileSync("emcc", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0]; } catch { /* Not installed. */ }
  if (emcc) {
    mkdirSync(path.dirname(file), { recursive: true });
    execFileSync("emcc", ["-O3", "--no-entry", "-sSTANDALONE_WASM", "-sINITIAL_MEMORY=67108864", "-sEXPORTED_FUNCTIONS=_unpack_integers,_inverse_haar_equal,_ycc_to_rgba,_malloc,_free",
      path.join(benchmarkRoot, "wasm/decode_kernel.c"), "-o", file], { stdio: "ignore" });
  }
  if (!existsSync(file)) return { unavailable: "emcc is not installed, so the WebAssembly kernel was not built" };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(file)), {});
  instance.exports._initialize?.();
  return { instance, emcc, bytes: readFileSync(file).length };
}
const wasm = loadWasm();

// ─── Checks before timing ──────────────────────────────────────────────

const integers = new Int32Array(PARENTS * 9), children = new Float32Array(CHILDREN * 3), rgba = new Uint8Array(CHILDREN * 4);
function worstDifference(set, inverse) {
  let worst = 0;
  for (const tile of set.tiles) {
    unpackIntegers(zlib.inflateRawSync(tile.deflated), integers);
    inverse(tile);
    for (let i = 0; i < children.length; i++) worst = Math.max(worst, Math.abs(children[i] - tile.expected[i]));
  }
  return worst;
}
const checks = {
  equalKernelAgainstReference: worstDifference(equal, tile => inverseHaarEqual(tile.parentPlanes, integers, HALF, HALF, equal.steps, children)),
  weightedKernelAgainstReference: worstDifference(weighted, tile => inverseHaarWeighted(tile.parentPlanes, integers, HALF, HALF, weighted.steps, tile.areas, children)),
};
let wasmMemory = null;
if (wasm.instance) {
  const e = wasm.instance.exports;
  const pointers = { bytes: e.malloc(PARENTS * 9 * 5), integers: e.malloc(PARENTS * 9 * 4), parent: e.malloc(PARENTS * 12), steps: e.malloc(36), children: e.malloc(CHILDREN * 12), rgba: e.malloc(CHILDREN * 4) };
  wasmMemory = { e, pointers, heap: () => e.memory.buffer };
  new Float32Array(e.memory.buffer, pointers.steps, 9).set(equal.steps);
  let worst = 0;
  for (const tile of equal.tiles) {
    const packed = zlib.inflateRawSync(tile.deflated);
    new Uint8Array(e.memory.buffer, pointers.bytes, packed.length).set(packed);
    new Float32Array(e.memory.buffer, pointers.parent, PARENTS * 3).set(tile.parentPlanes);
    e.unpack_integers(pointers.bytes, pointers.integers, PARENTS * 9);
    e.inverse_haar_equal(pointers.parent, pointers.integers, HALF, HALF, pointers.steps, pointers.children);
    const out = new Float32Array(e.memory.buffer, pointers.children, CHILDREN * 3);
    for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - tile.expected[i]));
  }
  checks.wasmKernelAgainstReference = worst;
}
for (const [name, value] of Object.entries(checks)) if (!(value < 0.01)) throw new Error(`${name}: the kernel disagrees with lib/hierarchy.mjs by ${value}`);

// ─── Operations ────────────────────────────────────────────────────────

const atlas = new Uint8Array(2048 * 2048 * 4);
let sink = 0;
const operations = [];
const add = (name, group, samples, temporaryBytes, run, note = "") => operations.push({ name, group, samples, temporaryBytes, run, note });
const cycle = set => { let k = 0; return () => set.tiles[k++ % set.tiles.length]; };

{
  const next = cycle(equal);
  let packed = zlib.inflateRawSync(equal.tiles[0].deflated);
  add("inflate one residual tile", "native", CHILDREN, equal.tiles[0].packedBytes, () => { packed = zlib.inflateRawSync(next().deflated); sink += packed.length; }, "zlib, native code; a browser's DecompressionStream is the counterpart");
  add("unpack integers", "JavaScript", CHILDREN, integers.byteLength, () => { sink += unpackIntegers(packed, integers); });
  const tile = cycle(equal);
  add("inverse transform, equal areas", "JavaScript", CHILDREN, children.byteLength, () => { inverseHaarEqual(tile().parentPlanes, integers, HALF, HALF, equal.steps, children); });
  const other = cycle(weighted);
  add("inverse transform, area-weighted", "JavaScript", CHILDREN, children.byteLength + CHILDREN * 4, () => { const t = other(); inverseHaarWeighted(t.parentPlanes, integers, HALF, HALF, weighted.steps, t.areas, children); }, "needs every child cell's area");
  add("Y′CbCr to RGBA", "JavaScript", CHILDREN, rgba.byteLength, () => { yccToRgba(children, CHILDREN, rgba); });
  const whole = cycle(equal);
  add("residual tile 256², whole decode", "JavaScript + native inflate", CHILDREN, equal.tiles[0].packedBytes + integers.byteLength + children.byteLength + rgba.byteLength, () => {
    const t = whole();
    unpackIntegers(zlib.inflateRawSync(t.deflated), integers);
    inverseHaarEqual(t.parentPlanes, integers, HALF, HALF, equal.steps, children);
    yccToRgba(children, CHILDREN, rgba);
  });
}
if (wasmMemory) {
  const { e, pointers } = wasmMemory;
  add("unpack integers", "WebAssembly", CHILDREN, integers.byteLength, () => { sink += e.unpack_integers(pointers.bytes, pointers.integers, PARENTS * 9); });
  add("inverse transform, equal areas", "WebAssembly", CHILDREN, children.byteLength, () => { e.inverse_haar_equal(pointers.parent, pointers.integers, HALF, HALF, pointers.steps, pointers.children); });
  add("Y′CbCr to RGBA", "WebAssembly", CHILDREN, rgba.byteLength, () => { e.ycc_to_rgba(pointers.children, CHILDREN, pointers.rgba); });
  const whole = cycle(equal);
  add("residual tile 256², whole decode", "WebAssembly + native inflate", CHILDREN, equal.tiles[0].packedBytes + integers.byteLength + children.byteLength + rgba.byteLength, () => {
    const t = whole(), packed = zlib.inflateRawSync(t.deflated);
    new Uint8Array(e.memory.buffer, pointers.bytes, packed.length).set(packed);
    new Float32Array(e.memory.buffer, pointers.parent, PARENTS * 3).set(t.parentPlanes);
    e.unpack_integers(pointers.bytes, pointers.integers, PARENTS * 9);
    e.inverse_haar_equal(pointers.parent, pointers.integers, HALF, HALF, pointers.steps, pointers.children);
    e.ycc_to_rgba(pointers.children, CHILDREN, pointers.rgba);
    rgba.set(new Uint8Array(e.memory.buffer, pointers.rgba, CHILDREN * 4));
  }, "includes copying the tile into and out of the module's memory");
}
{
  const next = cycle(weighted);
  add("JPEG tile decode, jpeg-js", "JavaScript", CHILDREN, CHILDREN * 4, () => { sink += jpeg.decode(next().jpeg, { useTArray: true }).data.length; }, "a pure-JavaScript decoder; browsers decode natively, see run-gpu.mjs");
  let slot = 0;
  add("copy a tile into an atlas", "JavaScript", CHILDREN, 0, () => { placeTile(rgba, TILE, atlas, 2048, (slot % 8) * TILE, ((slot >> 3) % 8) * TILE); slot++; });
}
// The same decode at other tile sizes: how the time grows with the size of a refinement.
for (const size of [64, 128, 512]) {
  const set = tilesOf(representation("healpix"), size), half = size / 2;
  const ints = new Int32Array(half * half * 9), planes = new Float32Array(size * size * 3), bytes = new Uint8Array(size * size * 4);
  const next = cycle(set);
  add(`residual tile ${size}², whole decode`, "JavaScript + native inflate", size * size, ints.byteLength + planes.byteLength + bytes.byteLength, () => {
    const t = next();
    unpackIntegers(zlib.inflateRawSync(t.deflated), ints);
    inverseHaarEqual(t.parentPlanes, ints, half, half, set.steps, planes);
    yccToRgba(planes, size * size, bytes);
  });
  if (wasmMemory) {
    const { e } = wasmMemory, own = cycle(set);
    const p = { bytes: e.malloc(half * half * 45), integers: e.malloc(half * half * 36), parent: e.malloc(half * half * 12), steps: e.malloc(36), children: e.malloc(size * size * 12), rgba: e.malloc(size * size * 4) };
    new Float32Array(e.memory.buffer, p.steps, 9).set(set.steps);
    add(`residual tile ${size}², whole decode`, "WebAssembly + native inflate", size * size, ints.byteLength + planes.byteLength + bytes.byteLength, () => {
      const t = own(), packed = zlib.inflateRawSync(t.deflated);
      new Uint8Array(e.memory.buffer, p.bytes, packed.length).set(packed);
      new Float32Array(e.memory.buffer, p.parent, half * half * 3).set(t.parentPlanes);
      e.unpack_integers(p.bytes, p.integers, half * half * 9);
      e.inverse_haar_equal(p.parent, p.integers, half, half, p.steps, p.children);
      e.ycc_to_rgba(p.children, size * size, p.rgba);
      bytes.set(new Uint8Array(e.memory.buffer, p.rgba, size * size * 4));
    });
  }
}
// A child tile's cell areas, which the area-weighted transform needs on the client.
for (const id of ["cube", "equirect", "ico-rhombus", "toast"]) {
  const rep = representation(id);
  add(`cell areas of one tile, ${id}`, "JavaScript", CHILDREN, CHILDREN * 4, () => { sink += cellAreas({ ...rep, charts: 1, chartWidth: () => TILE, chartHeight: () => TILE, toDir: (chart, u, v, out) => rep.toDir(0, u * TILE / rep.chartWidth(DELIVERY_RESOLUTION[id]), v * TILE / rep.chartHeight(DELIVERY_RESOLUTION[id]), out) }, 1)[0]; });
}
// The chart maps themselves: what any projection conversion or lookup pays per sample.
const directions = new Float64Array(CHILDREN * 3);
{
  const random = mulberry32(99), d = [0, 0, 0];
  for (let i = 0; i < CHILDREN; i++) { randomDirection(random, d); directions.set(d, i * 3); }
}
const place = [0, 0, 0], direction = [0, 0, 0];
for (const rep of REPRESENTATIONS.filter(item => !item.hexagonCells && !item.triangleCells)) {
  add(`direction to chart position, ${rep.id}`, "JavaScript", CHILDREN, 0, () => {
    for (let i = 0; i < CHILDREN; i++) { rep.fromDir(directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2], place); sink += place[1]; }
  }, rep.recursive ? "walks 16 levels of the triangle hierarchy" : "");
  add(`chart position to direction, ${rep.id}`, "JavaScript", CHILDREN, 0, () => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { rep.toDir(0, (x + 0.5) / 768, (y + 0.5) / 768, direction); sink += direction[2]; }
  });
}
// Converting between representations: fill one 256 × 256 tile of the target from a decoded source.
function reprojection(targetId, sourceSet) {
  const target = representation(targetId), from = sourceSet.rep, { W, H } = sourceSet.field;
  const padded = padField(sourceSet.field, buildGutter(from, sourceSet.N)), row = (W + 2) * 3;
  const width = target.chartWidth(DELIVERY_RESOLUTION[targetId]), height = target.chartHeight(DELIVERY_RESOLUTION[targetId]);
  add(`reproject a tile, ${from.id} to ${targetId}`, "JavaScript", CHILDREN, CHILDREN * 4, () => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      target.toDir(0, (x + 0.5) / width, (y + 0.5) / height, direction);
      from.fromDir(direction[0], direction[1], direction[2], place);
      const fx = place[1] * W - 0.5, fy = place[2] * H - 0.5, i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
      const p = place[0] * (H + 2) * row + (j + 1) * row + (i + 1) * 3, q = p + row, o = (y * TILE + x) * 4;
      for (let c = 0; c < 3; c++) rgba[o + c] = (padded[p + c] * (1 - tx) + padded[p + 3 + c] * tx) * (1 - ty) + (padded[q + c] * (1 - tx) + padded[q + 3 + c] * tx) * ty + 0.5;
    }
  }, "bilinear, in sRGB bytes, into RGBA");
}
reprojection("cube", equal);
reprojection("equirect", equal);
reprojection("equirect", weighted);
reprojection("healpix", weighted);

// ─── Timing ────────────────────────────────────────────────────────────

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
function timeAll() {
  return operations.map(operation => {
    for (let i = 0; i < options.warmup; i++) operation.run();
    const times = new Float64Array(options.iterations);
    for (let i = 0; i < options.iterations; i++) {
      const start = process.hrtime.bigint();
      operation.run();
      times[i] = Number(process.hrtime.bigint() - start) / 1e6;
    }
    times.sort();
    return { median: quantile(times, 0.5), p95: quantile(times, 0.95), p99: quantile(times, 0.99), min: times[0], max: times.at(-1) };
  });
}

console.log(`${operations.length} operations, ${options.rounds} rounds of ${options.iterations} timed runs after ${options.warmup} warm-up runs`);
const rounds = [];
for (let r = 0; r < options.rounds; r++) {
  rounds.push(await quietRound(async () => timeAll(), { idleSeconds: options["idle-seconds"], retries: options.retries }));
  console.log(`  round ${r + 1}: ${rounds.at(-1).disturbed ? `disturbed by ${rounds.at(-1).disturbed}` : "undisturbed"}, ${rounds.at(-1).busyCores.toFixed(1)} cores busy, ${rounds.at(-1).memory ? `${rounds.at(-1).memory.compressedMiB.toFixed(0)} MiB compressed, ${rounds.at(-1).memory.swappedOutMiB.toFixed(0)} MiB swapped out` : "memory not read"}`);
}
const usable = rounds.filter(round => !round.disturbed), counted = usable.length ? usable : rounds;
const middle = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = operations.map((operation, index) => {
  const of = key => counted.map(round => round.value[index][key]);
  const median = middle(of("median"));
  return {
    operation: operation.name, runsIn: operation.group, samples: operation.samples,
    medianMs: median, p95Ms: middle(of("p95")), p99Ms: middle(of("p99")),
    medianMsLowestRound: Math.min(...of("median")), medianMsHighestRound: Math.max(...of("median")),
    megasamplesPerSecond: operation.samples / 1e6 / (median / 1000), nanosecondsPerSample: median * 1e6 / operation.samples,
    temporaryBytes: operation.temporaryBytes, note: operation.note,
  };
});
console.table(rows.map(row => ({ operation: row.operation, in: row.runsIn, "median ms": Number(row.medianMs.toFixed(3)), "p95 ms": Number(row.p95Ms.toFixed(3)), "p99 ms": Number(row.p99Ms.toFixed(3)), "Msamples/s": Number(row.megasamplesPerSecond.toFixed(1)) })));
const tileBytes = set => set.tiles.reduce((sum, tile) => sum + tile.deflated.length, 0) / set.tiles.length;
console.log(writeResults("cpu", import.meta.url, {
  panorama: options.panorama, tile: TILE, delta: options.delta, rounds: options.rounds, iterations: options.iterations, warmup: options.warmup,
  wasm: wasm.instance ? { compiler: wasm.emcc, flags: "-O3 --no-entry -sSTANDALONE_WASM -sINITIAL_MEMORY=67108864", bytes: wasm.bytes } : { unavailable: wasm.unavailable },
  jpegJs: JSON.parse(readFileSync(new URL("../../node_modules/jpeg-js/package.json", import.meta.url), "utf8")).version,
  caveat: "A desktop CPU. Phones were not measured.",
}, {
  checks, sink: sink > 0,
  rounds: rounds.map(round => ({ disturbed: round.disturbed, attempts: round.attempts, busyCores: round.busyCores, secondsSinceInput: round.secondsSinceInput, memory: round.memory })),
  tiles: { equalAreaTiles: equal.tiles.length, meanResidualTileBytes: tileBytes(equal), meanJpegTileBytes: weighted.tiles.reduce((sum, tile) => sum + tile.jpeg.length, 0) / weighted.tiles.length },
  operations: rows,
}));
console.log(writeCsv("cpu", rows));
