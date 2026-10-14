/**
 * Local preview for the RT4KSR fp32 harness. Same allow-list as lib/serve.mjs,
 * with the cross-origin isolation headers the page requires. Measurement runs
 * still use CDP and do not listen on a port.
 *
 *   node scripts/benchmarks/ai-framegen-upscale/preview-server.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN, ISOLATION_HEADERS, harnessRoutes, resolveRoute } from "./lib/serve.mjs";

const benchmarkRoot = fileURLToPath(new URL(".", import.meta.url));
const work = path.resolve(benchmarkRoot, "../../../build/benchmarks/ai-framegen-upscale/work");
const pins = JSON.parse(await readFile(new URL("./browser-dependencies.json", import.meta.url), "utf8"));
const ortDist = path.join(work, "ort-web", `${pins.package.name}-${pins.package.version}`, "package", "dist");
const port = Number(process.env.AI_PREVIEW_PORT || 8756);
const routes = harnessRoutes({
  models: path.join(work, "models"),
  references: path.join(work, "references"),
  ortDist,
});
const headers = Object.fromEntries(ISOLATION_HEADERS.map(header => [header.name, header.value]));

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/") {
    response.writeHead(302, { ...headers, Location: "/preview.html" });
    response.end();
    return;
  }
  const resolved = resolveRoute(routes, `${ORIGIN}${pathname}`);
  if (resolved.status !== 200) {
    response.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
    response.end(resolved.reason || "not found");
    return;
  }
  const body = await readFile(resolved.file);
  response.writeHead(200, { ...headers, "Content-Type": resolved.contentType, "Content-Length": body.length });
  response.end(body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`RT4KSR preview: http://127.0.0.1:${port}/preview.html`);
});
