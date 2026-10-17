// Pure adversarial fixtures: no browser, battery reads, subprocesses or network.
import assert from "node:assert/strict";
import test from "node:test";
import { aggregate, frameIntervals, quantiles, visuallyComplete, visuallyCompleteStream } from "../scripts/benchmarks/earth-compare/metrics.mjs";
import { parseBattery, parsePmsetCustom, summarizePower, withSourcePowerMode } from "../scripts/benchmarks/power/battery.mjs";

const quality = { verified: true, landmarks: true, detail: true };
const rgba = values => Uint8Array.from(values.flatMap(value => [value, value, value, 255]));
const frame = (timestampMs, values = [0, 128, 255, 64]) => ({ timestampMs, width: values.length, height: 1, data: rgba(values) });
const complete = (frames, options = {}) => visuallyComplete(frames, { finalQuality: quality, ...options });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test("frame quantiles use type-7 interpolation without treating missing data as zero", () => {
  const source = [40, 10, 30, 20];
  const result = quantiles(source);
  assert.deepEqual({ ...result, p99: 39.7 }, { count: 4, min: 10, p50: 25, p95: 38.5, p99: 39.7, max: 40 });
  close(result.p99, 39.7);
  assert.deepEqual(source, [40, 10, 30, 20]);
  assert.deepEqual(quantiles([]), { count: 0, min: null, p50: null, p95: null, p99: null, max: null });
  for (const invalid of [null, NaN, Infinity, "1"]) assert.throws(() => quantiles([invalid]), /finite/);
});

test("presented-frame intervals exclude requested/rendered frames, duplicates and other streams", () => {
  const event = (name, ts, pid = 1, tid = 2) => ({ name, ts, pid, tid, ph: "I" });
  const result = frameIntervals([
    event("BeginFrame", 1), event("DrawFrame", 2),
    event("FramePresented", 30000), event("FramePresented", 10000),
    event("FramePresented", 10000), event("FramePresented", 60000),
    event("FramePresented", 15000, 3, 4), event("FramePresented", 16000, 3, 4),
    event("FrameDisplayed", 19000),
  ], { pid: 1, tid: 2 });
  assert.deepEqual(result.timestampsMs, [10, 30, 60]);
  assert.deepEqual(result.intervalsMs, [20, 30]);
  assert.equal(result.p50, 25);
  assert.equal(result.eventName, "FramePresented");
  const unavailable = frameIntervals([event("BeginFrame", 1), event("DrawFrame", 2), event("DrawFrame", 20000)]);
  assert.equal(unavailable.count, 0); assert.equal(unavailable.p95, null);
  assert.throws(() => frameIntervals([], { eventName: "DrawFrame" }), /presented/);
});

test("ambiguous presentation streams are reported, with a deterministic single stream", () => {
  const events = [1, 2].flatMap(pid => [1000, 17000, 33000].map(ts => ({ pid, tid: 2, name: "FramePresented", ts })));
  const result = frameIntervals({ traceEvents: events });
  assert.ok(result.warnings.some(text => text.startsWith("Multiple presentation streams"))); assert.equal(result.count, 2);
  assert.ok(result.warnings.some(text => text.startsWith("Presentation scope is unverified")));
  assert.deepEqual(result.scope, { pid: 1, tid: 2 });
});

test("visual completion requires a sustained final suffix and does not accept a late final frame", () => {
  assert.equal(complete([frame(0), frame(1000), frame(2000)]).timeMs, 0);
  const changed = [255, 0, 128, 64];
  const tooLate = complete([frame(0), frame(1000), frame(2000), frame(3000, changed)]);
  assert.equal(tooLate.status, "failed"); assert.equal(tooLate.reason, "insufficient-final-hold");
  const settlesAgain = complete([frame(0), frame(1000), frame(2000), frame(3000, changed), frame(4000, changed), frame(5000, changed)]);
  assert.equal(settlesAgain.status, "complete"); assert.equal(settlesAgain.timeMs, 3000);
  // An early matching interval followed by a mismatch cannot prove final completion.
  const interrupted = complete([frame(0), frame(1000), frame(2000), frame(3000, changed), frame(4000), frame(5000)]);
  assert.equal(interrupted.status, "failed");
});

test("visual tolerance is per channel and the included-pixel mask defines the denominator", () => {
  const baseline = [0, 128, 255, 64], near = [8, 120, 247, 72];
  assert.equal(complete([frame(0, near), frame(1000), frame(2000)]).status, "complete");
  assert.equal(complete([frame(0, [9, 128, 255, 64]), frame(1000), frame(2000)]).timeMs, null);
  const masked = complete([frame(0, [255, 128, 255, 64]), frame(1000), frame(2000)], { mask: [0, 1, 1, 1] });
  assert.equal(masked.status, "complete"); assert.equal(masked.comparedPixels, 3);
  const large = Array.from({ length: 200 }, (_, index) => index % 256);
  const oneChanged = large.slice(); oneChanged[0] = 255;
  assert.equal(complete([frame(0, oneChanged), frame(1000, large), frame(2000, large)]).status, "complete");
  const twoChanged = oneChanged.slice(); twoChanged[1] = 255;
  assert.equal(complete([frame(0, twoChanged), frame(1000, large), frame(2000, large)]).status, "failed");
});

test("blank, coarse, failed, unverified and malformed frames cannot count as completion", () => {
  assert.equal(visuallyComplete([frame(0), frame(1000), frame(2000)]).reason, "unverified-final-quality");
  for (const finalQuality of [{ ...quality, detail: false }, { ...quality, landmarks: false }, { ...quality, verified: false }]) {
    assert.equal(complete([frame(0), frame(1000), frame(2000)], { finalQuality }).status, "failed");
  }
  for (const bad of ["coarse", "failed", "blank"]) assert.equal(complete([frame(0), frame(1000), frame(2000)], { finalQuality: { ...quality, [bad]: true } }).reason, "failed-final-quality");
  assert.equal(complete([frame(0, [0, 0]), frame(1000, [0, 0]), frame(2000, [0, 0])]).reason, "blank-final-frame");
  assert.equal(complete([]).reason, "missing-frames");
  assert.equal(complete([frame(0)]).reason, "insufficient-frames");
  assert.equal(complete([frame(0), frame(0)]).reason, "invalid-frame-data");
  assert.equal(complete([frame(0), { ...frame(2000), data: Uint8Array.of(1) }]).reason, "invalid-frame-data");
  assert.equal(complete([frame(0), frame(2000)], { mask: [1] }).reason, "invalid-mask");
  assert.equal(complete([frame(0), frame(2000)], { mask: [0, 0, 0, 0] }).reason, "empty-mask");
  assert.equal(complete([frame(0), frame(2000)]).reason, "insufficient-final-hold");
});

test("event-driven capture can prove unchanged time, only with complete capture and multiple frames", () => {
  const sparse = [frame(0), frame(2500)];
  assert.equal(complete(sparse).status, "failed");
  const options = { eventDriven: true, captureComplete: true, observedUntilMs: 3000 };
  const result = complete(sparse, options);
  assert.equal(result.status, "complete"); assert.equal(result.heldUntilMs, 3000);
  assert.equal(complete(sparse, { ...options, captureComplete: false }).reason, "unverified-capture-continuity");
  assert.equal(complete(sparse, { ...options, observedUntilMs: 2000 }).reason, "unverified-capture-continuity");
  assert.equal(complete([frame(0)], { ...options, observedUntilMs: 10000 }).reason, "insufficient-frames");
  // The forced end screenshot discovers late detail: its hold starts at that screenshot.
  assert.equal(complete([frame(0), frame(3000, [255, 0, 128, 64])], options).status, "failed");
});

test("streaming visual comparison exactly matches array results, including failures", async () => {
  const normal = [frame(0), frame(1000), frame(2000)];
  const cases = [
    [normal, {}],
    [[frame(0), frame(3000)], { eventDriven: true, captureComplete: true, observedUntilMs: 4000 }],
    [[frame(0), frame(1000), frame(3000, [255, 0, 128, 64])], { eventDriven: true, captureComplete: true, observedUntilMs: 3000 }],
    [normal, { mask: [0, 1, 1, 1], threshold: 1, tolerance: 0 }],
    [normal, { finalQuality: null }],
    [normal, { finalQuality: { ...quality, coarse: true } }],
    [normal, { mask: [] }],
    [normal, { mask: [0, 0, 0, 0] }],
    [normal, { eventDriven: true, captureComplete: false }],
    [[frame(0, [0, 0]), frame(1000, [0, 0]), frame(2000, [0, 0])], {}],
    [[frame(0)], {}],
    [[frame(0), frame(0)], {}],
    [[frame(0), { ...frame(2000), data: null }], {}],
    [[{ ...frame(0), data: null }, frame(2000)], {}],
    [[{ ...frame(0), data: null }, { ...frame(2000), data: null }], {}],
    [[frame(0), { ...frame(2000), width: 0 }], {}],
    [[frame(0), { ...frame(1000), data: Array(16).fill(NaN) }, frame(2000)], {}],
    [[frame(0), { ...frame(1000), data: { length: 16 } }, frame(2000)], {}],
    [[], {}],
  ];
  for (const [frames, options] of cases) {
    const resolved = { finalQuality: quality, ...options };
    const metadata = frames.map((item, index) => ({ timestampMs: item.timestampMs, file: `frame-${index}.png` }));
    const streamed = await visuallyCompleteStream(metadata, async (_, index) => frames[index], resolved);
    assert.deepEqual(streamed, visuallyComplete(frames, resolved));
  }
});

test("streaming decodes the final once, processes earlier frames sequentially, and fails decode errors", async () => {
  const frames = [frame(0), frame(1000), frame(2000), frame(3000)];
  const calls = [], metadata = frames.map(({ timestampMs }) => ({ timestampMs }));
  let decoding = false;
  const result = await visuallyCompleteStream(metadata, async (_, index) => {
    assert.equal(decoding, false); decoding = true; calls.push(index);
    await Promise.resolve(); decoding = false;
    // Timestamp belongs to the retained capture metadata, not to the decoder.
    return { ...frames[index], timestampMs: -100 };
  }, { finalQuality: quality });
  assert.equal(result.status, "complete"); assert.deepEqual(calls, [3, 0, 1, 2]);
  for (const failureIndex of [0, 3]) {
    const failed = await visuallyCompleteStream(metadata, (_, index) => {
      if (index === failureIndex) throw new Error("invalid PNG");
      return frames[index];
    }, { finalQuality: quality });
    assert.equal(failed.reason, "frame-decode-failed"); assert.equal(failed.frameIndex, failureIndex);
  }
});

test("run aggregation reports medians and ranges with explicit missing counts", () => {
  const result = aggregate([{ timeMs: 10, heap: { bytes: 200 }, status: "ok" }, { timeMs: 30, heap: { bytes: 100 } }, { timeMs: null }]);
  assert.deepEqual(result.timeMs, { count: 2, missing: 1, median: 20, min: 10, max: 30, range: [10, 30] });
  assert.deepEqual(result.heap.bytes, { count: 2, missing: 1, median: 150, min: 100, max: 200, range: [100, 200] });
  assert.equal(Object.hasOwn(result, "status"), false);
});

const batteryText = (current, { charging = "No", external = "No", voltage = "12000" } = {}) => `"Voltage" = ${voltage}\n"Amperage" = ${current}\n"IsCharging" = ${charging}\n"ExternalConnected" = ${external}\n`;

test("battery parser decodes unsigned u64 discharge exactly before converting to watts", () => {
  const unsigned = ((1n << 64n) - 1234n).toString();
  const result = parseBattery(batteryText(unsigned));
  assert.equal(result.valid, true); assert.equal(result.currentMa, -1234); close(result.watts, 14.808);
  assert.equal(parseBattery(batteryText("-1234")).currentMa, -1234);
  assert.equal(parseBattery(batteryText(((1n << 64n) - 1n).toString())).currentMa, -1);
  assert.equal(parseBattery(batteryText((1n << 64n).toString())).valid, false);
});

test("battery parser rejects charging, plugged-in, zero-current, unknown or absent data", () => {
  for (const text of [batteryText("1234"), batteryText("0"), batteryText("-1234", { charging: "Yes" }), batteryText("-1234", { external: "Yes" }), batteryText("-1234", { voltage: "0" }), batteryText("bad"), "", '"Voltage" = 12000\n"Amperage" = -1234']) {
    const result = parseBattery(text); assert.equal(result.valid, false); assert.equal(result.watts, null);
  }
});

test("custom Low Power Mode parsing uses only the active power source's section", () => {
  const text = "Battery Power:\n lidwake 1\n lowpowermode 1\nAC Power:\n lowpowermode 0\nUPS Power:\n lowpowermode 0\n";
  assert.deepEqual(parsePmsetCustom(text, "Battery Power"), { lowPowerMode: true });
  assert.deepEqual(parsePmsetCustom(text, "AC Power"), { lowPowerMode: false });
  assert.deepEqual(parsePmsetCustom(text, "UPS Power"), { lowPowerMode: false });
  assert.equal(parsePmsetCustom(text, null), null);
  assert.equal(parsePmsetCustom("AC Power:\n lowpowermode 1\n", "Battery Power"), null);
  assert.equal(parsePmsetCustom("Battery Power:\n lowpowermode 9\n", "Battery Power"), null);
  assert.equal(parsePmsetCustom("Battery Power:\n lowpowermode 1\n lowpowermode 0\n", "Battery Power"), null);
  const onAc = { source: "AC Power", lowPowerMode: null };
  assert.deepEqual(withSourcePowerMode(onAc, text), { source: "AC Power", lowPowerMode: false });
  assert.deepEqual(withSourcePowerMode({ source: "Battery Power", lowPowerMode: null }, text), { source: "Battery Power", lowPowerMode: true });
  assert.deepEqual(withSourcePowerMode({ source: "AC Power", lowPowerMode: true }, text), { source: "AC Power", lowPowerMode: true });
  assert.equal(withSourcePowerMode(null, text), null);
  // A configured battery mode cannot qualify a plugged-in machine's sample.
  const plugged = parseBattery(batteryText("-1234", { external: "Yes" }));
  assert.equal(plugged.valid, false);
  assert.equal(summarizePower([{ timestampMs: 0, ...plugged, power: withSourcePowerMode(onAc, text) }, { timestampMs: 1000, ...plugged, power: withSourcePowerMode(onAc, text) }]).status, "failed");
});

const powerSample = (timestampMs, watts, extra = {}) => ({ timestampMs, watts, valid: true, discharging: true, externalConnected: false, isCharging: false, ...extra });

test("power averages are weighted by elapsed time and baseline subtraction preserves negative differences", () => {
  const result = summarizePower([powerSample(0, 10), powerSample(1000, 20), powerSample(4000, 30)], { idleWatts: 25 });
  assert.equal(result.status, "ok"); assert.equal(result.coveredMs, 4000); assert.equal(result.coverage, 1);
  close(result.energyJoules, 90); close(result.wholeMachineWatts, 22.5);
  close(result.wattsOverIdle, -2.5); close(result.netEnergyJoules, -10);
});

test("power rejects invalid or charging readings without bridging their missing intervals", () => {
  const result = summarizePower([powerSample(0, 10), powerSample(1000, 10), powerSample(2000, 100, { valid: false }), powerSample(3000, 30), powerSample(4000, 30)], { idleWatts: 5 });
  assert.equal(result.coveredMs, 2000); assert.equal(result.coverage, 0.5); assert.equal(result.rejectedSamples, 1);
  close(result.wholeMachineWatts, 20);
  for (const invalid of [{ isCharging: true }, { externalConnected: true }, { power: { source: "AC Power" } }, { watts: NaN }, { discharging: false }]) {
    assert.equal(summarizePower([powerSample(0, 10), powerSample(1000, 10, invalid)]).status, "failed");
  }
  assert.equal(summarizePower([powerSample(0, 10), powerSample(6000, 10)]).status, "failed");
  assert.equal(summarizePower([powerSample(1000, 10), powerSample(0, 10)]).reason, "invalid-sample-timestamps");
  assert.equal(summarizePower([]).status, "failed");
  assert.equal(summarizePower([powerSample(0, 10)]).wholeMachineWatts, null);
  assert.equal(summarizePower([powerSample(0, 10), powerSample(1000, 10)]).wattsOverIdle, null);
});
