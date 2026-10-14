/**
 * Serves the ai-framegen-upscale browser harness to headless Chrome by CDP
 * request interception (Fetch.requestPaused -> Fetch.fulfillRequest): no
 * listener, no port. Every response is cross-origin isolated (COOP
 * same-origin, COEP require-corp, CORP cross-origin) so the page gets
 * SharedArrayBuffer, `navigator.gpu` and an unquantized clock, and nothing is
 * cached (`Cache-Control: no-store`).
 *
 *   import { harnessRoutes, resolveRoute, serveSession } from "./lib/serve.mjs";
 *   const routes = harnessRoutes({ work, models, references, ortDist, media });
 *   const server = await serveSession(chrome, sessionId, routes);   // after Target.attachToTarget
 *   ... server.requests  // [{ url, status, bytes, ms, resourceType, reason? }]
 *
 * Routes are an explicit allow-list from URL prefixes to folders (DESIGN.md
 * section 8): `/` -> harness/ (page modules only, no subfolders), `/ort/` ->
 * the three onnxruntime-web files named in browser-dependencies.json,
 * `/models/` -> work/models, `/references/` -> work/references, `/media/` ->
 * named panorama JPEGs. Dot segments (also percent-encoded), empty segments,
 * backslashes, encoded slashes, other origins, unknown prefixes, unknown
 * extensions and files that do not exist are answered 404 with a reason; every
 * request is logged. `resolveRoute` is pure (no I/O besides an existence check
 * the caller can skip) so the fixture test can exercise it without a browser.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const ORIGIN = "https://foss-earth.test";
export const PAGE_URL = `${ORIGIN}/index.html`;
export const ISOLATION_HEADERS = [
  { name: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { name: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { name: "Cross-Origin-Resource-Policy", value: "cross-origin" },
  { name: "Cache-Control", value: "no-store" },
];
export const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm",
  ".json": "application/json", ".onnx": "application/octet-stream", ".f32": "application/octet-stream",
  ".rgba8": "application/octet-stream", ".jpg": "image/jpeg", ".png": "image/png",
};

const benchmarkRoot = fileURLToPath(new URL("../", import.meta.url));
export const harnessDirectory = path.join(benchmarkRoot, "harness");
const pins = () => JSON.parse(readFileSync(path.join(benchmarkRoot, "browser-dependencies.json"), "utf8"));

/**
 * The allow-list for one run. `ortDist` is the extracted package's dist/ folder
 * (only the pinned files are reachable), `media` maps file names under /media/
 * to absolute paths (e.g. { "northrop-mall.jpg": ".../6144.jpg" }).
 */
export function harnessRoutes({ models, references, ortDist, media = {}, harness = harnessDirectory }) {
  const ortFiles = pins().files.map(file => path.posix.basename(file.served));
  return [
    { prefix: "/ort/", directory: ortDist, files: ortFiles, extensions: [".mjs", ".wasm"] },
    { prefix: "/models/", directory: models, nested: true, extensions: [".onnx", ".json"] },
    { prefix: "/references/", directory: references, nested: true, extensions: [".json", ".rgba8", ".f32"] },
    { prefix: "/media/", mapped: media, extensions: [".jpg", ".png"] },
    { prefix: "/", directory: harness, extensions: [".html", ".mjs"] },
  ];
}

const notFound = reason => ({ status: 404, reason });

/**
 * Maps a request URL onto a file through `routes`, or says why not:
 * `{ status: 200, file, contentType, route }` or `{ status: 404, reason }`.
 * `exists` (default: the file system) is injectable for tests.
 */
export function resolveRoute(routes, url, exists = file => existsSync(file) && statSync(file).isFile()) {
  if (typeof url !== "string") return notFound("not a string");
  // Look at the raw text before URL parsing: the WHATWG parser silently removes "..", "." and "%2e%2e" segments.
  const rawPath = url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : null;
  if (rawPath === null || !(rawPath === "" || rawPath.startsWith("/"))) return notFound("foreign origin");
  const pathOnly = rawPath.split(/[?#]/)[0];
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(pathOnly)) return notFound("dot segment");
  if (pathOnly.includes("\\") || /%5c|%2f|%00/i.test(pathOnly)) return notFound("encoded separator or backslash");
  let parsed;
  try { parsed = new URL(url); } catch { return notFound("unparseable URL"); }
  if (parsed.origin !== ORIGIN) return notFound("foreign origin");
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { return notFound("bad percent-encoding"); }
  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("//") || pathname.includes("\0")) return notFound("empty segment");
  const route = routes.find(entry => pathname.startsWith(entry.prefix));
  if (!route) return notFound("unknown prefix");
  const relative = pathname.slice(route.prefix.length);
  const segments = relative.split("/");
  if (!relative || segments.some(segment => segment === "" || segment === "." || segment === "..")) return notFound("empty or dot segment");
  if (!route.nested && segments.length > 1) return notFound("subfolders are not served under this prefix");
  const extension = path.posix.extname(relative).toLowerCase();
  if (!route.extensions.includes(extension) || !CONTENT_TYPES[extension]) return notFound(`extension ${extension || "(none)"} not served under ${route.prefix}`);
  let file;
  if (route.mapped) {
    if (!Object.hasOwn(route.mapped, relative)) return notFound("unknown media name");
    file = route.mapped[relative];
  } else {
    if (route.files && !route.files.includes(relative)) return notFound(`not one of the pinned files under ${route.prefix}`);
    if (!route.directory) return notFound(`no folder configured for ${route.prefix}`);
    const root = path.resolve(route.directory);
    file = path.resolve(root, ...segments);
    if (!file.startsWith(root + path.sep)) return notFound("escapes the route folder");
  }
  if (!exists(file)) return notFound("no such file");
  return { status: 200, file, contentType: CONTENT_TYPES[extension], route: route.prefix };
}

/**
 * Intercepts every request of one attached page session and answers it from
 * `routes`. Requests to any other origin are refused too (404), so nothing
 * reaches the network. Returns `{ requests, detach() }`.
 */
export async function serveSession(chrome, sessionId, routes, { onRequest = null } = {}) {
  const requests = [];
  const handle = async params => {
    const { requestId, request, resourceType } = params;
    const start = performance.now();
    const resolved = resolveRoute(routes, request.url);
    const entry = { url: request.url, method: request.method, resourceType, status: resolved.status, bytes: 0 };
    let response;
    if (resolved.status === 200 && request.method === "GET") {
      try {
        const body = await readFile(resolved.file);
        entry.bytes = body.length;
        response = { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: resolved.contentType }, { name: "Content-Length", value: String(body.length) }, ...ISOLATION_HEADERS], body: body.toString("base64") };
      } catch (error) {
        Object.assign(entry, { status: 404, reason: `read failed: ${error.message}` });
      }
    } else if (resolved.status === 200) {
      Object.assign(entry, { status: 405, reason: `method ${request.method}` });
    } else entry.reason = resolved.reason;
    response ??= { requestId, responseCode: entry.status, responseHeaders: ISOLATION_HEADERS, body: "" };
    try {
      await chrome.send("Fetch.fulfillRequest", response, sessionId);
    } catch (error) {
      entry.fulfillError = error.message;
    }
    entry.ms = +(performance.now() - start).toFixed(2);
    requests.push(entry);
    onRequest?.(entry);
  };
  const detach = chrome.onEvent(message => {
    if (message.sessionId === sessionId && message.method === "Fetch.requestPaused") void handle(message.params);
  });
  await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
  return { requests, detach };
}
