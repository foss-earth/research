// Summarises map detail evidence as Markdown tables.
//   node benchmarks/map-detail/report.mjs <binding-dir> <sweep-dir> > summary.md
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const [bindingDir, sweepDir] = process.argv.slice(2);
const out = [];
const fmt = (value, digits = 1) => (value === null || value === undefined || Number.isNaN(value) ? "–" : typeof value === "number" ? value.toFixed(digits) : String(value));
// Retained evidence keeps only some screenshots, some of them as JPEG.
const shot = (dir, file) => {
  if (!file) return "–";
  for (const name of [file, file.replace(/\.png$/, ".jpg")]) {
    if (existsSync(path.join(dir, name))) return `[image](${path.basename(dir)}/${name})`;
  }
  return "–";
};

if (bindingDir && existsSync(bindingDir)) {
  out.push("## Binding fixtures", "");
  for (const file of readdirSync(bindingDir).filter(name => /^binding-.*\.json$/.test(name)).sort()) {
    const report = JSON.parse(readFileSync(path.join(bindingDir, file), "utf8"));
    out.push(`### ${report.backend}`, "", `GPU: ${report.gpu.devices}. Chrome ${report.chrome}. Commit \`${report.commit.slice(0, 12)}\` with uncommitted changes.`, "");
    out.push("| Scenario | Foreign pixels | Mid-churn foreign | Misplaced probes | Max texel error | Terrain unchanged | Next 2.5 s (sel/upl/table) | Then 3 s stationary (sel/upl/table) | Levels | Limits | Screenshot |");
    out.push("|---|---:|---|---:|---:|---|---|---|---|---|---|");
    for (const row of report.results) {
      if (row.error) { out.push(`| ${row.scenario} | error: ${row.error.split("\n")[0]} |||||||||| |`); continue; }
      const work = (counts) => counts ? `${counts.selections}/${counts.uploads}/${counts.tableWrites}` : "–";
      out.push(`| ${row.scenario} | ${row.image ? `${row.image.foreignPixels} / ${row.image.terrainPixels}` : "–"} | ${row.intermediate?.length ? row.intermediate.map(check => check.foreignPixels).join(", ") : "–"} | ${row.placement.misplaced} / ${row.placement.probes} | ${fmt(row.placement.maxTexelError, 2)} | ${row.independence.unchanged ? "yes" : "**no**"} | ${work(row.afterChange)} | ${work(row.stationary)} | ${Object.keys(row.diagnostics?.plan?.levels ?? {}).join(", ")} | ${row.feedback.limits.join(", ") || "none"} | ${shot(bindingDir, row.screenshot)} |`);
    }
    out.push("");
  }
}

if (sweepDir && existsSync(sweepDir)) {
  for (const file of readdirSync(sweepDir).filter(name => /^sweep-.*\.json$/.test(name)).sort()) {
    const report = JSON.parse(readFileSync(path.join(sweepDir, file), "utf8"));
    out.push(`## Sweep on ${report.backend}`, "", `GPU: ${report.gpu.devices}. Chrome ${report.chrome}. ${report.note}`, "");
    if (report.httpErrors && Object.keys(report.httpErrors).length) {
      out.push(`HTTP errors by endpoint: ${Object.entries(report.httpErrors).map(([key, count]) => `${key} ×${count}`).join("; ")}.`, "");
    }
    out.push("| Case | Settle s | Requests | MB | Sharpness | Frame p50 / p95 / p99 ms | CPU p95 ms | Draws | Delivered levels | Atlas GPU MB | Limits | Screenshot |");
    out.push("|---|---:|---:|---:|---:|---|---:|---:|---|---:|---|---|");
    for (const row of report.results) {
      if (row.error) { out.push(`| ${row.case} | error: ${row.error.split("\n")[0]} |||||||||| |`); continue; }
      const requests = Object.values(row.requests ?? {}).reduce((sum, host) => sum + host.requests, 0);
      const regions = row.imagery?.atlas?.plan?.regions ?? [];
      const delivered = {};
      for (const region of regions) if (region.screenArea > 0 && region.delivered !== null) delivered[region.delivered] = (delivered[region.delivered] ?? 0) + 1;
      const levels = row.imagery?.mode === "atlas"
        ? Object.entries(delivered).sort((a, b) => b[0] - a[0]).slice(0, 4).map(([level, count]) => `${level}×${count}`).join(" ")
        : "per tile";
      out.push(`| ${row.case} | ${fmt(row.settle.ms / 1000)}${row.settle.timedOut ? " (timeout)" : ""} | ${requests} | ${fmt(row.downloadBytes / 1048576)} | ${fmt(row.sharpness, 2)} | ${fmt(row.steady.intervals.p50)} / ${fmt(row.steady.intervals.p95)} / ${fmt(row.steady.intervals.p99)} | ${fmt(row.steady.cpu.p95, 2)} | ${row.steady.drawCalls.p50} | ${levels} | ${row.imagery?.atlas?.atlas ? fmt(row.imagery.atlas.atlas.estimatedGpuBytes / 1048576, 0) : "–"} | ${row.feedback.limits.join(", ") || "none"} | ${shot(sweepDir, row.screenshot)} |`);
    }
    out.push("");
    const sequences = report.results.filter(row => row.sequences);
    if (sequences.length) {
      out.push("### Sequences on the atlas", "", "| Case | Sequence | Seconds | Frame p95 / p99 ms | CPU p95 ms | Requests | MB | Terrain revisions | Displayed source |", "|---|---|---:|---|---:|---:|---:|---:|---|");
      for (const row of sequences) {
        for (const [name, sequence] of Object.entries(row.sequences)) {
          const requests = Object.entries(sequence.requests ?? {}).map(([host, value]) => `${host.includes("/") ? host.split("/").at(-1) : host.split(".")[0]} ${value.requests}`).join(", ") || "0";
          out.push(`| ${row.case} | ${name} | ${fmt(sequence.ms / 1000)} | ${fmt(sequence.intervals.p95)} / ${fmt(sequence.intervals.p99)} | ${fmt(sequence.cpu.p95, 2)} | ${requests} | ${fmt(sequence.downloadBytes / 1048576)} | ${sequence.revisionChanges} | ${sequence.displayedSource} |`);
        }
      }
      out.push("");
    }
  }
}
process.stdout.write(`${out.join("\n")}\n`);
