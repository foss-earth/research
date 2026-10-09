import { build } from "vite";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Immutable pre-optimization implementation, compiled alongside current source.
const baselineCommit = "cd84c60998cb4be4c71cce3f5a60f56292ac20dd";
const baseline = execFileSync("git", ["show", `${baselineCommit}:src/terrain/surfaceQuery.ts`], { encoding: "utf8" });
const root = `${process.cwd()}/benchmarks/collision/`;
await build({ configFile: false, logLevel: "warn", publicDir: false,
  define: { __BASELINE_COMMIT__: JSON.stringify(baselineCommit), __BASELINE_SOURCE__: JSON.stringify(baseline) },
  plugins: [{ name: "collision-checkpoint", enforce: "pre", transform(_code, id) {
    if (id.endsWith("/src/terrain/surfaceQuery.ts?baseline")) return baseline;
  } }],
  build: { ssr: `${root}surface-query.mjs`, outDir: `${root}.cache/compiled`, emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "surface-query.mjs" } } } });
await import(pathToFileURL(`${root}.cache/compiled/surface-query.mjs`).href);
