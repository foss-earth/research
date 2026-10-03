#!/usr/bin/env node
/**
 * Every derived number REPORT.md cites, as results/tables.md, from the files
 * in results/ alone (and, with --datasets, the generated datasets' manifests,
 * summarised into results/datasets.csv first).
 *
 *   node benchmarks/eac-progressive-prototype/make-tables.mjs [--datasets]
 *
 * Medians are over every run in a group (panoramas, start orientations and
 * repetitions together); n says how many. A time some runs never reached is
 * the median counting "never" as later than any time, with the number that
 * never got there, so a run that failed to arrive is not dropped.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db, geometricMean, groupBy, kib, median, medianTime, readRows, seconds, table, timeCell } from "./lib/analysis.mjs";
import { defaultDataset, resultsDirectory, writeCsv } from "./lib/paths.mjs";

const out = [];
const say = text => out.push(text, "");
const t = (rows, key) => timeCell(medianTime(rows.map(row => row[key])));
const m = (rows, key, format = value => value) => { const value = median(rows.map(row => row[key])); return value === null ? "–" : format(value); };
const readJson = name => { const file = path.join(resultsDirectory, `${name}.json`); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; };
const PROFILE_LABEL = { fast: "50 Mbit/s, 20 ms", "moderate-mobile": "10 Mbit/s, 50 ms", "constrained-mobile": "2 Mbit/s, 100 ms", "very-constrained": "0.75 Mbit/s, 150 ms", none: "not throttled" };

// ─── Datasets ──────────────────────────────────────────────────────────

if (process.argv.includes("--datasets")) {
  const rows = [];
  for (const panorama of readdirSync(defaultDataset)) for (const variant of readdirSync(path.join(defaultDataset, panorama))) {
    const manifest = JSON.parse(readFileSync(path.join(defaultDataset, panorama, variant, "manifest.json"), "utf8"));
    for (const level of manifest.levels) rows.push({ panorama, projection: manifest.projection, tile: manifest.tile.logical, stored: manifest.tile.stored, level: level.level, faceSize: level.faceSize, tiles: level.tiles, replacementBytes: level.replacementBytes, residualBytes: level.residualBytes, replacementBytesWithoutGutter: level.replacementBytesWithoutGutter, largestTileBytes: level.largestReplacementBytes, clippedShare: manifest.residual?.clippedShare ?? null, manifestBytes: readFileSync(path.join(defaultDataset, panorama, variant, "manifest.json")).length, tileListBytes: readFileSync(path.join(defaultDataset, panorama, variant, "tiles.json")).length });
    for (const boot of manifest.bootstrap) rows.push({ panorama, projection: manifest.projection, tile: manifest.tile.logical, level: "bootstrap", faceSize: boot.faceSize, tiles: 1, replacementBytes: boot.bytes });
  }
  console.log(writeCsv("datasets", rows));
}
const datasets = readRows("datasets").filter(row => row.panorama !== "pattern");
if (datasets.length) {
  say("## Datasets");
  say("Finest level (faces of 1536 texels), JPEG quality 80, 4:2:0, libjpeg-turbo. Gutter overhead is the encoded bytes of the stored tiles against the same tiles without their one-texel gutter.");
  const finest = datasets.filter(row => row.faceSize === 1536 && row.level !== "bootstrap");
  say(table(["Panorama", "Projection", "Tile", "Tiles", "KiB", "Gutter: more texels", "Gutter: more bytes", "Residual level KiB", "Mean tile KiB", "Largest tile KiB"], finest.map(row => [row.panorama, row.projection, row.tile, row.tiles, kib(row.replacementBytes), `${(((row.tile + 2) ** 2 / row.tile ** 2 - 1) * 100).toFixed(1)}%`, `${((row.replacementBytes / row.replacementBytesWithoutGutter - 1) * 100).toFixed(1)}%`, kib(row.residualBytes), (row.replacementBytes / row.tiles / 1024).toFixed(1), kib(row.largestTileBytes)])));
  const whole = groupBy(datasets.filter(row => row.level !== "bootstrap"), ["panorama", "projection", "tile"]).map(group => {
    const levels = group.rows, last = levels.at(-1), sum = key => levels.reduce((total, row) => total + (row[key] ?? 0), 0);
    return { ...group.key, pyramid: sum("replacementBytes"), finest: last.replacementBytes, residual: sum("residualBytes") + levels[0].replacementBytes, manifest: last.manifestBytes, list: last.tileListBytes, clipped: last.clippedShare };
  });
  say("Whole sphere: every level as replacement tiles, the finest level alone, and the residual chain (level 0 as a replacement tile, every level above as a difference).");
  say(table(["Panorama", "Projection", "Tile", "Pyramid KiB", "Finest only KiB", "Residual chain KiB", "Residual ÷ pyramid", "Residual ÷ finest only", "Clipped residual values", "manifest.json bytes", "tiles.json bytes"], whole.map(row => [row.panorama, row.projection, row.tile, kib(row.pyramid), kib(row.finest), kib(row.residual), (row.residual / row.pyramid).toFixed(2), (row.residual / row.finest).toFixed(2), row.clipped === null ? "–" : `${(row.clipped * 100).toFixed(4)}%`, row.manifest, row.list])));
}

// ─── Correctness ───────────────────────────────────────────────────────

const geometry = readJson("correctness-geometry");
if (geometry) {
  say("## Correctness gates");
  say(table(["Projection", "Tile", "Views", "Tiles under the view checked", "Missed", "Pixels needing a finer level than their cell got", "Scout rays", "Tiles wanted"], geometry.selection.map(row => [row.projection, row.tile, row.views, row.tilesChecked, row.tilesMissed, row.pixelsNeedingAFinerLevelThanChosen, row.meanScoutRays, row.meanTilesWanted])));
  say("Steps across boundaries, in bytes (largest channel), between two directions 10⁻⁷ of a face apart on either side:");
  for (const [variant, steps] of Object.entries(geometry.seamStepBytes)) say(`**${variant}**\n\n${table(["Where", "Mean", "p95", "p99", "Max"], Object.entries(steps).map(([where, s]) => [where, s.mean, s.p95, s.p99, s.max]))}`);
  if (geometry.errorByDistanceFromFaceEdge) say(`Error against the closed-form pattern by distance from the nearest face edge (finest texels): ${Object.entries(geometry.errorByDistanceFromFaceEdge).map(([variant, bins]) => `${variant}: ${Object.entries(bins).map(([bin, value]) => `${bin} ${value.meanError}`).join(", ")}`).join("; ")}.`);
  say(`Finest texel against the source's (2π/6144 at the horizon): ${Object.entries(geometry.texelAngleOverSource).map(([where, ratio]) => `${where} ${ratio.toFixed(2)}`).join(", ")}.`);
}
const residualChecks = readJson("correctness-residual");
if (residualChecks) {
  say("Residual chain, synthetic targets, JPEG quality 80, 4:2:0 (PSNR of each level's tile against its own target):");
  for (const [image, rows] of Object.entries(residualChecks.syntheticChain)) say(`**${image}**\n\n${table(["Quadrant", "Level", "Replacement dB", "Residual dB", "Clipped"], rows.map(row => [row.quadrant, row.level, row.replacementPsnr, row.residualPsnr, row.clippedShare]))}`);
  say(`Decoder mismatch, ${residualChecks.decoderMismatch.decoders}:`);
  say(table(["Tile", "Level", "PSNR between decoders", "Largest difference", "Residual against replacement tile"], residualChecks.decoderMismatch.rows.map(row => [row.tile, row.level, row.psnrBetweenDecoders, row.largestDifference, row.psnrAgainstReplacementTile])));
}
const gpuRows = readRows("gpu-checks");
if (gpuRows.length) {
  say("## GPU against CPU");
  say("Every state drawn on the GPU and read back, against the same state drawn by lib/render-cpu.mjs. \"Blank\" counts pixels in the clear colour.");
  say(table(["Backend", "Path", "Dataset", "Payload", "States", "Median dB", "Worst dB", "Worst state", "Largest byte difference", "Blank pixels", "Bottom row first", "Blue first"], groupBy(gpuRows, ["backend", "path", "dataset", "payload"]).map(({ key, rows }) => {
    const worst = rows.reduce((a, b) => (b.psnrAgainstCpu < a.psnrAgainstCpu ? b : a));
    return [key.backend, key.path, key.dataset, key.payload, rows.length, m(rows, "psnrAgainstCpu", db), db(worst.psnrAgainstCpu), `${worst.table}, ${worst.camera}`, Math.max(...rows.map(row => row.largestDifferenceFromCpu)), rows.reduce((sum, row) => sum + row.blankPixels, 0), rows[0].readBackBottomUp, rows[0].readBackBlueFirst];
  })));
  const closed = gpuRows.filter(row => row.psnrAgainstClosedForm !== null && row.psnrAgainstClosedForm !== undefined);
  if (closed.length) say(table(["Backend", "Path", "Dataset", "Camera", "GPU against closed form dB", "CPU against closed form dB"], closed.map(row => [row.backend, row.path, row.dataset, row.camera, db(row.psnrAgainstClosedForm), db(row.cpuPsnrAgainstClosedForm)])));
}

// ─── Representation at matched quality ─────────────────────────────────

const representation = readRows("representation");
if (representation.length) {
  say("## Representation at matched quality");
  say("Phase 1's twelve views at the phone viewport (1082 × 2402, 75° vertical), every second pixel each way, against the source. Every cell at the finest level.");
  const tiles = representation.filter(row => row.kind === "tiles" && row.tile === 192 && row.payload === "replacement");
  say(table(["Panorama", "Projection", "JPEG quality", "Finest level KiB", "View PSNR", "View SSIM"], tiles.map(row => [row.panorama, row.projection, row.jpegQuality, kib(row.finestLevelBytes), db(row.viewPsnr, 2), row.viewSsim.toFixed(4)])));
  const interpolate = (curve, key, target) => {
    const sorted = [...curve].sort((a, b) => a[key] - b[key]);
    for (let i = 0; i < sorted.length - 1; i++) if (sorted[i][key] <= target && target <= sorted[i + 1][key]) {
      const f = (target - sorted[i][key]) / (sorted[i + 1][key] - sorted[i][key]);
      return Math.exp(Math.log(sorted[i].finestLevelBytes ?? sorted[i].bytes) * (1 - f) + Math.log(sorted[i + 1].finestLevelBytes ?? sorted[i + 1].bytes) * f);
    }
    return null;
  };
  const ratios = { viewPsnr: [], viewSsim: [] }, perPanorama = [];
  for (const panorama of [...new Set(tiles.map(row => row.panorama))]) {
    const eac = tiles.filter(row => row.panorama === panorama && row.projection === "eac"), cube = tiles.filter(row => row.panorama === panorama && row.projection === "cube"), at80 = eac.find(row => row.jpegQuality === 80);
    const entry = [panorama];
    for (const key of ["viewPsnr", "viewSsim"]) { const bytes = interpolate(cube, key, at80[key]); entry.push(bytes ? (at80.finestLevelBytes / bytes).toFixed(3) : "outside the measured range"); if (bytes) ratios[key].push(at80.finestLevelBytes / bytes); }
    perPanorama.push(entry);
  }
  say("Equi-angular bytes ÷ cubemap bytes for the quality the equi-angular cube reaches at JPEG quality 80, the cubemap's bytes interpolated in log bytes along its own quality ladder:");
  say(table(["Panorama", "Matched by PSNR", "Matched by SSIM"], [...perPanorama, ["Geometric mean", geometricMean(ratios.viewPsnr)?.toFixed(3) ?? "–", geometricMean(ratios.viewSsim)?.toFixed(3) ?? "–"]]));
  const wide = readRows("representation-face2048").filter(row => row.kind === "tiles");
  if (wide.length) {
    say("Faces of 2048 texels (256-texel tiles), the same views:");
    say(table(["Panorama", "Projection", "JPEG quality", "Finest level KiB", "View PSNR", "View SSIM"], wide.map(row => [row.panorama, row.projection, row.jpegQuality, kib(row.finestLevelBytes), db(row.viewPsnr, 2), row.viewSsim.toFixed(4)])));
    // The 2048 ladder starts above the 1536 one, so compare at equal bytes instead: 1536's PSNR interpolated in log bytes.
    const equalBytes = [];
    for (const row of wide) {
      const curve = tiles.filter(item => item.panorama === row.panorama && item.projection === row.projection).sort((a, b) => a.finestLevelBytes - b.finestLevelBytes);
      for (let i = 0; i < curve.length - 1; i++) if (curve[i].finestLevelBytes <= row.finestLevelBytes && row.finestLevelBytes <= curve[i + 1].finestLevelBytes) {
        const f = Math.log(row.finestLevelBytes / curve[i].finestLevelBytes) / Math.log(curve[i + 1].finestLevelBytes / curve[i].finestLevelBytes), at = curve[i].viewPsnr * (1 - f) + curve[i + 1].viewPsnr * f;
        equalBytes.push([row.panorama, row.projection, row.jpegQuality, kib(row.finestLevelBytes), db(row.viewPsnr, 2), db(at, 2), db(row.viewPsnr - at, 2)]);
      }
    }
    // EAC against cubemap on each ladder, at every EAC point whose quality the cubemap's ladder spans.
    const ladderRatios = [];
    for (const [name, ladder] of [["1536-texel faces, 192-texel tiles", tiles], ["2048-texel faces, 256-texel tiles", wide]]) for (const key of ["viewPsnr", "viewSsim"]) {
      const ratios = [];
      for (const point of ladder.filter(row => row.projection === "eac")) {
        const bytes = interpolate(ladder.filter(row => row.panorama === point.panorama && row.projection === "cube"), key, point[key]);
        if (bytes) ratios.push(point.finestLevelBytes / bytes);
      }
      ladderRatios.push([name, key === "viewPsnr" ? "PSNR" : "SSIM", ratios.length, ratios.length ? geometricMean(ratios).toFixed(3) : "–", ratios.length ? `${Math.min(...ratios).toFixed(2)} to ${Math.max(...ratios).toFixed(2)}` : "–"]);
    }
    say("Equi-angular bytes ÷ cubemap bytes at equal quality, over every point of each ladder the cubemap's ladder spans:");
    say(table(["Ladder", "Matched by", "Points", "Geometric mean", "Range"], ladderRatios));
    say("At equal bytes: a 2048-texel face against the 1536-texel ladder's PSNR at the same size:");
    say(table(["Panorama", "Projection", "2048 at JPEG quality", "KiB", "2048 dB", "1536 dB at these bytes", "Difference"], equalBytes));
  }
  const residual = representation.filter(row => row.kind === "tiles" && row.payload === "residual");
  say("The residual chain's final picture against replacement tiles at the same quality setting:");
  say(table(["Panorama", "Projection", "Replacement dB", "Residual dB", "Difference", "Residual level KiB", "Replacement level KiB"], residual.map(row => { const base = tiles.find(item => item.panorama === row.panorama && item.projection === row.projection && item.jpegQuality === 80); return [row.panorama, row.projection, db(base.viewPsnr, 2), db(row.viewPsnr, 2), db(row.viewPsnr - base.viewPsnr, 2), kib(row.finestLevelBytes), kib(base.finestLevelBytes)]; })));
  const sizes = representation.filter(row => row.kind === "tiles" && row.payload === "replacement" && row.jpegQuality === 80);
  say("Tile size at the same face size:");
  say(table(["Panorama", "Projection", "Tile", "Finest level KiB", "Pyramid KiB", "View PSNR"], sizes.sort((a, b) => a.panorama.localeCompare(b.panorama) || a.projection.localeCompare(b.projection) || a.tile - b.tile).map(row => [row.panorama, row.projection, row.tile, kib(row.finestLevelBytes), kib(row.pyramidBytes), db(row.viewPsnr, 2)])));
  say("Bootstrap and coarse levels, whole sphere, equi-angular:");
  const boots = representation.filter(row => row.kind === "bootstrap" && row.projection === "eac"), levels = representation.filter(row => row.kind === "level" && row.projection === "eac");
  say(table(["Panorama", "What", "Face texels", "KiB", "View PSNR", "View SSIM"], [...boots.map(row => [row.panorama, "bootstrap, one image", row.faceSize, (row.bytes / 1024).toFixed(1), db(row.viewPsnr, 2), row.viewSsim.toFixed(3)]), ...levels.map(row => [row.panorama, `level ${row.level}, tiles`, row.faceSize, kib(row.levelBytes), db(row.viewPsnr, 2), row.viewSsim.toFixed(3)])].sort((a, b) => a[0].localeCompare(b[0]) || a[2] - b[2])));
  const control = representation.filter(row => row.kind === "control");
  say("The current path's published images (jpeg-js, quality 80, no chroma subsampling), drawn bilinearly without mipmaps. They lie on the source's own grid, which the reference is drawn from: the 6144 image is the source re-encoded once.");
  say(table(["Panorama", "Width", "KiB", "View PSNR", "View SSIM", "Equi-angular finest level at q80: KiB, dB"], control.map(row => { const eac = tiles.find(item => item.panorama === row.panorama && item.projection === "eac" && item.jpegQuality === 80); return [row.panorama, row.width, kib(row.bytes), db(row.viewPsnr, 2), row.viewSsim.toFixed(4), `${kib(eac.finestLevelBytes)}, ${db(eac.viewPsnr, 2)}`]; })));
}

// ─── Simulation ────────────────────────────────────────────────────────

const sim = readRows("sim");
const profileOrder = ["fast", "moderate-mobile", "constrained-mobile", "very-constrained", "none"];
const byProfile = (a, b) => profileOrder.indexOf(a.key.profile) - profileOrder.indexOf(b.key.profile);
function deliveryTables(rows, title, variantLabel = "Variant") {
  say(`### ${title}`);
  const still = rows.filter(row => row.trace === "stationary"), turn = rows.filter(row => row.trace === "quick-turn");
  if (still.length) say(table(["Link", variantLabel, "n", "Bootstrap s", "Acceptable s", "High s", "Mean shortfall dB", "KiB at 1 s", "KiB at 2 s", "KiB in all", "Requests", "KiB never shown", "Final PSNR"], groupBy(still, ["profile", "variant"]).sort(byProfile).map(({ key, rows: group }) => [PROFILE_LABEL[key.profile], key.variant, group.length, m(group, "bootstrapMs", seconds), t(group, "acceptableMs"), t(group, "highMs"), m(group, "meanShortfallDb", db), m(group, "bytesAt1s", kib), m(group, "bytesAt2s", kib), m(group, "bytes", kib), m(group, "requests", value => value.toFixed(0)), m(group, "bytesNeverShown", kib), m(group, "finalPsnr", db)])));
  if (turn.length) say(table(["Link", variantLabel, "n", "Short before the turn dB", "Short as it ends dB", "PSNR as it ends", "Acceptable after s", "High after s", "KiB in all", "KiB cancelled", "KiB never shown"], groupBy(turn, ["profile", "variant"]).sort(byProfile).map(({ key, rows: group }) => [PROFILE_LABEL[key.profile], key.variant, group.length, m(group, "beforeTurnShortfallDb", db), m(group, "afterTurnShortfallDb", db), m(group, "afterTurnPsnr", db), t(group, "afterTurnAcceptableMs"), t(group, "afterTurnHighMs"), m(group, "bytes", kib), m(group, "cancelledBytes", kib), m(group, "bytesNeverShown", kib)])));
}
if (sim.length) {
  say("## Simulation (Phase 1's network model, the real client, judged on the CPU)");
  deliveryTables(sim.filter(row => row.set === "policies"), "Progression: direct, every level, residual");
  say("Moving cameras (one start, three panoramas):");
  say(table(["Trace", "Link", "Variant", "n", "Mean shortfall dB", "Share of time high", "KiB in all", "KiB never shown", "Cancelled KiB"], groupBy(sim.filter(row => row.set === "policies" && ["slow-turn", "explore"].includes(row.trace)), ["trace", "profile", "variant"]).sort((a, b) => a.key.trace.localeCompare(b.key.trace) || byProfile(a, b)).map(({ key, rows }) => [key.trace, PROFILE_LABEL[key.profile], key.variant, rows.length, m(rows, "meanShortfallDb", db), m(rows, "shareOfTimeHigh", value => value.toFixed(2)), m(rows, "bytes", kib), m(rows, "bytesNeverShown", kib), m(rows, "cancelledBytes", kib)])));
  deliveryTables(sim.filter(row => row.set === "representation"), "Equi-angular against cubemap, same client");
  const rep = sim.filter(row => row.set === "representation" && row.trace === "stationary");
  say(`Final view PSNR against the source, looking forward: ${groupBy(rep, ["variant"]).map(({ key, rows }) => `${key.variant} ${m(rows, "finalPsnr", db)} dB (n ${rows.length})`).join(", ")}. By start: ${groupBy(rep, ["start", "variant"]).map(({ key, rows }) => `${key.start} ${key.variant} ${m(rows, "finalPsnr", db)}`).join("; ")}.`);
  deliveryTables(sim.filter(row => row.set === "insurance"), "Policy A against policy B (insurance)");
  deliveryTables(sim.filter(row => row.set === "sweeps"), "One parameter at a time (two panoramas, off-axis start)");
}

// ─── Real HTTP ─────────────────────────────────────────────────────────

const http = readRows("http");
const httpMeta = readJson("http");
if (http.length) {
  say("## Throttled real HTTP over the loopback (Chrome's emulation, WebGL 2 unless named)");
  if (httpMeta?.calibration) say(table(["Profile", "Nominal", "Small request ms (median of 5)", "1 MiB alone", "Six ¼ MiB at once", "Protocol"], Object.entries(httpMeta.calibration).map(([id, value]) => { const small = [...value.measured.smallRequestMs].sort((a, b) => a - b)[2]; return [id, `${value.nominal.megabitsPerSecond} Mbit/s, ${value.nominal.roundTripMs} ms`, small.toFixed(0), `${(value.measured.oneMiB.ms / 1000).toFixed(2)} s = ${(8 * value.measured.oneMiB.bytes / value.measured.oneMiB.ms / 1000).toFixed(2)} Mbit/s`, `${(value.measured.sixQuarterMiB.ms / 1000).toFixed(2)} s`, value.measured.protocol]; })));
  const main = http.filter(row => row.set === "main");
  deliveryTables(main, "Candidates and the control, cold cache");
  if (main.length) {
    say("The control's own milestones (the 64-texel cube preview, then the 6144 equirectangular image):");
    say(table(["Link", "Panorama", "n", "Preview shown s", "Whole image arrived s", "Decode ms", "Upload, 4 MiB a frame, ms", "Whole image shown s", "Served KiB", "Worst upload frame ms"], groupBy(main.filter(row => row.variant === "control" && row.trace === "stationary"), ["profile", "panorama"]).sort(byProfile).map(({ key, rows }) => [PROFILE_LABEL[key.profile], key.panorama, rows.length, m(rows, "bootstrapMs", seconds), m(rows, "wholeArrivedMs", seconds), m(rows, "wholeDecodeMs", value => value.toFixed(0)), m(rows, "wholeUploadMs", value => value.toFixed(0)), m(rows, "wholeShownMs", seconds), m(rows, "serverBytes", kib), m(rows, "worstUploadFrameWorkMs", value => value.toFixed(1))])));
    // The simulator's prediction beside the measurement, for the runs both made.
    const pairs = [];
    for (const { key, rows } of groupBy(main.filter(row => row.variant !== "control"), ["variant", "profile", "trace"])) {
      const variant = { "eac-direct": ["policies", "direct"], "eac-levels": ["policies", "levels"], "eac-residual": ["policies", "residual"], "cube-direct": ["representation", "cube"] }[key.variant];
      const simulated = sim.filter(row => row.set === variant[0] && row.variant === variant[1] && row.profile === key.profile && row.trace === key.trace && row.start === "off-axis");
      if (!simulated.length) continue;
      pairs.push([key.variant, PROFILE_LABEL[key.profile], key.trace, `${t(simulated, "highMs")} / ${t(rows, "highMs")}`, `${m(simulated, "bytes", kib)} / ${m(rows, "bytes", kib)}`, `${m(simulated, "meanShortfallDb", db)} / ${m(rows, "meanShortfallDb", db)}`, key.trace === "quick-turn" ? `${t(simulated, "afterTurnAcceptableMs")} / ${t(rows, "afterTurnAcceptableMs")}` : "–", `${simulated.length} / ${rows.length}`]);
    }
    say("Simulated against measured, the same panoramas and start (simulation / real HTTP):");
    say(table(["Variant", "Link", "Trace", "High s", "KiB", "Mean shortfall dB", "Acceptable after the turn s", "n"], pairs));
  }
  const frames = http.filter(row => ["backends", "busy"].includes(row.set));
  if (frames.length) {
    say("### Backends and frames (not throttled; the quiet guard on)");
    say(table(["Set", "Backend asked", "Ran on", "Variant", "Trace", "n", "Disturbed", "Frame interval p50 / p95 / p99 / max ms", "Frames over 20 ms", "Tick ms p50 / p99 / max", "Render call ms p50 / p99", "Upload call ms p50 / max", "Decode ms p50", "Reconstruct ms p50 / max", "Worst frame with an upload ms", "GPU ms (timer)"], groupBy(frames, ["set", "backend", "variant", "trace"]).map(({ key, rows }) => [key.set, key.backend, rows[0].backendActual, key.variant, key.trace, rows.length, rows.filter(row => row.disturbed).length, `${m(rows, "frameIntervalMedian", db)} / ${m(rows, "frameIntervalP95", db)} / ${m(rows, "frameIntervalP99", db)} / ${m(rows, "frameIntervalMax", db)}`, m(rows, "framesOver20Ms", value => value.toFixed(0)), `${m(rows, "tickMsMedian", value => value.toFixed(3))} / ${m(rows, "tickMsP99", value => value.toFixed(2))} / ${m(rows, "tickMsMax", value => value.toFixed(1))}`, `${m(rows, "renderCallMsMedian", value => value.toFixed(3))} / ${m(rows, "renderCallMsP99", value => value.toFixed(2))}`, `${m(rows, "uploadCallMsMedian", value => value.toFixed(3))} / ${m(rows, "uploadCallMsMax", value => value.toFixed(2))}`, m(rows, "decodeMsMedian", value => value.toFixed(2)), `${m(rows, "reconstructMsMedian", value => value.toFixed(2))} / ${m(rows, "reconstructMsMax", value => value.toFixed(2))}`, m(rows, "worstUploadFrameWorkMs", value => value.toFixed(1)), rows[0].gpuValid ? m(rows, "gpuMsMean", value => value.toFixed(3)) : "invalid"])));
  }
  const warmPlain = readRows("http-warm");
  for (const setId of ["warm", "stress", "failures"]) {
    // The warm-cache set over HTTPS is not a warm cache (Chrome does not cache past a certificate error); the plain-HTTP rerun is.
    const rows = setId === "warm" && warmPlain.length ? warmPlain : http.filter(row => row.set === setId);
    if (setId === "warm" && warmPlain.length) say("The warm-cache set as rerun over plain HTTP/1.1 on 127.0.0.1 (`--plain-http`); over HTTPS with the self-signed certificate, Chrome cached nothing and the second visit fetched every file again.");
    if (!rows.length) continue;
    say(`### ${setId}`);
    say(table(["Variant", "Visit", "n", "Served responses", "Served KiB", "From the HTTP cache", "Bootstrap s", "High s", "Final PSNR", "Failures", "Retries", "Evictions", "Re-downloads", "Rematerialized", "Level capped", "Peak resident", "Peak decoded MiB", "Frames over 20 ms"], groupBy(rows, ["variant", "visit"]).map(({ key, rows: group }) => [key.variant, key.visit, group.length, m(group, "serverRequests"), m(group, "serverBytes", kib), m(group, "resourcesFromCache"), m(group, "bootstrapMs", seconds), t(group, "highMs"), m(group, "finalPsnr", db), m(group, "failures"), m(group, "retries"), m(group, "evictions"), m(group, "redownloads"), m(group, "rematerialized"), m(group, "levelCapped"), m(group, "peakResidentTiles"), m(group, "peakDecodedBytes", value => (value / 2 ** 20).toFixed(1)), m(group, "framesOver20Ms")])));
  }
}

writeFileSync(path.join(resultsDirectory, "tables.md"), `# Derived tables\n\nGenerated by make-tables.mjs from results/. Do not edit.\n\n${out.join("\n")}`);
console.log(path.join(resultsDirectory, "tables.md"));
