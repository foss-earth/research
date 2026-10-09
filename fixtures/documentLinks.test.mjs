import assert from "node:assert/strict";
import test from "node:test";
import { documentTarget, markdownTargets, publicOwnerDocumentTarget } from "../scripts/lib/documentLinks.mjs";
test("local links preserve their current owner including fragment-only links", () => {
  assert.deepEqual(documentTarget("docs/layout.md", "../navigation.md#owner", "foss-earth/docs"), { kind: "local", owner: "foss-earth/docs", path: "navigation.md" });
  assert.deepEqual(documentTarget("docs/layout.md", "#controls", "foss-earth/docs"), { kind: "local", owner: "foss-earth/docs", path: "docs/layout.md" });
});
test("only the explicitly routed sibling document owners are allowed", () => {
  assert.deepEqual(documentTarget("docs/plan.md", "../../research/benchmarks/terrain/README.md", "foss-earth/docs"), { kind: "local", owner: "foss-earth/research", path: "benchmarks/terrain/README.md" });
  assert.throws(() => documentTarget("docs/plan.md", "../../flight/src/app.ts", "foss-earth/docs"), /escapes/);
  assert.throws(() => documentTarget("README.md", "/private/evidence.txt", "foss-earth/research"), /absolute/);
});
test("compatibility and external source citations never become filesystem reads", () => {
  const url = "https://github.com/foss-earth/foss-earth.github.io/blob/90e23b3ee96f53ec5900afc5991a21fffa58649d/docs/render-on-demand.md";
  assert.deepEqual(documentTarget("README.md", url, "foss-earth/docs"), { kind: "external", target: url });
});

test("portable public owner navigation names the independent repository", () => {
  assert.deepEqual(publicOwnerDocumentTarget("https://github.com/foss-earth/research/blob/main/docs/validation/timing.md#memory"), { owner: "foss-earth/research", path: "docs/validation/timing.md" });
  assert.throws(() => publicOwnerDocumentTarget("https://example.com/foss-earth/research/blob/main/report.md"), /Undeclared/);
  assert.throws(() => publicOwnerDocumentTarget("https://github.com/foss-earth/engine/blob/main/private.md"), /Undeclared/);
  assert.throws(() => publicOwnerDocumentTarget("https://github.com/foss-earth/docs/blob/main/%2e%2e%2foutside.md"), /escaped/);
  assert.throws(() => publicOwnerDocumentTarget("https://github.com/foss-earth/research/blob/main/report.md?raw=1"), /Undeclared/);
});

test("current Markdown navigation includes spaced and reference targets but excludes command examples", () => {
  const text = '[Local](<folder/a b.md#section>)\n[Community][conduct]\n[conduct]: CODE_OF_CONDUCT.md\n```md\n[Example](../private/missing.md)\n```\n[Owner](https://github.com/foss-earth/research)';
  assert.deepEqual(markdownTargets(text), ["folder/a b.md#section", "https://github.com/foss-earth/research", "CODE_OF_CONDUCT.md"]);
});

test("encoded traversal and platform-specific paths cannot read undeclared owners", () => {
  assert.throws(() => documentTarget("README.md", "%2e%2e/private/report.md", "foss-earth/docs"), /escapes/);
  assert.throws(() => documentTarget("README.md", "..\\private\\report.md", "foss-earth/docs"), /nonportable/);
});
