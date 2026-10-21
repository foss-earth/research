// Whether the tour draws the same pixels with the engine's held depth clears on and off, at a
// phone's viewport: the map, part way into a 360 image, inside it and part way out. The page's
// clock is stopped at each moment, so every frame drawn there is the same but for the setting.
// With `marker`, the device's location is shown first, on the campus, as the Location tab's GPS shows it.
// With `setting=<id>`, the setting is what is turned off and on, rather than the held clears.
// With `query=<a=b&c=d>`, the page's address carries those too (set.renderer.backend=webgl2, say).
// node scripts/benchmarks/startup-audit/pixels.mjs <tour dist> <out dir> [marker] [setting=<id>] [query=<…>]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { serveStatic } from './serve.mjs';
import { openHeadlessChrome } from '../../lib/headlessChrome.mjs';

const [rootArg, outArg, ...modes] = process.argv.slice(2);
const marker = modes.includes('marker');
const setting = modes.find(mode => mode.startsWith('setting='))?.slice('setting='.length) ?? null;
const query = modes.find(mode => mode.startsWith('query='))?.slice('query='.length) ?? null;
const root = path.resolve(rootArg);
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
const PHONE = { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true };
const port = 4187;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = await serveStatic({ root, base: '/tour/', port, proxy: { prefix: '/tour/twin-cities/media/', target: 'https://umn-vr.github.io' } });
const chrome = await openHeadlessChrome(path.join(out, 'chrome-profile'), undefined,
  ['--enable-unsafe-webgpu', '--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), '--ignore-gpu-blocklist',
    `--window-size=${PHONE.width},${PHONE.height}`, ...(process.env.CHROME_EXTRA_ARGS?.split(' ').filter(Boolean) ?? [])]);
const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
const send = (method, params = {}) => chrome.send(method, params, sessionId);
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
// A clock that stops on request, and a count of main passes per frame.
const CLOCK = `(() => {
  const real = performance.now.bind(performance);
  self.__stopped = null;
  performance.now = () => self.__stopped ?? real();
  self.__realNow = real;
  self.__passes = 0;
  if (!self.GPUCommandEncoder) return;
  const begin = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
    if (String(descriptor.label ?? '').includes('MainRenderPass')) self.__passes += 1;
    return begin.call(this, descriptor);
  };
})()`;

/** RGBA rows of an 8-bit RGBA or RGB PNG. */
function decodePng(buffer) {
  let at = 8, width = 0, height = 0, channels = 4;
  const data = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at), type = buffer.toString('ascii', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = body[9] === 6 ? 4 : 3; if (body[8] !== 8) throw new Error('not 8-bit'); }
    if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels, pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0, b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      pixels[y * stride + x] = (line[x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function differing(a, b) {
  const one = decodePng(a), two = decodePng(b);
  if (one.width !== two.width || one.height !== two.height) return { size: true };
  let count = 0, max = 0;
  for (let i = 0; i < one.pixels.length; i += one.channels) {
    let worst = 0;
    for (let c = 0; c < Math.min(3, one.channels); c += 1) worst = Math.max(worst, Math.abs(one.pixels[i + c] - two.pixels[i + c]));
    if (worst) { count += 1; max = Math.max(max, worst); }
  }
  return { count, max, of: one.width * one.height };
}

const frames = n => evaluate(`new Promise(resolve => { let left = ${n}; const step = () => (--left > 0 ? requestAnimationFrame(step) : resolve(true)); requestAnimationFrame(step); })`);
async function shot(defer) {
  const toggle = setting ? `T.settings.set(${JSON.stringify(setting)}, ${defer});` : `T.runtime.engine.deferDepthClears = ${defer};`;
  await evaluate(`(() => { const T = window.__fossEarthPanoramaTest; ${toggle} self.__passes = 0; T.runtime.requestRender(); })()`);
  await frames(4);
  const passes = await evaluate('self.__passes');
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  return { defer, passes, png: Buffer.from(data, 'base64') };
}

/** Stops the clock and compares the frames drawn with the setting off and on, until two of each agree. */
async function compare(name) {
  await evaluate('self.__stopped = self.__realNow()');
  let result = null;
  for (let attempt = 0; attempt < 6 && !result; attempt += 1) {
    const shots = [];
    for (const defer of [false, true, false, true]) shots.push(await shot(defer));
    const steady = shots[0].png.equals(shots[2].png) && shots[1].png.equals(shots[3].png);
    if (!steady) { await evaluate('self.__stopped = null'); await sleep(1500); await evaluate('self.__stopped = self.__realNow()'); continue; }
    const same = shots[0].png.equals(shots[1].png);
    result = { name, attempt, same, passes: { off: shots[0].passes, on: shots[1].passes }, ...(same ? {} : differing(shots[0].png, shots[1].png)) };
    await writeFile(path.join(out, `${name}-off.png`), shots[0].png);
    await writeFile(path.join(out, `${name}-on.png`), shots[1].png);
  }
  await evaluate('self.__stopped = null');
  return result ?? { name, steady: false };
}

const results = [];
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', PHONE);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
  const url = `http://localhost:${port}/tour/minneapolis/?panoramaTest=1${query ? `&${query}` : ''}`;
  for (const visit of marker ? ['cold'] : ['cold', 'warm']) {
    await send('Page.navigate', { url });
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 240000) {
      await sleep(500);
      ready = await evaluate(`(() => { const T = window.__fossEarthPanoramaTest; const s = T?.scenes.handle()?.status;
        return !!s && performance.getEntriesByName("boot:settled", "mark").length > 0 && s.overview === "applied" && s.entries.length > 0
          && s.entries.every(e => e.preview === "ready" || e.preview === "failed" || !e.supported); })()`).catch(() => false);
      if (ready) break;
    }
    // A page still loading at the limit is compared anyway, but its moments are rarely steady.
    console.log(visit, ready ? 'ready after' : 'NOT READY after', Math.round((Date.now() - started) / 1000), 's');
  }
  const facts = await evaluate(`({ isolated: self.crossOriginIsolated === true, engine: window.__fossEarthPanoramaTest.runtime.engine.name,
    defers: window.__fossEarthPanoramaTest.runtime.engine.deferDepthClears,
    setting: ${JSON.stringify(setting)}, has: ${setting ? `window.__fossEarthPanoramaTest.settings.has(${JSON.stringify(setting)})` : 'null'} })`);
  console.log(JSON.stringify(facts));
  const id = await evaluate(`window.__fossEarthPanoramaTest.scenes.handle().status.entries.find(e => e.supported && e.preview === 'ready')?.id`);
  if (marker) {
    // Northrop Mall, Minneapolis: the GPS fix the Location tab shows and centres on.
    await chrome.send('Browser.grantPermissions', { permissions: ['geolocation'], origin: `http://localhost:${port}` });
    await send('Emulation.setGeolocationOverride', { latitude: 44.9765, longitude: -93.2353, accuracy: 20 });
    await evaluate(`document.querySelector('[data-side="right"] [aria-label="Open new tab"], [aria-label="Open right panel"], [aria-label="Open new tab"]').click(); true`);
    await sleep(1000);
    const opened = await evaluate(`(() => { const items = [...document.querySelectorAll('[role="menuitem"], .foss-earth-tab-button')];
      const item = items.find(i => i.textContent.trim() === 'Location'); if (item) item.click(); return item ? true : items.map(i => i.textContent.trim()); })()`);
    if (opened !== true) throw new Error(`No Location tab: ${JSON.stringify(opened)}`);
    await sleep(1500);
    await evaluate(`document.querySelector('[aria-label="Use device location"]').click(); true`);
    await sleep(8000);
    // The view centres on the fix, under the tab: a touch drag down the map brings the marker below it.
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: PHONE.width / 2, y: 560, id: 1 }] });
    for (let step = 1; step <= 20; step += 1) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: PHONE.width / 2, y: 560 + 16 * step, id: 1 }] });
      await sleep(16);
    }
    await sleep(300);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(4000);
    const pressed = await evaluate(`document.querySelector('.foss-earth-location-gps')?.getAttribute('aria-pressed')`);
    console.log(JSON.stringify({ gps: pressed }));
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(out, 'marker-view.png'), Buffer.from(data, 'base64'));
  }
  await sleep(3000);
  results.push(await compare('map'));
  // Part way in: each moment stopped a little later, from the click.
  for (const ms of [90, 250, 600]) {
    await evaluate(`(() => { const T = window.__fossEarthPanoramaTest; void T.scenes.handle().enter(${JSON.stringify(id)}); })()`);
    await sleep(ms);
    results.push(await compare(`in-${ms}ms`));
    await sleep(3000);
    if (ms === 600) results.push(await compare('inside'));
    await evaluate('window.__fossEarthPanoramaTest.scenes.handle().exit()');
    await sleep(3000);
  }
  for (const ms of [90, 250, 600]) {
    await evaluate(`window.__fossEarthPanoramaTest.scenes.handle().enter(${JSON.stringify(id)}).then(() => true)`);
    await sleep(3000);
    await evaluate(`(() => { void window.__fossEarthPanoramaTest.scenes.handle().exit(); })()`);
    await sleep(ms);
    results.push(await compare(`out-${ms}ms`));
    await sleep(3000);
  }
  results.push(await compare('map-after'));
  for (const r of results) console.log(JSON.stringify(r));
  await writeFile(path.join(out, 'pixels.json'), JSON.stringify({ facts, results }, null, 1));
} finally {
  await chrome.close().catch(() => {});
  await server.close();
}
