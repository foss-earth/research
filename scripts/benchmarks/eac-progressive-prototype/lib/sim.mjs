/**
 * The deterministic network: Phase 1's model (lib/network.mjs there), as a
 * transport the real client can run on, so the simulator and the page run one
 * scheduler.
 *
 * Modelled, as in Phase 1: one open connection; a link of fixed rate that the
 * responses being received share equally (`sharing: "equal"`) or that goes to
 * the earliest request first (`"ordered"`); a request's first byte one round
 * trip after it is sent; `overheadBytes` of headers per response. Not
 * modelled: slow start, loss, a variable link, server think time, HTTP
 * caching, and decode and upload time (zero here; the page measures them).
 *
 * A request can be made to fail (`failEvery`: every n-th tile request gets
 * its headers and then an error) or to arrive late (`delayMs`), for the tests.
 */
export const PROFILES = [
  { id: "fast", megabitsPerSecond: 50, roundTripMs: 20 },
  { id: "moderate-mobile", megabitsPerSecond: 10, roundTripMs: 50 },
  { id: "constrained-mobile", megabitsPerSecond: 2, roundTripMs: 100 },
  { id: "very-constrained", megabitsPerSecond: 0.75, roundTripMs: 150 },
];
export const profile = id => PROFILES.find(item => item.id === id) ?? (() => { throw new Error(`unknown profile ${id}`); })();

export function createSimTransport({ megabitsPerSecond, roundTripMs }, { overheadBytes = 300, sharing = "equal", failEvery = 0, delayMs = 0 } = {}) {
  const bytesPerMs = megabitsPerSecond * 1e6 / 8 / 1000;
  let streams = [], time = 0, started = 0;
  return {
    get active() { return streams.length; },
    start({ url, bytes, done }) {
      started++;
      const fails = failEvery > 0 && !url.includes("boot-") && started % failEvery === 0;
      const stream = { remaining: fails ? overheadBytes : bytes + overheadBytes, got: 0, startsAt: time + roundTripMs + delayMs, done, fails };
      streams.push(stream);
      return { abort() { streams = streams.filter(item => item !== stream); return stream.got; } };
    },
    /** Delivers `dt` milliseconds of the link, from `from`. Completions are reported in the order they finish. */
    advance(from, dt) {
      time = from + dt;
      let capacity = bytesPerMs * dt;
      const finished = [];
      let active = streams.filter(stream => stream.startsAt <= from);
      while (active.length && capacity > 1e-9) {
        if (sharing === "ordered") {
          const stream = active[0], taken = Math.min(capacity, stream.remaining);
          capacity -= taken; stream.remaining -= taken; stream.got += taken;
          if (stream.remaining > 1e-9) break;
          finished.push(stream); active = active.slice(1);
        } else {
          const share = capacity / active.length, ending = active.filter(stream => stream.remaining <= share);
          if (!ending.length) { for (const stream of active) { stream.remaining -= share; stream.got += share; } capacity = 0; break; }
          for (const stream of ending) { capacity -= stream.remaining; stream.got += stream.remaining; stream.remaining = 0; finished.push(stream); }
          active = active.filter(stream => stream.remaining > 0);
        }
      }
      if (finished.length) streams = streams.filter(stream => !finished.includes(stream));
      for (const stream of finished) stream.done({ ok: !stream.fails, received: Math.round(stream.got), payload: null });
    },
  };
}

/** Stages for a client with no pixels: decoding takes `decodeMs` of simulated time, and uploads only count. */
export function createSimStages({ decodeMs = 0 } = {}) {
  const waiting = [];
  const stages = {
    uploads: 0, tableSets: 0, bootstrapUploads: 0,
    decode(job, done) { waiting.push({ at: stages.now + decodeMs, done }); },
    upload() { stages.uploads++; },
    uploadBootstrap() { stages.bootstrapUploads++; },
    setTable() { stages.tableSets++; },
    now: 0,
    /** Finishes every decode whose time has come. */
    flush(time) {
      stages.now = time;
      for (let k = 0; k < waiting.length;) { if (waiting[k].at <= time) waiting.splice(k, 1)[0].done(null); else k++; }
    },
  };
  return stages;
}

/**
 * Runs a client against the model for `durationMs`, the camera following
 * `cameraAt(seconds)`. `onSample(timeMs, camera)` is called every `sampleMs`,
 * after the client's step, so the caller can record what is on screen.
 */
export function simulate({ client, transport, stages, cameraAt, viewport, durationMs, tickMs = 10, sampleMs = 250, onSample }) {
  const ticks = Math.round(durationMs / tickMs), every = Math.round(sampleMs / tickMs);
  for (let tick = 0; tick <= ticks; tick++) {
    const time = tick * tickMs, camera = cameraAt(time / 1000);
    stages.flush(time);
    client.tick(time, camera, viewport);
    if (tick % every === 0) onSample?.(time, camera);
    transport.advance(time, tickMs);
  }
}
