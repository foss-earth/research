import { markdownTargets } from "./documentLinks.mjs";

/** Validate document presentation only. Code of conduct, contributing and security policies are the organization's (foss-earth/.github); the license stays with each repository. */
export function communityDocuments(documents) {
  if (typeof documents["LICENSE"] !== "string" || documents["LICENSE"].trim().length < 100) throw new Error("Missing real community document: LICENSE");
  if (!markdownTargets(documents["README.md"] ?? "").includes("LICENSE")) throw new Error("Missing own README community link: LICENSE");
  if (!documents["LICENSE"].includes("GNU AFFERO GENERAL PUBLIC LICENSE")) throw new Error("Preserve the inherited AGPL license.");
  return true;
}
