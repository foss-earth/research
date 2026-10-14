/**
 * ONNX Runtime Web 1.30.0 (native WebGPU EP build) for the ai-framegen-upscale
 * harness (DESIGN.md section 8). Plain ESM with no side effects on import and
 * no browser globals at top level; loadOrt() imports the pinned bundle
 * `/ort/ort.webgpu.min.mjs`, which loads `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`
 * (C++ WebGPU EP compiled with emdawnwebgpu; the JSEP branch is compiled out,
 * `dist/ort.webgpu.mjs:1499` and `:3229`).
 *
 * Facts this module relies on (ORT v1.30.0 source and dist, see
 * build/ai-framegen-upscale/notes/harness-findings.md):
 * - The EP option `device` (a GPUDevice) is registered with
 *   `webgpuRegisterDevice(device)` and passed to the C++ EP as `deviceId` > 0
 *   plus instance/device handles; ORT then creates no device of its own.
 * - `ort.env.webgpu.device` is only written for ORT's default device (id 0),
 *   so with an injected device it stays unset: gate E is proven otherwise.
 * - `env.webgpu.adapter` set to the harness adapter avoids ORT's own
 *   `navigator.gpu.requestAdapter()` call in initEp.
 * - Session option `enableGraphCapture` is forwarded as the EP option of the
 *   same name; with it every input and output must be a "gpu-buffer" tensor.
 * - Node placement is logged by session_state.cc VerifyEachNodeIsAssignedToAnEp
 *   at VERBOSE severity only: "Node placements", " All nodes placed on [EP].
 *   Number of nodes: N" or, per EP, " Node(s) placed on [EP]. Number of nodes: N"
 *   followed by "  OpType (name)" lines; a WARNING "Some nodes were not assigned
 *   to the preferred execution providers ..." when an implicit CPU EP got nodes.
 */

export const ORT_URL = "/ort/ort.webgpu.min.mjs";
export const ORT_FILES = ["ort.webgpu.min.mjs", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];

let loaded = null;

/**
 * Imports the bundle once and configures `env`: wasmPaths "/ort/", one
 * thread, no proxy worker, `logLevel`, and the harness adapter. Returns
 * `{ ort, importMs, cached, env }`.
 */
export async function loadOrt({ adapter = null, logLevel = "verbose" } = {}) {
  if (loaded) {
    loaded.ort.env.logLevel = logLevel;
    return { ...loaded, importMs: 0, cached: true };
  }
  const started = performance.now();
  const ort = await import(ORT_URL);
  const importMs = performance.now() - started;
  ort.env.wasm.wasmPaths = "/ort/";
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = logLevel;
  if (adapter) ort.env.webgpu.adapter = adapter;
  loaded = { ort, importMs };
  return { ort, importMs, cached: false, env: describeEnv(ort) };
}

/** A JSON-safe view of `ort.env` (versions, wasm settings, what env.webgpu holds). */
export function describeEnv(ort) {
  const webgpu = ort.env.webgpu ?? {};
  return {
    versions: { ...ort.env.versions },
    logLevel: ort.env.logLevel,
    wasm: { numThreads: ort.env.wasm.numThreads, proxy: ort.env.wasm.proxy, wasmPaths: ort.env.wasm.wasmPaths, simd: ort.env.wasm.simd ?? null },
    webgpu: {
      keys: Object.keys(webgpu).sort(),
      adapterSet: !!webgpu.adapter,
      deviceType: webgpu.device === undefined ? "undefined" : webgpu.device === null ? "null" : webgpu.device?.constructor?.name ?? typeof webgpu.device,
    },
  };
}

/**
 * The session options of DESIGN.md section 8. `logSeverityLevel` 0 = VERBOSE
 * (needed for the placement statement); the cold-load job uses 2 (WARNING).
 */
export function sessionOptions({ device, enableGraphCapture = false, logSeverityLevel = 0, logVerbosityLevel = 0, preferredOutputLocation = "gpu-buffer" }) {
  return {
    executionProviders: [{ name: "webgpu", device }],
    graphOptimizationLevel: "all",
    preferredOutputLocation,
    logSeverityLevel,
    logVerbosityLevel,
    ...(enableGraphCapture ? { enableGraphCapture: true } : {}),
  };
}

/** The options as recorded in results (the device itself is not serializable). */
export function describeOptions(options) {
  return { ...options, executionProviders: options.executionProviders.map(ep => ({ name: ep.name, device: ep.device ? "harness GPUDevice" : null })) };
}

/** `InferenceSession.create(bytes, options)` with its wall time. */
export async function createSession(ort, bytes, options) {
  const started = performance.now();
  const session = await ort.InferenceSession.create(bytes, options);
  return {
    session, createMs: performance.now() - started,
    inputNames: [...session.inputNames], outputNames: [...session.outputNames],
    inputMetadata: plainMetadata(session.inputMetadata), outputMetadata: plainMetadata(session.outputMetadata),
  };
}

const plainMetadata = metadata => (metadata ?? []).map(entry => ({ name: entry.name, isTensor: entry.isTensor, type: entry.type ?? null, shape: entry.shape ? [...entry.shape] : null }));

/** An ORT tensor over a harness GPU buffer (usage STORAGE | COPY_SRC | COPY_DST). */
export const gpuTensor = (ort, buffer, dims, dataType = "float32") => ort.Tensor.fromGpuBuffer(buffer, { dataType, dims });

/**
 * One run. `outputs` maps output names to preallocated GPU tensors (bound with
 * _OrtBindOutput) or is null for ORT-allocated "gpu-buffer" outputs (the caller
 * must dispose() them). Returns `{ results, ms }` (submission wall time, not a
 * GPU time).
 */
export async function runSession(session, feeds, outputs = null) {
  const started = performance.now();
  const results = outputs ? await session.run(feeds, outputs) : await session.run(feeds);
  return { results, ms: performance.now() - started };
}

const PLACEMENT_ALL = /All nodes placed on \[([^\]]+)\]\. Number of nodes: (\d+)/;
const PLACEMENT_SOME = /Node\(s\) placed on \[([^\]]+)\]\. Number of nodes: (\d+)/;
const PLACEMENT_HEADER = /Node placements\s*$/;
const PLACEMENT_WARNING = /Some nodes were not assigned to the preferred execution providers/;
const NODE_LINE = /VerifyEachNodeIsAssignedToAnEp\]\s{2,}(\S.*)$/;

/**
 * Gate D input from console lines (`[{ text }]` or strings) captured during one
 * session creation: per-EP node counts, CPU node count (null when no
 * placement statement was found = UNVERIFIED), the statement(s) and the
 * nodes listed under a CPU EP.
 */
export function parsePlacement(lines) {
  const providers = {};
  const statements = [];
  const cpuNodes = [];
  const evidence = [];
  let header = false, warning = null, current = null;
  for (const line of lines) {
    for (const raw of String(typeof line === "string" ? line : line.text).split("\n")) {
      let match;
      if (PLACEMENT_HEADER.test(raw)) { header = true; current = null; evidence.push(raw); continue; }
      if ((match = PLACEMENT_ALL.exec(raw)) || (match = PLACEMENT_SOME.exec(raw))) {
        providers[match[1]] = (providers[match[1]] ?? 0) + Number(match[2]);
        statements.push(match[0]);
        evidence.push(raw);
        current = match[1];
        continue;
      }
      if (PLACEMENT_WARNING.test(raw)) { warning = raw.trim(); evidence.push(raw); continue; }
      if (current && (match = NODE_LINE.exec(raw))) {
        if (/cpu/i.test(current)) cpuNodes.push({ provider: current, node: match[1].trim() });
        continue;
      }
      if (current && !/VerifyEachNodeIsAssignedToAnEp/.test(raw)) current = null;
    }
  }
  const found = statements.length > 0;
  const cpuCount = found ? Object.entries(providers).filter(([name]) => /cpu/i.test(name)).reduce((sum, [, count]) => sum + count, 0) : null;
  return {
    found, header, providers, cpuNodes: cpuCount, cpuNodeList: cpuNodes.slice(0, 200), warning,
    statement: found ? statements.join(" | ") : null, evidence: evidence.slice(0, 20),
  };
}
