import { parityJob } from "./parity.mjs";

const status = document.querySelector("#status");
const idle = document.querySelector("#idle");
const params = new URLSearchParams(location.search);
const job = params.get("job");
const profile = params.get("profile") || "720p";
const caseName = params.get("case") || "natural";
const profiles = new Set(["720p", "1080p", "small"]);
const cases = new Set(["natural", "synthetic"]);

async function bytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function tightly(rgba, width, height) {
  const count = width * height * 4;
  const view = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  if (view.byteLength < count) throw new Error(`frame is ${view.byteLength} bytes, not ${width} × ${height} RGBA`);
  return view.byteOffset === 0 && view.byteLength === count ? view : new Uint8Array(view.buffer, view.byteOffset, count);
}

async function publish(name, rgba, width, height) {
  const response = await fetch(`/demo/${encodeURIComponent(name)}?width=${width}&height=${height}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: tightly(rgba, width, height),
  });
  if (!response.ok) throw new Error(await response.text());
}

async function report(state, message) {
  status.hidden = false;
  idle.hidden = true;
  status.textContent = message;
  if (!job) return;
  const response = await fetch(`/demo/jobs/${encodeURIComponent(job)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, message }),
  });
  if (!response.ok) throw new Error(await response.text());
}

if (job && /^[A-Za-z0-9-]+$/.test(job)) {
  try {
    if (!profiles.has(profile) || !cases.has(caseName)) throw new Error(`Unknown profile or case: ${profile} ${caseName}`);
    await report("running", "Loading the fp32 graph and reference…");
    const prefix = `/references/rt4ksr-x2/${profile}/${caseName}/`;
    const meta = JSON.parse(new TextDecoder().decode(await bytes(`${prefix}meta.json`)));
    const input = meta.inputs[0];
    const valid = meta.output.valid;
    const inputRgba = await bytes(prefix + input.file);
    const referenceRgba = await bytes(prefix + meta.output.expected8);
    const prepared = await parityJob({ action: "prepare", candidate: "rt4ksr-x2", profile, precision: "fp32", case: caseName, logSeverityLevel: 2 });
    await report("running", `Session created in ${prepared.load.createMs.toFixed(0)} ms. Running the GPU path…`);
    const result = await parityJob({ action: "fullPath", case: caseName });
    const injection = result.injection ?? {};
    const failure = injection.thrown
      || (injection.deviceLost ? `WebGPU device lost: ${injection.deviceLost.message || injection.deviceLost.reason}` : "")
      || (injection.scopeErrors ? injection.scopeDetails.map(entry => entry.message).join("\n") : "");
    if (failure) {
      await report("error", failure);
    } else {
      const image = await parityJob({ action: "outputImage" });
      await report("running", "Publishing the three frames…");
      await publish("Half-resolution input", inputRgba, input.width, input.height);
      await publish("WebGPU output", image.rgba, image.width, image.height);
      await publish("Stored reference", referenceRgba, valid.width, valid.height);
      const within = (100 * result.withinOneFraction).toFixed(2);
      await report("done", `Done. ${within}% of output RGB codes are within one code of the stored reference. Largest code error: ${result.maxDifference}.`);
    }
  } catch (error) {
    try { await report("error", error?.stack || String(error)); } catch { status.textContent = error?.stack || String(error); }
  }
}
