import { parityJob } from "./parity.mjs";

const status = document.querySelector("#status");
const runButton = document.querySelector("#run");

function draw(canvas, rgba, width, height) {
  canvas.width = width;
  canvas.height = height;
  const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4);
  canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
}

async function bytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

runButton.addEventListener("click", async () => {
  const profile = document.querySelector("#profile").value;
  const caseName = document.querySelector("#case").value;
  runButton.disabled = true;
  status.textContent = "Loading the fp32 graph and reference…";
  try {
    const prefix = `/references/rt4ksr-x2/${profile}/${caseName}/`;
    const meta = JSON.parse(new TextDecoder().decode(await bytes(`${prefix}meta.json`)));
    const input = meta.inputs[0];
    const valid = meta.output.valid;
    draw(document.querySelector("#input"), await bytes(prefix + input.file), input.width, input.height);
    draw(document.querySelector("#reference"), await bytes(prefix + meta.output.expected8), valid.width, valid.height);
    const prepared = await parityJob({ action: "prepare", candidate: "rt4ksr-x2", profile, precision: "fp32", case: caseName, logSeverityLevel: 2 });
    status.textContent = `Session created in ${prepared.load.createMs.toFixed(0)} ms. Running the GPU path…`;
    const result = await parityJob({ action: "fullPath", case: caseName });
    const injection = result.injection ?? {};
    const failure = injection.thrown
      || (injection.deviceLost ? `WebGPU device lost: ${injection.deviceLost.message || injection.deviceLost.reason}` : "")
      || (injection.scopeErrors ? injection.scopeDetails.map(entry => entry.message).join("\n") : "");
    if (failure) {
      status.textContent = failure;
      return;
    }
    const image = await parityJob({ action: "outputImage" });
    draw(document.querySelector("#output"), image.rgba, image.width, image.height);
    const within = (100 * result.withinOneFraction).toFixed(2);
    status.textContent = `Done. ${within}% of output RGB codes are within one code of the stored reference. Largest code error: ${result.maxDifference}.`;
  } catch (error) {
    status.textContent = error?.stack || String(error);
  } finally {
    runButton.disabled = false;
  }
});
