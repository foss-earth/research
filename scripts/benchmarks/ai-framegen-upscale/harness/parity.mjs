/**
 * Stage 1 page jobs and shared model preparation. Inputs, graph and reference
 * bytes are hash-checked before use. Readbacks and conversion self-tests are
 * excluded from the steady-state memory screen, and never timed as inference.
 * Used by main.mjs and the Stage 2 pipelines; import has no browser side effects.
 */
import { installAccounting, createHarnessDevice, withErrorScopes, canvasTextureBytes } from "./gpu.mjs";
import { createKernels, createRgbaTexture, createTensorBuffer, modelInputFromRgba8, readBuffer, readTexture, writeRgbaTexture } from "./wgsl.mjs";
import { loadOrt, describeEnv, sessionOptions, describeOptions, createSession, gpuTensor, runSession } from "./ort.mjs";

let contextPromise = null;
let active = null;
const safeName = value => {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`invalid path component ${value}`);
  return value;
};
export const hashBytes = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");

export async function fetchBytes(url, expectedHash = null) {
  const start = performance.now();
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const fetchMs = performance.now() - start;
  const sha256 = await hashBytes(bytes);
  if (expectedHash && sha256 !== expectedHash) throw new Error(`${url}: sha256 ${sha256} != ${expectedHash}`);
  return { bytes, fetchMs, sha256, size: bytes.byteLength, url };
}
const fetchJson = async url => JSON.parse(new TextDecoder().decode((await fetchBytes(url)).bytes));

export async function getContext() {
  if (!contextPromise) contextPromise = (async () => {
    if (!isSecureContext || !crossOriginIsolated || !navigator.gpu) throw new Error("secure isolated WebGPU context required");
    const accounting = installAccounting();
    const harness = await createHarnessDevice();
    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU canvas unavailable");
    const canvasFormat = harness.record.preferredCanvasFormat;
    context.configure({ device: harness.device, format: canvasFormat, alphaMode: "opaque" });
    const kernels = createKernels(harness.device, { canvasFormat });
    accounting.markBaseline(["readback", "selftest", "existing-renderer"]);
    return { ...harness, accounting, canvas, context, kernels, canvasFormat };
  })();
  return contextPromise;
}

async function loadCase(candidate, profile, caseName) {
  const prefix = `/references/${safeName(candidate)}/${safeName(profile)}/${safeName(caseName)}/`;
  const meta = await fetchJson(`${prefix}meta.json`);
  if (meta.candidate !== candidate || meta.profile !== profile || meta.case !== caseName) throw new Error("reference identity mismatch");
  const inputs = [];
  for (const input of meta.inputs) {
    const source = await fetchBytes(prefix + safeName(input.file), input.sha256Rgba8);
    const rgba = new Uint8Array(source.bytes);
    const f32 = modelInputFromRgba8(rgba, input.width, input.height, input.dims[3], input.dims[2]);
    const hash = await hashBytes(f32.buffer);
    if (hash !== input.sha256F32) throw new Error(`${input.name}: JS-built f32 sha256 mismatch: ${hash}`);
    inputs.push({ ...input, rgba, f32, jsInputSha256: hash });
  }
  const reference = new Float32Array((await fetchBytes(prefix + safeName(meta.output.file), meta.output.sha256)).bytes);
  const expected8 = new Uint8Array((await fetchBytes(prefix + safeName(meta.output.expected8), meta.output.expected8Sha256)).bytes);
  const valid = meta.output.valid;
  if (valid.x !== 0 || valid.y !== 0 || reference.length !== 3 * valid.width * valid.height || expected8.length !== 4 * valid.width * valid.height) throw new Error("unsupported cropped reference layout");
  return { meta, inputs, reference, expected8 };
}

async function releaseResources(device, session, resources) {
  const failures = [];
  // Retirement failure/device loss must not prevent releasing independent
  // tensors, textures or the session. Each cleanup is attempted once.
  for (const [label, release] of [["queue retirement", () => device.queue.onSubmittedWorkDone()], ...(session ? [["ORT session", () => session.release()]] : []), ...[...resources].reverse()]) {
    try { await release(); } catch (error) { failures.push(`${label}: ${String(error.message ?? error)}`); }
  }
  return failures;
}

/**
 * The shared Stage 1/2 model API. Preallocated GPU outputs are required: a
 * failed GPU binding is reported, never retried on a different EP/location.
 * Fresh page per profile keeps the accounting baseline unambiguous.
 */
export async function prepareModel(params) {
  const { candidate, profile, precision, case: caseName = "synthetic", enableGraphCapture = false, logSeverityLevel = 0 } = params;
  const gpu = await getContext();
  const { device, accounting, canvas, kernels } = gpu;
  const folder = `/models/${safeName(candidate)}/${safeName(profile)}/`;
  const receipt = await fetchJson(`${folder}${safeName(precision)}.receipt.json`);
  if (receipt.candidate !== candidate || receipt.profile !== profile || receipt.precision !== precision) throw new Error("graph receipt identity mismatch");
  const modelFetch = await fetchBytes(`${folder}${precision}.onnx`, receipt.sha256);
  if (modelFetch.size !== receipt.bytes) throw new Error("graph byte count mismatch");
  const caseData = await loadCase(candidate, profile, caseName);
  const { meta } = caseData;
  if (JSON.stringify(receipt.inputs.map(input => [input.name, input.dims])) !== JSON.stringify(meta.inputs.map(input => [input.name, input.dims])) || JSON.stringify(receipt.outputs[0].dims) !== JSON.stringify(meta.output.dims)) throw new Error("reference/graph contract mismatch");
  canvas.width = meta.output.valid.width;
  canvas.height = meta.output.valid.height;
  const loaded = await loadOrt({ adapter: gpu.adapter });
  const { ort } = loaded;
  if (ort.env.versions.web !== "1.30.0") throw new Error(`unexpected ORT Web version ${JSON.stringify(ort.env.versions)}`);
  const resources = [];
  const own = (resource, label, method = "destroy") => { resources.push([label, () => resource[method]()]); return resource; };
  let sessionInfo = null;
  try {
  accounting.setPhase("steady");
  const inputs = caseData.inputs.map(input => {
    const buffer = own(createTensorBuffer(device, input.dims, input.name), `${input.name} buffer`);
    const texture = own(createRgbaTexture(device, input.width, input.height, { render: true, label: input.name }), `${input.name} texture`);
    const tensor = own(gpuTensor(ort, buffer, input.dims), `${input.name} tensor`, "dispose");
    const pack = own(kernels.pack({ texture, buffer, validWidth: input.width, validHeight: input.height, paddedWidth: input.dims[3], paddedHeight: input.dims[2] }), `${input.name} pack`);
    device.queue.writeBuffer(buffer, 0, input.f32);
    writeRgbaTexture(device, texture, input.rgba, input.width, input.height);
    return { ...input, buffer, texture, tensor, pack };
  });
  const outputBuffer = own(createTensorBuffer(device, meta.output.dims, "model-output"), "output buffer");
  const outputTensor = own(gpuTensor(ort, outputBuffer, meta.output.dims), "output tensor", "dispose");
  const outputTexture = own(createRgbaTexture(device, meta.output.valid.width, meta.output.valid.height, { storage: true, render: true, label: "reconstructed" }), "output texture");
  const unpack = own(kernels.unpack({ buffer: outputBuffer, texture: outputTexture, validWidth: meta.output.valid.width, validHeight: meta.output.valid.height, tensorWidth: meta.output.dims[3], tensorHeight: meta.output.dims[2] }), "output unpack");
  const present = own(kernels.present({ texture: outputTexture }), "output present");
  const options = sessionOptions({ device, enableGraphCapture, logSeverityLevel });
  // Explicit fault-isolation diagnostics may override optimization; the
  // registered parity runner always uses its default "all".
  if (params.graphOptimizationLevel !== undefined) {
    if (!["disabled", "basic", "extended", "all"].includes(params.graphOptimizationLevel)) throw new Error("invalid diagnostic graphOptimizationLevel");
    options.graphOptimizationLevel = params.graphOptimizationLevel;
  }
  accounting.setPhase("ort-session");
  sessionInfo = await createSession(ort, modelFetch.bytes, options);
  accounting.setPhase("steady");
  const prepared = {
    ...gpu, ...caseData, ort, receipt, inputs, outputBuffer, outputTensor, outputTexture, unpack, present,
    packs: inputs.map(input => input.pack), feeds: Object.fromEntries(inputs.map(input => [input.name, input.tensor])),
    outputs: { [meta.output.name]: outputTensor }, session: sessionInfo.session, sessionInfo, options, modelFetch,
    load: { importMs: loaded.importMs, fetchMs: modelFetch.fetchMs, bytes: modelFetch.size, createMs: sessionInfo.createMs },
    async dispose() {
      const failures = await releaseResources(device, sessionInfo.session, resources);
      if (failures.length) throw new Error(`model cleanup failures: ${failures.join("; ")}`);
    },
  };
  return prepared;
  } catch (error) {
    const failures = await releaseResources(device, sessionInfo?.session, resources);
    accounting.setPhase("steady");
    if (failures.length) error.message += ` (partial preparation cleanup: ${failures.join("; ")})`;
    throw error;
  }
}

export async function setReferenceCase(prepared, caseName) {
  const next = await loadCase(prepared.receipt.candidate, prepared.receipt.profile, caseName);
  if (JSON.stringify(next.meta.output.dims) !== JSON.stringify(prepared.meta.output.dims) || next.inputs.length !== prepared.inputs.length) throw new Error("case changes model shape");
  next.inputs.forEach((input, index) => Object.assign(prepared.inputs[index], { rgba: input.rgba, f32: input.f32, jsInputSha256: input.jsInputSha256 }));
  Object.assign(prepared, { meta: next.meta, reference: next.reference, expected8: next.expected8 });
}

export async function runPrepared(prepared) {
  prepared.accounting.setPhase("ort-run");
  try {
    const result = await runSession(prepared.session, prepared.feeds, prepared.outputs);
    const output = result.results[prepared.meta.output.name];
    if (output.location !== "gpu-buffer" || output.gpuBuffer !== prepared.outputBuffer) throw new Error("ORT did not return the preallocated GPU output");
    return result;
  } finally { prepared.accounting.setPhase("steady"); }
}

export function compareFloatTensor(actual, reference, tensorDims, valid, { clamp = true } = {}) {
  const plane = tensorDims[2] * tensorDims[3], validPlane = valid.width * valid.height;
  let maxAbs = 0, totalAbs = 0, totalSquare = 0, nonfinite = 0;
  for (let channel = 0; channel < 3; channel++) for (let y = 0; y < valid.height; y++) for (let x = 0; x < valid.width; x++) {
    let a = actual[channel * plane + y * tensorDims[3] + x], b = reference[channel * validPlane + y * valid.width + x];
    if (!Number.isFinite(a) || !Number.isFinite(b)) { nonfinite++; continue; }
    if (clamp) { a = Math.max(0, Math.min(1, a)); b = Math.max(0, Math.min(1, b)); }
    const difference = Math.abs(a - b);
    maxAbs = Math.max(maxAbs, difference); totalAbs += difference; totalSquare += difference * difference;
  }
  const total = 3 * validPlane, mse = totalSquare / total;
  return { maxAbs: nonfinite ? null : maxAbs, meanAbs: nonfinite ? null : totalAbs / total, psnrDb: nonfinite ? null : mse === 0 ? "Infinity" : 10 * Math.log10(1 / mse), mse, nonfinite, total, clamp };
}

export function compareRgba(actual, expected) {
  if (actual.length !== expected.length) throw new Error("RGBA length mismatch");
  const histogram = Array(256).fill(0);
  let maxDifference = 0, withinOne = 0, total = 0;
  for (let index = 0; index < actual.length; index++) {
    if (index % 4 === 3) continue;
    const difference = Math.abs(actual[index] - expected[index]);
    histogram[difference]++; total++; maxDifference = Math.max(maxDifference, difference); if (difference <= 1) withinOne++;
  }
  return { maxDifference, withinOne, total, withinOneFraction: withinOne / total, histogram };
}

async function deviceParity(prepared) {
  for (const input of prepared.inputs) prepared.device.queue.writeBuffer(input.buffer, 0, input.f32);
  // This also verifies the upload; a reference-builder hash alone cannot
  // prove that the actual GPU input buffer holds those bytes.
  const inputHashes = [];
  prepared.accounting.setPhase("readback");
  try {
    for (const input of prepared.inputs) {
      const uploadedHash = await hashBytes(await readBuffer(prepared.device, input.buffer));
      if (uploadedHash !== input.jsInputSha256) throw new Error(`${input.name}: GPU input upload sha256 mismatch`);
      inputHashes.push({ name: input.name, sha256: input.jsInputSha256, uploadedSha256: uploadedHash, verified: true });
    }
  } finally { prepared.accounting.setPhase("steady"); }
  const start = performance.now();
  const result = await runPrepared(prepared);
  await prepared.device.queue.onSubmittedWorkDone();
  const availableMs = performance.now() - start;
  prepared.accounting.setPhase("readback");
  const output = new Float32Array(await readBuffer(prepared.device, prepared.outputBuffer));
  prepared.accounting.setPhase("steady");
  return {
    ...compareFloatTensor(output, prepared.reference, prepared.meta.output.dims, prepared.meta.output.valid),
    unclamped: compareFloatTensor(output, prepared.reference, prepared.meta.output.dims, prepared.meta.output.valid, { clamp: false }),
    inputHashes,
    outputLocation: result.results[prepared.meta.output.name].location, outputBinding: "preallocated GPU tensor", submissionMs: result.ms, availableMs,
  };
}

async function fullPath(prepared) {
  const { device, kernels, accounting } = prepared;
  const scope = await withErrorScopes(device, async () => {
    for (const input of prepared.inputs) writeRgbaTexture(device, input.texture, input.rgba, input.width, input.height);
    let encoder = device.createCommandEncoder();
    for (const pack of prepared.packs) pack.encode(encoder);
    device.queue.submit([encoder.finish()]);
    await runPrepared(prepared);
    encoder = device.createCommandEncoder();
    prepared.unpack.encode(encoder);
    prepared.present.encode(encoder, prepared.context.getCurrentTexture().createView());
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    return true;
  });
  accounting.setPhase("readback");
  const output = await readTexture(device, prepared.outputTexture, prepared.meta.output.valid.width, prepared.meta.output.valid.height);
  prepared.presentedRgba = output;
  accounting.setPhase("steady");
  const deviceId = accounting.deviceId(device);
  const bufferRecord = accounting.objectRecord(prepared.outputBuffer);
  const sameDevice = scope.value === true && !scope.thrown && scope.errors.length === 0 && bufferRecord.device === deviceId && (prepared.ort.env.webgpu.device === undefined || prepared.ort.env.webgpu.device === device);
  return {
    ...compareRgba(output, prepared.expected8),
    injection: {
      sameDevice, gpuInputsAccepted: !scope.thrown, outputConsumed: scope.value === true,
      scopeErrors: scope.errors.length + (scope.thrown ? 1 : 0), scopeDetails: scope.errors, thrown: scope.thrown,
      uncapturedErrors: prepared.errors.uncaptured.length, uncapturedDetails: [...prepared.errors.uncaptured], deviceLost: prepared.errors.lost !== null,
      proof: "Injected EP option + harness GPU input/output buffers + harness WGSL consumption under validation/out-of-memory/internal scopes; preallocated output identity checked. env.webgpu.device is undefined for custom native device ids.",
      harnessDeviceId: deviceId, outputBufferDeviceId: bufferRecord.device, requested: { ...accounting.requested }, env: describeEnv(prepared.ort),
    },
  };
}

async function conversionSelfTest(prepared) {
  const { device, accounting, kernels } = prepared;
  accounting.setPhase("selftest");
  const results = [];
  try {
    for (const input of prepared.inputs) {
      const target = createRgbaTexture(device, input.width, input.height, { storage: true, label: "conversion-selftest" });
      const unpack = kernels.unpack({ buffer: input.buffer, texture: target, validWidth: input.width, validHeight: input.height, tensorWidth: input.dims[3], tensorHeight: input.dims[2] });
      try {
        writeRgbaTexture(device, input.texture, input.rgba, input.width, input.height);
        const encoder = device.createCommandEncoder(); input.pack.encode(encoder); unpack.encode(encoder);
        device.queue.submit([encoder.finish()]);
        const actual = await readTexture(device, target, input.width, input.height);
        const packed = new Float32Array(await readBuffer(device, input.buffer));
        let floatMaxAbs = 0, floatDifferentValues = 0, floatNonfinite = 0;
        for (let index = 0; index < packed.length; index++) {
          if (!Number.isFinite(packed[index])) { floatNonfinite++; continue; }
          const difference = Math.abs(packed[index] - input.f32[index]); floatMaxAbs = Math.max(floatMaxAbs, difference); if (difference !== 0) floatDifferentValues++;
        }
        const packedSha256 = await hashBytes(packed.buffer);
        results.push({ input: input.name, ...compareRgba(actual, input.rgba), floatMaxAbs, floatDifferentValues, floatNonfinite, packedSha256, expectedSha256: input.jsInputSha256, bitwiseEqual: packedSha256 === input.jsInputSha256,
          conversionNote: "rgba8unorm texture decoding can differ from the JS byte division by one f32 ULP; require finite values, max abs <= 1e-7, and exact 8-bit roundtrip. This check adds no numerical model acceptance threshold." });
      } finally { unpack.destroy(); target.destroy(); }
    }
  } finally { accounting.setPhase("steady"); }
  return { pass: results.every(result => result.maxDifference === 0 && result.floatNonfinite === 0 && result.floatMaxAbs <= 1e-7), inputs: results };
}

export async function parityJob(params, progress = () => {}) {
  if (params.action === "prepare") {
    if (active) { await active.dispose(); active = null; }
    progress("preparing session");
    active = await prepareModel(params);
    return { load: active.load, options: describeOptions(active.options), env: describeEnv(active.ort), session: { ...active.sessionInfo, session: undefined }, gpu: active.record };
  }
  if (!active) throw new Error("parity model is not prepared");
  if (params.action === "dispose") { await active.dispose(); active = null; return { disposed: true }; }
  if (params.case && params.case !== active.meta.case) await setReferenceCase(active, params.case);
  if (params.action === "deviceParity") return deviceParity(active);
  if (params.action === "fullPath") return fullPath(active);
  if (params.action === "outputImage") {
    if (!active.presentedRgba) throw new Error("no GPU output yet");
    return { width: active.meta.output.valid.width, height: active.meta.output.valid.height, rgba: active.presentedRgba };
  }
  if (params.action === "conversionSelfTest") return conversionSelfTest(active);
  if (params.action === "memory") return { accounting: active.accounting.snapshot(), canvasSwapchainTextureBytes: canvasTextureBytes(active.canvas, active.canvasFormat), exclusions: "Readback staging/self-test resources and existing renderer resources; canvas swapchain separately. Dropped undestroyed objects conservatively remain live.", errors: active.errors };
  throw new Error(`unknown parity action ${params.action}`);
}

export async function coldLoad(params, progress = () => {}) {
  progress("cold session create");
  const prepared = await prepareModel({ ...params, logSeverityLevel: 2 });
  try {
    for (const input of prepared.inputs) prepared.device.queue.writeBuffer(input.buffer, 0, input.f32);
    const runs = [];
    for (let index = 0; index < 2; index++) {
      progress(`run ${index + 1}`);
      const start = performance.now(); const result = await runPrepared(prepared);
      await prepared.device.queue.onSubmittedWorkDone();
      runs.push({ submissionMs: result.ms, availableMs: performance.now() - start });
    }
    return { ...prepared.load, first: runs[0], second: runs[1], outputBinding: "preallocated GPU tensor", env: describeEnv(prepared.ort), errors: prepared.errors, memory: prepared.accounting.snapshot() };
  } finally { await prepared.dispose(); }
}
