#!/usr/bin/env node
/**
 * The report's figures, as SVG that follows the reader's light or dark
 * setting, with Phase 1's chart helpers. Every figure is drawn from results/
 * and its table view is results/tables.md or the CSV named in its notes.
 *
 *   node benchmarks/eac-progressive-prototype/make-plots.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Figure, linePanel, niceTicks, rangePanel } from "../spherical-image-representation/lib/svg.mjs";
import { median, readRows } from "./lib/analysis.mjs";
import { plotsDirectory, resultsDirectory } from "./lib/paths.mjs";

mkdirSync(plotsDirectory, { recursive: true });
const load = name => { const file = path.join(resultsDirectory, name); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; };
const write = (name, figure) => { writeFileSync(path.join(plotsDirectory, name), figure.toString()); console.log(path.join(plotsDirectory, name)); };
const SLOTS = { direct: 1, "eac-direct": 1, levels: 2, "eac-levels": 2, residual: 3, "eac-residual": 3, cube: 4, "cube-direct": 4, control: 5, A: 1, "B-level0-2slots": 2, "B-level1-2slots": 3, "B-level2-2slots": 4, "B-level1-6slots": 6 };
const LABEL = { direct: "EAC, finest level at once", "eac-direct": "EAC, finest level at once", levels: "EAC, every level", "eac-levels": "EAC, every level", residual: "EAC, residual", "eac-residual": "EAC, residual", cube: "cubemap, finest level at once", "cube-direct": "cubemap, finest level at once", control: "current: preview, then whole 6144 image", A: "A: the view only", "B-level0-2slots": "B: then level 0 everywhere", "B-level1-2slots": "B: then level 1 everywhere", "B-level2-2slots": "B: then level 2 everywhere", "B-level1-6slots": "B: level 1, six requests" };

/** Median over runs of a value at each sample time, binned to the quarter second. */
function medianCurve(runs, value, field = "samples") {
  const bins = new Map();
  for (const run of runs) for (const sample of run[field]) {
    const v = value(sample);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const t = Math.round(sample.t / 250) * 0.25;
    if (!bins.has(t)) bins.set(t, []);
    bins.get(t).push(v);
  }
  return [...bins].sort((a, b) => a[0] - b[0]).filter(([, list]) => list.length >= runs.length / 2).map(([t, list]) => [t, median(list)]);
}
const seconds = upTo => ({ label: "seconds after entering", domain: [0, upTo], ticks: niceTicks(0, upTo, 6).map(value => ({ value, label: String(value) })) });

// ─── Quality against time, simulated ───────────────────────────────────

const simSeries = load("sim-series.json");
if (simSeries) {
  const figure = new Figure({ width: 980, title: "How far the view is below its own finished picture, over time (simulation)", subtitle: "Phase 1's network model with the real client; median over three panoramas and four start orientations. Lower is better. The quick turn begins at 2 s and ends at 2.6 s." });
  const panels = [["stationary", "constrained-mobile", "Looking forward, 2 Mbit/s"], ["stationary", "very-constrained", "Looking forward, 0.75 Mbit/s"], ["quick-turn", "constrained-mobile", "Quick turn, 2 Mbit/s"], ["quick-turn", "very-constrained", "Quick turn, 0.75 Mbit/s"]];
  panels.forEach(([trace, profile, title], k) => {
    const series = ["direct", "levels", "residual"].map(variant => ({ name: LABEL[variant], slot: SLOTS[variant], markers: false, points: medianCurve(simSeries.filter(run => run.set === "policies" && run.variant === variant && run.trace === trace && run.profile === profile), sample => sample.shortfall) }));
    series.push({ name: LABEL.cube, slot: SLOTS.cube, markers: false, points: medianCurve(simSeries.filter(run => run.set === "representation" && run.variant === "cube" && run.trace === trace && run.profile === profile), sample => sample.shortfall) });
    linePanel(figure, { x: 16 + (k % 2) * 480, y: figure.cursor + Math.floor(k / 2) * 250, w: 460, h: 240 }, { title, x: seconds(trace === "quick-turn" ? 10 : 6), y: { label: "dB below its own finished view", domain: [0, 20], ticks: [0, 1, 3, 5, 10, 15, 20] }, series });
  });
  figure.cursor += 510;
  figure.legend(["direct", "levels", "residual", "cube"].map(variant => ({ name: LABEL[variant], slot: SLOTS[variant] })), figure.cursor); figure.cursor += 30;
  figure.notes(["1 dB and 3 dB are Phase 1's \"high\" and \"acceptable\", kept for continuity; they are not validated perceptual limits. Rows: results/sim.csv; series: results/sim-series.json."]);
  write("quality-vs-time-sim.svg", figure);

  // Quality against bytes received, one panorama per panel, absolute.
  const bytesFigure = new Figure({ width: 980, title: "View quality against bytes received, looking forward (simulation, 2 Mbit/s)", subtitle: "Absolute PSNR of the view against the source, every quarter second, median over four start orientations; one panel per panorama." });
  ["northrop-mall", "bookstore", "superblock"].forEach((panorama, k) => {
    const series = ["direct", "levels", "residual"].map(variant => {
      const runs = simSeries.filter(run => run.set === "policies" && run.variant === variant && run.trace === "stationary" && run.profile === "constrained-mobile" && run.panorama === panorama);
      const bytes = medianCurve(runs, sample => sample.bytes / 1024), quality = medianCurve(runs, sample => sample.psnr), byTime = new Map(bytes);
      return { name: LABEL[variant], slot: SLOTS[variant], markers: false, points: quality.filter(([t]) => byTime.has(t)).map(([t, q]) => [byTime.get(t), q]) };
    });
    const all = series.flatMap(item => item.points.map(point => point[1])), low = Math.floor(Math.min(...all)), high = Math.ceil(Math.max(...all));
    linePanel(bytesFigure, { x: 16 + k * 320, y: bytesFigure.cursor, w: 310, h: 260 }, { title: panorama, x: { label: "KiB received", domain: [0, 500], ticks: [0, 100, 200, 300, 400, 500].map(value => ({ value, label: String(value) })) }, y: { label: "view PSNR, dB", domain: [low, high], ticks: niceTicks(low, high, 5) }, series });
  });
  bytesFigure.cursor += 270;
  bytesFigure.legend(["direct", "levels", "residual"].map(variant => ({ name: LABEL[variant], slot: SLOTS[variant] })), bytesFigure.cursor); bytesFigure.cursor += 30;
  bytesFigure.notes(["Series: results/sim-series.json."]);
  write("quality-vs-bytes-sim.svg", bytesFigure);

  // Insurance: the quick turn.
  const insurance = new Figure({ width: 980, title: "A quick turn with and without background insurance (simulation)", subtitle: "Median over three panoramas and three start orientations of how far the view is below its own finished picture. The turn ends at 2.6 s." });
  [["moderate-mobile", "10 Mbit/s"], ["constrained-mobile", "2 Mbit/s"]].forEach(([profile, label], k) => {
    const series = ["A", "B-level0-2slots", "B-level1-2slots", "B-level2-2slots"].map(variant => ({ name: LABEL[variant], slot: SLOTS[variant], markers: false, points: medianCurve(simSeries.filter(run => run.set === "insurance" && run.variant === variant && run.trace === "quick-turn" && run.profile === profile), sample => sample.shortfall) }));
    linePanel(insurance, { x: 16 + k * 480, y: insurance.cursor, w: 460, h: 240 }, { title: label, x: seconds(6), y: { label: "dB below its own finished view", domain: [0, 20], ticks: [0, 1, 3, 5, 10, 15, 20] }, series });
  });
  insurance.cursor += 250;
  insurance.legend(["A", "B-level0-2slots", "B-level1-2slots", "B-level2-2slots"].map(variant => ({ name: LABEL[variant], slot: SLOTS[variant] })), insurance.cursor); insurance.cursor += 30;
  insurance.notes(["What insurance costs a person who never turns is in results/tables.md (policy A against policy B, looking forward)."]);
  write("quick-turn-insurance-sim.svg", insurance);
}

// ─── Real HTTP ─────────────────────────────────────────────────────────

const httpSeries = load("http-series.json");
if (httpSeries) {
  const figure = new Figure({ width: 980, title: "View quality over time over throttled real HTTP (loopback, Chrome's emulation, WebGL 2)", subtitle: "Absolute PSNR against the source, median over two repetitions; one panorama per row. The current path shows its 64-texel preview, then the whole 6144 image." });
  const variants = ["eac-direct", "eac-levels", "eac-residual", "cube-direct", "control"];
  const rows = [["northrop-mall", "constrained-mobile"], ["superblock", "constrained-mobile"], ["northrop-mall", "very-constrained"]];
  rows.forEach(([panorama, profile], r) => ["stationary", "quick-turn"].forEach((trace, c) => {
    const series = variants.map(variant => ({ name: LABEL[variant], slot: SLOTS[variant], markers: false, points: medianCurve(httpSeries.filter(run => run.set === "main" && run.variant === variant && run.trace === trace && run.profile === profile && run.panorama === panorama), point => point.psnr, "points") }));
    const values = series.flatMap(item => item.points.map(point => point[1])), low = Math.floor(Math.min(...values, 30) / 2) * 2, high = Math.ceil(Math.max(...values, 30) / 2) * 2;
    linePanel(figure, { x: 16 + c * 480, y: figure.cursor + r * 250, w: 460, h: 240 }, { title: `${panorama}, ${trace}, ${profile === "constrained-mobile" ? "2" : "0.75"} Mbit/s`, x: seconds(10), y: { label: "view PSNR, dB", domain: [low, high], ticks: niceTicks(low, high, 5) }, series });
  }));
  figure.cursor += 760;
  figure.legend(variants.map(variant => ({ name: LABEL[variant], slot: SLOTS[variant] })), figure.cursor); figure.cursor += 30;
  figure.notes(["The 6144 image lies on the source's own grid and scores higher against it than any resampled grid can; compare times, not final levels, between it and the tiles. Rows: results/http.csv."]);
  write("quality-vs-time-http.svg", figure);

  // Resources over a long exploring trace with a small budget.
  const stress = httpSeries.filter(run => run.set === "stress");
  if (stress.length) {
    const resource = new Figure({ width: 980, title: "Resources held over three laps of the exploring trace, 64 GPU slots (real HTTP, 10 Mbit/s)", subtitle: "Every quarter second: tiles resident in the GPU atlas, texels held on the CPU, requests in flight." });
    [["residentTiles", "tiles resident (of 64)", [0, 70]], ["decodedBytes", "texels held on the CPU, MiB", [0, 8]], ["inflightRequests", "requests in flight", [0, 8]]].forEach(([key, label, domain], k) => {
      const series = stress.map((run, i) => ({ name: run.variant, slot: i + 1, markers: false, points: run.points.filter(point => point[key] !== undefined).map(point => [point.t / 1000, key === "decodedBytes" ? point[key] / 2 ** 20 : point[key]]) }));
      linePanel(resource, { x: 16 + k * 320, y: resource.cursor, w: 310, h: 240 }, { title: label, x: seconds(48), y: { domain, ticks: niceTicks(domain[0], domain[1], 4) }, series });
    });
    resource.cursor += 250;
    resource.legend(stress.map((run, i) => ({ name: run.variant, slot: i + 1 })), resource.cursor); resource.cursor += 30;
    write("resources-over-time-http.svg", resource);
  }
}

// ─── Frames ────────────────────────────────────────────────────────────

const http = readRows("http").filter(row => ["backends", "busy"].includes(row.set));
if (http.length) {
  const figure = new Figure({ width: 980, title: "Frame intervals and the main thread's work per frame while tiles arrive (not throttled)", subtitle: "Band: median to 99th percentile over each run's frames; whiskers to the longest; dot at the median. Two runs per row, their medians. This desktop meets its display rate either way; the long frames are what to look at." });
  const groups = new Map();
  for (const row of http) { const key = `${row.set === "busy" ? "core busy, " : ""}${row.backendActual}, ${row.variant}, ${row.trace}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  const rows = [...groups].map(([label, list], i) => ({ label, slot: list[0].variant === "control" ? 5 : list[0].variant.includes("residual") ? 3 : list[0].variant.includes("mesh") ? 6 : 1, low: median(list.map(row => row.frameIntervalMedian)), mark: median(list.map(row => row.frameIntervalMedian)), high: median(list.map(row => row.frameIntervalP99)), min: median(list.map(row => row.frameIntervalMedian)), max: median(list.map(row => row.frameIntervalMax)), text: `p99 ${median(list.map(row => row.frameIntervalP99)).toFixed(1)}, max ${median(list.map(row => row.frameIntervalMax)).toFixed(1)} ms`, order: i }));
  figure.cursor += rangePanel(figure, { x: 16, y: figure.cursor, w: 948 }, { title: "Frame interval, ms", domain: [10, 60], ticks: [16.7, 20, 33.3, 50].map(value => ({ value, label: String(value) })), labelWidth: 330, valueWidth: 170, rows });
  const work = [...groups].map(([label, list]) => ({ label, slot: list[0].variant === "control" ? 5 : 1, low: 0, mark: median(list.map(row => row.worstUploadFrameWorkMs)), high: median(list.map(row => row.worstUploadFrameWorkMs)), text: `${median(list.map(row => row.worstUploadFrameWorkMs)).toFixed(1)} ms` }));
  figure.cursor += 10;
  figure.cursor += rangePanel(figure, { x: 16, y: figure.cursor, w: 948 }, { title: "The worst frame that uploaded anything: main-thread work (tick or upload pump, plus render call), ms", domain: [0, 40], ticks: [0, 5, 10, 16.7, 20, 30, 40].map(value => ({ value, label: String(value) })), labelWidth: 330, valueWidth: 170, rows: work });
  figure.notes(["Rows: results/http.csv (sets backends and busy); every frame of the first repetition: results/http-frames.json. WebGL 1's GPU timer is invalid here and is not shown."]);
  write("frame-times-http.svg", figure);
}
