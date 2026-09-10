import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Uses a fresh temporary Chromium profile and headless mode only. Never connects
// to the user's browser, opens a window, or sends native mouse/keyboard events.
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.resolve(process.argv[2] || path.join(root, "benchmarks/collision/results-gpu.json"));
const moduleName = process.env.PLAYWRIGHT_MODULE;
let chromium;
try {
  ({ chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : "playwright"));
} catch (error) {
  throw new Error("Playwright is required. Install it separately and set PLAYWRIGHT_MODULE to its index.mjs, or install playwright in this project.", { cause: error });
}
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.CHROME_PATH || (existsSync(macChrome) ? macChrome : undefined);
execFileSync(process.execPath, ["benchmarks/collision/build-gpu-comparison.mjs"], { cwd: root, stdio: "inherit" });
const args = ["--enable-unsafe-webgpu", "--enable-gpu", "--disable-software-rasterizer"];
if (process.platform === "darwin") args.push("--use-angle=metal");
const browser = await chromium.launch({ headless: true, executablePath, args });
try {
  const session = await browser.newBrowserCDPSession();
  const diagnostics = await session.send("SystemInfo.getInfo");
  const gpuDiagnostics = diagnostics.gpu;
  const descriptions = gpuDiagnostics.devices.map(device => `${device.vendorString} ${device.deviceString}`).join(" ");
  console.log(`Chromium GPU devices: ${descriptions}`);
  if (/swiftshader|llvmpipe|software rasterizer/i.test(descriptions)) throw new Error("Software GPU rejected by Chromium diagnostics");
  const page = await browser.newPage();
  page.on("console", message => { if (message.text().startsWith("collision-benchmark:")) console.log(message.text()); });
  page.on("pageerror", error => console.error(error));
  await page.goto(pathToFileURL(path.join(root, "benchmarks/collision/.cache/gpu-comparison.html")).href);
  const report = await page.evaluate(() => window.runCollisionBenchmark());
  const adapter = report.environment.adapter;
  const identity = `${adapter.vendor} ${adapter.architecture} ${adapter.description} ${descriptions}`;
  if (adapter.isFallbackAdapter === true || /swiftshader|llvmpipe|software/i.test(identity)) throw new Error("Software GPU results rejected");
  if (!/apple|amd|ati |intel|nvidia|qualcomm|mali|imagination/i.test(identity)) throw new Error("Hardware GPU vendor could not be identified; results will not be saved");
  if (process.platform === "darwin" && (!/apple|amd|intel/i.test(identity) || !/metal/i.test(JSON.stringify(gpuDiagnostics.auxAttributes)))) {
    throw new Error("Could not verify a real hardware GPU using Metal; results will not be saved");
  }
  if (report.backgroundedDuringRun) throw new Error("Benchmark was backgrounded; results will not be saved");
  report.environment.runner = { mode: "isolated headless Chromium via Playwright; offline file URL; no visible browser or user profile", browserVersion: browser.version(), executablePath: executablePath || "Playwright Chromium", args, hardwareGpuVerified: true, gpuDiagnostics };
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.table(report.results.map(row => ({ scenario: row.scenario, rays: row.rays, ...Object.fromEntries(Object.entries(row.timing).map(([name, timing]) => [name, timing.medianMs.toFixed(5)])) })));
  console.log(`Verified hardware GPU: ${identity.trim()}\nResults: ${output}`);
} finally {
  await browser.close();
}
