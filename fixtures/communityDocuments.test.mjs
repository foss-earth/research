import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { communityDocuments } from "../scripts/lib/communityDocuments.mjs";

const documents = Object.fromEntries(["README.md", "AGENTS.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "LICENSE", "SECURITY.md"].map(file => [file, readFileSync(new URL("../" + file, import.meta.url), "utf8")]));
test("the actual owner documents expose working local policy links and later attribution rationale", () => {
  assert.equal(communityDocuments(documents), true);
});
test("a copied placeholder, early rule or missing rationale cannot satisfy community coverage", () => {
  assert.throws(() => communityDocuments({ ...documents, "SECURITY.md": "See another project" }), /Missing real/);
  assert.throws(() => communityDocuments({ ...documents, "README.md": documents["README.md"].replace("(LICENSE)", "(https://example.com/other-license)") }), /Missing own README/);
  const rule = "You cannot have AI as a co-author, or your contributions will be rejected.";
  assert.throws(() => communityDocuments({ ...documents, "README.md": documents["README.md"] + rule }), /not README/);
  assert.throws(() => communityDocuments({ ...documents, "CONTRIBUTING.md": rule + "\n" + documents["CONTRIBUTING.md"] }), /later Commit/);
  assert.throws(() => communityDocuments({ ...documents, "CONTRIBUTING.md": documents["CONTRIBUTING.md"].replace("advertising", "promotion") }), /explanation/);
});
