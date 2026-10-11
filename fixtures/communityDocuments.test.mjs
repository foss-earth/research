import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { communityDocuments } from "../scripts/lib/communityDocuments.mjs";

const documents = Object.fromEntries(["README.md", "LICENSE"].map(file => [file, readFileSync(new URL("../" + file, import.meta.url), "utf8")]));
test("the actual owner documents keep the AGPL license and its README link", () => {
  assert.equal(communityDocuments(documents), true);
});
test("a placeholder, unlinked or replaced license cannot satisfy community coverage", () => {
  assert.throws(() => communityDocuments({ ...documents, LICENSE: "See another project" }), /Missing real/);
  assert.throws(() => communityDocuments({ ...documents, "README.md": documents["README.md"].replace("(LICENSE)", "(https://example.com/other-license)") }), /Missing own README/);
  assert.throws(() => communityDocuments({ ...documents, LICENSE: documents.LICENSE.replace("GNU AFFERO GENERAL PUBLIC LICENSE", "MIT License") }), /AGPL/);
});
