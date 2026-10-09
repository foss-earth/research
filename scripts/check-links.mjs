import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentTarget } from "./lib/documentLinks.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "link-routing.json"), "utf8"));
const allowed = new Map([[manifest.owner, root]]);
for (const name of ["docs", "research"]) {
  const sibling = path.join(root, "..", name);
  if (existsSync(path.join(sibling, "package.json"))) allowed.set("foss-earth/" + name, sibling);
}
let local = 0, compatibility = 0, declaredPending = 0;
for (const link of manifest.links) {
  const text = readFileSync(path.join(root, link.document), "utf8");
  if (!text.includes(link.newTarget)) throw new Error("Recorded link absent from " + link.document + ": " + link.newTarget);
  const result = documentTarget(link.document, link.newTarget, manifest.owner);
  if (result.kind === "external") {
    const exact = "https://github.com/foss-earth/foss-earth.github.io/blob/" + manifest.sourceRevision + "/";
    if (!result.target.startsWith(exact)) throw new Error("Compatibility link lacks immutable source pin: " + result.target);
    compatibility++;
  } else {
    const ownerRoot = allowed.get(result.owner);
    if (!ownerRoot) { declaredPending++; continue; }
    const destination = path.join(ownerRoot, result.path);
    if (!existsSync(destination)) throw new Error("Missing routed local document: " + result.owner + "/" + result.path);
    if (!realpathSync(destination).startsWith(realpathSync(ownerRoot) + path.sep)) throw new Error("Routed document follows a link outside its owner.");
    local++;
  }
  if (link.status.startsWith("unresolved")) declaredPending++;
}
console.log(JSON.stringify({ check: "routed document source links", local, immutableCompatibility: compatibility, declaredPending, networkChecked: false, anchorQualification: false, publicationReady: false }));
