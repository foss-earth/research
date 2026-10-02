#!/usr/bin/env node
/**
 * Draws the report's figures from results/*.csv and results/*.json into
 * plots/*.svg. A figure whose results are missing is skipped.
 *
 *   node benchmarks/spherical-image-representation/make-plots.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { plotsDirectory } from "./lib/environment.mjs";
import { NAMES, ORDER, SLOT, atLogX, formatSamples, groupBy, kib, logXAt, mean, readCsv, readJson, stateAt, upperEnvelope } from "./lib/analysis.mjs";
import { Figure, barPanel, linePanel, niceTicks, rangePanel, stackPanel } from "./lib/svg.mjs";

mkdirSync(plotsDirectory, { recursive: true });
const written = [];
function save(name, figure) { writeFileSync(path.join(plotsDirectory, `${name}.svg`), figure.toString()); written.push(name); }
const signed = (value, digits = 2) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
const SHORT = { eac: "Equi-angular", qsc: "QSC", "oct-ea": "equal-area", oct: "L1", "ico-rhombus": "rhombus", "ico-hex": "hexagon", "ico-tri": "triangle" };
const FAMILIES = [
  { title: "Cubed spheres", members: ["cube", "eac", "qsc"] },
  { title: "Octahedral squares", members: ["oct-ea", "toast", "oct"] },
  { title: "HEALPix", members: ["healpix"] },
  { title: "Icosahedral", members: ["ico-rhombus", "ico-hex", "ico-tri"] },
];
/** Four panels, one per family, each with the control in grey. `draw(box, family)` draws one. */
function familyPanels(figure, height, draw) {
  const gap = 16, width = (figure.width - 32 - gap) / 2;
  FAMILIES.forEach((family, k) => draw({ x: 16 + (k % 2) * (width + gap), y: figure.cursor + Math.floor(k / 2) * (height + 14), w: width, h: height }, family));
  figure.cursor += 2 * height + 14 + 4;
}

// ─── 6, 7: cell areas and cell shapes ──────────────────────────────────

const geometry = readJson("geometry");
if (geometry) {
  const finest = ORDER.filter(id => id !== "ico-hex").map(id => geometry.results.filter(result => result.representation === id).sort((a, b) => b.samples - a.samples)[0]).filter(Boolean);
  {
    const figure = new Figure({ title: "Cell areas", subtitle: "Solid angle of a cell relative to an equal share of the sphere. Band: 1st to 99th percentile of cells; whiskers: smallest and largest; dot: median. About 800,000 cells each." });
    const used = rangePanel(figure, { x: 16, y: figure.cursor, w: figure.width - 32 }, {
      domain: [0.003, 3], log: true, label: "cell area ÷ mean cell area (log scale)", valueWidth: 200,
      ticks: [0.003, 0.01, 0.03, 0.1, 0.3, 1, 3].map(value => ({ value, label: String(value), reference: value === 1 })),
      rows: finest.map(result => ({
        label: NAMES[result.representation], min: result.area.min, low: result.area.p01, mark: result.area.median, high: result.area.p99, max: result.area.max,
        text: result.area.maxOverMin < 1.02 ? "equal area" : result.representation === "equirect" ? `largest ÷ smallest ${Math.round(result.area.maxOverMin)} here` : `largest ÷ smallest ${result.area.maxOverMin.toFixed(2)}`,
      })),
    });
    figure.cursor += used;
    figure.notes(["Equirectangular cells shrink without limit toward the poles, so its ratio grows with resolution. The others' ratios are properties of the map and do not."]);
    save("cell-area", figure);
  }
  {
    const figure = new Figure({ title: "Cell shape and sample spacing", subtitle: "Two different things. Left: how elongated a cell is in its chart. Right: how many samples the lattice spends for each sample an ideal hexagonal lattice would need to leave no direction farther from a sample. Band: 1st to 99th percentile; dot: area-weighted mean." });
    const width = (figure.width - 32 - 16) / 2;
    const rows = key => finest.map(result => ({ label: NAMES[result.representation], low: result[key].p01, high: result[key].p99, mark: result[key].areaWeightedMean, text: result[key].areaWeightedMean.toFixed(2) }));
    const a = rangePanel(figure, { x: 16, y: figure.cursor, w: width }, { title: "Cell elongation in the chart", domain: [1, 4], ticks: [1, 2, 3, 4].map(value => ({ value, label: String(value), reference: value === 1 })), label: "long ÷ short axis", valueWidth: 44, labelWidth: 140, rows: rows("chartAspect") });
    rangePanel(figure, { x: 16 + width + 16, y: figure.cursor, w: width }, { title: "Samples spent ÷ ideal hexagonal lattice", domain: [1, 4], ticks: [1, 2, 3, 4].map(value => ({ value, label: String(value), reference: value === 1 })), label: "1 is ideal; a square lattice is 1.30", valueWidth: 44, labelWidth: 140, rows: rows("coveringExcess") });
    figure.cursor += a;
    figure.notes(["Equirectangular runs off both scales near the poles (elongation and excess above 100). The icosahedral rhombus has elongated cells and a nearly ideal lattice; triangle cells are the reverse: equal-sided cells whose centres form a honeycomb, which wastes half its samples by this measure."]);
    save("cell-shape", figure);
  }
}

// ─── 1: view quality against samples ───────────────────────────────────

const reconstruction = readJson("reconstruction");
if (reconstruction) {
  const curve = (id, filter = "linear", group = "all", key = "psnr") => reconstruction.summary.filter(row => row.representation === id && row.filter === filter && row.panorama === "all" && row.group === group).map(row => [row.samples, row[key]]).sort((a, b) => a[0] - b[0]);
  {
    const figure = new Figure({ title: "View quality against number of samples, no compression", subtitle: "PSNR of 512 × 512, 75° views rebuilt from each representation against the same views from the 6144 × 3072 source. Mean of 34 views of 6 panoramas, linear reconstruction. Equirectangular in grey in every panel." });
    familyPanels(figure, 250, (box, family) => linePanel(figure, box, {
      title: family.title, endLabels: 84,
      x: { log: true, domain: [35000, 12e6], ticks: [1e5, 1e6, 1e7].map(value => ({ value, label: formatSamples(value) })), label: "samples on the sphere (log scale)", format: formatSamples },
      y: { domain: [20, 44], ticks: [20, 26, 32, 38, 44], label: "PSNR, dB", format: value => `${value.toFixed(2)} dB` },
      series: [{ name: NAMES.equirect, slot: "quiet", points: curve("equirect") }, ...family.members.map(id => ({ name: NAMES[id], slot: SLOT[id], points: curve(id), endLabel: SHORT[id] ?? NAMES[id] }))],
    }));
    figure.notes(["The curves nearly coincide: at this scale the choice of representation moves quality by about a decibel, while doubling the samples moves it by three. The next figure shows the differences alone."]);
    save("quality-vs-samples", figure);
  }
  {
    const target = 1e6, rows = [];
    const figure = new Figure({ title: "Quality at one million samples, relative to equirectangular", subtitle: "Difference in view PSNR at equal sample count, interpolated between measured resolutions; and the share of samples saved or added to match equirectangular's quality at one million samples." });
    for (const filter of ["linear", "nearest"]) {
      const control = curve("equirect", filter), base = atLogX(control, target);
      const list = ORDER.filter(id => id !== "equirect").map(id => {
        const points = curve(id, filter), delta = atLogX(points, target) - base, needed = logXAt(points, base);
        return { id, delta, saving: needed ? 1 - needed / target : null };
      }).sort((a, b) => b.delta - a.delta);
      rows.push({ filter, list });
    }
    const width = (figure.width - 32 - 16) / 2;
    let used = 0;
    rows.forEach(({ filter, list }, k) => {
      used = barPanel(figure, { x: 16 + k * (width + 16), y: figure.cursor, w: width }, {
        title: filter === "linear" ? "Linear reconstruction" : "Nearest sample", domain: [-0.5, 2], baseline: 0, labelWidth: 132, valueWidth: 104,
        ticks: [0, 1, 2].map(value => ({ value, label: value === 0 ? "0" : signed(value, 0) })), label: "dB against equirectangular",
        rows: list.map(item => ({ label: NAMES[item.id], value: item.delta, slot: item.delta >= 0 ? 1 : 8, text: `${signed(item.delta)} dB${item.saving === null ? "" : `, ${item.saving >= 0 ? "−" : "+"}${Math.abs(item.saving * 100).toFixed(0)}%`}` })),
      });
    });
    figure.cursor += used;
    figure.notes(["The percentage is the change in sample count for equal quality. Linear reconstruction is bilinear in a chart; for hexagon cells it is barycentric between the three nearest samples."]);
    save("quality-per-sample", figure);
  }
  {
    // Where the camera looks: the horizon, and the poles.
    const figure = new Figure({ title: "The same comparison by where the camera looks", subtitle: "Difference in view PSNR from equirectangular at one million samples, linear reconstruction, for views along the horizon and views at the poles." });
    const width = (figure.width - 32 - 16) / 2;
    let used = 0;
    [["horizon", "Six views along the horizon"], ["pole", "Four views at and near the poles"]].forEach(([group, title], k) => {
      const base = atLogX(curve("equirect", "linear", group), 1e6);
      const list = ORDER.filter(id => id !== "equirect").map(id => ({ id, delta: atLogX(curve(id, "linear", group), 1e6) - base })).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
      used = barPanel(figure, { x: 16 + k * (width + 16), y: figure.cursor, w: width }, {
        title, domain: [-1.5, 3], baseline: 0, labelWidth: 132, valueWidth: 64,
        ticks: [-1, 0, 1, 2, 3].map(value => ({ value, label: value === 0 ? "0" : signed(value, 0) })), label: "dB against equirectangular",
        rows: list.map(item => ({ label: NAMES[item.id], value: item.delta, slot: item.delta >= 0 ? 1 : 8, text: `${signed(item.delta)} dB` })),
      });
    });
    figure.cursor += used;
    save("quality-by-view", figure);
  }
}

// ─── 2: view quality against bytes, whole sphere ───────────────────────

const codec = readCsv("codec");
if (codec) {
  const panoramas = [...new Set(codec.map(row => row.panorama))];
  // For one representation and codec: the best quality at each byte count over both resolutions and every quality setting, per panorama.
  const envelope = (id, name, panorama, metric = "viewPsnr") => upperEnvelope(codec.filter(row => row.representation === id && row.codec === name && row.panorama === panorama).map(row => [row.bytes, row[metric]]));
  // For drawing: each setting (resolution and quality) averaged over panoramas, then the best of those at each size.
  const averaged = (id, name) => upperEnvelope([...groupBy(codec.filter(row => row.representation === id && row.codec === name), row => `${row.N}/${row.quality}`).values()]
    .map(rows => [mean(rows.map(row => kib(row.bytes))), mean(rows.map(row => row.viewPsnr))]));
  {
    const figure = new Figure({ title: "View quality against bytes: each representation as JPEG", subtitle: "Every chart compressed whole with libjpeg-turbo, 4:2:0, at five qualities and two resolutions; each setting is averaged over the 6 panoramas and the best at each size is drawn. View PSNR against the source, 12 views. Equirectangular in grey in every panel." });
    familyPanels(figure, 250, (box, family) => linePanel(figure, box, {
      title: family.title, endLabels: 84,
      x: { log: true, domain: [60, 3200], ticks: [64, 128, 256, 512, 1024, 2048].map(value => ({ value, label: String(value) })), label: "KiB for the whole sphere (log scale)", format: value => `${value.toFixed(0)} KiB` },
      y: { domain: [25, 35], ticks: [25, 27, 29, 31, 33, 35], label: "PSNR, dB", format: value => `${value.toFixed(2)} dB` },
      series: [{ name: NAMES.equirect, slot: "quiet", points: averaged("equirect", "jpeg") }, ...family.members.map(id => ({ name: NAMES[id], slot: SLOT[id], points: averaged(id, "jpeg"), endLabel: SHORT[id] ?? NAMES[id] }))],
    }));
    save("quality-vs-bytes", figure);
  }
  {
    // Bytes for equal quality, relative to equirectangular, per codec.
    const figure = new Figure({ title: "Bytes for equal view quality, relative to equirectangular", subtitle: "For each panorama, the quality equirectangular reaches at 2560 × 1280 and quality 75 is the target; each representation's bytes to reach it are read off its own best curve with the same codec. Geometric mean over 6 panoramas." });
    const width = (figure.width - 32 - 16) / 2;
    let used = 0;
    [["jpeg", "JPEG 4:2:0, matched by PSNR", "viewPsnr"], ["jpeg", "JPEG 4:2:0, matched by SSIM", "viewSsim"]].forEach(([name, title, metric], k) => {
      const list = ORDER.filter(id => id !== "equirect").map(id => {
        let log = 0, cases = 0;
        for (const panorama of panoramas) {
          const control = codec.find(row => row.representation === "equirect" && row.codec === name && row.panorama === panorama && row.quality === 75 && row.N === Math.max(...codec.filter(item => item.representation === "equirect").map(item => item.N)));
          const needed = logXAt(envelope(id, name, panorama, metric), control[metric]);
          if (needed !== null) { log += Math.log(needed / control.bytes); cases++; }
        }
        return { id, ratio: cases === panoramas.length ? Math.exp(log / cases) : null, cases };
      }).sort((a, b) => (a.ratio ?? 9) - (b.ratio ?? 9));
      used = barPanel(figure, { x: 16 + k * (width + 16), y: figure.cursor, w: width }, {
        title, domain: [0.6, 1.4], baseline: 1, labelWidth: 132, valueWidth: 60, ticks: [0.6, 0.8, 1, 1.2, 1.4].map(value => ({ value, label: `${value}×` })), label: "bytes ÷ equirectangular's",
        rows: list.map(item => ({ label: NAMES[item.id], value: item.ratio, slot: item.ratio !== null && item.ratio <= 1 ? 1 : 8, text: item.ratio === null ? `reached in ${item.cases} of ${panoramas.length}` : `${item.ratio.toFixed(2)}×` })),
      });
    });
    figure.cursor += used;
    figure.notes(["Below 1× needs fewer bytes than equirectangular. Triangle cells are stored two to a rhombus cell, side by side in a row, which is how a square-image codec has to be given them."]);
    save("bytes-at-equal-quality", figure);
  }
  {
    const figure = new Figure({ title: "The same samples under four codecs", subtitle: "Cubemap, 768 px faces. View PSNR against bytes for the whole sphere, mean of 6 panoramas. AVIF is macOS's encoder through sips, at three qualities." });
    const items = [["jpeg", "JPEG 4:2:0", 1], ["webp", "WebP", 2], ["avif", "AVIF", 3], ["jpeg444", "JPEG 4:4:4", "quiet"]];
    const top = Math.max(...codec.filter(row => row.representation === "cube").map(row => row.N));
    const height = figure.legend(items.map(([, name, slot]) => ({ name, slot })), figure.cursor + 6);
    figure.cursor += height + 4;
    linePanel(figure, { x: 16, y: figure.cursor, w: figure.width - 32, h: 280 }, {
      x: { log: true, domain: [180, 3200], ticks: [256, 512, 1024, 2048].map(value => ({ value, label: `${value} KiB` })), label: "bytes for the whole sphere (log scale)", format: value => `${value.toFixed(0)} KiB` },
      y: { domain: [29, 35], ticks: [29, 30, 31, 32, 33, 34, 35], label: "view PSNR, dB", format: value => `${value.toFixed(2)} dB` },
      series: items.map(([name, label, slot]) => {
        const byQuality = groupBy(codec.filter(row => row.representation === "cube" && row.N === top && row.codec === name), "quality");
        return { name: label, slot, points: [...byQuality.values()].map(rows => [mean(rows.map(row => kib(row.bytes))), mean(rows.map(row => row.viewPsnr))]).sort((a, b) => a[0] - b[0]) };
      }),
    });
    figure.cursor += 280;
    save("codecs", figure);
  }
}

// ─── Replacement against residual refinement ───────────────────────────

const hierarchy = readCsv("hierarchy"), hierarchyMeta = readJson("hierarchy");
if (hierarchy) {
  const finestOf = Object.fromEntries(hierarchyMeta.hierarchies.map(item => [item.representation, item.finest]));
  const baseOf = Object.fromEntries(hierarchyMeta.hierarchies.map(item => [item.representation, item.base]));
  const kinds = [
    { id: "jpeg-all", name: "JPEG tiles, every level", of: row => row.kind === "image-replacement" && row.codec === "jpeg", bytes: "cumulative" },
    { id: "jpeg-direct", name: "JPEG tiles, coarse sphere + finest level only", of: row => row.kind === "image-replacement" && row.codec === "jpeg", bytes: "direct" },
    { id: "webp-all", name: "WebP tiles, every level", of: row => row.kind === "image-replacement" && row.codec === "webp", bytes: "cumulative" },
    { id: "jpeg-residual", name: "JPEG residual tiles", of: row => row.kind === "image-residual", bytes: "cumulative" },
    { id: "haar-all", name: "Haar tiles coded alone, every level", of: row => row.kind === "haar-replacement", bytes: "cumulative" },
    { id: "haar-residual", name: "Haar residual", of: row => row.kind === "haar-residual" && !String(row.scheme).includes("-p"), bytes: "cumulative" },
  ];
  // Bytes each kind needs for the quality JPEG tiles at quality 80 reach, per panorama and representation, then the geometric mean of the ratios.
  function ratios(metric) {
    const sums = Object.fromEntries(kinds.map(kind => [kind.id, { log: 0, n: 0, missed: 0 }]));
    for (const [, rows] of groupBy(hierarchy, row => `${row.panorama}|${row.representation}`)) {
      const rep = rows[0].representation, top = rows.filter(row => row.level === finestOf[rep]), coarse = rows.filter(row => row.level === baseOf[rep]);
      const bytesOf = (row, mode) => (mode === "cumulative" ? row.cumulativeBytes : row.levelBytes + coarse.find(item => item.scheme === row.scheme).levelBytes);
      const reference = top.find(row => row.scheme === "jpeg-replacement-q80");
      for (const kind of kinds) {
        const points = top.filter(kind.of).map(row => [bytesOf(row, kind.bytes), row[metric]]);
        const needed = logXAt(points, reference[metric]);
        if (needed === null) { sums[kind.id].missed++; continue; }
        sums[kind.id].log += Math.log(needed / reference.cumulativeBytes); sums[kind.id].n++;
      }
    }
    return kinds.map(kind => ({ ...kind, ratio: sums[kind.id].n ? Math.exp(sums[kind.id].log / sums[kind.id].n) : null, cases: sums[kind.id].n, missed: sums[kind.id].missed }));
  }
  {
    const figure = new Figure({ title: "Bytes to bring the whole sphere to full resolution, at equal quality", subtitle: "Relative to a pyramid of JPEG tiles at quality 80 with every level sent. Each scheme's quality setting is interpolated to match that pyramid's view quality, by PSNR (left) and by SSIM (right). Geometric mean over 6 panoramas and 7 representations." });
    // One column of names, then the two panels' bars side by side.
    const names = 268, bars = (figure.width - 32 - names - 16) / 2;
    let used = 0;
    [["viewPsnr", "Matched by PSNR"], ["viewSsim", "Matched by SSIM"]].forEach(([metric, title], k) => {
      used = barPanel(figure, { x: k === 0 ? 16 : 16 + names + bars + 16 - 12, y: figure.cursor, w: k === 0 ? names + bars : bars + 12 }, {
        title: k === 0 ? `${" ".repeat(0)}${title}` : title, domain: [0, 1.6], baseline: 0, labelWidth: k === 0 ? names : 12, valueWidth: 50, ticks: [0, 0.5, 1, 1.5].map(value => ({ value, label: `${value}×` })), label: "bytes ÷ the JPEG pyramid's",
        rows: ratios(metric).map(item => ({ label: k === 0 ? item.name : "", value: item.ratio, slot: 1, text: item.ratio === null ? "out of range" : `${item.ratio.toFixed(2)}×` })),
      });
    });
    figure.cursor += used;
    figure.notes(["Haar: the area-weighted transform of lib/hierarchy.mjs, uniformly quantized, zigzag bytes, deflate. Residual: only the difference from the level above is sent. JPEG residual: each tile is the difference from its enlarged parent, as a JPEG.", "The two panels disagree about Haar because its flat quantization suits PSNR and JPEG's tables suit SSIM. Neither is a perceptual study."]);
    save("residual-vs-replacement", figure);
  }
  {
    // Quality after each level against the bytes sent so far, one representation.
    const rep = "cube", schemes = [["jpeg-replacement-q80", "JPEG tiles, every level", 1], ["jpeg-residual-q80", "JPEG residual tiles", 2], ["haar-residual-d12", "Haar residual", 3], ["haar-replacement-d12", "Haar tiles coded alone, every level", "quiet"]];
    const figure = new Figure({ title: "Quality after each level, against bytes sent so far", subtitle: "Cubemap, 768 px faces, 256 px tiles; each dot is one more level of the whole sphere complete. View PSNR against the source, mean of 12 views of 6 panoramas." });
    const height = figure.legend(schemes.map(([, name, slot]) => ({ name, slot })), figure.cursor + 6);
    figure.cursor += height + 4;
    linePanel(figure, { x: 16, y: figure.cursor, w: figure.width - 32, h: 300 }, {
      x: { log: true, domain: [3, 2500], ticks: [4, 16, 64, 256, 1024].map(value => ({ value, label: `${value} KiB` })), label: "bytes sent, cumulative (log scale)", format: value => `${value.toFixed(0)} KiB` },
      y: { domain: [20, 34], ticks: [20, 22, 24, 26, 28, 30, 32, 34], label: "view PSNR, dB", format: value => `${value.toFixed(2)} dB` },
      series: schemes.map(([id, name, slot]) => {
        const levels = groupBy(hierarchy.filter(row => row.representation === rep && row.scheme === id), "level");
        return { name, slot, points: [...levels.values()].map(rows => [mean(rows.map(row => kib(row.cumulativeBytes))), mean(rows.map(row => row.viewPsnr))]).sort((a, b) => a[0] - b[0]) };
      }),
    });
    figure.cursor += 300;
    figure.notes(["A residual scheme's coarse levels cost more than a replacement scheme's, because they are stored precisely enough to be refined; it overtakes once the finer levels arrive."]);
    save("quality-per-level", figure);
  }
  {
    // What the details look like.
    const stats = hierarchyMeta.statistics.filter(row => row.delta === 12), figure = new Figure({ title: "Haar details by level", subtitle: "Quantized details of the step into each level, full-resolution step 12, mean over 6 panoramas and 7 representations. Levels are counted from the finest (0) toward the coarse sphere." });
    const finest = rep => finestOf[rep];
    const byDepth = groupBy(stats, row => finest(row.representation) - row.childLevel);
    const depths = [...byDepth.keys()].filter(depth => depth <= 5).sort((a, b) => b - a);
    const series = (key, name, slot) => ({ name, slot, points: depths.map(depth => [5 - depth, mean(byDepth.get(depth).map(row => row[key]))]) });
    const width = (figure.width - 32 - 16) / 2, xAxis = { domain: [-0.2, 5.2], ticks: depths.map(depth => ({ value: 5 - depth, label: depth === 0 ? "finest" : `−${depth}` })), label: "level" };
    const height = figure.legend([{ name: "luma", slot: 1 }, { name: "chroma", slot: 2 }], figure.cursor + 6);
    figure.cursor += height + 4;
    linePanel(figure, { x: 16, y: figure.cursor, w: width, h: 240 }, { title: "Share of details that are zero", x: xAxis, y: { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1].map(value => ({ value, label: `${value * 100}%` })) }, series: [series("lumaZeroFraction", "luma", 1), series("chromaZeroFraction", "chroma", 2)] });
    linePanel(figure, { x: 16 + width + 16, y: figure.cursor, w: width, h: 240 }, { title: "Entropy, bits per detail", x: xAxis, y: { domain: [0, 8], ticks: [0, 2, 4, 6, 8] }, series: [series("lumaEntropyBitsPerCoefficient", "luma", 1), series("chromaEntropyBitsPerCoefficient", "chroma", 2)] });
    figure.cursor += 240;
    save("haar-details", figure);
  }
}

// ─── Quality against bytes received, by order; 5: memory ───────────────

const progressive = readCsv("progressive");
if (progressive) {
  // Mean over panoramas of what is held after each of a fixed list of byte counts.
  const panoramas = [...new Set(progressive.map(row => row.panorama))];
  const deliveries = groupBy(progressive.filter(row => row.budget !== null), row => `${row.representation}|${row.scheme}|${row.order}|${row.panorama}`);
  const BUDGETS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048].map(k => k * 1024);
  const curve = (rep, scheme, order, y = "viewPsnr", x = "bytes") => BUDGETS.map(budget => {
    const states = panoramas.map(panorama => stateAt(deliveries.get(`${rep}|${scheme}|${order}|${panorama}`) ?? [], budget));
    if (!states.every(state => state && state[y] !== null)) return null;
    return [x === "bytes" ? kib(budget) : mean(states.map(state => state[x])) / 2 ** 20, mean(states.map(state => state[y]))];
  }).filter(Boolean);
  const bytesAxis = { log: true, domain: [6, 2600], ticks: [8, 32, 128, 512, 2048].map(value => ({ value, label: String(value) })), label: "KiB received (log scale)", format: value => `${value.toFixed(0)} KiB` };
  const psnrAxis = { domain: [20, 34], ticks: [20, 22, 24, 26, 28, 30, 32, 34], label: "PSNR of the view, dB", format: value => `${value.toFixed(2)} dB` };
  const ORDERS = [["view", "the view first, level by level", 1], ["gain", "most error removed per byte, whole sphere", 2], ["view-direct", "coarse sphere, then the finest level under the view", 3], ["level", "level by level, whole sphere", "quiet"]];
  {
    const figure = new Figure({ title: "Quality of the view against bytes received, by order of sending", subtitle: "What a 512 × 512, 75° view shows after a given number of bytes, drawn from the finest level that has arrived in each direction. Mean of 12 views of 6 panoramas. 256-cell tiles except the last panel." });
    const height = figure.legend(ORDERS.map(([, name, slot]) => ({ name, slot })), figure.cursor + 6);
    figure.cursor += height + 4;
    const panels = [["cube", "haar-residual-d12", "Cubemap, Haar residual tiles"], ["cube", "jpeg-residual-q80", "Cubemap, JPEG residual tiles"], ["cube", "jpeg-replacement-q80", "Cubemap, JPEG tiles (replacement)"], ["equirect", "jpeg-replacement-q80-whole", "Equirectangular, one JPEG per level"]];
    const gap = 16, width = (figure.width - 32 - gap) / 2;
    panels.forEach(([rep, scheme, title], k) => linePanel(figure, { x: 16 + (k % 2) * (width + gap), y: figure.cursor + Math.floor(k / 2) * 264, w: width, h: 250 }, {
      title, x: bytesAxis, y: psnrAxis, series: ORDERS.map(([order, name, slot]) => ({ name, slot, points: curve(rep, scheme, order) })).filter(series => series.points.length),
    }));
    figure.cursor += 2 * 264;
    figure.notes(["With the view first, a view reaches a given quality with a fraction of the bytes; the rest of the sphere then holds only its coarse level."]);
    save("quality-vs-bytes-received", figure);
  }
  {
    const figure = new Figure({ title: "What a turn would reveal", subtitle: "The same bytes, sent with one view first: quality of that view, and of the view facing the opposite way, which has received nothing but what the whole sphere got. Cubemap, mean of 12 views of 6 panoramas." });
    const items = [["viewPsnr", "the view the bytes were ordered for", 1], ["oppositePsnr", "the opposite view", 2]];
    const height = figure.legend(items.map(([, name, slot]) => ({ name, slot })), figure.cursor + 6);
    figure.cursor += height + 4;
    const gap = 16, width = (figure.width - 32 - gap) / 2;
    [["haar-residual-d12", "view", "Haar residual tiles, the view first"], ["jpeg-replacement-q80", "view-direct", "JPEG tiles, finest level under the view"]].forEach(([scheme, order, title], k) => linePanel(figure, { x: 16 + k * (width + gap), y: figure.cursor, w: width, h: 250 }, {
      title, x: bytesAxis, y: psnrAxis, series: items.map(([key, name, slot]) => ({ name, slot, points: curve("cube", scheme, order, key) })),
    }));
    figure.cursor += 250;
    save("quality-after-a-turn", figure);
  }
  {
    const figure = new Figure({ title: "Decoded memory against quality of the view", subtitle: "Texture bytes a client holds (four per sample received) against what the view shows. Cubemap, Haar residual tiles, mean of 12 views of 6 panoramas." });
    const items = ORDERS.filter(([order]) => order === "view" || order === "level");
    const height = figure.legend(items.map(([, name, slot]) => ({ name, slot })), figure.cursor + 6);
    figure.cursor += height + 4;
    linePanel(figure, { x: 16, y: figure.cursor, w: figure.width - 32, h: 270 }, {
      x: { log: true, domain: [0.04, 20], ticks: [0.0625, 0.25, 1, 4, 16].map(value => ({ value, label: `${value} MiB` })), label: "decoded samples held, RGBA8 (log scale)", format: value => `${value.toFixed(2)} MiB` },
      y: psnrAxis, series: items.map(([order, name, slot]) => ({ name, slot, points: curve("cube", "haar-residual-d12", order, "viewPsnr", "residentBytes") })),
    });
    figure.cursor += 270;
    save("memory-vs-quality", figure);
  }
}

// ─── 3: quality against simulated time; 8: bytes never looked at ───────

const network = readCsv("network"), networkSeries = readJson("network-series");
if (network && networkSeries) {
  const PROFILE_NAMES = { fast: "Fast: 50 Mbit/s, 20 ms", "moderate-mobile": "Moderate mobile: 10 Mbit/s, 50 ms", "constrained-mobile": "Constrained mobile: 2 Mbit/s, 100 ms", "very-constrained": "Very constrained: 0.75 Mbit/s, 150 ms" };
  const RUNS = [
    ["cube", "haar-residual-d12", "view", "Haar residual tiles, the view only", 1],
    ["cube", "jpeg-residual-q80", "view", "JPEG residual tiles, the view only", 2],
    ["cube", "jpeg-replacement-q80", "view-direct", "JPEG tiles, finest level under the view", 3],
    ["equirect", "jpeg-replacement-q80-whole", "view-direct", "whole equirectangular JPEG, full size at once", "quiet"],
  ];
  // Mean over panoramas at each quarter second; nothing until every panorama's coarse sphere has arrived.
  const series = (rep, scheme, policy, profile, trace) => {
    const runs = networkSeries.runs.filter(run => run.representation === rep && run.scheme === scheme && run.policy === policy && run.profile === profile && run.trace === trace);
    return runs.length ? runs[0].deficitDb.map((_, i) => [i * networkSeries.secondsBetweenValues, runs.every(run => run.deficitDb[i] !== null) ? mean(runs.map(run => run.deficitDb[i])) : null]) : [];
  };
  for (const [trace, title, note] of [
    ["quick-turn", "How far the view is from full quality over time: a quick turn", "The person looks forward for 2 s, turns 180° in 0.6 s, and stays."],
    ["stationary", "How far the view is from full quality over time: looking forward", "The person enters and does not move."],
    ["slow-turn", "How far the view is from full quality over time: a slow full turn", "A full turn along the horizon in 20 s."],
  ]) {
    if (!network.some(row => row.trace === trace)) continue;
    const duration = (networkSeries.runs.find(run => run.trace === trace).deficitDb.length - 1) * networkSeries.secondsBetweenValues;
    const figure = new Figure({ title, subtitle: `${note} Decibels below the same view drawn from the uncompressed full-resolution control: lower is better, 0 is the control. A line starts when the coarse sphere has arrived. Mean of 3 panoramas; simulated network.` });
    const height = figure.legend(RUNS.map(([, , , name, slot]) => ({ name, slot })), figure.cursor + 6);
    figure.cursor += height + 4;
    const gap = 16, width = (figure.width - 32 - gap) / 2;
    Object.entries(PROFILE_NAMES).forEach(([profile, name], k) => linePanel(figure, { x: 16 + (k % 2) * (width + gap), y: figure.cursor + Math.floor(k / 2) * 244, w: width, h: 230 }, {
      title: name,
      x: { domain: [0, duration], ticks: niceTicks(0, duration, 5).map(value => ({ value, label: `${value} s` })), label: "seconds after entering", format: value => `${value} s` },
      y: { domain: [0, 16], ticks: [0, 4, 8, 12, 16], label: "dB below the control", format: value => `${value.toFixed(1)} dB` },
      series: RUNS.map(([rep, scheme, policy, label, slot]) => ({ name: label, slot, markers: false, points: series(rep, scheme, policy, profile, trace) })),
    }));
    figure.cursor += 2 * 244;
    save(`quality-vs-time-${trace}`, figure);
  }
  {
    const figure = new Figure({ title: "Bytes received that were never looked at", subtitle: "Constrained mobile (2 Mbit/s, 100 ms). Bytes received during the trace, each file's bytes split by the share of its cells that some moment's view covered. Cubemap except the last rows; mean of 3 panoramas." });
    const rows = [
      ["cube", "haar-residual-d12", "view", "Haar residual tiles, the view only"],
      ["cube", "haar-residual-d12", "view-fill", "Haar residual tiles, the view, then the rest"],
      ["cube", "haar-residual-d12", "global", "Haar residual tiles, whole sphere by level"],
      ["cube", "jpeg-residual-q80", "view", "JPEG residual tiles, the view only"],
      ["cube", "jpeg-replacement-q80", "view", "JPEG tiles, the view only, every level"],
      ["cube", "jpeg-replacement-q80", "view-direct", "JPEG tiles, finest level under the view"],
      ["cube", "jpeg-replacement-q80", "global", "JPEG tiles, whole sphere by level"],
      ["equirect", "jpeg-replacement-q80-whole", "view-direct", "Whole equirectangular JPEG, full size at once"],
      ["equirect", "jpeg-replacement-q80-whole", "global", "Whole equirectangular JPEG, every size in turn"],
    ];
    const gap = 16, names = 300, bars = (figure.width - 32 - names - gap) / 2;
    let used = 0;
    [["stationary", "Looking forward, 10 s"], ["slow-turn", "A slow full turn, 20 s"]].forEach(([trace, title], k) => {
      used = stackPanel(figure, { x: k === 0 ? 16 : 16 + names + bars + gap - 8, y: figure.cursor, w: k === 0 ? names + bars : bars + 8 }, {
        title, domain: [0, 1600], labelWidth: k === 0 ? names : 8, valueWidth: 58, ticks: [0, 500, 1000, 1500].map(value => ({ value, label: String(value) })), label: "KiB received",
        rows: rows.map(([rep, scheme, policy, label]) => {
          const runs = network.filter(row => row.representation === rep && row.scheme === scheme && row.policy === policy && row.profile === "constrained-mobile" && row.trace === trace);
          const used = mean(runs.map(row => kib(row.bytesReceived - row.bytesNeverLookedAt))), wasted = mean(runs.map(row => kib(row.bytesNeverLookedAt)));
          return { label: k === 0 ? label : "", segments: [{ value: used, slot: 1, name: "looked at", text: `${used.toFixed(0)} KiB` }, { value: wasted, slot: 2, name: "never looked at", text: `${wasted.toFixed(0)} KiB` }], text: `${(wasted / (used + wasted) * 100).toFixed(0)}%` };
        }),
      });
    });
    figure.cursor += used;
    const height = figure.legend([{ name: "for cells a view covered", slot: 1 }, { name: "for cells no view covered; the percentage is their share", slot: 2 }], figure.cursor + 4, { line: false });
    figure.cursor += height;
    save("bytes-never-looked-at", figure);
  }
}

// ─── 4: decode time ────────────────────────────────────────────────────

// Timed in a loop, as the Node rows are, so the browser rows come from the run that kept the processor awake.
const cpu = readCsv("cpu"), gpuDecode = readCsv("gpu-busy-decode") ?? readCsv("gpu-decode");
if (cpu) {
  const figure = new Figure({ title: "Decoding one 256 × 256 tile", subtitle: "Median time on this desktop CPU (Apple M5): Node for the JavaScript and WebAssembly rows, headless Chrome for the browser's own decoders. Every row is timed in a loop, with the processor awake. A phone is slower by a factor this benchmark did not measure." });
  const ms = value => (value >= 10 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : value.toFixed(3));
  const pick = (name, where) => cpu.find(row => row.operation === name && row.runsIn.startsWith(where));
  const browser = (name) => gpuDecode?.find(row => row.operation.startsWith(name));
  const rows = [
    ["Residual tile, whole decode, JavaScript", pick("residual tile 256², whole decode", "JavaScript")],
    ["Residual tile, whole decode, WebAssembly", pick("residual tile 256², whole decode", "WebAssembly")],
    ["· of which inflate (native)", pick("inflate one residual tile", "native")],
    ["· unpack integers, JavaScript", pick("unpack integers", "JavaScript")],
    ["· inverse transform, JavaScript", pick("inverse transform, equal areas", "JavaScript")],
    ["· inverse transform, area-weighted, JavaScript", pick("inverse transform, area-weighted", "JavaScript")],
    ["· inverse transform, WebAssembly", pick("inverse transform, equal areas", "WebAssembly")],
    ["· Y′CbCr to RGBA, JavaScript", pick("Y′CbCr to RGBA", "JavaScript")],
    ["JPEG tile, browser's decoder", browser("JPEG tile 256²: createImageBitmap"), "median"],
    ["· then ImageBitmap to RGBA bytes", browser("JPEG tile 256²: ImageBitmap to RGBA"), "median"],
    ["WebP tile, browser's decoder", browser("WebP tile 256²: createImageBitmap"), "median"],
    ["JPEG tile, jpeg-js (JavaScript)", pick("JPEG tile decode, jpeg-js", "JavaScript")],
    ["Copy a decoded tile into an atlas", pick("copy a tile into an atlas", "JavaScript")],
  ].filter(([, row]) => row).map(([label, row, key]) => ({ label, value: row[key ?? "medianMs"], slot: 1, text: `${ms(row[key ?? "medianMs"])} ms` }));
  const used = barPanel(figure, { x: 16, y: figure.cursor, w: figure.width - 32 }, { domain: [0, 1.6], baseline: 0, labelWidth: 300, valueWidth: 70, ticks: [0, 0.4, 0.8, 1.2, 1.6].map(value => ({ value, label: `${value}` })), label: "milliseconds per tile (65,536 samples)", rows });
  figure.cursor += used + 6;
  // Time against the size of the refinement.
  const sweep = where => [64, 128, 256, 512].map(size => [size * size, pick(`residual tile ${size}², whole decode`, where)?.medianMs]).filter(([, value]) => value);
  if (sweep("JavaScript").length > 1) {
    const height = figure.legend([{ name: "JavaScript", slot: 1 }, { name: "WebAssembly", slot: 2 }], figure.cursor + 6);
    figure.cursor += height + 4;
    linePanel(figure, { x: 16, y: figure.cursor, w: figure.width - 32, h: 230 }, {
      title: "Residual tile decode against tile size",
      x: { log: true, domain: [3000, 350000], ticks: [64, 128, 256, 512].map(size => ({ value: size * size, label: `${size}²` })), label: "samples in the tile (log scale)", format: value => `${Math.sqrt(value)}²` },
      y: { domain: [0, 4], ticks: [0, 1, 2, 3, 4], label: "milliseconds", format: value => `${ms(value)} ms` },
      series: [{ name: "JavaScript", slot: 1, points: sweep("JavaScript") }, { name: "WebAssembly", slot: 2, points: sweep("WebAssembly") }],
    });
    figure.cursor += 230;
  }
  save("decode-time", figure);
}

// ─── GPU cost of drawing, and 9: frame times while detail arrives ─────

const gpuRender = readCsv("gpu-render"), gpuRefine = readCsv("gpu-refine");
if (gpuRender) {
  const figure = new Figure({ title: "GPU time to draw the panorama once more", subtitle: "A 1080 × 2400 view on this desktop GPU, headless Chrome. The extra GPU time per additional blended copy of the panorama in the frame, which isolates the panorama from the frame's fixed cost. WebGL 1's timer gave no usable reading." });
  const backends = [["webgl2", "WebGL 2"], ["webgpu", "WebGPU"]].filter(([id]) => gpuRender.some(row => row.backend === id && row.gpuMsPerCopy !== null));
  const width = (figure.width - 32 - 16) / 2;
  let used = 0;
  backends.forEach(([id, title], k) => {
    const list = gpuRender.filter(row => row.backend === id && !row.error);
    used = barPanel(figure, { x: k === 0 ? 16 : 16 + width + 16 + 96, y: figure.cursor, w: k === 0 ? width + 96 : width - 96 }, {
      title, domain: [0, 0.8], baseline: 0, labelWidth: k === 0 ? 236 : 8, valueWidth: 62, ticks: [0, 0.2, 0.4, 0.6, 0.8].map(value => ({ value, label: String(value) })), label: "ms per copy",
      rows: list.map(row => ({ label: k === 0 ? row.variant.replace("mesh patches, cube, one texture per face", "mesh patches, cube, 6 textures") : "", value: row.gpuMsPerCopy, slot: row.architecture === "ray lookup" ? 1 : 2, text: row.gpuMsPerCopy === null ? "no reading" : `${row.gpuMsPerCopy.toFixed(3)}` })),
    });
  });
  figure.cursor += used;
  const height = figure.legend([{ name: "ray lookup: one triangle, the map in the pixel shader", slot: 1 }, { name: "mesh patches: the map at the vertices", slot: 2 }], figure.cursor + 4, { line: false });
  figure.cursor += height;
  save("gpu-draw-cost", figure);
}
if (gpuRefine) {
  // The same frames in two states of the processor: see run-gpu.mjs, --keep-busy.
  const gpuRefineBusy = readCsv("gpu-busy-refine");
  const figure = new Figure({ title: "Main-thread work per frame while detail arrives", subtitle: "Time spent in a frame's uploads, decoding and render call, on this desktop, headless Chrome, WebGL 2 (the other backends are in results/tables.md). Dot: median; band: 95th to 99th percentile; whisker: the worst frame. The line at 16.7 ms is one frame at 60 Hz." });
  const conditions = [["Nothing else running: the processor idles between frames", gpuRefine], ["One other core kept busy: the processor stays awake", gpuRefineBusy]].filter(([, rows]) => rows);
  conditions.forEach(([title, rows], k) => {
    const list = rows.filter(row => row.backend === "webgl2");
    if (!list.length) return;
    const used = rangePanel(figure, { x: 16, y: figure.cursor, w: figure.width - 32 }, {
      title, domain: [0.01, 200], log: true, labelWidth: 400, valueWidth: 96, label: k === conditions.length - 1 ? "milliseconds (log scale)" : "",
      ticks: [0.01, 0.1, 1, 16.7, 100].map(value => ({ value, label: String(value), reference: value === 16.7 })),
      rows: list.map(row => ({ label: row.scenario.replace(/^one /, "One ").replace(/^four /, "Four ").replace(/^no /, "No ").replace(/^the /, "The ").replace(/^a /, "A "), min: row.cpuFrameWorkMsMedian, low: row.cpuFrameWorkMsP95, high: row.cpuFrameWorkMsP99, max: row.cpuFrameWorkMsMax, mark: row.cpuFrameWorkMsMedian, text: `worst ${row.cpuFrameWorkMsMax >= 10 ? row.cpuFrameWorkMsMax.toFixed(0) : row.cpuFrameWorkMsMax.toFixed(1)} ms` })),
    });
    figure.cursor += used;
  });
  save("frame-times", figure);
}

console.log(`wrote ${written.length} figures to ${plotsDirectory}: ${written.join(", ")}`);
