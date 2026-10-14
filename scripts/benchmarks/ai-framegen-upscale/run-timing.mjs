/**
 * Stage 2 matched-control timing blocks, gates G/I. Run after run-parity.mjs:
 * node scripts/benchmarks/ai-framegen-upscale/run-timing.mjs --parity=<parity.json>
 *   --corpus-root=<panoramas> [--candidates=...] [--profiles=...]
 * Raw GPU/CPU/rAF samples, per-block telemetry and provenance go into build/.
 * Never run this while other agents or heavy jobs are active.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { launchChrome, openHarnessPage } from "./lib/browser.mjs";
import { harnessRoutes } from "./lib/serve.mjs";
import { parseArguments, workDirectory, runDirectory, environment, writeResults, writeCsv, scriptReceipt, sha256File, formatJson, scratchEnvironment, insideBuild } from "./lib/environment.mjs";
import { ensureThermalHelper, sample, sampleRecord, blockTelemetry, measureSampleCost, pidsFromProcessInfo } from "./lib/telemetry.mjs";
import { resolveTimingParameters, roundOrder, stopReason, qualifyVariant, compareVariants, acceptedRounds, aaCheck, blockValue } from "./lib/blocks.mjs";
import { evaluateBlock } from "./lib/blocks.mjs";
import { seriesMedians, summary } from "./lib/stats.mjs";
import { fgScreens, srScreen } from "./lib/gates.mjs";

const defaults = { work: "", parity: "", "corpus-root": "", candidates: ["rife-4.25-lite", "rt4ksr-x2"], profiles: ["small", "720p", "1080p", "540p"], precisions: ["fp32", "fp16"], taps: 1,
  "graph-capture": false, "capture-parity": "", "block-iterations": 30, "warmup-seconds": 5, "minimum-pairs": 11, "maximum-pairs": 33, "maximum-run-seconds": 120, "order-seed": 0, "telemetry-cadence-ms": 500,
  sustained: false, quality: "", "sustained-seconds": 60, "sustained-repeats": 3, "combined-seconds": 300 };
const metrics = ["renderGpuMs", "cinGpuMs", "coutGpuMs", "presentGpuMs", "scaleGpuMs", "blendGpuMs", "modelSpanMs", "reconstructionGpuMs", "totalGpuMs", "encodeCpuMs", "modelSubmitCpuMs", "rafIntervalMs", "secondRafIntervalMs"];
const load = file => JSON.parse(readFileSync(file, "utf8"));
const gatePass = gate => gate === true || gate?.pass === true;

/** Callback cadence proxy only: timestamps cannot establish GPU/vsync completion. */
export function callbackCadence(records, nominalIntervalMs = 1000 / 60) {
  const callbacks = records.flatMap(row => [
    { timestamp: row.rafTimestamp, now: row.callbackNow },
    ...(Number.isFinite(row.secondCallbackNow) ? [{ timestamp: row.secondRafTimestamp, now: row.secondCallbackNow }] : []),
  ]);
  const gaps = callbacks.slice(1).map((value, i) => value.now - callbacks[i].now);
  const scheduledGaps = callbacks.slice(1).map((value, i) => value.timestamp - callbacks[i].timestamp);
  const offsets = callbacks.map(value => value.now - value.timestamp);
  return { callbacks: callbacks.length, nominalIntervalMs, callbackStartGapsMs: summary(gaps), scheduledRafGapsMs: summary(scheduledGaps), callbackOffsetsMs: summary(offsets),
    intervalsAbove125Percent: gaps.filter(value => value > 1.25 * nominalIntervalMs).length,
    intervalsAbove200Percent: gaps.filter(value => value > 2 * nominalIntervalMs).length,
    inferredSkippedCallbackOpportunities: gaps.reduce((sum, value) => sum + Math.max(0, Math.round(value / nominalIntervalMs) - 1), 0),
    inferredSkippedScheduledOpportunities: scheduledGaps.reduce((sum, value) => sum + Math.max(0, Math.round(value / nominalIntervalMs) - 1), 0),
    qualification: "unqualified elapsed callback cadence diagnostic; no GPU completion/vsync clock alignment, no scanout or distinct-frame deadline claim" };
}

/** Admission needs every reference case, not the best one. Pure for fixture use. */
export function admittedProfiles(parity, options) {
  const rows = parity.records ?? parity.profiles ?? parity.results ?? [];
  if (!Array.isArray(rows)) throw new Error("parity results need a records array");
  const selected = [], skipped = [];
  for (const candidate of options.candidates) for (const profile of options.profiles) {
    if (profile === "540p" && candidate !== "rife-4.25-lite") continue;
    const precisions = [];
    for (const precision of options.precisions) {
      const matches = rows.filter(row => row.candidate === candidate && row.profile === profile && row.precision === precision);
      const valid = matches.length > 0 && matches.every(row => row.status === "completed"
        && gatePass(row.graph?.gateA) && gatePass(row.gateD) && row.staticOpSupport?.pass === true
        && row.runtimeBuild?.nativeAsyncifyFilesObserved === true && row.runtimeBuild?.jsepFilesObserved === false
        && row.cases?.length === 2 && ["synthetic", "natural"].every(name => row.cases.some(c => c.case === name))
        && row.cases.every(c => gatePass(c.gateB) && gatePass(c.gateC) && gatePass(c.gateE) && c.conversionSelfTest?.pass === true));
      if (valid) precisions.push(precision);
      else skipped.push({ candidate, profile, precision, reason: matches.length ? "one or more A-E gates failed/unverified" : "no parity record" });
    }
    if (precisions.length) selected.push({ candidate, profile, precisions });
  }
  return { selected, skipped };
}

export function summarizeBlocks(blocks, variants, timer, parameters, fg) {
  const variantsOut = {}, comparisons = [];
  const models = variants.filter(name => name.startsWith("model-"));
  for (const variant of variants) {
    const stage = {};
    for (const metric of metrics) {
      const gpu = !/Cpu|raf|Raf/.test(metric);
      stage[metric] = qualifyVariant(blocks, variant, { metric, metricKind: gpu ? "gpu" : "elapsed", timerValidated: timer.validated }, parameters);
      const values = blocks.filter(block => block.name === variant && stage[metric].rounds.includes(block.round)).map(block => block.summary[metric]);
      stage[metric].distribution = summary(values);
    }
    variantsOut[variant] = stage;
  }
  for (const model of models) for (const control of variants.filter(name => !name.startsWith("model-"))) {
    comparisons.push(compareVariants(blocks, model, control, { metric: "totalGpuMs", metricKind: "gpu", timerValidated: timer.validated }, parameters));
  }
  const screens = {};
  for (const variant of models) {
    const stage = variantsOut[variant];
    // Gate G sums stage p95s. Qualification and the rounds those p95s use must
    // cover every term in W, not the summed total: a stable render can hold
    // totalGpuMs inside 5% while modelSpanMs does not.
    const qualification = costQualification(blocks, variant, parameters, timer.validated);
    const accepted = qualification.rounds;
    const readings = metric => blocks.filter(block => block.name === variant && accepted.includes(block.round)).flatMap(block => block.series[metric] ?? []).filter(Number.isFinite);
    const p95 = metric => summary(readings(metric)).p95;
    const P = p95("presentGpuMs") / (fg ? 2 : 1);
    const terms = { Cin: p95("cinGpuMs"), Cout: p95("coutGpuMs") };
    if ([...Object.values(terms), P, p95("modelSpanMs")].every(Number.isFinite)) {
      const modelTerm = { upper: p95("modelSpanMs"), upperEstimate: fg ? "G_span p95" : "U_span p95" };
      const values = fg ? fgScreens({ ...terms, G: modelTerm, P, R_est: null }) : srScreen({ ...terms, U: modelTerm, P_out: P });
      screens[variant] = { qualification, costStatistic: "p95 of per-iteration samples in rounds accepted for every W-term GPU metric; conservative sum of stage p95s", values };
    } else screens[variant] = { status: "not-evaluated", reason: "no accepted finite samples", qualification };
  }
  return { variants: variantsOut, comparisons, screens };
}

const costMetrics = ["cinGpuMs", "modelSpanMs", "coutGpuMs", "presentGpuMs"];

function costQualification(blocks, variant, parameters, timerValidated) {
  const again = `${variant}-again`;
  const hasAgain = blocks.some(block => block.name === again);
  const names = hasAgain ? [variant, again] : [variant];
  const sets = costMetrics.map(metric => new Set(acceptedRounds(blocks, names, metric).rounds));
  const rounds = [...sets[0]].filter(round => sets.every(set => set.has(round))).sort((a, b) => a - b);
  const reasons = [];
  if (timerValidated !== true) reasons.push("GPU timer validation not supplied or failed");
  if (!hasAgain) reasons.push("no A/A control (candidate-again) for this variant");
  if (rounds.length < parameters.minimumPairs) reasons.push(`${rounds.length} rounds accepted for every W term, fewer than minimumPairs ${parameters.minimumPairs}`);
  const perMetric = {};
  if (hasAgain && rounds.length) for (const metric of costMetrics) {
    const values = name => rounds.map(round => blockValue(blocks.find(block => block.name === name && block.round === round), metric));
    const aa = aaCheck(values(variant), values(again), parameters);
    perMetric[metric] = aa.differencePercent;
    if (!aa.within) reasons.push(`${metric}: A/A differs by ${Number.isFinite(aa.differencePercent) ? aa.differencePercent.toFixed(2) : "?"} %, more than ${parameters.maximumAaDifferencePercent} %`);
  }
  const differences = Object.values(perMetric).filter(Number.isFinite);
  return {
    qualified: reasons.length === 0, acceptedRounds: rounds.length, rounds, metrics: costMetrics,
    aa: { differencePercent: differences.length ? Math.max(...differences) : null, within: hasAgain && costMetrics.every(metric => perMetric[metric] <= parameters.maximumAaDifferencePercent), perMetric },
    reasons: [...new Set(reasons)], claim: reasons.length === 0 ? "conditional observation on this machine" : "unqualified",
  };
}

function caseBytes(entry) {
  const hashes = (entry?.deviceParity?.inputHashes ?? []).map(item => [item.name, item.sha256, item.uploadedSha256, item.verified === true]);
  const packed = (entry?.conversionSelfTest?.inputs ?? []).map(item => [item.input, item.packedSha256, item.expectedSha256]);
  return { hashes: hashes.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), packed: packed.sort((a, b) => String(a[0]).localeCompare(String(b[0]))) };
}

/** A captured row is the same profile only when its graph, both-case gates, uploads and packed inputs match the non-capture row. */
export function capturedProfileMatches(normal, captured) {
  if (!normal?.modelSha256 || captured?.modelSha256 !== normal.modelSha256 || captured.enableGraphCapture !== true || captured.gateD?.pass !== true) return false;
  if (!Array.isArray(normal.cases) || !Array.isArray(captured.cases)) return false;
  for (const name of ["synthetic", "natural"]) {
    const left = normal.cases.find(item => item.case === name), right = captured.cases.find(item => item.case === name);
    if (!left || !right || right.gateB?.pass !== true || right.gateC?.pass !== true || right.gateE?.pass !== true || right.conversionSelfTest?.pass !== true) return false;
    const bytes = caseBytes(right);
    if (!bytes.hashes.length || !bytes.packed.length || JSON.stringify(bytes) !== JSON.stringify(caseBytes(left))) return false;
    if (bytes.hashes.some(item => item[3] !== true || !item[1] || item[1] !== item[2]) || bytes.packed.some(item => !item[1] || item[1] !== item[2])) return false;
  }
  return true;
}

async function observedBlock(page, variant, iterations, sampler, chromePids, parameters, cadenceMs) {
  await page.job("timingIdle");
  const before = await sample(sampler), during = [];
  let active = true, cadenceTimer = null, wakeObserver = null;
  const observer = (async () => {
    while (active) {
      await new Promise(resolve => { wakeObserver = resolve; cadenceTimer = setTimeout(resolve, cadenceMs); });
      cadenceTimer = null; wakeObserver = null;
      if (active) {
        try { during.push(await sample(sampler)); }
        catch (error) { during.push({ memory: null, thermal: null, error: String(error) }); }
      }
    }
  })();
  let value, failed = null;
  const started = performance.now();
  try { value = await page.job("timingBlock", { variant, iterations }, { timeoutMs: 60000, intervalMs: 150 }); }
  catch (error) { failed = String(error.stack ?? error); }
  finally { active = false; if (cadenceTimer !== null) clearTimeout(cadenceTimer); wakeObserver?.(); }
  // Finish any in-flight sample, but cancel the cadence wait: no arbitrary
  // settling interval is inserted before the endpoint sample.
  await observer;
  const after = await sample(sampler);
  const telemetry = blockTelemetry(before, after, { excludePids: chromePids });
  const evaluated = evaluateBlock(telemetry, parameters);
  // Rule I is unchanged; required memory/thermal signals observed during the
  // block also must remain valid. GPU during is own load and is not an idle test.
  for (const point of during) {
    if (!point.memory || point.memory.pressure !== parameters.requiredMemoryPressureLevel) evaluated.reasons.push("during:memory-pressure-or-missing");
    if (!point.thermal || point.thermal.thermalState > parameters.maximumThermalState) evaluated.reasons.push("during:thermal-or-missing");
  }
  if (failed) evaluated.reasons.push("page-job-failed");
  evaluated.reasons = [...new Set(evaluated.reasons)]; evaluated.disturbed = evaluated.reasons.length > 0;
  const series = Object.fromEntries(metrics.map(metric => [metric, (value?.records ?? []).map(row => row[metric] ?? null)]));
  const medians = seriesMedians(series);
  return { name: variant, wallMs: performance.now() - started, ...evaluated, telemetry, observations: { before: sampleRecord(before), during: during.map(sampleRecord), after: sampleRecord(after), cadenceMs },
    series, summary: medians.medians, missing: medians.missing, records: value?.records ?? [], cadence: callbackCadence(value?.records ?? []), memory: value?.memory ?? null, error: failed };
}

async function runComparison(item, options, run, work, routes, helper, parameters) {
  const label = `${item.candidate}-${item.profile}`;
  const browser = await launchChrome(insideBuild(path.join(run.root, "chrome", label)));
  let page;
  const configuration = { ...item, taps: options.taps, graphCapture: options["graph-capture"], captureParity: options["capture-parity"] ? scriptReceipt(options["capture-parity"]) : null, timingParameters: parameters.table, overrides: parameters.overrides, telemetryCadenceMs: options["telemetry-cadence-ms"], parity: scriptReceipt(options.parity) };
  const result = { configuration, blocks: [], stop: null, preparation: null, sustained: { status: "not-run", reason: "screen must pass A-I and quality first" } };
  const checkpoint = async () => writeResults(run.results, `timing-${label}`, import.meta.url, configuration, result);
  try {
    page = await openHarnessPage(browser, routes);
    const env = await environment({ browser: { ...browser.version, flags: browser.flags }, gpu: browser.gpu });
    result.environment = env;
    const sourcePins = load(new URL("./export/sources.json", import.meta.url));
    const corpus = Object.values(sourcePins.corpus.images ?? sourcePins.corpus).find(entry => entry.panorama === "363729" || entry.panorama === 363729 || entry.name === "northrop-mall");
    if (!corpus) throw new Error("northrop panorama pin unavailable");
    result.preparation = await page.job("timingPrepare", { ...item, panoramaUrl: "/media/northrop-mall.jpg", panoramaSha256: corpus.sha256, taps: options.taps, enableGraphCapture: options["graph-capture"] }, { timeoutMs: 120000 });
    const sampler = { thermalHelper: helper.path };
    const cost = await measureSampleCost({ count: 5, ...sampler });
    delete cost.raw; result.telemetryCost = cost;
    result.browserProcesses = pidsFromProcessInfo(await browser.chrome.send("SystemInfo.getProcessInfo"));
    const fg = item.candidate === "rife-4.25-lite";
    const models = item.precisions.map(precision => `model-${precision}`);
    const variants = [...(fg ? ["native60", "repeat", "blend", "plumbing"] : ["native", "bilinear", "plumbing"]), ...models];
    result.variants = variants;
    const start = performance.now();
    const warmStart = performance.now();
    let warm = 0, longestWarmJob = 0;
    while ((performance.now() - warmStart) / 1000 + longestWarmJob < parameters.values.maximumWarmupSeconds) {
      const jobStart = performance.now();
      await page.job("timingBlock", { variant: variants[warm++ % variants.length], iterations: 1, warmup: true }, { timeoutMs: 60000 });
      longestWarmJob = Math.max(longestWarmJob, (performance.now() - jobStart) / 1000);
    }
    result.warmup = { boundedSeconds: parameters.values.maximumWarmupSeconds, wallSeconds: (performance.now() - warmStart) / 1000, iterations: warm, order: variants, allVariantsExecuted: warm >= variants.length };
    if (result.warmup.wallSeconds > parameters.values.maximumWarmupSeconds) throw new Error("warmup exceeded registered bound; comparison not timed");
    if (!result.warmup.allVariantsExecuted) throw new Error("bounded warmup did not execute every variant; comparison not timed");
    let round = 0, longestRound = 0;
    for (;;) {
      const why = stopReason({ roundsStarted: round, elapsedSeconds: (performance.now() - start) / 1000, projectedRoundSeconds: longestRound }, parameters.values);
      if (why) { result.stop = why; break; }
      const roundStart = performance.now();
      const order = roundOrder({ variants, again: models, round, orderSeed: parameters.values.orderSeed });
      for (let position = 0; position < order.length; position++) {
        const block = await observedBlock(page, order[position], parameters.values.blockIterations, sampler, result.browserProcesses, parameters.values, options["telemetry-cadence-ms"]);
        result.blocks.push({ round, position, ...block });
        if (block.error) throw new Error(block.error);
      }
      longestRound = Math.max(longestRound, (performance.now() - roundStart) / 1000); round++;
      result.elapsedSeconds = (performance.now() - start) / 1000;
      result.summary = summarizeBlocks(result.blocks, variants, result.preparation.timer, parameters.values, fg);
      await checkpoint();
      console.log(`${label} round ${round}, ${result.elapsedSeconds.toFixed(1)} s; disturbed ${result.blocks.filter(b => b.disturbed).length}/${result.blocks.length}`);
    }
    result.summary = summarizeBlocks(result.blocks, variants, result.preparation.timer, parameters.values, fg);
    if (options.sustained) await sustainedRuns(page, result, item, options, sampler, parameters.values);
  } catch (error) {
    result.error = String(error.stack ?? error); result.stop = "error";
    console.error(`${label}: ${error.message}`);
  } finally {
    const cleanupErrors = [];
    try {
      if (page) {
        result.disposal = await page.job("timingDispose").catch(error => ({ error: String(error) }));
        try { writeFileSync(path.join(run.logs, `console-${label}.txt`), page.console.map(line => `[${line.source}/${line.level}] ${line.text}`).join("\n") + "\n"); } catch (error) { cleanupErrors.push(String(error)); }
        try { await page.close(); } catch (error) { cleanupErrors.push(String(error)); }
      }
    } finally { await browser.close().catch(error => cleanupErrors.push(String(error))); }
    result.cleanupErrors = cleanupErrors;
    result.completedAt = new Date().toISOString(); await checkpoint();
    writeCsv(run.results, `timing-${label}`, result.blocks.map(block => ({ round: block.round, position: block.position, variant: block.name, disturbed: block.disturbed, reasons: block.reasons.join(";"), ...block.summary })));
  }
  return result;
}

async function sustainedRuns(page, result, item, options, sampler, parameters) {
  const quality = options.quality ? load(options.quality) : null;
  const parity = load(options.parity);
    const rows = parity.profiles ?? parity.records ?? [];
  const shortlisted = item.precisions.filter(precision => {
    const cases = rows.filter(row => row.candidate === item.candidate && row.profile === item.profile && row.precision === precision);
    const h = quality?.verdicts?.filter(v => v.candidate === item.candidate && v.profile === item.profile && v.precision === precision);
    const g = result.summary.screens[`model-${precision}`];
    const gPass = g?.qualification?.qualified && (item.candidate === "rife-4.25-lite" ? Object.values(g.values ?? {}).some(v => v.verdict === "advance") : g.values?.verdict === "advance");
    return cases.length && cases.every(row => gatePass(row.gateF)) && quality?.screenCoverage?.complete === true && h?.length && h.every(v => v.verdict === "pass") && gPass;
  });
  if (!shortlisted.length) { result.sustained = { status: "not-run", reason: "no profile passes A-I, F and final H; no representative SR render-cost evidence" }; return; }
  const runs = [];
  for (const precision of shortlisted) for (let repeat = 0; repeat < options["sustained-repeats"]; repeat++) {
    const start = performance.now(), chunks = [];
    while ((performance.now() - start) / 1000 < options["sustained-seconds"]) {
      chunks.push(await observedBlock(page, `model-${precision}`, parameters.blockIterations, sampler, result.browserProcesses, parameters, options["telemetry-cadence-ms"]));
    }
    runs.push({ precision, repeat, wallSeconds: (performance.now() - start) / 1000, chunks });
  }
  result.sustained = { status: "run", runs, combined: { status: "not-run", reason: "five-minute combined FG/SR workload requires both independent candidates to pass; no such paired screen established" } };
}

export async function main() {
  const options = parseArguments(defaults);
  if (!options.parity || !existsSync(options.parity)) throw new Error("--parity=<run/results/parity.json> is required");
  if (!options["corpus-root"]) throw new Error("--corpus-root is required (read-only panorama corpus)");
  if (!(options["telemetry-cadence-ms"] >= 100 && options["telemetry-cadence-ms"] <= 1000)) throw new Error("telemetry cadence outside 100..1000 ms");
  const parameters = resolveTimingParameters({ blockIterations: options["block-iterations"], maximumWarmupSeconds: options["warmup-seconds"], minimumPairs: options["minimum-pairs"], maximumPairs: options["maximum-pairs"], maximumRunSeconds: options["maximum-run-seconds"], orderSeed: options["order-seed"] });
  const work = workDirectory(options.work); Object.assign(process.env, scratchEnvironment(work));
  for (const directory of Object.values(scratchEnvironment(work))) insideBuild(directory);
  const run = runDirectory("timing");
  const parity = load(options.parity), admission = admittedProfiles(parity, options);
  if (options["graph-capture"]) {
    if (!options["capture-parity"]) throw new Error("captured timing needs --capture-parity=<separate captured-session correctness evidence>");
    const captured = load(options["capture-parity"]);
    for (const item of admission.selected) for (const precision of item.precisions) {
      const normal = parity.profiles.find(row => row.candidate === item.candidate && row.profile === item.profile && row.precision === precision);
      const row = captured.profiles?.find(row => row.candidate === item.candidate && row.profile === item.profile && row.precision === precision && capturedProfileMatches(normal, row));
      if (!row) throw new Error("captured session parity missing/failed/changed graph or input hash");
    }
  }
  const helper = await ensureThermalHelper(work);
  const pins = load(new URL("./browser-dependencies.json", import.meta.url));
  const ortDist = path.join(work, "ort-web", `${pins.package.name}-${pins.package.version}`, "package", "dist");
  for (const pin of pins.files) if (sha256File(path.join(ortDist, path.basename(pin.served))) !== pin.sha256) throw new Error("ORT served hash mismatch");
  for (const item of admission.selected) for (const precision of item.precisions) {
    const file = path.join(work, "models", item.candidate, item.profile, `${precision}.onnx`);
    const evidence = (parity.profiles ?? parity.records).find(row => row.candidate === item.candidate && row.profile === item.profile && row.precision === precision);
    if (sha256File(file) !== evidence.modelSha256) throw new Error("model changed since parity admission");
  }
  const routes = harnessRoutes({ models: path.join(work, "models"), references: path.join(work, "references"), ortDist,
    media: { "northrop-mall.jpg": path.join(options["corpus-root"], "363729", "6144.jpg") } });
  const results = [];
  console.log(`run folder ${run.root}; ${admission.selected.length} candidate/profile comparisons`);
  await writeResults(run.results, "admission", import.meta.url, options, { admission, thermalHelper: helper });
  for (const item of admission.selected) results.push(await runComparison(item, options, run, work, routes, helper, parameters));
  await writeResults(run.results, "index", import.meta.url, options, { admission, runs: results.map(result => ({ configuration: result.configuration, stop: result.stop, error: result.error ?? null })) });
  return results.some(result => result.error) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 1; });
}
