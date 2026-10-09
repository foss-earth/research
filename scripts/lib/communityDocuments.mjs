import { markdownTargets } from "./documentLinks.mjs";

const rule = "You cannot have AI as a co-author, or your contributions will be rejected.";
/** Validate document presentation only; common CI owns identity/admission policy. */
export function communityDocuments(documents) {
  for (const file of ["CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "LICENSE", "SECURITY.md"]) {
    if (typeof documents[file] !== "string" || documents[file].trim().length < 100) throw new Error("Missing real community document: " + file);
    if (!markdownTargets(documents["README.md"] ?? "").includes(file)) throw new Error("Missing own README community link: " + file);
  }
  if (documents["README.md"].includes(rule) || documents["README.md"].includes(rule.toUpperCase())) throw new Error("Contribution rule belongs later in CONTRIBUTING, not README.");
  if (!documents["LICENSE"].includes("GNU AFFERO GENERAL PUBLIC LICENSE")) throw new Error("Preserve the inherited AGPL license.");
  if (!documents["AGENTS.md"]?.includes(rule)) throw new Error("Agent policy needs the current contribution sentence.");
  const contributing = documents["CONTRIBUTING.md"];
  const section = contributing.indexOf("## Commit attribution");
  const sentence = contributing.indexOf(rule);
  if (section < 0 || sentence < section || !/^## /m.test(contributing.slice(0, section))) throw new Error("Contribution rule needs a later Commit attribution section.");
  const explanation = contributing.slice(section);
  for (const term of ["vendor", "advertising", "accountable", "provenance", "rights"]) if (!explanation.includes(term)) throw new Error("Missing contribution-credit explanation: " + term);
  return true;
}
