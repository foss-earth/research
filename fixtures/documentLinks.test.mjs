import assert from "node:assert/strict";
import test from "node:test";
import { documentTarget } from "../scripts/lib/documentLinks.mjs";
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
