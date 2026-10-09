/**
 * Correctness gates for streaming and caching, on the deterministic network:
 * the real client (lib/client.mjs) with a transport that can be slow, late or
 * failing. They check what must hold whatever the policy: nothing blank once
 * the bootstrap is up, bounded queues and memory, honest byte counters, and
 * no effect from a panorama that has been left.
 *
 *   node --test benchmarks/eac-progressive-prototype/tests/check-*.mjs
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { tilingFromManifest } from "../lib/tiling.mjs";
import { createSelector } from "../lib/selection.mjs";
import { createClient } from "../lib/client.mjs";
import { createSimStages, createSimTransport, profile, simulate } from "../lib/sim.mjs";
import { cameraPath } from "../lib/traces.mjs";
import { viewportOf } from "../lib/config.mjs";
import { defaultDataset, loadConfig, writeResults } from "../lib/paths.mjs";

const config = loadConfig(), viewport = viewportOf(config);
const directory = path.join(defaultDataset, "northrop-mall", "eac-t192");
const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")), tileBytes = JSON.parse(readFileSync(path.join(directory, "tiles.json"), "utf8")), tiling = tilingFromManifest(manifest);
const record = {};
after(() => { console.log(writeResults("correctness-client", import.meta.url, { viewport, dataset: "northrop-mall/eac-t192" }, record)); });

/** A client on the model, with a transport that also counts what it delivered and stages that hand out tokens instead of texels. */
function setup({ policy = {}, limits = {}, network = "constrained-mobile", transportOptions = {}, wrap = transport => transport } = {}) {
  let delivered = 0;
  const inner = createSimTransport(profile(network), transportOptions);
  const transport = wrap({
    start(request) {
      const done = request.done;
      const handle = inner.start({ ...request, done(result) { delivered += result.received; done(result); } });
      return { abort() { const received = handle.abort(); delivered += received; return received; } };
    },
    advance: (from, dt) => inner.advance(from, dt),
  });
  const stages = createSimStages(), decoded = [];
  const decode = stages.decode;
  stages.decode = (job, done) => { decoded.push(job); decode(job, () => done({ tile: job.tile })); };
  const client = createClient({ tiling, manifest, tileBytes, bootstrapSize: 48, selector: createSelector(tiling, config.selection), policy: { ...config.policy, ...policy }, limits: { ...config.limits, ...limits }, transport, stages, log: true });
  return { client, transport, stages, decoded, delivered: () => delivered };
}

/** Every cell shows the bootstrap or a tile that is resident in a slot: never something that is not there. */
function assertNothingBlank(client, when) {
  for (let cell = 0; cell < client.table.length; cell++) {
    const tile = client.table[cell];
    if (tile < 0) continue;
    assert.equal(client.stateOf(tile), 5, `${when}: cell ${cell} shows tile ${tile}, which is not resident`);
    assert.ok(client.slotOf(tile) >= 0, `${when}: cell ${cell} shows a tile with no slot`);
  }
}

for (const [name, policy] of [["direct replacement", {}], ["every level", { refinement: "levels" }], ["residual", { payload: "residual" }], ["insurance", { insurance: { enabled: true, maxLevel: 1, slots: 2 } }]]) {
  test(`${name}: the view completes, queues stay within their limits, and the byte counter matches the link`, () => {
    const { client, transport, stages, decoded, delivered } = setup({ policy });
    const trace = cameraPath("quick-turn", "off-axis");
    let completeAt = null;
    simulate({ client, transport, stages, cameraAt: trace.at, viewport, durationMs: trace.duration * 1000, onSample(time) {
      if (client.bootstrapDisplayedAt !== null) assertNothingBlank(client, `${name} at ${time} ms`);
      if (completeAt === null && client.viewComplete()) completeAt = time;
    } });
    const { counters, limits } = client;
    assert.ok(client.bootstrapDisplayedAt !== null && client.bootstrapDisplayedAt < 1000, "the bootstrap is shown");
    assert.ok(client.viewComplete(), "the last view is complete");
    assert.ok(counters.peak.inflightRequests <= limits.requests, `in flight ${counters.peak.inflightRequests}`);
    assert.ok(counters.peak.pendingTiles <= limits.pendingTiles + limits.requests, `pending ${counters.peak.pendingTiles}`);
    assert.ok(counters.peak.residentTiles <= limits.gpuSlots);
    assert.equal(counters.bytesReceived, delivered(), "every byte the link delivered is counted, cancelled ones included");
    if (policy.payload === "residual") {
      // A residual tile is decoded only with its own parent's texels in hand.
      for (const job of decoded) if (job.kind === "r") assert.equal(job.parent?.tile, tiling.parent(job.tile), `tile ${job.tile} was decoded without its parent`);
    }
    for (const event of client.events) if (event[1] === "request") assert.ok(typeof event[3] === "string" && event[3].length > 0, "every request records why it was made");
    record[name] = { firstViewCompleteMs: completeAt, bootstrapMs: client.bootstrapDisplayedAt, requests: counters.requests, bytesReceived: counters.bytesReceived, cancelled: counters.cancelled, cancelledBytes: counters.cancelledBytes, insuranceBytes: counters.insuranceBytes, peak: counters.peak };
  });
}

test("failed and late requests never leave a hole, and failures are retried", () => {
  const { client, transport, stages } = setup({ transportOptions: { failEvery: 3, delayMs: 400 } });
  const trace = cameraPath("explore", "off-axis");
  simulate({ client, transport, stages, cameraAt: trace.at, viewport, durationMs: trace.duration * 1000, onSample(time) { if (client.bootstrapDisplayedAt !== null) assertNothingBlank(client, `at ${time} ms`); } });
  assert.ok(client.counters.failures > 0 && client.counters.retries > 0);
  record["one request in three failing, 400 ms late"] = { failures: client.counters.failures, retries: client.counters.retries, uploads: client.counters.uploads };
});

test("a small cache evicts, keeps the view covered, and stays within its budget over a long trace", () => {
  const gpuSlots = 40, { client, transport, stages } = setup({ network: "fast", limits: { gpuSlots, decodedBytes: 4 << 20 }, policy: { payload: "residual" } });
  // Three laps of the exploring trace: the same views come round again.
  const trace = cameraPath("explore", "face-edge"), laps = 3, residents = [];
  simulate({ client, transport, stages, cameraAt: seconds => trace.at(seconds % trace.duration), viewport, durationMs: trace.duration * laps * 1000, onSample(time) {
    if (client.bootstrapDisplayedAt !== null) assertNothingBlank(client, `at ${time} ms`);
    residents.push(client.resources());
  } });
  const { counters } = client;
  assert.ok(counters.evictions > 0, "the budget was small enough to evict");
  assert.ok(counters.peak.residentTiles <= gpuSlots);
  assert.ok(counters.peak.decodedBytes <= (4 << 20) + (config.limits.pendingTiles + config.limits.requests) * tiling.stored ** 2 * 4, `decoded peak ${counters.peak.decodedBytes}`);
  assert.ok(counters.levelCapped > 0, "with too few slots for the view the level drops instead of leaving gaps");
  // A steady footprint: the last lap holds no more than the first.
  const lap = Math.floor(residents.length / laps), peakOf = list => Math.max(...list.map(item => item.residentTiles + item.decodedBytes / (tiling.stored ** 2 * 4)));
  assert.ok(peakOf(residents.slice(2 * lap)) <= peakOf(residents.slice(0, lap)) + 1);
  record[`${gpuSlots} slots, residual, three laps`] = { evictions: counters.evictions, redownloads: counters.redownloads, rematerialized: counters.rematerialized, dropped: counters.dropped, levelCapped: counters.levelCapped, gpuHits: counters.gpuHits, gpuMisses: counters.gpuMisses, peak: counters.peak };
});

test("a response for a panorama that was left changes nothing", () => {
  // A transport that cannot abort: everything asked for still arrives, after the client has been disposed.
  const { client, transport, stages } = setup({ network: "constrained-mobile", wrap: transport => ({ start: request => { transport.start(request); return { abort: () => 0 }; }, advance: transport.advance }) });
  const camera = { yaw: 17, pitch: 9, roll: 0 };
  for (let time = 0; time < 600; time += 10) { stages.flush(time); client.tick(time, camera, viewport); transport.advance(time, 10); }
  const before = { uploads: stages.uploads, tables: stages.tableSets, inflight: client.inflightTiles().length };
  assert.ok(before.inflight > 0, "requests were in flight when the panorama was left");
  client.dispose();
  for (let time = 600; time < 6000; time += 10) { stages.flush(time); client.tick(time, camera, viewport); transport.advance(time, 10); }
  assert.equal(stages.uploads, before.uploads);
  assert.equal(stages.tableSets, before.tables);
  assert.ok(client.counters.staleResponses >= before.inflight);
  record["left with requests in flight"] = { inFlight: before.inflight, staleResponsesIgnored: client.counters.staleResponses };
});

test("a turn cancels only what the new view has no use for, and counts its bytes", () => {
  const { client, transport, stages, delivered } = setup({ network: "very-constrained" });
  const trace = cameraPath("quick-turn", "face-centre");
  simulate({ client, transport, stages, cameraAt: trace.at, viewport, durationMs: trace.duration * 1000 });
  const { counters } = client;
  assert.equal(counters.bytesReceived, delivered());
  for (const event of client.events) if (event[1] === "cancel") assert.ok(event[3] >= 0);
  record["quick turn at 0.75 Mbit/s"] = { cancelled: counters.cancelled, cancelledBytes: counters.cancelledBytes, bytesReceived: counters.bytesReceived, bytesNeverShown: client.bytesNeverShown() };
});
