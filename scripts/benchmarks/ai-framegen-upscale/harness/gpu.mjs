/**
 * The harness-owned WebGPU device, GPU memory accounting, error capture and a
 * timestamp-query ring (DESIGN.md section 8). Plain browser ESM; importing it
 * has no side effects: call installAccounting() before ONNX Runtime is
 * imported, then createHarnessDevice().
 *
 * Accounting wraps GPUDevice.prototype.createBuffer/createTexture/createQuerySet
 * and the matching destroy() methods. Every object is charged to the phase
 * label current at creation ("harness", "ort-session", "ort-run", "steady",
 * "readback", ...) and to the device that created it; bytes are the buffer
 * size, the texture's w x h x layers x bytesPerTexel summed over mips x samples
 * (format table below), or query count x 8. An object dropped without
 * destroy() stays counted (conservative). Canvas swap-chain textures are not
 * created through createTexture and are reported separately by the caller.
 */

/** Features ORT 1.30.0's native WebGPU EP requests for its own device in the wasm build (webgpu_context.cc:791-811). */
export const ORT_FEATURES = ["chromium-experimental-subgroup-matrix", "timestamp-query", "shader-f16", "subgroups", "subgroup-size-control"];
/** Limits ORT sets to the adapter maxima for its own device (webgpu_context.cc:814-837). */
export const ORT_LIMITS = [
  "maxBindGroups", "maxComputeWorkgroupStorageSize", "maxComputeWorkgroupsPerDimension", "maxStorageBuffersPerShaderStage",
  "maxStorageBufferBindingSize", "maxBufferSize", "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ",
];

const BYTES_PER_TEXEL = {
  r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1, stencil8: 1,
  r16uint: 2, r16sint: 2, r16float: 2, r16unorm: 2, rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2, depth16unorm: 2,
  r32uint: 4, r32sint: 4, r32float: 4, rg16uint: 4, rg16sint: 4, rg16float: 4, rgba8unorm: 4, "rgba8unorm-srgb": 4,
  rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4, bgra8unorm: 4, "bgra8unorm-srgb": 4, rgb9e5ufloat: 4, rgb10a2uint: 4,
  rgb10a2unorm: 4, rg11b10ufloat: 4, depth24plus: 4, depth32float: 4,
  // depth24plus-stencil8 / depth32float-stencil8 may be stored wider; charged at the wider size (conservative).
  "depth24plus-stencil8": 8, "depth32float-stencil8": 8,
  rg32uint: 8, rg32sint: 8, rg32float: 8, rgba16uint: 8, rgba16sint: 8, rgba16float: 8,
  rgba32uint: 16, rgba32sint: 16, rgba32float: 16,
};

function textureBytes(descriptor) {
  const size = descriptor.size;
  const [width, height = 1, layers = 1] = Array.isArray(size) ? size : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
  const known = Object.hasOwn(BYTES_PER_TEXEL, descriptor.format);
  const texel = known ? BYTES_PER_TEXEL[descriptor.format] : 16;
  const mips = descriptor.mipLevelCount ?? 1, samples = descriptor.sampleCount ?? 1, is3d = descriptor.dimension === "3d";
  let bytes = 0;
  for (let level = 0; level < mips; level++) {
    const w = Math.max(1, width >> level), h = Math.max(1, height >> level), d = is3d ? Math.max(1, layers >> level) : layers;
    bytes += w * h * d * texel;
  }
  return { bytes: bytes * samples, knownFormat: known };
}

let accounting = null;

/**
 * Installs the wrappers once and returns the accounting object:
 * `{ setPhase(label), phase, markBaseline(excluded), excludePhase(label),
 * snapshot(), deviceId(device), objectRecord(object), requested }`.
 */
export function installAccounting() {
  if (accounting) return accounting;
  const devices = new WeakMap();
  let nextDevice = 1;
  const deviceId = device => {
    if (!devices.has(device)) devices.set(device, nextDevice++);
    return devices.get(device);
  };
  const records = new WeakMap();
  const liveRecords = new Set();
  const state = {
    phase: "harness", live: 0, peak: 0, created: 0, destroyed: 0, unknownFormats: [],
    byPhase: {}, byDevice: {}, calls: {}, baseline: null, countedPeak: 0, countedLive: 0, excluded: new Set(),
  };
  const phaseEntry = label => (state.byPhase[label] ??= { objects: 0, createdBytes: 0, destroyedBytes: 0, liveBytes: 0, peakLiveBytes: 0, byKind: {} });
  const count = (name, device) => {
    const key = `${name}@${device ? deviceId(device) : 0}`;
    const entry = (state.calls[state.phase] ??= {});
    entry[key] = (entry[key] ?? 0) + 1;
  };
  const charge = (object, kind, bytes, device, extra = {}) => {
    const label = state.phase;
    const record = { kind, bytes, label, device: deviceId(device), live: true, counted: state.baseline !== null && !state.excluded.has(label), ...extra };
    records.set(object, record);
    liveRecords.add(record);
    state.created++;
    state.live += bytes;
    state.peak = Math.max(state.peak, state.live);
    const entry = phaseEntry(label);
    entry.objects++;
    entry.createdBytes += bytes;
    entry.liveBytes += bytes;
    entry.peakLiveBytes = Math.max(entry.peakLiveBytes, entry.liveBytes);
    entry.byKind[kind] = (entry.byKind[kind] ?? 0) + bytes;
    const perDevice = (state.byDevice[record.device] ??= { objects: 0, bytes: 0 });
    perDevice.objects++;
    perDevice.bytes += bytes;
    if (record.counted) {
      state.countedLive += bytes;
      state.countedPeak = Math.max(state.countedPeak, state.countedLive);
    }
  };
  const release = object => {
    const record = records.get(object);
    if (!record || !record.live) return;
    record.live = false;
    liveRecords.delete(record);
    state.destroyed++;
    state.live -= record.bytes;
    const entry = phaseEntry(record.label);
    entry.destroyedBytes += record.bytes;
    entry.liveBytes -= record.bytes;
    if (record.counted) state.countedLive -= record.bytes;
  };
  const wrap = (prototype, name, after) => {
    const original = prototype[name];
    prototype[name] = function wrapped(...args) {
      const result = original.apply(this, args);
      after.call(this, result, ...args);
      return result;
    };
  };
  wrap(GPUDevice.prototype, "createBuffer", function (buffer, descriptor) { count("createBuffer", this); charge(buffer, "buffer", Number(descriptor.size), this, { usage: descriptor.usage }); });
  wrap(GPUDevice.prototype, "createTexture", function (texture, descriptor) {
    count("createTexture", this);
    const { bytes, knownFormat } = textureBytes(descriptor);
    if (!knownFormat) state.unknownFormats.push(descriptor.format);
    charge(texture, "texture", bytes, this, { format: descriptor.format });
  });
  wrap(GPUDevice.prototype, "createQuerySet", function (querySet, descriptor) { count("createQuerySet", this); charge(querySet, "querySet", 8 * descriptor.count, this); });
  for (const name of ["createShaderModule", "createComputePipeline", "createComputePipelineAsync", "createRenderPipeline", "createBindGroup", "createCommandEncoder"]) {
    wrap(GPUDevice.prototype, name, function () { count(name, this); });
  }
  wrap(GPUQueue.prototype, "submit", function () { count("submit", null); });
  wrap(GPUComputePassEncoder.prototype, "dispatchWorkgroups", function () { count("dispatchWorkgroups", null); });
  for (const prototype of [GPUBuffer.prototype, GPUTexture.prototype, GPUQuerySet.prototype]) {
    const original = prototype.destroy;
    prototype.destroy = function destroy(...args) {
      release(this);
      return original.apply(this, args);
    };
  }
  // Devices and adapters requested after the harness device would mean a second device (gate E).
  const requested = { adapters: 0, devices: 0 };
  wrap(GPU.prototype, "requestAdapter", function () { requested.adapters++; });
  wrap(GPUAdapter.prototype, "requestDevice", function () { requested.devices++; });

  accounting = {
    deviceId,
    requested,
    get phase() { return state.phase; },
    /** Labels new objects from now on; returns the previous label. */
    setPhase(label) { const previous = state.phase; state.phase = label; return previous; },
    /** Starts the incremental count (gate F): objects created from now on in phases not excluded. */
    markBaseline(excluded = []) {
      // Earlier objects become baseline resources. Their later destroy()
      // must not subtract from the new incremental counter.
      for (const record of liveRecords) record.counted = false;
      state.baseline = { at: performance.now(), liveBytes: state.live };
      state.excluded = new Set(excluded);
      state.countedLive = 0;
      state.countedPeak = 0;
    },
    excludePhase(label) { state.excluded.add(label); },
    /** What the accounting knows about one buffer/texture/query set: `{ kind, bytes, label, device, live, counted }` or null. */
    objectRecord(object) {
      const record = records.get(object);
      return record ? { ...record } : null;
    },
    /** Plain-object copy of the counters. */
    snapshot() {
      return {
        liveBytes: state.live, peakLiveBytes: state.peak, objectsCreated: state.created, objectsDestroyed: state.destroyed,
        baseline: state.baseline ? { liveBytes: state.baseline.liveBytes } : null,
        incremental: { liveBytes: state.countedLive, peakBytes: state.countedPeak, excludedPhases: [...state.excluded] },
        byPhase: JSON.parse(JSON.stringify(state.byPhase)), byDevice: JSON.parse(JSON.stringify(state.byDevice)),
        calls: JSON.parse(JSON.stringify(state.calls)), requested: { ...requested }, unknownFormats: [...new Set(state.unknownFormats)],
      };
    },
  };
  return accounting;
}

const describeAdapterInfo = info => {
  const out = {};
  for (const key in info) if (typeof info[key] !== "function" && key !== "subgroupMatrixConfigs" && key !== "memoryHeaps") out[key] = info[key];
  if (info.subgroupMatrixConfigs) out.subgroupMatrixConfigs = info.subgroupMatrixConfigs.length;
  return out;
};
const limitsObject = limits => {
  const out = {};
  for (const key in limits) out[key] = limits[key];
  return out;
};

/**
 * The high-performance adapter and a device with every ORT feature the adapter
 * has (plus `extraFeatures`), and the ORT limits at the adapter maxima.
 * Returns `{ adapter, device, record, errors }`; `errors` collects
 * uncapturederror messages and the device-lost state.
 */
export async function createHarnessDevice({ extraFeatures = [], label = "harness" } = {}) {
  const started = performance.now();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const wanted = [...new Set([...ORT_FEATURES, ...extraFeatures])];
  const requiredFeatures = wanted.filter(feature => adapter.features.has(feature));
  const requiredLimits = Object.fromEntries(ORT_LIMITS.filter(key => key in adapter.limits).map(key => [key, adapter.limits[key]]));
  const device = await adapter.requestDevice({ label, requiredFeatures, requiredLimits });
  const errors = { uncaptured: [], lost: null };
  device.addEventListener("uncapturederror", event => errors.uncaptured.push({ at: performance.now(), message: event.error?.message ?? String(event.error) }));
  device.lost.then(info => { errors.lost = { reason: info.reason, message: info.message }; });
  const record = {
    adapterInfo: describeAdapterInfo(adapter.info ?? {}),
    adapterFeatures: [...adapter.features].sort(),
    adapterLimits: limitsObject(adapter.limits),
    requiredFeatures, missingOrtFeatures: ORT_FEATURES.filter(feature => !adapter.features.has(feature)), requiredLimits,
    deviceFeatures: [...device.features].sort(),
    deviceLimits: limitsObject(device.limits),
    preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat(),
    wgslLanguageFeatures: [...(navigator.gpu.wgslLanguageFeatures ?? [])].sort(),
    createMs: performance.now() - started,
  };
  return { adapter, device, record, errors };
}

/** Chrome puts `message` on the first stack line. Firefox's stack is frames only, so keep the message when it is not already there. */
function thrownText(error) {
  const message = error?.message ? String(error.message) : String(error);
  const stack = error?.stack ? String(error.stack) : "";
  if (!stack || stack.includes(message)) return stack || message;
  return `${message}\n${stack}`;
}

/**
 * Runs `work()` (sync or async) inside validation, out-of-memory and internal
 * error scopes; returns `{ value, errors: [{ filter, message }] }`. A thrown
 * error is returned as `thrown` after the scopes are popped.
 */
export async function withErrorScopes(device, work) {
  const filters = ["validation", "out-of-memory", "internal"];
  for (const filter of filters) device.pushErrorScope(filter);
  let value, thrown = null;
  try { value = await work(); } catch (error) { thrown = error; }
  const errors = [];
  for (const filter of [...filters].reverse()) {
    const error = await device.popErrorScope();
    if (error) errors.push({ filter, message: error.message });
  }
  return { value, errors, thrown: thrown ? thrownText(thrown) : null };
}

/**
 * Timestamp queries for timed passes without stalling a frame loop: a query
 * set of 2 x `capacity` slots, resolved into one buffer per batch, copied into
 * one of `ringSize` MAP_READ buffers that are mapped asynchronously and
 * collected later. Usage per batch: `writes(i)` -> timestampWrites for pass i,
 * then `finish(encoder, passCount)` before submit, then `collect()` after the
 * block (resolves every pending batch to arrays of { beginNs, endNs, ns }).
 */
export function createTimestampRing(device, { capacity = 64, ringSize = 4 } = {}) {
  if (!device.features.has("timestamp-query")) throw new Error("timestamp-query is not enabled on the device");
  const querySet = device.createQuerySet({ type: "timestamp", count: 2 * capacity, label: "timestamp-ring" });
  const resolve = device.createBuffer({ size: 16 * capacity, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, label: "timestamp-resolve" });
  const free = Array.from({ length: ringSize }, (_, index) => device.createBuffer({ size: 16 * capacity, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: `timestamp-read-${index}` }));
  const pending = [];
  return {
    capacity,
    writes: index => ({ querySet, beginningOfPassWriteIndex: 2 * index, endOfPassWriteIndex: 2 * index + 1 }),
    /** Encodes the resolve and the copy; returns false (no copy) when every readback buffer is still in flight. */
    finish(encoder, passCount, tag = null) {
      if (passCount > capacity) throw new Error(`timestamp ring holds ${capacity} passes, got ${passCount}`);
      const target = free.shift();
      if (!target) return false;
      encoder.resolveQuerySet(querySet, 0, 2 * passCount, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, target, 0, 16 * passCount);
      pending.push({ target, passCount, tag, mapped: null });
      return true;
    },
    /** Call after queue.submit: starts mapping the latest batch. */
    submitted() {
      const batch = pending.at(-1);
      if (batch && !batch.mapped) batch.mapped = batch.target.mapAsync(GPUMapMode.READ);
    },
    async collect() {
      const out = [];
      while (pending.length) {
        const batch = pending.shift();
        await (batch.mapped ?? batch.target.mapAsync(GPUMapMode.READ));
        const values = new BigUint64Array(batch.target.getMappedRange(0, 16 * batch.passCount).slice(0));
        batch.target.unmap();
        free.push(batch.target);
        const passes = [];
        for (let index = 0; index < batch.passCount; index++) {
          const begin = values[2 * index], end = values[2 * index + 1];
          passes.push({ beginNs: Number(begin), endNs: Number(end), ns: Number(end - begin) });
        }
        out.push({ tag: batch.tag, passes });
      }
      return out;
    },
    destroy() { querySet.destroy(); resolve.destroy(); for (const buffer of free) buffer.destroy(); },
  };
}

/** Bytes of a canvas swap-chain texture (not accounted as incremental, rule F). */
export const canvasTextureBytes = (canvas, format) => canvas.width * canvas.height * (BYTES_PER_TEXEL[format] ?? 4);
