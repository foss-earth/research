import { build } from "vite";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { outputPath } from "../../lib/researchPaths.mjs";
const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL("./", import.meta.url));
const paths = ["bvh-prototype.mjs", "gpu-comparison.mjs", "run-gpu-headless.mjs"].map(file => path.join(root, file));
paths.push(require.resolve("@foss-earth/engine/babylon"));
const source = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), workingTreeMayBeDirty: true,
  sha256: Object.fromEntries(paths.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])),
};
const result = await build({ configFile: false, logLevel: "warn", publicDir: false,
  define: { __BENCHMARK_SOURCE__: JSON.stringify(source), __BUILD_MACHINE__: JSON.stringify({ cpu: os.cpus()[0].model, platform: os.platform(), arch: os.arch(), release: os.release() }) },
  build: { write: false, minify: false, lib: { entry: `${root}/gpu-comparison.mjs`, formats: ["iife"], name: "CollisionBenchmark" } },
});
const output = Array.isArray(result) ? result[0].output : result.output;
const code = output.find(item => item.type === "chunk").code;
const file = process.argv[2] ? outputPath(path.relative(new URL("../../../build/", import.meta.url).pathname, path.resolve(process.argv[2]))) : outputPath("benchmarks", "collision", "bundle", "gpu-comparison.html");
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>CPU / WebGPU collision comparison</title>
<style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:16px system-ui}button,a{font:inherit;margin-right:20px}pre{white-space:pre-wrap}td,th{text-align:right;padding:8px;border-bottom:1px solid #bbb}td:first-child,th:first-child{text-align:left}</style>
<h1>CPU / WebGPU collision comparison</h1><p>Offline synthetic ray query benchmark. Prefer the terminal headless runner. Includes GPU readback; does not measure whole-game FPS or power.</p>
<button id="run">Run comparison</button><a id="download" hidden>Download JSON</a><p id="status">Ready</p><div id="summary"></div><pre id="details"></pre>
<script>${code.replaceAll("</script", "<\\/script")}</script>`);
console.log(`Built offline WebGPU benchmark: ${file}`);
