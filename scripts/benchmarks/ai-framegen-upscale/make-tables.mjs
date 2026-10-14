/**
 * Combine Stage 1/2 evidence and recompute registered gates, retaining source
 * hashes and diagnostic/unqualified labels. Run after parity/quality/timing:
 * node scripts/benchmarks/ai-framegen-upscale/make-tables.mjs --parity=<file>
 *   --quality=<file> --timing=<results folder> [--publish]
 * Default writes a fresh build/tables run. --publish deliberately copies small
 * numeric summaries/provenance into benchmarks/ai-framegen-upscale/results/.
 * No weights, graphs, raw tensors or corpus-derived images are published.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArguments, runDirectory, writeResults, writeCsv, scriptReceipt, formatJson, repositoryRoot, sha256File } from "./lib/environment.mjs";
import { checkDeviceParity, checkFullPath, checkPlacement, checkInjection, checkMemory, checkFgQuality, checkSrQuality, fgQualityEntries, srQualityInput } from "./lib/gates.mjs";

const load = file => JSON.parse(readFileSync(file, "utf8"));
const n = (value, digits = 3) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : value === "Infinity" ? "∞" : "—";
const pass = gate => gate?.pass === true ? "pass" : gate?.status === "UNVERIFIED" ? "unverified" : gate ? "fail" : "not run";
const table = (columns, rows) => `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n${rows.map(row => `| ${row.join(" | ")} |`).join("\n")}\n`;

/** Pure recomputation; every case remains visible, never select the best one. */
export function parityRows(parity) {
  return parity.profiles.flatMap(profile => {
    const D = checkPlacement(profile.placement ?? { cpuNodes: null });
    const peak = profile.memory?.accounting?.incremental?.peakBytes;
    const F = peak === undefined ? null : checkMemory({ peakIncrementalBytes: peak });
    return (profile.cases?.length ? profile.cases : [{ case: "not run" }]).map(item => {
      const B = item.deviceParity ? checkDeviceParity({ precision: profile.precision, ...item.deviceParity, psnrDb: item.deviceParity.psnrDb === "Infinity" ? Infinity : item.deviceParity.psnrDb }) : null;
      const C = item.fullPath ? checkFullPath({ precision: profile.precision, ...item.fullPath }) : null;
      const E = item.fullPath?.injection ? checkInjection(item.fullPath.injection) : null;
      const disagreement = [B && B.pass !== item.gateB?.pass, C && C.pass !== item.gateC?.pass, D.pass !== profile.gateD?.pass && profile.gateD !== undefined, E && E.pass !== item.gateE?.pass, F && F.pass !== profile.gateF?.pass].some(Boolean);
      return { candidate: profile.candidate, profile: profile.profile, precision: profile.precision, case: item.case, modelSha256: profile.modelSha256 ?? null,
        status: profile.status, A: profile.graph?.gateA?.pass === true, exportMaxAbs: profile.graph?.gateA?.maxAbs ?? null, exportMeanAbs: profile.graph?.gateA?.meanAbs ?? null,
        B, C, D, E, F, disagreement, maxAbs: item.deviceParity?.maxAbs ?? null, meanAbs: item.deviceParity?.meanAbs ?? null, psnrDb: item.deviceParity?.psnrDb ?? null,
        withinOnePercent: item.fullPath ? 100 * item.fullPath.withinOneFraction : null, maxCodes: item.fullPath?.maxDifference ?? null,
        peakMiB: peak === undefined ? null : peak / 2 ** 20, error: profile.error ?? profile.reason ?? null };
    });
  });
}

export function qualityRows(quality) {
  const complete = !!quality.completedAt && quality.mode === "final" && quality.screenCoverage?.complete === true;
  return quality.verdicts.map(entry => {
    let computed;
    if (entry.part.startsWith("FG ")) {
      const part = quality.fg?.[entry.candidate]?.[entry.profile]?.[entry.precision]?.[entry.part.slice(3)];
      computed = checkFgQuality(fgQualityEntries(part));
      if (part?.invalidOutput) computed.pass = false;
    } else {
      const part = quality.sr?.[entry.candidate]?.[entry.profile]?.[entry.precision];
      computed = checkSrQuality(srQualityInput(part));
      if (part?.invalidOutput) computed.pass = false;
    }
    return { ...entry, complete, recomputed: computed, disagreement: computed.pass !== (entry.verdict === "pass"), cpuQualityGatePass: complete && entry.precision === "fp32" && entry.status === "gate" && entry.gateA === true && entry.verdict === "pass" };
  });
}

/** The published H row. `admitted` is the CPU gate, not the file-level complete flag and not an fp16 verdict. */
export function qualityPublication(row) {
  return { status: row.status ?? "—", verdict: row.verdict, admitted: row.cpuQualityGatePass === true ? "yes" : "no" };
}

function timingRows(timings) {
  return timings.flatMap(run => Object.entries(run.summary?.screens ?? {}).map(([variant, screen]) => {
    const stage = run.summary.variants?.[variant];
    const fg = run.configuration.candidate === "rife-4.25-lite";
    const values = fg ? Object.entries(screen.values ?? {}) : [["SR", screen.values]];
    return values.map(([regime, value]) => ({ candidate: run.configuration.candidate, profile: run.configuration.profile, variant, regime,
      graphCapture: run.configuration.graphCapture, taps: run.configuration.taps, qualified: screen.qualification?.qualified ?? false,
      acceptedRounds: screen.qualification?.acceptedRounds ?? 0, aaPercent: screen.qualification?.aa?.differencePercent ?? null,
      renderMedian: stage?.renderGpuMs?.medianOfBlockMedians ?? null, cinMedian: stage?.cinGpuMs?.medianOfBlockMedians ?? null,
      modelMedian: stage?.modelSpanMs?.medianOfBlockMedians ?? null, coutMedian: stage?.coutGpuMs?.medianOfBlockMedians ?? null,
      presentMedian: stage?.presentGpuMs?.medianOfBlockMedians ?? null, reconstructionMedian: stage?.reconstructionGpuMs?.medianOfBlockMedians ?? null,
      totalMedian: stage?.totalGpuMs?.medianOfBlockMedians ?? null, costs: value?.conservative ?? null, verdict: value?.verdict ?? "not evaluated",
      bound: value?.bound ?? null, reliedOn: value?.reliedOn ?? null, gate: value, costStatistic: screen.costStatistic, reasons: screen.qualification?.reasons ?? [screen.reason] }));
  }).flat());
}

export async function main() {
  const options = parseArguments({ parity: "", quality: "", timing: "", "capture-parity": "", "optimizer-diagnostic": "", publish: false });
  if (!options.parity || !options.quality) throw new Error("--parity and --quality are required");
  const parity = load(options.parity), quality = load(options.quality);
  const timingFiles = options.timing ? readdirSync(options.timing).filter(name => /^timing-.*\.json$/.test(name)).sort().map(name => path.join(options.timing, name)) : [];
  const timings = timingFiles.map(load);
  const P = parityRows(parity), H = qualityRows(quality), G = timingRows(timings);
  if (P.some(row => row.disagreement) || H.some(row => row.disagreement)) throw new Error("recomputed gate disagrees with recorded verdict; review before publishing");
  if (!quality.completedAt || !quality.screenCoverage?.complete || quality.mode !== "final") throw new Error("final complete quality screen is required; partial/development cannot be published");
  const sourceFiles = [options.parity, options.quality, ...timingFiles, ...[options["capture-parity"], options["optimizer-diagnostic"]].filter(Boolean)];
  const provenance = { schema: 1, createdAt: new Date().toISOString(), generator: scriptReceipt(import.meta.url),
    sourceResults: sourceFiles.map(file => ({ ...scriptReceipt(file), bytes: statSync(file).size })), corpusImagesPublished: false,
    qualification: "GPU timings can qualify only as conditional observations on this machine; CPU/elapsed/cold timings remain unqualified. G_span/U_span is an upper bound; no kernel lower bound measured.",
    review: "Root plus independent workflow adversarial reviews; final gate rows recomputed from numeric results. Contact sheets remain in build for human inspection." };
  const cold = (parity.coldLoads ?? []).map(entry => ({ candidate: entry.candidate, profile: entry.profile, precision: entry.precision, cacheState: entry.cacheState, repeat: entry.repeat,
    modelSha256: entry.modelSha256, status: entry.status, fetchMs: entry.result?.fetchMs ?? null, bytes: entry.result?.bytes ?? null, importMs: entry.result?.importMs ?? null,
    createMs: entry.result?.createMs ?? null, firstAvailableMs: entry.result?.first?.availableMs ?? null, secondAvailableMs: entry.result?.second?.availableMs ?? null, error: entry.error ?? null }));
  const lines = ["# AI frame generation and upscaling: registered gate results", "", "Generated from the selected numeric evidence in [results/](results/). All errors compare cropped RGB; A/B clamp to [0,1]. Failed and unverified gates remain visible. Cold and CPU wall times are unqualified observations. See [REPORT.md](REPORT.md) for recommendations and limits.", "", "## Export and browser parity", "",
    table(["Candidate", "Profile", "Precision", "Case", "A", "B max / mean", "B PSNR dB", "B", "C within ±1 / max codes", "C", "D", "E", "F MiB / gate"],
      P.map(row => [row.candidate, row.profile, row.precision, row.case, row.A ? "pass" : "fail/not run", `${n(row.maxAbs, 6)} / ${n(row.meanAbs, 6)}`, n(row.psnrDb, 2), pass(row.B), `${n(row.withinOnePercent, 2)}% / ${row.maxCodes ?? "—"}`, pass(row.C), pass(row.D), pass(row.E), `${n(row.peakMiB, 2)} / ${pass(row.F)}`])),
    "", "## Final replay quality (gate H)", "", "All six sequences; cut-straddling FG pairs excluded and recorded separately. Status `gate` is the fp32 screen; fp16 stays `supplementary`. CPU H is yes only for a complete final fp32 gate row that passed export parity and H. It does not admit the profile: failed device parity, capture parity or memory still stop it. Human inspection remains required beyond Stage 2.", "",
    table(["Candidate", "Profile", "Precision", "Part", "Status", "H", "Failing sequences", "CPU H"], H.map(row => { const published = qualityPublication(row); return [row.candidate, row.profile, row.precision, row.part, published.status, published.verdict, (row.failingSequences ?? []).join(", ") || "—", published.admitted]; })),
    "", "## Full-path GPU observations and gate G", "", "Milliseconds. Medians are medians of block medians; G uses the conservative sum of per-stage p95 values over accepted candidate/A-A rounds. Model spans include GPU idle while the CPU submits commands. No lower kernel bound was measured. R for the globe is unknown.", "",
    table(["Candidate/profile", "Variant", "Capture", "Cin", "Model span", "Cout", "P total", "Reconstruction", "R + reconstruction", "Accepted / A-A %", "Qualified"], G.map(row => [`${row.candidate}/${row.profile}`, row.variant, String(row.graphCapture), n(row.cinMedian), n(row.modelMedian), n(row.coutMedian), n(row.presentMedian), n(row.reconstructionMedian), n(row.totalMedian), `${row.acceptedRounds} / ${n(row.aaPercent, 2)}`, String(row.qualified)])),
    "", table(["Profile/variant", "Screen", "p95 W", "FG R budget / SR R_native_min rho=.25,.5", "G decision", "Bound"], G.map(row => [`${row.profile}/${row.variant}${row.graphCapture ? " captured" : ""}`, row.regime, n(row.costs?.W_FG ?? row.costs?.W_SR), row.costs?.R_budget !== undefined ? n(row.costs.R_budget) : `${n(row.costs?.R_native_min?.[0.25])}, ${n(row.costs?.R_native_min?.[0.5])}`, `${row.verdict}${row.qualified ? "" : " (unqualified)"}`, row.bound ?? "no admission bound"])),
    "", "Disqualified profiles were not timed. The combined FG→SR screen is not computed without admitted RIFE stage costs. Sustained 3 × 60 s and five-minute combined runs are not run when no profile passes the complete screen.", "", "## Separate cold/cache-warm starts", "", "Three starts per graph and cache state. Fetch, ORT import, session create and first/second output retirement are separate; these wall times include browser/CDP/setup interference and do not qualify as isolated cost.", "",
    table(["Candidate/profile", "Precision", "Cache", "Rep", "Fetch", "Import", "Create", "First available", "Second available", "Status"], cold.map(row => [`${row.candidate}/${row.profile}`, row.precision, row.cacheState, row.repeat, n(row.fetchMs, 1), n(row.importMs, 1), n(row.createMs, 1), n(row.firstAvailableMs, 1), n(row.secondAvailableMs, 1), row.status])), ""];
  const run = runDirectory("tables");
  const files = [];
  for (const [name, data] of Object.entries({ "parity-summary": { profiles: P, environment: parity.environment }, "quality-summary": { rows: H, fg: quality.fg, sr: quality.sr, models: quality.models, screenCoverage: quality.screenCoverage, completedAt: quality.completedAt, sequences: quality.sequences }, "timing-summary": { rows: G, comparisons: timings.map(run => ({ configuration: run.configuration, comparisons: run.summary?.comparisons ?? [], stop: run.stop, preparation: { timer: run.preparation?.timer, kernelLowerBound: run.preparation?.kernelLowerBound }, warmup: run.warmup, sustained: run.sustained, environment: run.environment })) }, "cold-loads": cold, provenance })) {
    files.push(await writeResults(run.results, name, import.meta.url, options, { evidence: data, provenance }));
  }
  const markdown = path.join(run.root, "tables.md"); writeFileSync(markdown, lines.join("\n"));
  files.push(writeCsv(run.results, "parity", P.map(row => ({ ...row, B: pass(row.B), C: pass(row.C), D: pass(row.D), E: pass(row.E), F: pass(row.F) }))));
  if (options.publish) {
    const destination = path.join(repositoryRoot, "benchmarks", "ai-framegen-upscale"); mkdirSync(path.join(destination, "results"), { recursive: true });
    for (const file of files) {
      if (statSync(file).size >= 1000000) throw new Error(`${path.basename(file)} exceeds selected evidence limit; split/review it`);
      copyFileSync(file, path.join(destination, "results", path.basename(file)));
    }
    copyFileSync(markdown, path.join(destination, "tables.md"));
    if (options["capture-parity"]) {
      if (statSync(options["capture-parity"]).size >= 1000000) throw new Error("capture evidence exceeds 1MB limit");
      copyFileSync(options["capture-parity"], path.join(destination, "results", "capture-parity.json"));
    }
    if (options["optimizer-diagnostic"]) {
      if (statSync(options["optimizer-diagnostic"]).size >= 1000000) throw new Error("optimizer evidence exceeds 1MB limit");
      copyFileSync(options["optimizer-diagnostic"], path.join(destination, "results", "optimizer-diagnostic.json"));
    }
  }
  console.log(`tables: ${markdown}; published=${options.publish}`);
  return { run, P, H, G, provenance };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
