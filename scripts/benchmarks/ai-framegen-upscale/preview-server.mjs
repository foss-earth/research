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
import { encodeRgbPng } from "./lib/rgbPng.mjs";

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
const share = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Private-Network": "true",
};
/** The latest opaque PNG of a named frame, for the image viewer to fetch. */
const frames = new Map();
/** Opaque PNGs of the stored reference and its half-resolution input. No GPU run. */
const sources = new Map();
/** Status a runner publishes and the Experiment tab polls. */
const jobs = new Map();
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const jobPath = /^\/demo\/jobs\/([A-Za-z0-9-]+)$/;
const sourcePath = /^\/demo\/source\/(Original|Half-resolution)$/;
const references = path.join(work, "references");
const profiles = new Set(["720p", "1080p", "small"]);
const cases = new Set(["natural", "synthetic"]);

function frameName(pathname) {
  if (!pathname.startsWith("/demo/")) return null;
  let leaf = pathname.slice("/demo/".length);
  if (!leaf || leaf.includes("/")) return null;
  try { leaf = decodeURIComponent(leaf); } catch { return null; }
  if (!/^[\w][\w .'-]*$/.test(leaf) || leaf.length > 80 || leaf === "jobs") return null;
  return leaf;
}

async function sourcePng(name, profile, caseName) {
  if (!profiles.has(profile) || !cases.has(caseName)) throw new Error("profile or case is not one this preview serves");
  const key = `${name}\0${profile}\0${caseName}`;
  const cached = sources.get(key);
  if (cached) return cached;
  const root = path.resolve(references);
  const dir = path.resolve(root, "rt4ksr-x2", profile, caseName);
  if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) throw new Error("case is outside the references");
  const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
  const input = meta.inputs?.[0];
  const output = meta.output;
  const chosen = name === "Original"
    ? { file: output?.expected8, width: output?.valid?.width, height: output?.valid?.height }
    : { file: input?.file, width: input?.width, height: input?.height };
  if (typeof chosen.file !== "string" || !/^[\w.-]+$/.test(chosen.file)) throw new Error("reference file is not named");
  const file = path.resolve(dir, chosen.file);
  if (!file.startsWith(`${dir}${path.sep}`)) throw new Error("reference file is outside the case");
  const rgba = await readFile(file);
  if (!Number.isInteger(chosen.width) || !Number.isInteger(chosen.height) || rgba.length !== chosen.width * chosen.height * 4) {
    throw new Error("reference size does not match its pixels");
  }
  const png = encodeRgbPng(rgba, chosen.width, chosen.height);
  sources.set(key, png);
  return png;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        reject(new Error("frame is larger than 32 MiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const pathname = url.pathname;
  if (request.method === "OPTIONS") {
    response.writeHead(204, { ...headers, ...share, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" });
    response.end();
    return;
  }
  const job = jobPath.exec(pathname);
  if (job && request.method === "POST") {
    try {
      const body = await readBody(request);
      const record = JSON.parse(body.toString("utf8"));
      if ((record.state !== "running" && record.state !== "done" && record.state !== "error") || typeof record.message !== "string" || record.message.length > 8000) {
        throw new Error("a run record needs a state and a message");
      }
      jobs.set(job[1], { state: record.state, message: record.message });
      response.writeHead(204, headers);
      response.end();
    } catch (error) {
      response.writeHead(400, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (job && request.method === "GET") {
    const record = jobs.get(job[1]);
    if (!record) {
      response.writeHead(404, { ...headers, ...share, "Content-Type": "text/plain; charset=utf-8" });
      response.end("no such run");
      return;
    }
    const body = Buffer.from(JSON.stringify(record));
    response.writeHead(200, { ...headers, ...share, "Content-Type": "application/json", "Content-Length": body.length });
    response.end(body);
    return;
  }
  const source = sourcePath.exec(pathname);
  if (source && request.method === "GET") {
    try {
      const png = await sourcePng(source[1], url.searchParams.get("profile"), url.searchParams.get("case"));
      response.writeHead(200, { ...headers, ...share, "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "no-store" });
      response.end(png);
    } catch (error) {
      response.writeHead(404, { ...headers, ...share, "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  const name = frameName(pathname);
  if (name && request.method === "POST") {
    try {
      const width = Number(url.searchParams.get("width"));
      const height = Number(url.searchParams.get("height"));
      const rgba = await readBody(request);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height > 8192 || width > 8192 || height < 1 || rgba.length !== width * height * 4) {
        response.writeHead(400, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
        response.end("width, height and tightly packed RGBA do not agree");
        return;
      }
      frames.set(name, encodeRgbPng(rgba, width, height));
      response.writeHead(204, headers);
      response.end();
    } catch (error) {
      response.writeHead(400, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (name && request.method === "GET") {
    const png = frames.get(name);
    if (!png) {
      response.writeHead(404, { ...headers, ...share, "Content-Type": "text/plain; charset=utf-8" });
      response.end("that frame has not been published");
      return;
    }
    response.writeHead(200, { ...headers, ...share, "Content-Type": "image/png", "Content-Length": png.length });
    response.end(png);
    return;
  }
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
