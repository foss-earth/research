import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentTarget, markdownTargets, publicOwnerDocumentTarget } from "./lib/documentLinks.mjs";
import { communityDocuments } from "./lib/communityDocuments.mjs";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(root, "link-routing.json"), "utf8"));
const inside = filename => filename === root || filename.startsWith(root + path.sep);
function ownerFile(relative) {
  const filename = path.resolve(root, relative);
  if (!inside(filename) || !existsSync(filename) || !inside(realpathSync(filename))) throw new Error("Missing or escaped owner document: " + relative);
  return filename;
}
let local = 0, compatibility = 0, publicNavigation = 0, declaredPending = 0;
for (const link of manifest.links) {
  const text = readFileSync(ownerFile(link.document), "utf8");
  if (!text.includes(link.newTarget)) throw new Error("Recorded link absent from " + link.document + ": " + link.newTarget);
  const result = documentTarget(link.document, link.newTarget, manifest.owner);
  if (result.kind === "external") {
    if (link.status === "routed-public-owner-navigation; publication availability pending") {
      const target = publicOwnerDocumentTarget(result.target);
      if (target.owner !== link.owner || target.path !== link.destinationPath) throw new Error("Public navigation disagrees with recorded owner: " + result.target);
      publicNavigation++; declaredPending++;
    } else {
      const exact = "https://github.com/foss-earth/foss-earth.github.io/blob/" + manifest.sourceRevision + "/";
      if (!result.target.startsWith(exact)) throw new Error("Compatibility link lacks immutable source pin: " + result.target);
      compatibility++;
    }
  } else {
    if (result.owner !== manifest.owner) throw new Error("Nonportable sibling navigation: " + link.newTarget);
    ownerFile(result.path); local++;
  }
  if (link.status.startsWith("unresolved")) declaredPending++;
}

const documents = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "build", "dist", "node_modules"].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Source navigation must not follow a symbolic link: " + filename);
    if (entry.isDirectory()) collect(filename);
    else if (entry.isFile() && entry.name.endsWith(".md")) documents.push(path.relative(root, filename).split(path.sep).join("/"));
  }
}
collect(root);
let currentLocal = 0, currentExternal = 0;
for (const document of documents) for (const target of markdownTargets(readFileSync(ownerFile(document), "utf8"))) {
  const result = documentTarget(document, target, manifest.owner);
  if (result.kind === "external") { currentExternal++; continue; }
  if (result.owner !== manifest.owner) throw new Error("Current navigation requires an undeclared adjacent checkout: " + document + " -> " + target);
  ownerFile(result.path); currentLocal++;
}
const community = Object.fromEntries(["README.md", "AGENTS.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "LICENSE", "SECURITY.md"].map(file => [file, readFileSync(ownerFile(file), "utf8")]));
communityDocuments(community);
console.log(JSON.stringify({ check: "independent owner document routes, current Markdown and community navigation", documents: documents.length, local, immutableCompatibility: compatibility, publicNavigation, declaredPending, currentLocal, currentExternal, siblingCheckoutsRead: 0, networkChecked: false, anchorQualification: false, publicationReady: false }));
