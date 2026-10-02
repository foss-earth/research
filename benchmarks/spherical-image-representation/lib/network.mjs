/**
 * A deterministic model of fetching a scheme's units over one connection, so
 * results do not depend on the network the benchmark machine happens to have.
 *
 * What is modelled:
 *
 * - One connection that is already open: the page was served from the same
 *   static host, so no DNS, TCP or TLS handshake is charged to the panorama.
 * - A link of fixed rate. With `sharing: "equal"` the responses being received
 *   share it equally, a fluid model of HTTP/2 streams of equal weight, which
 *   is what a server that ignores priorities does. With `sharing: "ordered"`
 *   the earliest request still unfinished gets the whole link, as a server
 *   that honours the client's priorities could do.
 * - A request's first byte arrives one round trip after it is sent.
 * - Each response carries `overheadBytes` of headers and framing.
 * - At most `concurrency` requests are outstanding. The client chooses them
 *   from a priority list it recomputes as the camera moves. Nothing is
 *   requested beside unit 0, the coarse sphere, until it has arrived: the
 *   first picture is not made to share the link.
 * - Cancelling a request frees its slot at once; the bytes already received
 *   are counted as wasted. Bytes in flight when the cancel is sent are not
 *   modelled, which flatters cancellation slightly.
 *
 * What is not: TCP slow start and congestion control, loss, a variable link,
 * server think time, HTTP caching, head-of-line blocking on HTTP/1.1, and the
 * time to decode a unit after it arrives (run-cpu.mjs measures that apart).
 * HTTP/3 would differ mainly under loss, which this model does not have.
 */

/** Experimental profiles, not claims about anyone's network. */
export const PROFILES = [
  { id: "fast", megabitsPerSecond: 50, roundTripMs: 20 },
  { id: "moderate-mobile", megabitsPerSecond: 10, roundTripMs: 50 },
  { id: "constrained-mobile", megabitsPerSecond: 2, roundTripMs: 100 },
  { id: "very-constrained", megabitsPerSecond: 0.75, roundTripMs: 150 },
];

/**
 * Runs one delivery. `wanted(stepIndex, arrived)` returns `{ list, keep }` for
 * a scheduling step: `list` is the units in priority order, `keep` is a set of
 * units whose requests must not be cancelled (null keeps everything).
 * `onStep(time, arrived)` is called every `stepSeconds` of simulated time,
 * after the scheduler, so the caller can measure the picture.
 *
 * Returns totals: bytes received, requests sent, requests cancelled, bytes of
 * cancelled requests, and each unit's arrival time (NaN if it never arrived).
 */
export function simulateDelivery({ scheme, profile, duration, wanted, onStep, concurrency = 6, overheadBytes = 300, sharing = "equal", tickSeconds = 0.01, stepSeconds = 0.05 }) {
  const units = scheme.units;
  const arrived = new Uint8Array(units.length), requested = new Uint8Array(units.length);
  const arrival = new Float64Array(units.length).fill(NaN), received = new Float64Array(units.length);
  const bytesPerTick = profile.megabitsPerSecond * 1e6 / 8 * tickSeconds, roundTrip = profile.roundTripMs / 1000;
  let streams = [];
  const totals = { requests: 0, cancelled: 0, cancelledBytes: 0, bytes: 0 };
  const ticksPerStep = Math.round(stepSeconds / tickSeconds), ticks = Math.round(duration / tickSeconds);

  function schedule(stepIndex) {
    const { list, keep } = wanted(stepIndex, arrived);
    // Units worth a slot now: not yet asked for, and, in a residual scheme, with their parent at least asked for.
    const ready = [];
    for (const unit of list) {
      if (requested[unit]) continue;
      if (unit !== 0 && !arrived[0]) break;
      if (scheme.residual && units[unit].parent >= 0 && !requested[units[unit].parent]) continue;
      ready.push(unit);
      if (ready.length >= concurrency) break;
    }
    if (keep && ready.length > concurrency - streams.length) {
      // Give up requests the view no longer needs, but only for something it does need.
      const needed = ready.filter(unit => keep.has(unit)).length;
      let free = concurrency - streams.length;
      streams = streams.filter(stream => {
        if (free >= needed || keep.has(stream.unit) || stream.unit === 0) return true;
        totals.cancelled++; totals.cancelledBytes += stream.got;
        requested[stream.unit] = 0; free++;
        return false;
      });
    }
    for (const unit of ready) {
      if (streams.length >= concurrency) break;
      // A cancelled unit may be asked for again; what it had received is not resumed.
      requested[unit] = 1; totals.requests++;
      streams.push({ unit, remaining: units[unit].bytes + overheadBytes, got: 0, startsAt: null });
    }
  }

  for (let tick = 0; tick <= ticks; tick++) {
    const time = tick * tickSeconds;
    if (tick % ticksPerStep === 0) {
      schedule(tick / ticksPerStep);
      for (const stream of streams) if (stream.startsAt === null) stream.startsAt = time + roundTrip;
      onStep?.(time, arrived);
    }
    // Share this tick's bytes among the responses that have started.
    let capacity = bytesPerTick;
    let active = streams.filter(stream => stream.startsAt !== null && stream.startsAt <= time);
    while (active.length && capacity > 0 && sharing === "ordered") {
      // The earliest request takes what it needs; the next gets what is left of the tick.
      const stream = active[0], taken = Math.min(capacity, stream.remaining);
      capacity -= taken; stream.remaining -= taken; stream.got += taken; received[stream.unit] += taken; totals.bytes += taken;
      if (stream.remaining > 0) break;
      arrived[stream.unit] = 1; arrival[stream.unit] = time + tickSeconds;
      active = active.slice(1);
    }
    while (active.length && capacity > 0 && sharing === "equal") {
      const share = capacity / active.length;
      const finishing = active.filter(stream => stream.remaining <= share);
      if (!finishing.length) {
        for (const stream of active) { stream.remaining -= share; stream.got += share; received[stream.unit] += share; totals.bytes += share; }
        capacity = 0;
      } else {
        for (const stream of finishing) {
          capacity -= stream.remaining; stream.got += stream.remaining; received[stream.unit] += stream.remaining; totals.bytes += stream.remaining;
          stream.remaining = 0; arrived[stream.unit] = 1; arrival[stream.unit] = time + tickSeconds;
        }
        active = active.filter(stream => stream.remaining > 0);
      }
    }
    if (streams.some(stream => stream.remaining === 0)) {
      streams = streams.filter(stream => stream.remaining > 0);
      // A slot is free: fill it without waiting for the next step.
      schedule(Math.floor(tick / ticksPerStep));
      for (const stream of streams) if (stream.startsAt === null) stream.startsAt = time + tickSeconds + roundTrip;
    }
  }
  return { ...totals, arrival, received, arrived };
}
