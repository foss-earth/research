// A static server for the startup measurements that answers like GitHub Pages: gzip for text,
// Cache-Control: max-age=600, ETag revalidation. Files are compressed once, when first asked for,
// and kept in memory so compression does not land in the timings. Started and stopped by run.mjs.
// `proxy` answers one path prefix from another site, as the tour's dev server does for the
// photographs the site publishes (vite.config.ts, tourMedia); answers are kept in memory too.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|wasm)|image\/svg)/;

/** Serves `root` under `base` (e.g. "/tour/") on `port`; resolves to { url, close, log }. */
export async function serveStatic({ root, base, port, proxy = null }) {
  const cache = new Map();
  const log = [];
  const remote = async pathname => {
    const key = `proxy:${pathname}`;
    if (cache.has(key)) return cache.get(key);
    const answer = await fetch(new URL(pathname, proxy.target)).catch(() => null);
    if (!answer?.ok) { cache.set(key, null); return null; }
    // A connection dropped while the body is read is answered as missing, and asked again next time.
    const bytes = await answer.arrayBuffer().catch(() => null);
    if (!bytes) return null;
    const body = Buffer.from(bytes);
    const type = answer.headers.get('content-type') ?? 'application/octet-stream';
    const entry = { type, body, gzip: COMPRESSIBLE.test(type) ? gzipSync(body, { level: 6 }) : null,
      etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`, modified: new Date(0).toUTCString() };
    cache.set(key, entry);
    return entry;
  };
  const load = async file => {
    if (cache.has(file)) return cache.get(file);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return null;
    const body = await readFile(file);
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const entry = { type, body, gzip: COMPRESSIBLE.test(type) ? gzipSync(body, { level: 6 }) : null,
      etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`, modified: info.mtime.toUTCString() };
    cache.set(file, entry);
    return entry;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === base.slice(0, -1)) { response.writeHead(301, { location: base }).end(); return; }
    if (!pathname.startsWith(base)) { response.writeHead(404).end(); log.push([404, pathname]); return; }
    let relative = pathname.slice(base.length);
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const file = path.join(root, relative);
    if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
    let entry = proxy && pathname.startsWith(proxy.prefix) ? await remote(pathname) : await load(file);
    if (!entry && !path.extname(file)) {
      if (await load(path.join(file, 'index.html'))) { response.writeHead(301, { location: `${pathname}/${url.search}` }).end(); return; }
    }
    if (!entry) { response.writeHead(404).end(); log.push([404, pathname]); return; }
    const headers = { 'content-type': entry.type, 'cache-control': 'max-age=600', etag: entry.etag, 'last-modified': entry.modified, vary: 'Accept-Encoding' };
    if (request.headers['if-none-match'] === entry.etag) { response.writeHead(304, headers).end(); return; }
    const gzip = entry.gzip && /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
    const body = gzip ? entry.gzip : entry.body;
    response.writeHead(200, { ...headers, ...(gzip ? { 'content-encoding': 'gzip' } : {}), 'content-length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, 'localhost', resolve); });
  return { url: `http://localhost:${port}${base}`, log, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
