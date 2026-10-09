import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "tools-manifest.json"), "utf8"));
for (const tool of manifest.tools) {
  const file = path.join(root, tool.path);
  if (!realpathSync(file).startsWith(realpathSync(root) + path.sep)) throw new Error("Tool escaped its owner: " + tool.path);
  const bytes = readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== tool.sha256) throw new Error("Refresh tool source receipt after editing " + tool.path);
  for (const dependency of tool.dependencies) {
    if (dependency.kind === "local" && !existsSync(path.join(root, dependency.path))) throw new Error("Missing local tool dependency " + dependency.path);
    if (dependency.kind === "public-owner" && !manifest.publicOwnerDependencies.includes(dependency.specifier)) throw new Error("Undeclared public export " + dependency.specifier);
    if (dependency.kind === "forbidden-checkout") throw new Error("Experiment imports a private app checkout: " + dependency.specifier);
  }
  if (tool.runtimeQualification !== false || !tool.requirements.length) throw new Error("Tool must state the unqualified prerequisites: " + tool.path);
}
console.log(JSON.stringify({ check: "research source graph and declared prerequisites", sources: manifest.tools.length, toolsExecuted: 0, qualification: false, unresolvedRequirements: [...new Set(manifest.tools.flatMap(tool => tool.requirements))] }));
