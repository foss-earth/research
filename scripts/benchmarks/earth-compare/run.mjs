/** W0: measurement only. Google Earth's traffic is never intercepted or retained. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { newOutputDirectory } from "../../lib/outputDirectory.mjs";
import { evaluate, waitForExpression } from "../../lib/headlessChrome.mjs";
import { environment, readPower } from "../ai-framegen-upscale/lib/environment.mjs";
import { sample, sampleRecord, blockTelemetry, ensureThermalHelper } from "../ai-framegen-upscale/lib/telemetry.mjs";
import { secondsSinceInput } from "../spherical-image-representation/lib/quiet.mjs";
import { VIEWS, MOTIONS } from "./views.mjs";
import { toFossView, toEarthUrl, parseEarthUrl, cameraPose, comparePoses, comparePaths } from "./camera.mjs";
import { frameIntervals, aggregate } from "./metrics.mjs";
import { readBattery, summarizePower } from "../power/battery.mjs";
import { IMAGE_POLICY, VIEWPORT, readGoogleKey, settingsScript, redact, runOrder, qualificationReasons, serveBuild,
  withImageMask, imageMask, imagePolicyDigest, maskUiReasons } from "./support.mjs";
import { renderGeometry, compareRenderGeometry, cropRenderImage } from "./renderGeometry.mjs";
import { openChrome, connectWatcher } from "./browser.mjs";
import { prepareEarth, earthRenderInfo } from "./earthUi.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bench = "window.__fossEarthBench";
const snapshot = `${bench}?.runtime.captureNavigationSnapshot()`;
const help = `Usage: node scripts/benchmarks/earth-compare/run.mjs --plan
  --calibrate --local-dist=<built app dist> [--view=<id>] [--load-seconds=60] [--masks=<view masks.json>]
  --capture --local-dist=<dist> --calibration=<calibration.json> --qualification=<reviews.json>
    [--power=adapter|battery] [--baseline=<power.json>] [--brightness=<fixed setting>]
    [--runs=3] [--repeat-start=0] [--view=<id>] [--masks=<view masks.json>]
    [--idle-seconds=10] [--max-wait-seconds=300]
  --watch-port=<port> --view=<id> [--load-seconds=60]
Capture requires previously reviewed calibration overlays, masks, landmarks and detail.
Calibration and watcher output are observations; they never establish performance parity.
No tool installation, interception of Google Earth, setting changes, or deployment.\n`;

export function parseOptions(args) {
  const allowed = new Set(["plan", "calibrate", "capture", "local-dist", "calibration", "qualification", "masks", "view", "load-seconds", "power", "baseline", "brightness", "runs", "repeat-start", "idle-seconds", "max-wait-seconds", "watch-port", "help"]);
  const flags = new Set(["plan", "calibrate", "capture", "help"]), options = {};
  for (const arg of args) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(options, match[1])) throw new Error("Unknown or duplicate option; use --help");
    if (flags.has(match[1]) ? match[2] !== undefined : !match[2]) throw new Error("Option needs --name=value; use --help");
    options[match[1]] = flags.has(match[1]) ? true : match[2];
  }
  options["repeat-start"] = Number(options["repeat-start"] ?? 0);
  for (const [name, fallback, min, max] of [["runs", 3, 1, 3], ["load-seconds", 60, 3, 600], ["idle-seconds", 10, 1, 300], ["max-wait-seconds", 300, 1, 3600]]) {
    options[name] = Number(options[name] ?? fallback);
    if (!Number.isFinite(options[name]) || options[name] < min || options[name] > max || (name === "runs" && !Number.isInteger(options[name]))) throw new Error(`Invalid --${name}`);
  }
  if (!Number.isInteger(options["repeat-start"]) || options["repeat-start"] < 0 || options["repeat-start"] + options.runs > 3) throw new Error("Repeat ids must remain within 0..2; use --runs=1 with --repeat-start=1 or 2");
  if (options.calibrate && options["repeat-start"] !== 0) throw new Error("Calibration must start at repeat 0");
  if (options.power && !["adapter", "battery"].includes(options.power)) throw new Error("--power must be adapter or battery");
  if (options.view && !VIEWS.some(view => view.id === options.view)) throw new Error("Unknown view");
  if (!options.help && [options.plan, options.calibrate, options.capture, options["watch-port"]].filter(Boolean).length !== 1) throw new Error("Choose --plan, --calibrate, --capture or --watch-port");
  return options;
}

export async function waitForQuiet(idleSeconds, maxWaitSeconds, readIdle = secondsSinceInput) {
  const deadline = performance.now() + maxWaitSeconds * 1000;
  while (performance.now() < deadline) {
    const idle = await readIdle();
    if (idle === null) throw new Error("Idle telemetry unavailable; refusing a qualified benchmark");
    if (idle >= idleSeconds) return;
    await sleep(1000);
  }
  throw new Error("Machine remained active; no benchmark started");
}

async function attach(chrome, targetId, { resize = true } = {}) {
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  for (const domain of ["Page", "Runtime", "Network"]) await chrome.send(domain + ".enable", {}, sessionId);
  await chrome.send("Performance.enable", { timeDomain: "threadTicks" }, sessionId);
  const dpr = await evaluate(chrome, sessionId, "devicePixelRatio");
  if (resize) await chrome.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: dpr, mobile: false }, sessionId);
  return { sessionId, dpr };
}

async function getPose(chrome, sessionId, target) {
  if (target !== "google-earth") {
    const value = await evaluate(chrome, sessionId, snapshot);
    return value ? cameraPose(value) : null;
  }
  const url = await evaluate(chrome, sessionId, "location.href");
  try { return parseEarthUrl(url); } catch { return null; }
}

async function setView(chrome, sessionId, view) {
  await waitForExpression(chrome, sessionId, `!!${bench}`, 60000);
  await evaluate(chrome, sessionId, `${bench}.setViewState(${JSON.stringify(toFossView(view))})`);
}

async function navigate(chrome, sessionId, url) {
  // Retire the old hook before navigating: warm navigation cannot observe it.
  await evaluate(chrome, sessionId, "delete window.__fossEarthBench");
  const navigation = await chrome.send("Page.navigate", { url }, sessionId);
  if (navigation.errorText) throw new Error("Navigation failed");
  return navigation;
}

function perProcess(before, after, infos) {
  return infos.map(info => {
    const a = before?.table.get(info.id), b = after?.table.get(info.id);
    return { pid: info.id, type: info.type, startedDuringWindow: !a && !!b,
      cpuMs: b && (!a || b.cpuMs >= a.cpuMs) ? b.cpuMs - (a?.cpuMs ?? 0) : null,
      rssBeforeBytes: a?.rssBytes ?? (b ? 0 : null), rssAfterBytes: b?.rssBytes ?? null };
  });
}

/** Collect first, decode afterwards. Ack every cast; bounded buffers fail closed. */
export async function collect(chrome, sessionId, { durationMs, action, thermalHelper, powerMode, idleWatts = null, frameDirectory = null,
  contention = "exclusive", visualCapture = true, ports = {} }) {
  const frames = [], trace = [], poses = [], batteries = [], problems = [];
  const writes = new Set();
  if (frameDirectory) mkdirSync(path.join(frameDirectory, "frames"), { recursive: true });
  let bytes = 0, frameBytes = 0, traceBytes = 0, doneTrace;
  const traceDone = new Promise(resolve => { doneTrace = resolve; });
  const retainFrame = (data, metadata) => {
    if (frames.length >= 50000 || frameBytes > 4 * 1024 ** 3 || writes.size >= 8) {
      if (!problems.includes("screencast-overflow")) problems.push("screencast-overflow");
      return Promise.resolve();
    }
    if (!frameDirectory) {
      if (frameBytes > 256 * 1024 ** 2) { problems.push("screencast-overflow"); return Promise.resolve(); }
      frames.push({ ...metadata, png: data }); return Promise.resolve();
    }
    const file = `frames/${String(frames.length).padStart(5, "0")}.png`;
    frames.push({ ...metadata, file });
    const writing = writeFile(path.join(frameDirectory, file), Buffer.from(data, "base64"))
      .catch(() => { problems.push("screencast-write-failed"); }).finally(() => writes.delete(writing));
    writes.add(writing);
    return writing;
  };
  const readSample = ports.sample ?? sample;
  const before = await readSample({ thermalHelper });
  let beforeMetrics, started = performance.now(), originEpochMs = Date.now(), recording = false;
  const remove = chrome.onEvent(event => {
    if (event.method === "Tracing.dataCollected") {
      const size = JSON.stringify(event.params.value).length;
      traceBytes += size;
      if (traceBytes < 256 * 1024 * 1024) trace.push(...event.params.value); else if (!problems.includes("trace-overflow")) problems.push("trace-overflow");
    }
    if (event.method === "Tracing.tracingComplete") doneTrace();
    if (event.sessionId !== sessionId) return;
    if (event.method === "Network.loadingFinished") bytes += event.params.encodedDataLength;
    if (event.method === "Page.screencastFrame") {
      const { data, sessionId: castId } = event.params;
      const ack = () => chrome.send("Page.screencastFrameAck", { sessionId: castId }, sessionId).catch(() => { problems.push("screencast-ack-failed"); });
      frameBytes += data.length;
      const capturedMs = event.params.metadata?.timestamp * 1000 - originEpochMs;
      if (!recording || capturedMs < 0) { void ack(); return; }
      if (!Number.isFinite(capturedMs)) { problems.push("screencast-timestamp-unavailable"); void ack(); return; }
      void retainFrame(data, { timestampMs: capturedMs, arrivalTimestampMs: performance.now() - started }).finally(ack);
    }
  });
  let stopPolling = false;
  const readPose = async boundary => {
    if (!action?.poseTarget) return;
    try {
      const at = performance.now() - started;
      const pose = await getPose(chrome, sessionId, action.poseTarget);
      const end = performance.now() - started;
      if (pose) poses.push({ timeMs: (at + end) / 2, readSpanMs: end - at, pose, ...(boundary ? { boundary } : {}) });
    } catch { if (!problems.includes("pose-or-power-poll-failed")) problems.push("pose-or-power-poll-failed"); }
  };
  const poll = async () => {
    while (!stopPolling) {
      try {
      if (powerMode === "battery") {
        const reading = await readBattery();
        if (reading.power?.lowPowerMode !== true) Object.assign(reading, { valid: false, reason: "low-power-mode-unconfirmed", watts: null });
        batteries.push(reading);
      }
      await readPose();
      } catch { if (!problems.includes("pose-or-power-poll-failed")) problems.push("pose-or-power-poll-failed"); }
      await sleep(250);
    }
  };
  let polling, afterMetrics, after, infos, ended, actionEndMs;
  try {
    await chrome.send("Tracing.start", { categories: "benchmark,cc,viz,disabled-by-default-display.framedisplayed,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" });
    if (visualCapture) await chrome.send("Page.startScreencast", { format: "png", everyNthFrame: 1 }, sessionId);
    beforeMetrics = await chrome.send("Performance.getMetrics", {}, sessionId);
    started = performance.now(); originEpochMs = Date.now(); recording = true;
    await readPose("start");
    polling = poll();
    await action?.run?.();
    actionEndMs = performance.now() - started;
    await readPose("end");
    await sleep(Math.max(0, durationMs - (performance.now() - started)));
    if (visualCapture) {
      // Final screenshot anchors the final appearance while the cast is still observed.
      const final = await chrome.send("Page.captureScreenshot", { format: "png" }, sessionId);
      ended = performance.now() - started;
      await chrome.send("Page.stopScreencast", {}, sessionId); recording = false;
      await Promise.all(writes);
      while (frames.length && frames.at(-1).timestampMs >= ended) frames.pop();
      await retainFrame(final.data, { timestampMs: ended });
    } else ended = performance.now() - started;
    afterMetrics = await chrome.send("Performance.getMetrics", {}, sessionId);
    after = await readSample({ thermalHelper });
    infos = (await chrome.send("SystemInfo.getProcessInfo")).processInfo;
  } finally {
    stopPolling = true;
    try {
      try { await polling; await Promise.all(writes); } catch { problems.push("capture-cleanup-failed"); }
      if (visualCapture) try { await chrome.send("Page.stopScreencast", {}, sessionId); } catch { problems.push("screencast-stop-failed"); }
      try {
        await chrome.send("Tracing.end");
        let timer; await Promise.race([traceDone, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Trace did not end")), 15000); })]).finally(() => clearTimeout(timer));
      } catch { problems.push("trace-stop-failed"); }
    } finally { remove(); }
  }
  const metric = (values, name) => values.metrics.find(item => item.name === name)?.value ?? null;
  const taskA = metric(beforeMetrics, "TaskDuration"), taskB = metric(afterMetrics, "TaskDuration");
  const processInfo = perProcess(before.processes, after.processes, infos);
  const telemetry = blockTelemetry(before, after, { excludePids: infos.map(info => info.id) });
  const disturbances = [];
  if (telemetry.input.secondsSinceInputAfter === null || telemetry.input.secondsSinceInputAfter < ended / 1000) disturbances.push("user-input-during-run");
  if (!telemetry.processCpu || telemetry.processCpu.otherCores > 1.5) disturbances.push("other-process-load-or-missing-telemetry");
  if (!telemetry.memory || telemetry.memory.pressureBefore !== 1 || telemetry.memory.pressureAfter !== 1 || telemetry.memory.swapoutPages > 0 || telemetry.memory.compressedMiB > 16) disturbances.push("memory-pressure-or-missing-telemetry");
  if (!telemetry.thermal || telemetry.thermal.stateBefore > 0 || telemetry.thermal.stateAfter > 0) disturbances.push("thermal-state-or-missing-telemetry");
  if (telemetry.gpu.idleBefore?.deviceUtilization === undefined || telemetry.gpu.idleBefore.deviceUtilization > 10) disturbances.push("gpu-busy-before-or-missing-telemetry");
  if (contention === "exclusive") problems.push(...disturbances);
  const correctPower = power => powerMode === "battery" ? power?.source === "Battery Power" && power.lowPowerMode === true : power?.source === "AC Power";
  if (powerMode !== "observe" && !(powerMode === "battery" ? [batteries[0]?.power, batteries.at(-1)?.power] : [before.power, after.power]).every(correctPower)) problems.push("power-state-unconfirmed");
  const power = powerMode === "battery" ? summarizePower(batteries, { idleWatts }) : null;
  if (powerMode === "battery" && (power?.status !== "ok" || power.coverage < .95 || power.rejectedSamples > 0 || power.coveredMs < ended * .90 || idleWatts === null)) problems.push("incomplete-power-measurement");
  const traceStart = metric(beforeMetrics, "Timestamp"), traceEnd = metric(afterMetrics, "Timestamp");
  const scopedTrace = traceStart !== null && traceEnd !== null ? trace.filter(event => event.ts >= traceStart * 1e6 && event.ts <= traceEnd * 1e6) : trace;
  if (traceStart === null || traceEnd === null) problems.push("trace-clock-unavailable");
  poses.sort((a, b) => a.timeMs - b.timeMs);
  return { frames, trace: scopedTrace, traceStartUs: traceStart === null ? null : traceStart * 1e6, poses, batteries, problems, disturbances, contention, visualCapture, durationMs: ended, actionEndMs, encodedBytes: bytes,
    taskDurationMs: taskA !== null && taskB !== null ? (taskB - taskA) * 1000 : null,
    jsHeapBytes: metric(afterMetrics, "JSHeapUsedSize"), processes: processInfo, telemetry,
    telemetryBefore: sampleRecord(before), telemetryAfter: sampleRecord(after),
    power };
}

async function saveObservation(directory, record, quality, secrets) {
  const framesDirectory = path.join(directory, "frames"); mkdirSync(framesDirectory, { recursive: true });
  const { frames, trace, ...rest } = record;
  frames.filter(frame => frame.png).forEach((frame, index) => {
    const png = Buffer.from(frame.png, "base64");
    writeFileSync(path.join(framesDirectory, `${String(index).padStart(5, "0")}.png`), png);
  });
  const pngBytes = frame => frame.png ? Buffer.from(frame.png, "base64") : readFileSync(path.join(directory, frame.file));
  const finalPng = frames.length ? pngBytes(frames.at(-1)) : null;
  const dimensions = finalPng ? { width: finalPng.readUInt32BE(16), height: finalPng.readUInt32BE(20) } : null;
  // Decompression and comparison happen offline, after reviewing the exact final PNG.
  const visual = { status: "pending", reason: "unreviewed-final-frame", timeMs: null };
  const intervals = frameIntervals(trace);
  const summary = { ...rest, frames: frames.map((frame, index) => ({ timestampMs: frame.timestampMs, file: `frames/${String(index).padStart(5, "0")}.png` })),
    finalSha256: finalPng ? createHash("sha256").update(finalPng).digest("hex") : null, dimensions,
    visual, frameIntervals: intervals, qualified: false, qualityReview: "pending-exact-final-frame-review" };
  writeFileSync(path.join(directory, "trace.json"), JSON.stringify(redact({ traceEvents: trace }, secrets)));
  writeFileSync(path.join(directory, "observation.json"), JSON.stringify(redact(summary, secrets), null, 2) + "\n");
  return summary;
}

async function calibrationOverlays(output, viewId, view, policy) {
  const { decodePng, encodePng } = await import("@foss-earth/images/node");
  const entry = view["google-earth"];
  if (!entry) return;
  const loadFinal = target => {
    const folder = path.join(output, view[target].directory);
    const record = JSON.parse(readFileSync(path.join(folder, "observation.json"), "utf8"));
    const geometry = renderGeometry(record.renderInfo);
    const image = decodePng(readFileSync(path.join(folder, record.frames.at(-1).file)));
    return { geometry, image: geometry.valid ? cropRenderImage(image, geometry) : null };
  };
  const earth = loadFinal("google-earth");
  const overlays = {};
  for (const target of ["local", "published"]) {
    if (!view[target]) continue;
    const foss = loadFinal(target);
    const comparison = compareRenderGeometry(earth.geometry, foss.geometry);
    if (!comparison.matched) { overlays[target] = { error: "render geometry differs", comparison }; continue; }
    const rgb = new Uint8Array(foss.image.width * foss.image.height * 3);
    for (let p = 0; p < foss.image.width * foss.image.height; p++) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round((foss.image.data[p * 4 + c] + earth.image.data[p * 4 + c]) / 2);
    const file = `${viewId}-${target}-overlay.png`;
    // Paths are from our own calibration records, never from the page.
    const relative = path.join("overlays", file);
    mkdirSync(path.join(output, "overlays"), { recursive: true });
    writeFileSync(path.join(output, relative), encodePng({ width: foss.image.width, height: foss.image.height, rgb }));
    const mask = imageMask(foss.image.width, foss.image.height, policy), maskRgb = new Uint8Array(mask.length * 3);
    for (let p = 0; p < mask.length; p++) maskRgb.fill(mask[p] * 255, p * 3, p * 3 + 3);
    const maskFile = path.join("overlays", `${viewId}-${target}-mask.png`);
    writeFileSync(path.join(output, maskFile), encodePng({ width: foss.image.width, height: foss.image.height, rgb: maskRgb }));
    overlays[target] = { file: relative, maskFile, imagePolicySha256: imagePolicyDigest(policy), blend: .5, reviewed: false, comparison };
  }
  view.overlays = overlays;
}

async function moveGoogle(chrome, sessionId, motion) {
  if (!motion.shortcutVerified || !motion.keys?.length) throw new Error("Motion has no verified keyboard mapping");
  for (const key of motion.keys) await chrome.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, sessionId);
  try { await sleep(motion.durationMs); } finally {
    for (const key of [...motion.keys].reverse()) await chrome.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, sessionId);
  }
}

async function replayFoss(chrome, sessionId, samples) {
  // The actual snapshots are separately sampled through CDP, not assumed from the requested path.
  const sequence = samples.map(({ timeMs, pose }) => ({ timeMs, view: { latDeg: pose.latDeg, lonDeg: pose.lonDeg,
    headingDeg: pose.headingDeg, pitchDeg: pose.pitchDeg, zoomMeters: pose.zoomMeters } }));
  if (sequence.length < 3) throw new Error("Google Earth's camera path has too few samples to replay");
  await evaluate(chrome, sessionId, `(async () => {
    const s=${JSON.stringify(sequence)}, start=performance.now(); let i=0;
    await new Promise(resolve => { function frame(now) {
      const t=now-start; while(i+1<s.length && s[i+1].timeMs<=t) i++;
      const a=s[i], b=s[Math.min(i+1,s.length-1)], u=b.timeMs>a.timeMs?Math.max(0,Math.min(1,(t-a.timeMs)/(b.timeMs-a.timeMs))):0;
      const v={}; for(const name of ['latDeg','lonDeg','headingDeg','pitchDeg','zoomMeters']) {
        let d=b.view[name]-a.view[name]; if(name==='headingDeg'||name==='lonDeg') d=((d+540)%360)-180;
        v[name]=a.view[name]+d*u;
      } ${bench}.setViewState(v);
      if(t<s[s.length-1].timeMs) requestAnimationFrame(frame); else resolve();
    } requestAnimationFrame(frame); });
  })()`);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(help); return; }
  const views = options.view ? VIEWS.filter(view => view.id === options.view) : VIEWS;
  const masks = options.masks ? JSON.parse(readFileSync(options.masks, "utf8")) : {};
  if (!masks || typeof masks !== "object" || Array.isArray(masks) || Object.keys(masks).some(id => !VIEWS.some(view => view.id === id))) throw new Error("Masks must be keyed by known view ids");
  const imagePolicies = Object.fromEntries(views.map(view => [view.id, withImageMask(masks[view.id])]));
  if (options.plan) { console.log(JSON.stringify({ views, motions: MOTIONS, imagePolicies,
    repeats: options.runs, repeatStart: options["repeat-start"], order: Array.from({ length: options.runs }, (_, r) => runOrder(r + options["repeat-start"])), viewport: VIEWPORT,
    minimumCaptureSeconds: views.length * 3 * options.runs * (8 * options["load-seconds"] + 90),
    minimumCalibrationSeconds: views.length * (9 * options["load-seconds"] + 30),
    phases: ["cold", "warm", "idle-60s", "pan-10s", "orbit-10s", "zoom-10s"], qualification: "requires reviewed calibration and real power/camera/detail evidence" }, null, 2)); return; }
  const output = newOutputDirectory("benchmarks", "earth-compare");
  const secrets = [];
  const write = (file, value) => writeFileSync(path.join(output, file), JSON.stringify(redact(value, secrets), null, 2) + "\n");
  let server;
  const observations = [], calibration = {};
  try {
    const powerMode = options.power ?? "adapter";
    const qualification = options.qualification ? JSON.parse(readFileSync(options.qualification, "utf8")) : {};
    const calibrated = options.calibration ? JSON.parse(readFileSync(options.calibration, "utf8")) : {};
    write("method.json", { schema: 2, imagePolicies, imagePolicySha256: Object.fromEntries(Object.entries(imagePolicies).map(([id, policy]) => [id, imagePolicyDigest(policy)])) });
    let idleWatts = null;
    if (options.baseline) {
      const baseline = JSON.parse(readFileSync(options.baseline, "utf8"));
      if (baseline.kind !== "idle" || baseline.summary?.status !== "ok" || baseline.summary.coverage < .95 || baseline.configuration?.brightness !== options.brightness) throw new Error("Idle baseline is invalid or brightness differs");
      idleWatts = baseline.summary.wholeMachineWatts;
    }
    if (options.capture) {
      for (const view of views) for (const target of ["google-earth", "published", "local"]) {
        const reasons = qualificationReasons(qualification[view.id]?.[target], { powerMode, brightness: options.brightness, idleBaseline: idleWatts, imagePolicy: imagePolicies[view.id] });
        if (!calibrated[view.id]?.imagePolicy || imagePolicyDigest(calibrated[view.id].imagePolicy) !== imagePolicyDigest(imagePolicies[view.id])) reasons.push("Common mask differs from calibration");
        if (reasons.length || !calibrated[view.id]?.[target]) throw new Error(`Missing qualification/calibration for ${view.id}/${target}: ${reasons.join("; ")}`);
      }
    }
    const initialPower = powerMode === "battery" ? (await readBattery()).power : await readPower();
    write("environment.json", await environment({ configuration: options, initialPower, imagePolicy: IMAGE_POLICY, viewport: VIEWPORT }));
    if (options.capture && (powerMode === "battery" ? initialPower?.source !== "Battery Power" || initialPower.lowPowerMode !== true : initialPower?.source !== "AC Power")) throw new Error("Required power state is not confirmed by system telemetry");
    const thermal = await ensureThermalHelper(output);
    if (options["watch-port"]) {
      const chrome = await connectWatcher(Number(options["watch-port"]));
      let watchedSession;
      try {
        const targets = (await chrome.send("Target.getTargets")).targetInfos.filter(t => t.type === "page" && t.url.startsWith("https://earth.google.com/web/"));
        if (targets.length !== 1) throw new Error("Watcher needs exactly one signed-out Google Earth tab in a dedicated disposable profile under build/");
        const { sessionId } = await attach(chrome, targets[0].targetId, { resize: false });
        watchedSession = sessionId;
        const directory = path.join(output, "manual"); mkdirSync(directory);
        const record = await collect(chrome, sessionId, { durationMs: options["load-seconds"] * 1000, thermalHelper: thermal.path,
              powerMode, frameDirectory: directory, action: { poseTarget: "google-earth" } });
        record.problems.push("manual-observation-unmatched");
        Object.assign(record, { directory: "manual", target: "google-earth", view: views[0].id, phase: "manual", kind: "motion", imagePolicy: IMAGE_POLICY, powerMode });
        observations.push(await saveObservation(directory, record, null, secrets));
        write("observations.json", observations);
      } finally {
        try { if (watchedSession) await chrome.send("Target.detachFromTarget", { sessionId: watchedSession }); }
        finally { await chrome.close(); }
      }
      return;
    }
    if (!options["local-dist"]) throw new Error("Supply a built app with --local-dist");
    server = await serveBuild(options["local-dist"]);
    const key = readGoogleKey(); secrets.push(key);
    const repeats = options.calibrate ? 1 : options.runs;
    for (let offset = 0; offset < repeats; offset++) for (const view of views) {
      const repeat = offset + options["repeat-start"];
      // Calibration establishes FOSS's measured target altitude/FOV before opening GE.
      const order = options.calibrate ? ["local", "published", "google-earth"] : runOrder(repeat);
      calibration[view.id] ??= {};
      const imagePolicy = imagePolicies[view.id];
      calibration[view.id].imagePolicy = imagePolicy;
      for (const target of order) {
        await waitForQuiet(options["idle-seconds"], options["max-wait-seconds"]);
        const directory = path.join(output, `${view.id}-${repeat}-${target}`); mkdirSync(directory);
        const browser = await openChrome(directory), chrome = browser.chrome;
        let activeSession;
        try {
          const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
          for (const tab of (await chrome.send("Target.getTargets")).targetInfos) {
            if (tab.type === "page" && tab.targetId !== targetId) await chrome.send("Target.closeTarget", { targetId: tab.targetId });
          }
          const { sessionId, dpr } = await attach(chrome, targetId);
          activeSession = sessionId;
          if (target !== "google-earth") await chrome.send("Page.addScriptToEvaluateOnNewDocument", { source: settingsScript(key,
            new URL(target === "published" ? "https://foss-earth.github.io/app/" : server.url).origin) }, sessionId);
          const reference = (options.calibrate ? calibration : calibrated)[view.id]?.local?.pose;
          if (target === "google-earth" && !reference) throw new Error("Calibrate the local camera first");
          const url = target === "google-earth" ? toEarthUrl(reference) : `${target === "published" ? "https://foss-earth.github.io/app/" : server.url}?bench=1`;
          const quality = qualification[view.id]?.[target];
          let earthPolicy = null;
          for (const phase of options.calibrate ? ["calibration"] : ["cold", "warm", "idle"]) {
            const phaseDir = path.join(directory, phase); mkdirSync(phaseDir);
            const record = await collect(chrome, sessionId, { durationMs: (phase === "idle" ? 60 : options["load-seconds"]) * 1000,
              thermalHelper: thermal.path, powerMode, idleWatts, frameDirectory: phaseDir,
              action: { async run() {
                if (phase === "idle") return;
                await navigate(chrome, sessionId, url);
                if (target !== "google-earth") await setView(chrome, sessionId, view);
                else earthPolicy = await prepareEarth(chrome, sessionId, { timeoutMs: 60000 });
              } } });
            const pose = await getPose(chrome, sessionId, target);
            if (!pose) record.problems.push("camera-pose-unavailable");
            const expected = reference ?? { ...toFossView(view) };
            const comparison = pose ? comparePoses(expected, pose) : null;
            if (!comparison?.matched) record.problems.push("camera-pose-mismatch");
            if (target === "google-earth" && !earthPolicy?.policyVerified) record.problems.push("google-clean-map-policy-unverified");
            if (target === "google-earth" && phase !== "idle") record.problems.push("google-ui-preparation-in-timed-window");
            const renderInfo = await earthRenderInfo(chrome, sessionId);
            const referenceRenderInfo = (options.calibrate ? calibration : calibrated)[view.id]?.local?.renderInfo ?? (target === "local" ? renderInfo : null);
            const geometryComparison = compareRenderGeometry(renderGeometry(referenceRenderInfo), renderGeometry(renderInfo));
            if (!geometryComparison.matched) record.problems.push("render-geometry-unmatched");
            record.problems.push(...maskUiReasons(renderInfo, renderGeometry(renderInfo), imagePolicy));
            const detail = target === "google-earth" ? null : await evaluate(chrome, sessionId,
              `({ tiles:${bench}.runtime.getTileMetrics(),detail:${bench}.runtime.getGoogleTerrainDetailState(), canvas:[${bench}.runtime.scene.getEngine().getRenderWidth(),${bench}.runtime.scene.getEngine().getRenderHeight()] })`);
            Object.assign(record, { target, view: view.id, repeat, phase, kind: phase === "idle" ? "idle" : "load", pose, requestedView: view,
              cameraComparison: comparison, detail, renderInfo, referenceRenderInfo, geometryComparison, earthPolicy, headed: true, devicePixelRatio: dpr, imagePolicy, powerMode,
              directory: path.relative(output, phaseDir) });
            const saved = await saveObservation(phaseDir, record, quality, secrets);
            observations.push(saved);
            write("observations.json", observations);
            if (options.calibrate) calibration[view.id][target] = { pose, directory: path.relative(output, phaseDir), devicePixelRatio: dpr, renderInfo, earthPolicy, cameraComparison: comparison };
            if (options.calibrate) write("calibration.json", calibration);
          }
          if (options.capture || (options.calibrate && target === "google-earth")) for (const motion of MOTIONS) {
            const name = motion.id ?? motion.name;
            // Each motion starts from the same settled pose. No app's tile cache is copied.
            await navigate(chrome, sessionId, url);
            if (target !== "google-earth") await setView(chrome, sessionId, view);
            else earthPolicy = await prepareEarth(chrome, sessionId, { timeoutMs: 60000 });
            await sleep(options["load-seconds"] * 1000);
            const renderInfoBefore = await earthRenderInfo(chrome, sessionId);
            const recorded = calibrated[view.id]?.motions?.[name];
            if (options.capture && !recorded) throw new Error(`Calibrate the Google Earth ${view.id}/${name} camera path first`);
            const motionDir = path.join(directory, name); mkdirSync(motionDir);
            // One uninterrupted cast/trace covers motion and subsequent settling.
            const record = await collect(chrome, sessionId, { durationMs: motion.durationMs + options["load-seconds"] * 1000,
              thermalHelper: thermal.path, powerMode, idleWatts, frameDirectory: motionDir, action: { poseTarget: target, run: () => target === "google-earth" ? moveGoogle(chrome, sessionId, motion) : replayFoss(chrome, sessionId, recorded) } });
            const moving = record.poses.filter(p => p.timeMs <= record.actionEndMs + 50);
            if (options.calibrate) {
              (calibration[view.id].motions ??= {})[name] = moving;
            }
            const pathComparison = recorded ? comparePaths(recorded, moving, { durationMs: motion.durationMs }) : null;
            if (!pathComparison?.matched) record.problems.push("camera-motion-unmatched");
            if (target === "google-earth" && !earthPolicy?.policyVerified) record.problems.push("google-clean-map-policy-unverified");
            const renderInfo = await earthRenderInfo(chrome, sessionId), referenceRenderInfo = (options.calibrate ? calibration : calibrated)[view.id]?.local?.renderInfo ?? null;
            const geometryComparison = compareRenderGeometry(renderGeometry(referenceRenderInfo), renderGeometry(renderInfo));
            const geometryStable = compareRenderGeometry(renderGeometry(renderInfoBefore), renderGeometry(renderInfo)).matched
              && JSON.stringify(renderGeometry(renderInfoBefore).rect) === JSON.stringify(renderGeometry(renderInfo).rect);
            if (!geometryComparison.matched || !geometryStable) record.problems.push("render-geometry-unmatched-or-changed");
            record.problems.push(...maskUiReasons(renderInfoBefore, renderGeometry(renderInfoBefore), imagePolicy), ...maskUiReasons(renderInfo, renderGeometry(renderInfo), imagePolicy));
            Object.assign(record, { target, view: view.id, repeat, phase: name, kind: "motion", pathComparison, motionDurationMs: motion.durationMs,
              renderInfo, referenceRenderInfo, renderInfoBefore, geometryComparison, geometryStable, earthPolicy, headed: true,
              imagePolicy, powerMode, directory: path.relative(output, motionDir) });
            const saved = await saveObservation(motionDir, record, quality, secrets); observations.push(saved);
            write("observations.json", observations);
          }
        } catch (error) {
          writeFileSync(path.join(directory, "failure.json"), JSON.stringify(redact({ error: error.message }, secrets), null, 2));
          if (activeSession) {
            try {
              const screenshot = await chrome.send("Page.captureScreenshot", { format: "png" }, activeSession);
              writeFileSync(path.join(directory, "failure.png"), Buffer.from(screenshot.data, "base64"));
            } catch { /* Retain the original failure even if the renderer died. */ }
          }
          throw error;
        } finally { await browser.close(); }
      }
      write("observations.json", observations);
      if (options.calibrate) { await calibrationOverlays(output, view.id, calibration[view.id], imagePolicy); write("calibration.json", calibration); }
    }
    const groups = {};
    for (const row of observations) {
      const key = `${row.view}/${row.target}/${row.phase}`;
      (groups[key] ??= []).push(row);
    }
    write("summary.json", Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, { accepted: rows.filter(r => r.qualified).length,
      observations: rows.length, statistics: aggregate(rows.filter(r => r.qualified).map(r => ({ encodedBytes: r.encodedBytes, visuallyCompleteMs: r.visual.timeMs,
        taskDurationMs: r.taskDurationMs, jsHeapBytes: r.jsHeapBytes, frameP50: r.frameIntervals.p50, frameP95: r.frameIntervals.p95, frameP99: r.frameIntervals.p99, wattsOverIdle: r.power?.wattsOverIdle }))) }])));
  } catch (error) {
    write("observations.json", observations);
    if (options.calibrate) write("calibration.json", calibration);
    write("failure.json", { error: error.message, observations: observations.length });
    throw new Error(redact(error.message, secrets));
  } finally { await server?.close(); console.log(output); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
