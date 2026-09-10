import { Mesh, VertexData, NullEngine, Scene, Engine } from "@babylonjs/core";
import { createSurfaceQuery } from "../../src/terrain/surfaceQuery.ts";
import { buildBvh, createCpuBvhQuery, createGpuBvhQuery, bvhShader } from "./bvh-prototype.mjs";

const rounds = 15, warmup = 12;
const status = document.querySelector("#status"), details = document.querySelector("#details");
const runButton = document.querySelector("#run"), download = document.querySelector("#download");
const yieldFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], minMs: sorted[0], samplesMs: values };
};
function fixture() {
  const positions = [], indices = [], size = 128;
  for (let z = 0; z <= size; z++) for (let x = 0; x <= size; x++) positions.push(x - 64, 2 * Math.sin(x / 9) * Math.cos(z / 11), z - 64);
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const a = z * (size + 1) + x, b = a + 1, c = a + size + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
function makeRays(count, scenario, seed) {
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const rays = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const dx = random() * 0.3 - 0.15, dz = random() * 0.3 - 0.15;
    const dy = -Math.sqrt(1 - dx * dx - dz * dz);
    rays.set([random() * 100 - 50, scenario === "distant-miss" ? 100 : 10, random() * 100 - 50, scenario === "distant-miss" ? 5 : 20, dx, dy, dz, 0], i * 8);
  }
  return rays;
}
function createProductionQuery(geometry) {
  const engine = new NullEngine(), scene = new Scene(engine), mesh = new Mesh("fixture", scene);
  const data = new VertexData(); data.positions = geometry.positions; data.indices = geometry.indices;
  data.normals = new Float32Array(geometry.positions.length);
  VertexData.ComputeNormals(data.positions, data.indices, data.normals);
  data.applyToMesh(mesh); mesh.computeWorldMatrix(true);
  const surface = createSurfaceQuery(scene, () => null, () => true);
  return { dispose: () => engine.dispose(), query(rays, output) {
    for (let i = 0; i < rays.length / 8; i++) {
      const o = i * 8;
      const hit = surface.raycast({ x: rays[o], y: rays[o + 1], z: rays[o + 2] }, { x: rays[o + 4], y: rays[o + 5], z: rays[o + 6] }, rays[o + 3]);
      output[i * 4] = hit?.distanceMeters ?? -1;
      output[i * 4 + 1] = hit?.normal.x ?? 0; output[i * 4 + 2] = hit?.normal.y ?? 0; output[i * 4 + 3] = hit?.normal.z ?? 0;
    }
    return output;
  } };
}
function assertMatches(expected, actual, label) {
  for (let i = 0; i < expected.length; i += 4) {
    if ((expected[i] < 0) !== (actual[i] < 0)) throw new Error(`${label}: hit mismatch for ray ${i / 4}`);
    if (Math.abs(expected[i] - actual[i]) > 0.003) throw new Error(`${label}: distance differs by ${Math.abs(expected[i] - actual[i])} m for ray ${i / 4}`);
    if (actual[i] >= 0) {
      const dot = expected[i + 1] * actual[i + 1] + expected[i + 2] * actual[i + 2] + expected[i + 3] * actual[i + 3];
      if (!Number.isFinite(dot) || Math.abs(dot) < 0.999) throw new Error(`${label}: normal mismatch for ray ${i / 4}`);
    }
  }
}
async function run() {
  runButton.disabled = true; download.hidden = true; details.textContent = ""; document.querySelector("#summary").textContent = "";
  let device, production, gpu;
  const report = { generatedAt: new Date().toISOString(), source: __BENCHMARK_SOURCE__, buildMachine: __BUILD_MACHINE__,
    environment: { userAgent: navigator.userAgent, secureContext: isSecureContext, hardwareConcurrency: navigator.hardwareConcurrency },
    method: { rounds, warmupBatches: warmup, rayCounts: [1, 5, 128, 1024], alternatingOrder: true,
      geometry: "32,768 triangles, undulating 128 x 128 m grid, all algorithms use identical float32 positions and rays in local metres",
      workload: "Each timed batch is a current-step query; sequential batches await full completion; GPU uploads new rays, dispatches, copies output, awaits mapAsync, copies results into CPU-owned memory, then unmaps",
      timing: "End-to-end wall latency per batch. CPU batches repeat 20 times for 1/5-ray BVH and all distant misses to exceed browser timer precision; GPU always timed individually. P95 across 15 samples (maximum order statistic). No GPU timestamp or CPU energy claim.",
      validation: "All tested rays match production Babylon hit/miss and distance within 3 mm; normals agree up to orientation (absolute dot >= 0.999). GPU matches CPU BVH with the same checks. Not an exhaustive robustness proof." },
    limitations: "Synthetic benchmark in an idle foreground browser, no renderer or streaming workload. BVH implementations are experimental query kernels, not integrated collision backends; production query includes transforms/geodetic metadata omitted by both BVH kernels. CPU builds the BVH once; GPU copies it, with build/upload/compile measured separately. Float32 local coordinates required. Does not move JSBSim's CPU WASM contact solver to GPU. No game FPS, battery, watts, or cross-device claims.",
    preparation: {}, results: [] };
  const onHidden = () => { if (document.hidden) report.backgroundedDuringRun = true; };
  document.addEventListener("visibilitychange", onHidden);
  try {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable. Use a browser with hardware WebGPU enabled; no result was measured.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const info = adapter.info;
    report.environment.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null };
    if (report.environment.adapter.isFallbackAdapter === true || /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.description}`)) throw new Error("Software adapter rejected: this comparison requires a real GPU");
    device = await adapter.requestDevice();
    let validationError;
    device.addEventListener("uncapturederror", event => { validationError = event.error.message; });
    const shader = device.createShaderModule({ code: bvhShader });
    const compilation = await shader.getCompilationInfo();
    if (compilation.messages.some(m => m.type === "error")) throw new Error(compilation.messages.map(m => m.message).join("\n"));
    let started = performance.now();
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module: shader, entryPoint: "main" } });
    report.preparation.pipelineCompileMs = performance.now() - started;
    const geometry = fixture();
    started = performance.now(); const bvh = buildBvh(geometry.positions, geometry.indices);
    report.preparation.cpuBvhBuildMs = performance.now() - started;
    report.preparation.nodes = bvh.nodes; report.preparation.depth = bvh.depth;
    report.preparation.uploadBytes = bvh.nodeData.byteLength + bvh.triangleData.byteLength;
    const cpu = createCpuBvhQuery(bvh);
    production = createProductionQuery(geometry);
    for (const scenario of ["dense-local-hit", "distant-miss"]) for (const count of report.method.rayCounts) {
      status.textContent = `Measuring ${scenario}: ${count} rays`;
      await yieldFrame();
      started = performance.now(); gpu = await createGpuBvhQuery(device, pipeline, bvh, count);
      const gpuUploadAndAllocationMs = performance.now() - started;
      const timings = { productionCpu: [], cpuBvh: [], gpuBvh: [] };
      const output = new Float32Array(count * 4), reference = new Float32Array(count * 4), cpuOutput = new Float32Array(count * 4);
      let checksum = 0, validatedRays = 0;
      for (let round = -warmup; round < rounds; round++) {
        const rays = makeRays(count, scenario, 12345 + round + warmup);
        // Validate each fresh batch outside its timing window.
        production.query(rays, reference); cpu(rays, cpuOutput); await gpu.query(rays, output);
        assertMatches(reference, cpuOutput, "Production vs CPU BVH"); assertMatches(cpuOutput, output, "CPU vs GPU BVH");
        validatedRays += count;
        const order = round % 2 ? ["gpuBvh", "cpuBvh", "productionCpu"] : ["productionCpu", "cpuBvh", "gpuBvh"];
        for (const backend of order) {
          const repeats = backend === "gpuBvh" ? 1 : (scenario === "distant-miss" || (backend === "cpuBvh" && count <= 5) ? 20 : 1);
          const start = performance.now();
          for (let repeat = 0; repeat < repeats; repeat++) {
            if (backend === "gpuBvh") await gpu.query(rays, output);
            else if (backend === "cpuBvh") cpu(rays, output);
            else production.query(rays, output);
            checksum += output[0];
          }
          if (round >= 0) timings[backend].push((performance.now() - start) / repeats);
        }
      }
      if (validationError) throw new Error(validationError);
      const timing = Object.fromEntries(Object.entries(timings).map(([name, samples]) => [name, summarize(samples)]));
      const cpuMedian = timing.cpuBvh.medianMs, gpuMedian = timing.gpuBvh.medianMs;
      report.results.push({ scenario, rays: count, triangles: bvh.triangles, gpuUploadAndAllocationMs, validatedRays, checksum, timing,
        fasterPrototype: cpuMedian <= gpuMedian ? "cpuBvh" : "gpuBvh", gpuToCpuLatencyRatio: gpuMedian / cpuMedian,
        gpuPreparationAmortizedAfterBatches: gpuMedian < cpuMedian ? Math.ceil((report.preparation.pipelineCompileMs + gpuUploadAndAllocationMs) / (cpuMedian - gpuMedian)) : null });
      gpu.dispose(); gpu = null;
      details.textContent = JSON.stringify(report, null, 2);
    }
    report.completedAt = new Date().toISOString();
    report.backgroundedDuringRun ??= false;
    document.querySelector("#summary").innerHTML = `<table><tr><th>Scenario / rays</th><th>Production CPU ms</th><th>CPU BVH ms</th><th>GPU BVH + readback ms</th></tr>${report.results.map(r => `<tr><td>${r.scenario} / ${r.rays}</td><td>${r.timing.productionCpu.medianMs.toFixed(4)}</td><td>${r.timing.cpuBvh.medianMs.toFixed(4)}</td><td>${r.timing.gpuBvh.medianMs.toFixed(4)}</td></tr>`).join("")}</table>`;
    const json = JSON.stringify(report, null, 2);
    details.textContent = json;
    download.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    download.download = `collision-gpu-${Date.now()}.json`; download.hidden = false;
    status.textContent = report.backgroundedDuringRun ? "Complete, but tab was backgrounded: repeat for usable timing." : "Complete: all ray results verified against production and both prototypes.";
  } catch (error) {
    status.textContent = `Failed: ${error.message}`; details.textContent = `${error.stack}\n${JSON.stringify(report, null, 2)}`;
  } finally {
    document.removeEventListener("visibilitychange", onHidden); gpu?.dispose(); production?.dispose(); device?.destroy(); runButton.disabled = false;
  }
}
runButton.addEventListener("click", run);
