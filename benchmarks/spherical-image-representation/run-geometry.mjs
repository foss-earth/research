#!/usr/bin/env node
/**
 * Experiment 1: how each representation spreads its samples over the sphere.
 * Geometry only; no image. The hexagon-cell icosahedral variant is left out:
 * its samples are where the rhombus cells' are, so its lattice figures are
 * the rhombus variant's.
 *
 *   node benchmarks/spherical-image-representation/run-geometry.mjs [--targets=3000,50000,800000] [--representations=…]
 *
 * Writes results/geometry.json (statistics, histograms, latitude profiles) and
 * results/geometry.csv (one row per representation and resolution).
 */
import { REPRESENTATIONS, representation, resolutionFor, sampleCount } from "./lib/representations.mjs";
import { latitudeProfile, measureCells, summarizeCells } from "./lib/geometry.mjs";
import { parseArguments, writeCsv, writeResults } from "./lib/environment.mjs";

const options = parseArguments({ targets: ["3000", "50000", "800000"], representations: REPRESENTATIONS.filter(rep => !rep.hexagonCells).map(rep => rep.id), subdivide: 4 });
const targets = options.targets.map(Number);
const results = [], table = [];
for (const id of options.representations) {
  const rep = representation(id);
  for (const target of targets) {
    const N = resolutionFor(rep, target);
    if (results.some(result => result.representation === id && result.N === N)) continue;
    const started = performance.now();
    const cells = measureCells(rep, N, { subdivide: options.subdivide });
    const summary = summarizeCells(cells);
    results.push({ representation: id, label: rep.label, family: rep.family, N, chartSize: [rep.chartWidth(N), rep.chartHeight(N)], charts: rep.charts, ...summary, latitudeProfile: latitudeProfile(cells) });
    table.push({
      representation: id, N, samples: sampleCount(rep, N),
      areaMaxOverMin: summary.area.maxOverMin, areaStd: summary.area.standardDeviation, areaMin: summary.area.min, areaMax: summary.area.max,
      areaP01: summary.area.p01, areaP99: summary.area.p99,
      chartAspectMean: summary.chartAspect.areaWeightedMean, chartAspectMax: summary.chartAspect.max,
      stretchMajorMax: summary.chartStretchMajor.max, stretchMajorMean: summary.chartStretchMajor.areaWeightedMean, stretchMinorMin: summary.chartStretchMinor.min,
      coveringWorst: summary.coveringRadius.max, coveringMean: summary.coveringRadius.areaWeightedMean,
      coveringExcessMean: summary.coveringExcess.areaWeightedMean, coveringExcessMax: summary.coveringExcess.max,
      efficiencyAtWorstCovering: summary.efficiencyAtWorstCovering, efficiencyAtRmsCovering: summary.efficiencyAtRmsCovering,
      totalAreaOverSphere: summary.totalAreaOverSphere,
    });
    console.log(`${id} N=${N}: ${sampleCount(rep, N)} samples, ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
}
console.table(table.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "number" && !Number.isInteger(value) ? Number(value.toFixed(3)) : value]))));
console.log(writeResults("geometry", import.meta.url, { targets, subdivide: options.subdivide, method: "see lib/geometry.mjs" }, { results }));
console.log(writeCsv("geometry", table));
