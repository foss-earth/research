/**
 * GPU-resident panorama/control/model timing jobs. Called through main.mjs's
 * job API by run-timing.mjs; samples stay in build/. No per-frame GPU wait or
 * readback: queries are resolved and read only after an entire block.
 */
import { getContext, prepareModel } from "./parity.mjs";
import { createTimestampRing, withErrorScopes } from "./gpu.mjs";
import { createRgbaTexture } from "./wgsl.mjs";
import { runSession } from "./ort.mjs";

let prepared = null;
const frame = () => new Promise(resolve => requestAnimationFrame(timestamp => resolve({ timestamp, now: performance.now() })));

/** One page owns one candidate/profile comparison; sessions share its device. */
export async function timingPrepare(params) {
  if (prepared) throw new Error("dispose the previous timing comparison first");
  const ctx = await getContext();
  const { device, accounting, kernels, canvas, context } = ctx;
  accounting.setPhase("renderer-existing");
  const response = await fetch(params.panoramaUrl);
  if (!response.ok) throw new Error(`panorama fetch ${response.status}`);
  const blob = await response.blob();
  if (params.panoramaSha256) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const hex = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
    if (hex !== params.panoramaSha256) throw new Error("timing panorama hash mismatch");
  }
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const equirect = createRgbaTexture(device, bitmap.width, bitmap.height, { render: true, label: "existing-panorama" });
  device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: equirect }, [bitmap.width, bitmap.height]);
  bitmap.close();
  accounting.markBaseline(["renderer-existing", "timing-readback"]);
  accounting.setPhase("steady");
  const models = {}, cold = [];
  const cleanup = [];
  try {
    for (const precision of params.precisions) {
      const model = await prepareModel({ ...params, markBaseline: false, precision, case: "synthetic", enableGraphCapture: params.enableGraphCapture ?? false });
      models[precision] = model;
      for (const input of model.inputs) device.queue.writeBuffer(input.buffer, 0, input.f32);
      const first = await runSession(model.session, model.feeds, model.outputs);
      const available = performance.now();
      await device.queue.onSubmittedWorkDone();
      cold.push({ precision, firstSubmitMs: first.ms, firstRetirementWaitMs: performance.now() - available, sessionCreateMs: model.sessionInfo.createMs });
    }
    const exemplar = models[params.precisions[0]];
    const [height, width] = exemplar.meta.output.valid ? [exemplar.meta.output.valid.height, exemplar.meta.output.valid.width] : [exemplar.outputTexture.height, exemplar.outputTexture.width];
    canvas.width = width; canvas.height = height;
    context.configure({ device, format: ctx.canvasFormat, alphaMode: "opaque" });
    const fg = params.candidate === "rife-4.25-lite";
    accounting.setPhase("steady");
    const nativeTexture = createRgbaTexture(device, width, height, { render: true, label: "native-control" });
    const controlTexture = createRgbaTexture(device, width, height, { render: true, storage: true, label: "control-output" });
    const lowWidth = fg ? width : width / 2, lowHeight = fg ? height : height / 2;
    const lowTexture = createRgbaTexture(device, lowWidth, lowHeight, { render: true, storage: true, label: "low-control" });
    const reconstructedLow = createRgbaTexture(device, lowWidth, lowHeight, { storage: true, label: "plumbing-reconstructed" });
    cleanup.push(nativeTexture, controlTexture, lowTexture, reconstructedLow);
    const panorama = target => kernels.panorama({ equirect, target, taps: params.taps ?? 1 });
    const nativeRender = panorama(nativeTexture), lowRender = panorama(lowTexture);
    const nativePresent = kernels.present({ texture: nativeTexture }), controlPresent = kernels.present({ texture: controlTexture });
    const lowPresent = kernels.present({ texture: lowTexture });
    const bilinear = kernels.bilinear({ source: lowTexture, target: controlTexture });
    const plumbingScale = kernels.bilinear({ source: reconstructedLow, target: controlTexture });
    const modelBindings = {};
    for (const [precision, m] of Object.entries(models)) {
      const renders = m.inputs.map(input => panorama(input.texture));
      const presents = m.inputs.map(input => kernels.present({ texture: input.texture }));
      const plumbing = m.inputs.map(input => kernels.unpack({ buffer: input.buffer, texture: fg ? controlTexture : reconstructedLow,
        validWidth: input.width, validHeight: input.height, tensorWidth: input.dims[3], tensorHeight: input.dims[2] }));
      const blend = fg ? kernels.blend({ first: m.inputs[0].texture, second: m.inputs[1].texture, target: controlTexture }) : null;
      modelBindings[precision] = { renders, presents, plumbing, blend, retained: 0 };
      cleanup.push(...renders, ...presents, ...plumbing, ...(blend ? [blend] : []));
    }
    const marker = kernels.marker();
    cleanup.push(nativeRender, lowRender, nativePresent, controlPresent, lowPresent, bilinear, plumbingScale, marker);
    prepared = { ...ctx, params, models, modelBindings, cleanup, equirect, fg, nativeRender, lowRender, nativePresent, controlPresent, lowPresent, bilinear, plumbingScale, marker };
    const timer = await validateTimer(prepared);
    return { candidate: params.candidate, profile: params.profile, precisions: params.precisions, cold, timer, gpu: ctx.record, memory: accounting.snapshot(),
      modelEstimate: "G_span/U_span: end-before-marker to begin-after-marker; upper bound includes CPU submission gaps",
      kernelLowerBound: { status: "missing", reason: "native WASM EP profiling has no readable kernel profile; no lower bound manufactured" } };
  } catch (error) {
    prepared = null;
    for (const m of Object.values(models)) await m.dispose().catch(() => {});
    for (const resource of [...cleanup, equirect]) { try { resource.destroy?.(); } catch { /* Keep attempting independent releases. */ } }
    throw error;
  }
}

async function validateTimer(p) {
  const ring = createTimestampRing(p.device, { capacity: 8, ringSize: 1 });
  try {
    const encoder = p.device.createCommandEncoder();
    for (let i = 0; i < 8; i++) p.marker.encode(encoder, ring.writes(i));
    ring.finish(encoder, 8);
    p.device.queue.submit([encoder.finish()]); ring.submitted();
    const [batch] = await ring.collect();
    const monotonic = batch.passes.every((pass, i) => pass.endNs >= pass.beginNs && (!i || pass.beginNs >= batch.passes[i - 1].endNs));
    const positive = batch.passes.some(pass => pass.ns > 0);
    const unquantized = batch.passes.some(pass => pass.ns % 65536 !== 0);
    return { validated: monotonic && positive && unquantized && !p.errors.lost, monotonic, positive, unquantized, passes: batch.passes, unit: "ns", hardware: p.record.adapterInfo, range: "eight sequential marker compute passes" };
  } finally { ring.destroy(); }
}

/** All earlier submissions retired before the node-side GPU-idle observation. */
export async function timingIdle() {
  if (!prepared) throw new Error("timingPrepare required");
  await prepared.device.queue.onSubmittedWorkDone();
  return { memory: prepared.accounting.snapshot(), lost: prepared.errors.lost, errors: prepared.errors.uncaptured };
}

/** One rAF step/interval; two rAFs for FG, one for SR. */
export async function timingBlock({ variant, iterations = 30, warmup = false }) {
  const p = prepared;
  if (!p) throw new Error("timingPrepare required");
  const { device, kernels } = p;
  const name = variant.replace(/-again$/, "");
  const precision = name.startsWith("model-") ? name.slice(6) : p.params.precisions[0];
  const m = p.models[precision], bindings = p.modelBindings[precision];
  if (!m) throw new Error(`unprepared precision ${precision}`);
  const model = name.startsWith("model-");
  if (!(iterations >= 1 && iterations <= 1000)) throw new Error("iterations outside 1..1000");
  const supported = p.fg ? ["native60", "repeat", "blend", "plumbing", ...p.params.precisions.map(v => `model-${v}`)] : ["native", "bilinear", "plumbing", ...p.params.precisions.map(v => `model-${v}`)];
  if (!supported.includes(name)) throw new Error(`unsupported timing variant ${name}`);
  // Seed the retained endpoint outside the measured block. Only its successor
  // is packed during each FG interval; no duplicate Cin is hidden in the cost.
  if (p.fg && name !== "native60" && name !== "repeat") {
    bindings.retained = 0;
    const encoder = device.createCommandEncoder();
    bindings.renders[0].setCamera(0); bindings.renders[0].encode(encoder);
    m.packs[0].encode(encoder);
    device.queue.submit([encoder.finish()]);
  }
  p.accounting.setPhase("timing-readback");
  const ring = createTimestampRing(device, { capacity: iterations * 12, ringSize: 1 });
  p.accounting.setPhase("steady");
  const records = [], descriptors = [];
  let query = 0, previousRaf = null;
  const timed = (encoder, binding, stage, record, view = null) => {
    const index = query++;
    if (query > ring.capacity) throw new Error("timestamp capacity exceeded");
    descriptors.push({ index, stage, record });
    if (view) binding.encode(encoder, view, ring.writes(index));
    else binding.encode(encoder, ring.writes(index));
    return index;
  };
  const present = (encoder, binding, record) => timed(encoder, binding, "P", record, p.context.getCurrentTexture().createView());
  const scope = await withErrorScopes(device, async () => {
    for (let i = 0; i < iterations; i++) {
      const raf = await frame();
      const row = { iteration: i, rafTimestamp: raf.timestamp, callbackNow: raf.now, rafIntervalMs: previousRaf === null ? null : raf.now - previousRaf,
        encodeCpuMs: 0, modelSubmitCpuMs: 0, passes: {}, modelMarkers: null };
      previousRaf = raf.now;
      records.push(row);
      const cpu = performance.now();
      let encoder = device.createCommandEncoder();
      if (p.fg && name === "native60") {
        p.nativeRender.setCamera(i + 0.5); timed(encoder, p.nativeRender, "R", row); present(encoder, p.nativePresent, row);
      } else if (p.fg && name === "repeat") {
        p.lowRender.setCamera(i); timed(encoder, p.lowRender, "R", row); present(encoder, p.lowPresent, row);
      } else if (p.fg) {
        const retained = bindings.retained, fresh = 1 - retained;
        bindings.renders[fresh].setCamera(i + 1); timed(encoder, bindings.renders[fresh], "R", row);
        if (model || name === "plumbing") timed(encoder, m.packs[fresh], "Cin", row);
        if (model) {
          const before = timed(encoder, p.marker, "markerBefore", row);
          device.queue.submit([encoder.finish()]); row.encodeCpuMs += performance.now() - cpu;
          const feeds = { img0: m.inputs[retained].tensor, img1: m.inputs[fresh].tensor };
          const result = await runSession(m.session, feeds, m.outputs); row.modelSubmitCpuMs = result.ms;
          const afterCpu = performance.now();
          encoder = device.createCommandEncoder();
          const after = timed(encoder, p.marker, "markerAfter", row);
          row.modelMarkers = { before, after };
          timed(encoder, m.unpack, "Cout", row); present(encoder, m.present, row);
          device.queue.submit([encoder.finish()]); row.encodeCpuMs += performance.now() - afterCpu;
          encoder = null;
        } else {
          if (name === "blend") timed(encoder, bindings.blend, "blend", row);
          else timed(encoder, bindings.plumbing[fresh], "Cout", row);
          present(encoder, p.controlPresent, row);
        }
        bindings.retained = fresh;
      } else if (name === "native") {
        p.nativeRender.setCamera(i * 0.5); timed(encoder, p.nativeRender, "R", row); present(encoder, p.nativePresent, row);
      } else if (name === "bilinear") {
        p.lowRender.setCamera(i * 0.5); timed(encoder, p.lowRender, "R", row);
        timed(encoder, p.bilinear, "scale", row); present(encoder, p.controlPresent, row);
      } else {
        bindings.renders[0].setCamera(i * 0.5); timed(encoder, bindings.renders[0], "R", row);
        timed(encoder, m.packs[0], "Cin", row);
        if (model) {
          const before = timed(encoder, p.marker, "markerBefore", row);
          device.queue.submit([encoder.finish()]); row.encodeCpuMs += performance.now() - cpu;
          const result = await runSession(m.session, m.feeds, m.outputs); row.modelSubmitCpuMs = result.ms;
          const afterCpu = performance.now();
          encoder = device.createCommandEncoder();
          const after = timed(encoder, p.marker, "markerAfter", row); row.modelMarkers = { before, after };
          timed(encoder, m.unpack, "Cout", row); present(encoder, m.present, row);
          device.queue.submit([encoder.finish()]); row.encodeCpuMs += performance.now() - afterCpu; encoder = null;
        } else {
          timed(encoder, bindings.plumbing[0], "Cout", row);
          timed(encoder, p.plumbingScale, "scale", row); present(encoder, p.controlPresent, row);
        }
      }
      if (encoder) { device.queue.submit([encoder.finish()]); row.encodeCpuMs += performance.now() - cpu; }
      if (p.fg) {
        const secondRaf = await frame();
        row.secondRafTimestamp = secondRaf.timestamp; row.secondCallbackNow = secondRaf.now;
        row.secondRafIntervalMs = secondRaf.now - raf.now; previousRaf = secondRaf.now;
        const secondCpu = performance.now(), second = device.createCommandEncoder();
        if (name === "native60") {
          p.nativeRender.setCamera(i + 1); timed(second, p.nativeRender, "R", row); present(second, p.nativePresent, row);
        } else if (name === "repeat") present(second, p.lowPresent, row);
        else present(second, bindings.presents[bindings.retained], row);
        device.queue.submit([second.finish()]); row.encodeCpuMs += performance.now() - secondCpu;
      }
    }
    const resolve = device.createCommandEncoder();
    ring.finish(resolve, query); device.queue.submit([resolve.finish()]); ring.submitted();
    const [batch] = await ring.collect();
    for (const entry of descriptors) {
      const pass = batch.passes[entry.index];
      if (!Number.isFinite(pass.ns) || pass.ns < 0) throw new Error("invalid GPU query");
      (entry.record.passes[entry.stage] ??= []).push(pass);
    }
    for (const row of records) {
      const sum = stage => (row.passes[stage] ?? []).reduce((total, pass) => total + pass.ns / 1e6, 0);
      row.renderGpuMs = sum("R"); row.cinGpuMs = sum("Cin"); row.coutGpuMs = sum("Cout"); row.presentGpuMs = sum("P");
      row.scaleGpuMs = sum("scale"); row.blendGpuMs = sum("blend");
      row.modelSpanMs = row.modelMarkers ? (batch.passes[row.modelMarkers.after].beginNs - batch.passes[row.modelMarkers.before].endNs) / 1e6 : 0;
      if (row.modelSpanMs < 0) throw new Error("nonmonotonic model bracket");
      row.reconstructionGpuMs = row.cinGpuMs + row.modelSpanMs + row.coutGpuMs + row.presentGpuMs + row.scaleGpuMs + row.blendGpuMs;
      row.totalGpuMs = row.renderGpuMs + row.reconstructionGpuMs;
    }
    return { variant, records, warmup, memory: p.accounting.snapshot() };
  });
  ring.destroy();
  if (scope.thrown || scope.errors.length || p.errors.lost || p.errors.uncaptured.length) {
    throw new Error(JSON.stringify({ thrown: scope.thrown, errors: scope.errors, lost: p.errors.lost, uncaptured: p.errors.uncaptured }));
  }
  return scope.value;
}

/** Attempt every independent release even if one release fails. */
export async function timingDispose() {
  if (!prepared) return { disposed: false };
  const p = prepared; prepared = null;
  const failures = [];
  try { await p.device.queue.onSubmittedWorkDone(); } catch (error) { failures.push(String(error)); }
  for (const m of Object.values(p.models)) { try { await m.dispose(); } catch (error) { failures.push(String(error)); } }
  for (const resource of [...p.cleanup, p.equirect]) { try { resource.destroy?.(); } catch (error) { failures.push(String(error)); } }
  return { disposed: true, failures, memory: p.accounting.snapshot() };
}
