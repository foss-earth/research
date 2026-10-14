#!/usr/bin/env node
/**
 * Stage 1 browser gates B-F and separate cold-load observations on final
 * fixed-shape graphs. Small first, then 720p, 1080p and RIFE 540p. Nothing
 * listens on a port or reaches the network: CDP serves pinned local bytes.
 *
 * node scripts/benchmarks/ai-framegen-upscale/run-parity.mjs
 *   [--candidates=rife-4.25-lite,rt4ksr-x2] [--profiles=small,720p,1080p,540p]
 *   [--precisions=fp32,fp16] [--cases=synthetic,natural] [--cold-repeats=3]
 *   [--work=<build folder>] [--results=<build folder>]
 *
 * Writes results/parity.json, parity.csv, environment.json and console/request
 * logs under a new build/benchmarks/ai-framegen-upscale/parity/<stamp>/ run.
 * Each completed profile is persisted before starting the next one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { harnessRoutes } from "./lib/serve.mjs";
import { launchChrome, openHarnessPage } from "./lib/browser.mjs";
import { parsePlacement } from "./harness/ort.mjs";
import { checkDeviceParity, checkFullPath, checkPlacement, checkInjection, checkMemory } from "./lib/gates.mjs";
import { parseArguments, workDirectory, runDirectory, scratchEnvironment, environment, writeResults, writeCsv, sha256File, repositoryRoot, buildRoot } from "./lib/environment.mjs";

const options = parseArguments({ candidates: ["rife-4.25-lite", "rt4ksr-x2"], profiles: ["small", "720p", "1080p", "540p"], precisions: ["fp32", "fp16"], cases: ["synthetic", "natural"], "cold-repeats": 3, work: "", "job-timeout-ms": 180000 });
for (const [key, allowed] of Object.entries({ candidates: ["rife-4.25-lite", "rt4ksr-x2"], profiles: ["small", "720p", "1080p", "540p"], precisions: ["fp32", "fp16"], cases: ["synthetic", "natural"] })) {
  if (!options[key].length || options[key].some(value => !allowed.includes(value))) throw new Error(`invalid --${key}`);
}
if (!Number.isInteger(options["cold-repeats"]) || options["cold-repeats"] < 0 || options["cold-repeats"] > 3) throw new Error("cold-repeats must be 0..3");
const work = workDirectory(options.work);
const scratch = scratchEnvironment(work);
for (const folder of Object.values(scratch)) mkdirSync(folder, { recursive: true });
Object.assign(process.env, scratch);
const run = runDirectory("parity");
const pins = JSON.parse(readFileSync(new URL("./browser-dependencies.json", import.meta.url), "utf8"));
const ortDist = path.join(work, "ort-web", `${pins.package.name}-${pins.package.version}`, "package", "dist");
for (const pin of pins.files) {
  const file = path.join(ortDist, path.basename(pin.served));
  if (sha256File(file) !== pin.sha256) throw new Error(`ORT served pin mismatch: ${file}`);
}
const routes = harnessRoutes({ models: path.join(work, "models"), references: path.join(work, "references"), ortDist });
const providerRoot = path.join(buildRoot, "ai-framegen-upscale", "upstream", "onnxruntime-v1.30.0", "onnxruntime", "core", "providers", "webgpu");

/** Version ranges parsed from the pinned native EP's registration table. */
export function nativeOpSupport(receipt) {
  const tableFile = path.join(providerRoot, "webgpu_execution_provider.cc");
  const binaryFile = path.join(providerRoot, "math", "binary_elementwise_ops.cc");
  const uncomment = text => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const table = uncomment(readFileSync(tableFile, "utf8")), binary = uncomment(readFileSync(binaryFile, "utf8"));
  const registrations = {};
  const add = (op, start, end = null) => (registrations[op] ??= []).push({ start: Number(start), end: end === null ? null : Number(end) });
  for (const match of table.matchAll(/KERNEL_CREATE_INFO_VERSIONED\((\d+),\s*(\d+),\s*(\w+)\)/g)) add(match[3], match[1], match[2]);
  for (const match of table.matchAll(/KERNEL_CREATE_INFO\((\d+),\s*(\w+)\)/g)) add(match[2], match[1]);
  for (const match of table.matchAll(/Create(\w+)VersionedKernelInfo\((\d+),\s*(\d+),/g)) add(match[1], match[2], match[3]);
  for (const match of table.matchAll(/Create(\w+)KernelInfo\((\d+),/g)) add(match[1], match[2]);
  for (const match of table.matchAll(/ONNX_OPERATOR_VERSIONED_(?:TYPED_)?KERNEL_CLASS_NAME\(kWebGpuExecutionProvider,\s*kOnnxDomain,\s*(\d+),\s*(\d+),\s*(?:(?:float|MLFloat16|int32_t|uint32_t|int64_t),\s*)?(\w+)\)/g)) add(match[3], match[1], match[2]);
  for (const match of table.matchAll(/ONNX_OPERATOR_(?:TYPED_)?KERNEL_CLASS_NAME\(kWebGpuExecutionProvider,\s*kOnnxDomain,\s*(\d+),\s*(?:(?:float|MLFloat16|int32_t|uint32_t|int64_t),\s*)?(\w+)\)/g)) add(match[2], match[1]);
  for (const line of binary.split("\n")) {
    const match = /RegisterBinaryOp\(kernel_registry, "(\w+)"/.exec(line);
    if (!match) continue;
    for (const range of line.matchAll(/\{(\d+),\s*(\d+|std::nullopt)\}/g)) add(match[1], range[1], range[2] === "std::nullopt" ? null : range[2]);
  }
  const entries = Object.keys(receipt.opHistogram).sort().map(op => ({ op, count: receipt.opHistogram[op], opset: receipt.opset, ranges: registrations[op] ?? [], supported: (registrations[op] ?? []).some(range => receipt.opset >= range.start && (range.end === null || receipt.opset <= range.end)) }));
  return {
    pass: entries.every(entry => entry.supported), entries,
    scope: "Graph op types/opset against pinned native WebGPU registrations; float16 kernel availability is established in docs/ai-framegen-upscale-models.md. Not a substitute for gate D placement.",
    sources: [{ path: path.relative(repositoryRoot, tableFile), sha256: sha256File(tableFile) }, { path: path.relative(repositoryRoot, binaryFile), sha256: sha256File(binaryFile) }],
  };
}

function checkMemoryPressure() {
  const value = Number(execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8" }).trim());
  if (value !== 1) throw new Error(`memory pressure level ${value}; browser workload deferred`);
  return value;
}
const consoleLog = page => page.console.map(line => `${line.t}\t${line.source}\t${line.level}\t${line.text}`).join("\n") + "\n";
const runtimeBuild = requests => {
  const served = requests.filter(entry => entry.status === 200 && entry.url.includes("/ort/")).map(entry => path.posix.basename(new URL(entry.url).pathname));
  return { nativeAsyncifyFilesObserved: ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"].every(file => served.includes(file)), served, jsepFilesObserved: served.some(file => /jsep/.test(file)), proof: "Hash-pinned ort.webgpu bundle loads native asyncify WebGPU build; runtime request capture confirms exact wasm/glue. JSEP selection is compiled out in this pinned bundle." };
};

const profiles = [], coldLoads = [];
let capturedEnvironment = await environment();
const configuration = { ...options, work: path.relative(repositoryRoot, work), parameters: { jobTimeoutMs: options["job-timeout-ms"], coldRepeatsPerCacheState: options["cold-repeats"] }, timingQualification: "Correctness/memory run; cold wall times are separate unqualified shared-machine observations." };
async function persist() {
  for (const entry of profiles) entry.coldLoad = coldLoads.filter(cold => cold.candidate === entry.candidate && cold.profile === entry.profile && cold.precision === entry.precision);
  await writeResults(run.results, "parity", import.meta.url, configuration, { environment: capturedEnvironment, profiles, coldLoads });
  await writeResults(run.results, "environment", import.meta.url, configuration, { environment: capturedEnvironment });
  writeCsv(run.results, "parity", profiles.flatMap(entry => (entry.cases ?? []).map(item => ({ candidate: entry.candidate, profile: entry.profile, precision: entry.precision, case: item.case, B: item.gateB?.pass, maxAbs: item.deviceParity?.maxAbs, meanAbs: item.deviceParity?.meanAbs, psnrDb: item.deviceParity?.psnrDb, C: item.gateC?.pass, withinOnePercent: 100 * (item.fullPath?.withinOneFraction ?? 0), maxDifference: item.fullPath?.maxDifference, D: entry.gateD?.status, E: item.gateE?.pass, F: entry.gateF?.pass, peakIncrementalMiB: entry.memory?.accounting?.incremental?.peakBytes / 2 ** 20 }))));
}
async function runProfile(candidate, profile, precision) {
  const stem = `${candidate}-${profile}-${precision}`;
  const receiptFile = path.join(work, "models", candidate, profile, `${precision}.receipt.json`);
  const entry = { candidate, profile, precision, cases: [] };
  profiles.push(entry);
  try { entry.memoryPressureBefore = checkMemoryPressure(); }
  catch (error) {
    entry.status = "not-run"; entry.reason = error.message;
    console.log(`${stem}: not run (${error.message})`);
    await persist(); return;
  }
  if (!existsSync(receiptFile)) { entry.status = "not-run"; entry.reason = "final graph receipt missing"; await persist(); return; }
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  if (sha256File(path.join(work, "models", candidate, profile, `${precision}.onnx`)) !== receipt.sha256) throw new Error(`${stem}: graph hash mismatch`);
  entry.graph = { sha256: receipt.sha256, bytes: receipt.bytes, file: receipt.file, gateA: receipt.gateA };
  entry.modelSha256 = receipt.sha256;
  entry.staticOpSupport = nativeOpSupport(receipt);
  const profileDirectory = path.join(run.root, "chrome-profiles", `parity-${stem}`);
  mkdirSync(profileDirectory, { recursive: true });
  let browser, page;
  try {
    browser = await launchChrome(profileDirectory);
    page = await openHarnessPage(browser, routes);
    const init = await page.job("init");
    capturedEnvironment = await environment({ browser: { ...browser.version, flags: browser.flags }, gpu: init.gpu });
    entry.gpu = init.gpu;
    const placementStart = page.console.length;
    entry.preparation = await page.job("parity", { action: "prepare", candidate, profile, precision, case: options.cases[0] }, { timeoutMs: options["job-timeout-ms"] });
    entry.placement = parsePlacement(page.console.slice(placementStart));
    entry.gateD = checkPlacement(entry.placement);
    for (const caseName of options.cases) {
      const item = { case: caseName };
      entry.cases.push(item);
      item.conversionSelfTest = await page.job("conversionSelfTest", { case: caseName });
      item.deviceParity = await page.job("deviceParity", { case: caseName }, { timeoutMs: options["job-timeout-ms"] });
      item.gateB = checkDeviceParity({ precision, ...item.deviceParity, psnrDb: item.deviceParity.psnrDb === "Infinity" ? Infinity : item.deviceParity.psnrDb });
      item.fullPath = await page.job("fullPath", { case: caseName }, { timeoutMs: options["job-timeout-ms"] });
      item.gateC = checkFullPath({ precision, ...item.fullPath });
      item.gateE = checkInjection(item.fullPath.injection);
      console.log(`${stem}/${caseName}: B=${item.gateB.pass} C=${item.gateC.pass} D=${entry.gateD.status} E=${item.gateE.pass}`);
    }
    entry.memory = await page.job("parity", { action: "memory" });
    entry.gateF = checkMemory({ peakIncrementalBytes: entry.memory.accounting.incremental.peakBytes });
    entry.runtimeBuild = runtimeBuild(page.requests);
    entry.status = "completed";
    entry.pass = receipt.gateA?.pass === true && entry.staticOpSupport.pass && entry.runtimeBuild.nativeAsyncifyFilesObserved && !entry.runtimeBuild.jsepFilesObserved && entry.gateD.pass && entry.gateF.pass && entry.cases.every(item => item.gateB.pass && item.gateC.pass && item.gateE.pass && item.conversionSelfTest.pass);
    console.log(`${stem}: peak incremental ${(entry.memory.accounting.incremental.peakBytes / 2 ** 20).toFixed(2)} MiB; F=${entry.gateF.pass}`);
    await page.job("parity", { action: "dispose" });
  } catch (error) {
    entry.status = "failed"; entry.error = String(error.stack ?? error); entry.pass = false;
    if (page) entry.lastConsole = page.console.slice(-10);
    console.log(`${stem}: failed (${error.message})`);
  } finally {
    if (page) { writeFileSync(path.join(run.logs, `console-${stem}.txt`), consoleLog(page)); writeFileSync(path.join(run.logs, `requests-${stem}.json`), JSON.stringify(page.requests, null, 2) + "\n"); await page.close(); }
    if (browser) await browser.close();
    await persist();
  }
  // A numerically failing graph still gets cold observations; unsafe bindings
  // or conversion validation failures do not justify more GPU work.
  if (entry.status !== "completed" || !entry.cases.every(item => item.gateE.pass && item.conversionSelfTest.pass)) return;
  // The successful parity run already seeds this exact model's Dawn cache.
  const warmDirectory = profileDirectory;
  for (const cacheState of ["cold", "cache-warm"]) for (let repeat = 0; repeat < options["cold-repeats"]; repeat++) {
    const directory = cacheState === "cold" ? path.join(run.root, "chrome-profiles", `cold-${stem}-${repeat + 1}`) : warmDirectory;
    mkdirSync(directory, { recursive: true });
    const cold = { candidate, profile, precision, modelSha256: receipt.sha256, cacheState, repeat: repeat + 1, profileDirectory: path.relative(repositoryRoot, directory) };
    cold.cacheWarmClaim = cacheState === "cache-warm";
    if (cacheState === "cache-warm") cold.note = "profile reused from this graph's preceding successful parity run, which seeds Dawn/shader caches";
    let coldBrowser, coldPage;
    try {
      cold.memoryPressureBefore = checkMemoryPressure();
      coldBrowser = await launchChrome(directory);
      coldPage = await openHarnessPage(coldBrowser, routes);
      cold.result = await coldPage.job("coldLoad", { candidate, profile, precision, case: options.cases[0] }, { timeoutMs: options["job-timeout-ms"] });
      cold.runtimeBuild = runtimeBuild(coldPage.requests);
      cold.status = "completed";
    } catch (error) { cold.status = "failed"; cold.error = String(error.stack ?? error); }
    finally {
      if (coldPage) { writeFileSync(path.join(run.logs, `console-${stem}-${cacheState}-${repeat + 1}.txt`), consoleLog(coldPage)); await coldPage.close(); }
      if (coldBrowser) await coldBrowser.close();
      coldLoads.push(cold); await persist();
    }
  }
}

console.log(`parity results: ${path.relative(repositoryRoot, run.results)}`);
// Profile order is binding even when the CLI list is supplied in another order.
for (const profile of ["small", "720p", "1080p", "540p"].filter(profile => options.profiles.includes(profile))) {
  for (const candidate of options.candidates) {
    if (profile === "540p" && candidate !== "rife-4.25-lite") continue;
    for (const precision of options.precisions) await runProfile(candidate, profile, precision);
  }
}
await persist();
console.log(`wrote ${path.relative(repositoryRoot, path.join(run.results, "parity.json"))}`);
