import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newOutputDirectory } from "./outputDirectory.mjs";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const buildRoot = path.join(repositoryRoot, "build");
/** Only source/evidence reads use retained records; new bytes always go to build/. */
export function retainedPath(...parts) { return path.join(repositoryRoot, ...parts); }
export function outputPath(...parts) {
  const output = path.resolve(buildRoot, ...parts);
  if (!output.startsWith(buildRoot + path.sep)) throw new Error("Research output escaped this owner's build/.");
  // Inspect an existing ancestor too: a symlink cannot redirect output outside.
  mkdirSync(buildRoot, { recursive: true });
  let ancestor = output;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realBuild = realpathSync(buildRoot), realAncestor = realpathSync(ancestor);
  if (realAncestor !== realBuild && !realAncestor.startsWith(realBuild + path.sep)) throw new Error("Research output ancestor escaped this owner's build/.");
  return output;
}

export const resultOverride = process.argv.find(arg => arg.startsWith("--results="))?.slice(10);
const results = new Map();
export function resultDirectory(area) {
  if (results.has(area)) return results.get(area);
  const key = "FOSS_EARTH_RESEARCH_RESULTS_" + area.toUpperCase().replaceAll("-", "_");
  const supplied = resultOverride ?? process.env[key];
  const absolute = supplied ? path.resolve(supplied) : path.join(newOutputDirectory("benchmarks", area), "results");
  if (!absolute.startsWith(buildRoot + path.sep)) throw new Error("--results must name a directory inside research build/.");
  const directory = outputPath(path.relative(buildRoot, absolute));
  process.env[key] = directory; results.set(area, directory);
  return directory;
}
