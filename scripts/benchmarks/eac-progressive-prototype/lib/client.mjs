/**
 * The client: one panorama's bootstrap, view-aware scheduler, bounded caches
 * and display table. It is the same code in the simulator (Node) and in the
 * page (every backend), so a policy compared across them is one policy.
 *
 * It knows tiles only as ids of a tiling (lib/tiling.mjs) and touches no
 * pixels. Its surroundings are three things it is handed:
 *
 * - `transport.start({ url, bytes, done })` → `{ abort() }`. `done({ ok,
 *   received, payload })` is called once; `abort()` returns the bytes that had
 *   arrived, which are counted as spent.
 * - `stages.decode(job, done)` turns a payload into texels (for a residual
 *   tile, with its parent's texels), and `stages.upload(slot, tile, texels)`,
 *   `stages.uploadBootstrap(texels)`, `stages.setTable(table)` put them on
 *   screen. Decoding is asynchronous; the rest happens inside `tick`.
 * - `tick(now, camera, viewport)` once a frame (or once a simulator step).
 *
 * **Tile states.** absent → loading → fetched → decoding → decoded → resident.
 * A resident tile owns a slot of the GPU atlas. In residual mode a tile's
 * texels also stay on the CPU while a child may need them as its prediction.
 *
 * **What is asked for, in order** (the reason is logged with every request):
 *
 * 1. the bootstrap, alone, until it is on screen (`bootstrapAlone`);
 * 2. `view`: tiles the view needs. `refinement: "direct"` asks only for the
 *    level the view needs, largest share of the view first. `"levels"` asks
 *    for every level from 0 up, coarsest first: a tile is not a download
 *    dependency of its children, it is just shown sooner. Residual payloads
 *    always go level by level, since a child needs its parent;
 * 3. `margin`: the same for tiles only the margin around the view touches;
 * 4. `insurance` (policy B): once the view has everything it asked for, the
 *    rest of the sphere up to `insurance.maxLevel`, nearest the view first, on
 *    at most `insurance.slots` requests at once. Its bytes are counted apart.
 *
 * **Bounds.** At most `requests` in flight and `inflightBytes` expected (from
 * the manifest's sizes); no new request while `pendingTiles` are fetched and
 * not yet on screen, so a fast link cannot pile up decode work; `decodes` at
 * once; `uploadsPerFrame` per tick; `gpuSlots` resident; `decodedBytes` of
 * texels kept on the CPU.
 *
 * **Queued and in-flight work.** There is no queue to go stale: the list is
 * rebuilt from the camera every tick, so a request that has not started is
 * simply not on the next list. A request in flight for a tile nothing wants
 * any more is aborted only when something the view needs is waiting for its
 * slot (`cancel`); otherwise it finishes and its tile is kept.
 *
 * **Eviction.** A new tile takes a free slot, or the slot of the resident tile
 * with the lowest standing: shown under the view (3), wanted by the view (2),
 * in the margin (1), anything else (0), oldest use first. A tile that would
 * outrank nothing is dropped, not swapped in. The bootstrap is not in a slot
 * and is never evicted, so every direction always has something to show.
 */
export const DEFAULT_LIMITS = { requests: 6, inflightBytes: 4 << 20, pendingTiles: 12, decodes: 2, uploadsPerFrame: 2, gpuSlots: 196, decodedBytes: 32 << 20, retries: 3, retryBackoffMs: 250 };
export const DEFAULT_POLICY = { refinement: "direct", payload: "replacement", bootstrapAlone: true, cancel: true, insurance: { enabled: false, maxLevel: 0, slots: 2 } };

const ABSENT = 0, LOADING = 1, FETCHED = 2, DECODING = 3, DECODED = 4, RESIDENT = 5;
export const STATE_NAMES = ["absent", "loading", "fetched", "decoding", "decoded", "resident"];

export function createClient({ tiling, manifest, tileBytes = null, bootstrapSize, selector, policy: policyOverrides = {}, limits: limitOverrides = {}, transport, stages, baseUrl = "", log = false }) {
  const policy = { ...DEFAULT_POLICY, ...policyOverrides, insurance: { ...DEFAULT_POLICY.insurance, ...policyOverrides.insurance } };
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const residual = policy.payload === "residual", stepwise = residual || policy.refinement === "levels";
  const count = tiling.count, C = tiling.cells, cellCount = tiling.roots * C * C, texelBytes = tiling.stored * tiling.stored * 4;
  const bootstrap = manifest.bootstrap.find(item => item.faceSize === bootstrapSize) ?? (() => { throw new Error(`no bootstrap of ${bootstrapSize}; the manifest has ${manifest.bootstrap.map(item => item.faceSize).join(", ")}`); })();
  // What a tile is expected to weigh before it arrives: its own size if the client loaded tiles.json, else its level's mean.
  const expectedBytes = tile => {
    if (tileBytes) return (residual && tiling.level(tile) > 0 ? tileBytes.residual : tileBytes.replacement)[tile];
    const level = manifest.levels[tiling.level(tile)];
    return (residual && level.level > 0 ? level.residualBytes : level.replacementBytes) / level.tiles;
  };

  const state = new Uint8Array(count), slotOf = new Int16Array(count).fill(-1), lastUsed = new Float64Array(count), attempts = new Uint8Array(count), retryAt = new Float64Array(count);
  const everShown = new Uint8Array(count), fetchedBytes = new Float64Array(count), downloads = new Uint16Array(count), insuranceFetched = new Uint8Array(count);
  const slotTile = new Int32Array(limits.gpuSlots).fill(-1), freeSlots = Array.from({ length: limits.gpuSlots }, (_, k) => limits.gpuSlots - 1 - k);
  const inflight = new Map(), payloads = new Map(), texels = new Map(), kept = new Map();
  const table = new Int32Array(cellCount).fill(-1);
  let disposed = false, tableDirty = true, selection = null, selectionKey = null, now = 0;
  let boot = { state: ABSENT, handle: null, attempts: 0, retryAt: 0, displayedAt: null, requestedAt: null, payload: null };
  let decoding = 0, keptBytes = 0;
  const events = [];
  const counters = {
    requests: 0, responses: 0, bytesReceived: 0, cancelled: 0, cancelledBytes: 0, failures: 0, retries: 0, staleResponses: 0,
    insuranceRequests: 0, insuranceBytes: 0, decodes: 0, uploads: 0, uploadedBytes: 0, evictions: 0, dropped: 0, redownloads: 0, rematerialized: 0,
    gpuHits: 0, gpuMisses: 0, tableUpdates: 0, levelCapped: 0,
    peak: { inflightRequests: 0, inflightBytes: 0, compressedBytes: 0, decodedBytes: 0, pendingTiles: 0, residentTiles: 0 },
  };
  const note = (type, tile, a, b) => { if (log) events.push([Math.round(now * 10) / 10, type, tile, a ?? null, b ?? null]); };
  const pendingTiles = () => payloads.size + texels.size + decoding;
  const inflightBytes = () => { let sum = 0; for (const request of inflight.values()) sum += request.expected; return sum; };
  const standing = tile => {
    if (!selection) return 0;
    if (slotOf[tile] >= 0 && shownInView.has(tile)) return 3;
    if (wanted.has(tile)) return 2;
    return near.has(tile) ? 1 : 0;
  };
  let wanted = new Set(), near = new Set(), shownInView = new Set();

  function peaks() {
    const peak = counters.peak;
    peak.inflightRequests = Math.max(peak.inflightRequests, inflight.size + (boot.state === LOADING ? 1 : 0));
    peak.inflightBytes = Math.max(peak.inflightBytes, inflightBytes());
    let compressed = 0;
    for (const item of payloads.values()) compressed += item.received;
    peak.compressedBytes = Math.max(peak.compressedBytes, compressed);
    peak.decodedBytes = Math.max(peak.decodedBytes, texels.size * texelBytes + keptBytes);
    peak.pendingTiles = Math.max(peak.pendingTiles, pendingTiles());
    peak.residentTiles = Math.max(peak.residentTiles, limits.gpuSlots - freeSlots.length);
  }

  // ─── The bootstrap ───────────────────────────────────────────────────

  function requestBootstrap() {
    boot.state = LOADING; boot.requestedAt ??= now;
    counters.requests++; note("request", -1, "bootstrap", bootstrap.bytes);
    boot.handle = transport.start({ url: baseUrl + bootstrap.url, bytes: bootstrap.bytes, done(result) {
      if (disposed) { counters.staleResponses++; return; }
      counters.bytesReceived += result.received;
      if (!result.ok) {
        // Nothing can be shown without it, so it is tried again for as long as the panorama is open.
        counters.failures++; boot.state = ABSENT; boot.attempts++; boot.retryAt = now + limits.retryBackoffMs * 2 ** Math.min(6, boot.attempts);
        note("fail", -1, "bootstrap");
        return;
      }
      counters.responses++; boot.state = DECODING; note("response", -1, result.received);
      stages.decode({ tile: -1, kind: "bootstrap", payload: result.payload, bootstrap }, pixels => {
        if (disposed) return;
        stages.uploadBootstrap(pixels, bootstrap);
        boot.state = RESIDENT; boot.displayedAt = now; note("bootstrap-shown", -1);
      });
    } });
  }

  // ─── What to ask for ─────────────────────────────────────────────────

  /** Whether a tile's texels are in hand as a prediction, or on their way. */
  const texelsComing = tile => kept.has(tile) || texels.has(tile) || inflight.has(tile) || payloads.has(tile) || state[tile] === DECODING;

  function candidates() {
    const list = [], seen = new Set();
    const add = (tile, group, weight, why) => {
      if (seen.has(tile)) return;
      seen.add(tile);
      if (now < retryAt[tile]) return;
      list.push({ tile, group, level: tiling.level(tile), weight, why });
    };
    const chain = (tile, group, weight) => {
      if (!stepwise) { if (state[tile] === ABSENT) add(tile, group, weight, `${group}: level ${tiling.level(tile)} the view needs, ${weight} rays`); return; }
      const own = tiling.level(tile);
      if (!residual) {
        for (let level = 0; level <= own; level++) {
          const step = tiling.ancestor(tile, level);
          if (state[step] === ABSENT && !(level < own && coveredAbove(step))) add(step, group, weight, `${group}: level ${level} on the way to level ${own}, ${weight} rays`);
        }
        return;
      }
      if (state[tile] !== ABSENT) return;
      // A residual tile needs its parent's texels. From the tile upward, the first ancestor that has them, or
      // will, ends the chain; resident is not enough, since a resident tile's texels may have been let go.
      let from = 0;
      for (let level = own - 1; level >= 0; level--) if (texelsComing(tiling.ancestor(tile, level))) { from = level + 1; break; }
      for (let level = from; level <= own; level++) {
        const step = tiling.ancestor(tile, level);
        add(step, group, weight, `${group}: level ${level} of the chain to level ${own}${state[step] === RESIDENT ? ", texels needed again as a prediction" : ""}, ${weight} rays`);
      }
    };
    for (const [tile, weight] of selection.visible) chain(tile, "view", weight);
    for (const [tile, weight] of selection.margin) chain(tile, "margin", weight);
    const order = { view: 0, margin: 1, insurance: 2 };
    if (policy.insurance.enabled && viewComplete()) {
      const centre = selection.centre, at = [0, 0, 0];
      for (let level = 0; level <= Math.min(policy.insurance.maxLevel, tiling.maxLevel); level++) {
        for (let tile = tiling.firstOfLevel(level); tile < tiling.firstOfLevel(level + 1); tile++) {
          if (state[tile] !== ABSENT || seen.has(tile) || (!residual && coveredAbove(tile))) continue;
          tiling.centre(tile, at);
          const away = Math.acos(Math.max(-1, Math.min(1, at[0] * centre[0] + at[1] * centre[1] + at[2] * centre[2])));
          add(tile, "insurance", -away, `insurance: level ${level}, ${(away * 180 / Math.PI).toFixed(0)}° from the view`);
        }
      }
    }
    // Stepwise work goes coarse to fine; within a level, and for direct work, the largest share of the view first.
    list.sort((p, q) => order[p.group] - order[q.group] || (stepwise || p.group === "insurance" ? p.level - q.level : 0) || q.weight - p.weight || p.tile - q.tile);
    return list;
  }
  /** Whether every cell under a tile already shows something finer than it: fetching it would improve nothing. */
  function coveredAbove(tile) {
    const { face, level, x, y } = tiling.address(tile), span = C >> level;
    for (let cy = y * span; cy < (y + 1) * span; cy++) for (let cx = x * span; cx < (x + 1) * span; cx++) {
      const shown = table[(face * C + cy) * C + cx];
      if (shown < 0 || tiling.level(shown) <= level) return false;
    }
    return true;
  }
  function viewComplete() {
    for (const tile of selection.visible.keys()) if (state[tile] !== RESIDENT) return false;
    return true;
  }

  function startRequest(candidate) {
    const tile = candidate.tile, again = downloads[tile] > 0;
    const kind = residual && tiling.level(tile) > 0 ? "r" : "t", expected = expectedBytes(tile);
    state[tile] = state[tile] === RESIDENT ? RESIDENT : LOADING;
    counters.requests++; downloads[tile]++;
    if (again) counters.redownloads++;
    if (candidate.group === "insurance") { counters.insuranceRequests++; insuranceFetched[tile] = 1; }
    note("request", tile, candidate.why, Math.round(expected));
    const request = { tile, group: candidate.group, expected, kind, handle: null };
    inflight.set(tile, request);
    request.handle = transport.start({ url: baseUrl + tiling.path(tile, kind), bytes: expected, done(result) {
      if (disposed) { counters.staleResponses++; return; }
      inflight.delete(tile);
      counters.bytesReceived += result.received; fetchedBytes[tile] += result.received;
      if (request.group === "insurance") counters.insuranceBytes += result.received;
      if (!result.ok) {
        counters.failures++; attempts[tile]++;
        if (state[tile] === LOADING) state[tile] = ABSENT;
        // After the last retry the tile is left alone for a while; what is already on screen stays there.
        retryAt[tile] = now + limits.retryBackoffMs * 2 ** Math.min(8, attempts[tile] > limits.retries ? 8 : attempts[tile]);
        if (attempts[tile] <= limits.retries) counters.retries++;
        note("fail", tile, attempts[tile]);
        return;
      }
      counters.responses++; attempts[tile] = 0; note("response", tile, result.received);
      payloads.set(tile, { payload: result.payload, received: result.received, kind, rematerialize: state[tile] === RESIDENT });
      if (state[tile] === LOADING) state[tile] = FETCHED;
    } });
  }

  function schedule() {
    if (boot.state === ABSENT && now >= boot.retryAt) requestBootstrap();
    if (policy.bootstrapAlone && boot.state !== RESIDENT) return;
    const list = candidates();
    let insuranceInFlight = 0;
    for (const request of inflight.values()) if (request.group === "insurance") insuranceInFlight++;
    for (const candidate of list) {
      if (pendingTiles() >= limits.pendingTiles) break;
      const tile = candidate.tile;
      if (inflight.has(tile)) continue;
      // A residual child is asked for once its parent is at least on its way, as in Phase 1's model.
      if (residual && tiling.level(tile) > 0 && !texelsComing(tiling.parent(tile))) continue;
      if (candidate.group === "insurance" && insuranceInFlight >= policy.insurance.slots) continue;
      if (inflight.size >= limits.requests || inflightBytes() + expectedBytes(tile) > limits.inflightBytes && inflight.size > 0) {
        // Full. Something the view needs may take the slot of a request nothing wants any more.
        if (!policy.cancel || candidate.group !== "view") break;
        let victim = null;
        for (const request of inflight.values()) if (!wanted.has(request.tile) && !near.has(request.tile) && request.group !== "view") { victim = request; break; }
        if (!victim) for (const request of inflight.values()) if (!wanted.has(request.tile) && !near.has(request.tile)) { victim = request; break; }
        if (!victim) break;
        const received = victim.handle.abort();
        inflight.delete(victim.tile);
        if (state[victim.tile] === LOADING) state[victim.tile] = ABSENT;
        counters.cancelled++; counters.cancelledBytes += received; counters.bytesReceived += received; fetchedBytes[victim.tile] += received;
        if (victim.group === "insurance") { counters.insuranceBytes += received; insuranceInFlight--; }
        note("cancel", victim.tile, received);
        if (inflight.size >= limits.requests) break;
      }
      startRequest(candidate);
      if (candidate.group === "insurance") insuranceInFlight++;
    }
  }

  // ─── Decoding and uploading ──────────────────────────────────────────

  function decodeReady() {
    if (decoding >= limits.decodes || !payloads.size) return;
    // What the view wants first, then arrival order.
    const order = [...payloads.keys()].sort((p, q) => standingOf(q) - standingOf(p));
    for (const tile of order) {
      if (decoding >= limits.decodes) break;
      const item = payloads.get(tile);
      let parentTexels = null;
      if (item.kind === "r") {
        const parent = tiling.parent(tile);
        const holder = kept.get(parent) ?? texels.get(parent);
        if (!holder) continue; // its parent is still on the way
        parentTexels = holder.pixels;
        if (kept.has(parent)) kept.get(parent).used = now;
      }
      payloads.delete(tile);
      if (!item.rematerialize) state[tile] = DECODING;
      decoding++; counters.decodes++; note("decode", tile);
      const { x, y } = tiling.address(tile);
      stages.decode({ tile, kind: item.kind, payload: item.payload, parent: parentTexels, quadrantX: x & 1, quadrantY: y & 1 }, pixels => {
        if (disposed) return;
        decoding--;
        if (item.rematerialize) { counters.rematerialized++; keep(tile, pixels); note("rematerialized", tile); return; }
        state[tile] = DECODED; texels.set(tile, { pixels }); note("decoded", tile);
      });
    }
  }
  const standingOf = tile => (wanted.has(tile) ? 2 : near.has(tile) ? 1 : 0);

  /** Texels kept on the CPU as predictions, oldest use dropped first when over budget. A tile with a child on its way is never dropped. */
  function keep(tile, pixels) {
    if (!residual || tiling.level(tile) === tiling.maxLevel) return;
    if (!kept.has(tile)) keptBytes += texelBytes;
    kept.set(tile, { pixels, used: now });
    while (keptBytes > limits.decodedBytes) {
      let victim = -1, oldest = Infinity;
      for (const [candidate, entry] of kept) {
        if (entry.used >= oldest) continue;
        if (tiling.children(candidate).some(child => inflight.has(child) || payloads.has(child))) continue;
        victim = candidate; oldest = entry.used;
      }
      if (victim < 0) break;
      kept.delete(victim); keptBytes -= texelBytes; note("texels-dropped", victim);
    }
  }

  function uploadReady() {
    if (!texels.size) return;
    let budget = limits.uploadsPerFrame;
    const order = [...texels.keys()].sort((p, q) => standingOf(q) - standingOf(p) || tiling.level(p) - tiling.level(q));
    for (const tile of order) {
      if (budget <= 0) break;
      const { pixels } = texels.get(tile);
      let slot = freeSlots.pop();
      if (slot === undefined) {
        // Full: the resident tile of lowest standing gives up its slot, if the new tile outranks it.
        let victim = -1, lowest = Infinity, oldest = Infinity;
        for (let s = 0; s < slotTile.length; s++) {
          const held = slotTile[s], rank = standing(held);
          if (rank < lowest || (rank === lowest && lastUsed[held] < oldest)) { victim = held; lowest = rank; oldest = lastUsed[held]; }
        }
        const rank = standingOf(tile);
        // Swapping one tile the view wants for another would only churn, so equal standing gives way only below that.
        if (lowest > rank || (lowest === rank && lowest >= 2)) {
          texels.delete(tile); state[tile] = ABSENT; counters.dropped++; retryAt[tile] = now + 1000; note("dropped", tile);
          continue;
        }
        slot = slotOf[victim]; slotOf[victim] = -1; state[victim] = ABSENT; counters.evictions++; note("evict", victim, slot);
      }
      slotOf[tile] = slot; slotTile[slot] = tile; state[tile] = RESIDENT; lastUsed[tile] = now;
      stages.upload(slot, tile, pixels);
      counters.uploads++; counters.uploadedBytes += texelBytes; budget--; tableDirty = true; note("upload", tile, slot);
      texels.delete(tile);
      keep(tile, pixels);
    }
  }

  /** Every cell shows its finest resident ancestor, no finer than the cell needs, or the bootstrap (−1). */
  function rebuildTable() {
    shownInView = new Set();
    let changed = false;
    for (let cell = 0; cell < cellCount; cell++) {
      const face = Math.floor(cell / (C * C)), cx = cell % C, cy = Math.floor(cell / C) % C;
      const cap = selection && selection.cells[cell] >= 0 ? selection.cells[cell] : tiling.maxLevel;
      let shown = -1;
      for (let level = cap; level >= 0; level--) {
        const shift = tiling.maxLevel - level, tile = tiling.id(face, level, cx >> shift, cy >> shift);
        if (state[tile] === RESIDENT) { shown = tile; break; }
      }
      if (shown >= 0 && selection?.inView[cell]) { shownInView.add(shown); everShown[shown] = 1; lastUsed[shown] = now; }
      if (table[cell] !== shown) { table[cell] = shown; changed = true; }
    }
    tableDirty = false;
    if (changed) { stages.setTable(table, slotOf); counters.tableUpdates++; }
  }

  return {
    tiling, policy, limits, table, counters, events, bootstrap,
    /** One step: look, ask, decode, upload, show. */
    tick(time, camera, viewport) {
      if (disposed) return;
      now = time;
      // Leave room for the margin and for work in flight: the view may use at most three quarters of the slots.
      const next = selector.selectWithin(camera, viewport, Math.floor(limits.gpuSlots * 0.75));
      if (next.key !== selectionKey) {
        selection = next; selectionKey = next.key; tableDirty = true;
        wanted = new Set(); near = new Set();
        for (const tile of next.visible.keys()) for (let t = tile; t >= 0; t = stepwise ? tiling.parent(t) : -1) wanted.add(t);
        for (const tile of next.margin.keys()) for (let t = tile; t >= 0; t = stepwise ? tiling.parent(t) : -1) near.add(t);
        if (next.levelCap < selector.finest) counters.levelCapped++;
        for (const tile of next.visible.keys()) { if (state[tile] === RESIDENT) counters.gpuHits++; else counters.gpuMisses++; }
      }
      uploadReady();
      if (tableDirty) rebuildTable();
      decodeReady();
      schedule();
      peaks();
    },
    /** Leaving the panorama: every request is aborted, and anything that still arrives is ignored. */
    dispose() {
      disposed = true;
      for (const request of inflight.values()) { counters.cancelled++; const received = request.handle.abort(); counters.cancelledBytes += received; counters.bytesReceived += received; }
      inflight.clear(); boot.handle?.abort?.();
    },
    get disposed() { return disposed; },
    get bootstrapDisplayedAt() { return boot.displayedAt; },
    get selection() { return selection; },
    stateOf: tile => state[tile],
    slotOf: tile => slotOf[tile],
    /** Whether the view shows every tile it asked for. */
    viewComplete: () => Boolean(selection) && boot.state === RESIDENT && viewComplete(),
    /** The level each cell under the view would show with everything arrived, as a display table. */
    completeTable() {
      const complete = new Int32Array(cellCount).fill(-1);
      for (let cell = 0; cell < cellCount; cell++) {
        if (!selection || selection.cells[cell] < 0) continue;
        const face = Math.floor(cell / (C * C)), shift = tiling.maxLevel - selection.cells[cell];
        complete[cell] = tiling.id(face, selection.cells[cell], (cell % C) >> shift, (Math.floor(cell / C) % C) >> shift);
      }
      return complete;
    },
    /** What is held right now, for the resource plots and the overlay. */
    resources() {
      let compressed = 0;
      for (const item of payloads.values()) compressed += item.received;
      return {
        inflightRequests: inflight.size + (boot.state === LOADING ? 1 : 0), inflightBytes: inflightBytes(), compressedBytes: compressed,
        decodedBytes: texels.size * texelBytes + keptBytes, pendingTiles: pendingTiles(), residentTiles: limits.gpuSlots - freeSlots.length,
        gpuBytesInUseEstimate: (limits.gpuSlots - freeSlots.length) * texelBytes,
      };
    },
    /** Bytes received for tiles that were never shown under the view. */
    bytesNeverShown() {
      let sum = 0;
      for (let tile = 0; tile < count; tile++) if (!everShown[tile]) sum += fetchedBytes[tile];
      return sum;
    },
    inflightTiles: () => [...inflight.keys()],
  };
}
