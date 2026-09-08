import { build } from "vite";
import { pathToFileURL } from "node:url";

const root = `${process.cwd()}/benchmarks/terrain/`;
await build({ configFile: false, logLevel: "warn", publicDir: false,
  plugins: [{ name: "benchmark-private-planner", transform(code, id) {
    if (id.endsWith("/src/engine/babylon/createRasterTilesRuntime.ts")) {
      // Expose pure planner functions only in this isolated benchmark bundle.
      return `${code}\nexport { getDesiredTiles as benchmarkDesiredTiles, chooseTilePatchSegments as benchmarkSegments };\n`;
    }
  } }],
  build: { ssr: `${root}current-path.mjs`, outDir: `${root}.cache/compiled`, emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "current-path.mjs" } } } });
await import(pathToFileURL(`${root}.cache/compiled/current-path.mjs`).href);
