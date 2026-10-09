/**
 * In-page half of benchmarks/scene-ab/run.mjs. Evaluated in a FOSS Earth app
 * opened with `?panoramaTest=1`; it reads only that test hook and the
 * runtime's frame profiler, and changes only registry parameters.
 */
(() => {
  const T = window.__fossEarthPanoramaTest;
  if (!T) throw new Error("No panorama test hook: open the app with ?panoramaTest=1.");
  const { runtime, settings } = T;
  const scene = runtime.scene;
  const engine = runtime.engine;
  const handle = () => T.scenes.handle();
  const status = () => handle()?.status ?? null;

  /** Resolves after `count` more rendered frames, asking for each. */
  function frames(count) {
    return new Promise(resolve => {
      let left = count;
      const observer = scene.onAfterRenderObservable.add(() => {
        if (--left > 0) { runtime.requestRender(); return; }
        scene.onAfterRenderObservable.remove(observer);
        resolve();
      });
      runtime.requestRender();
    });
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  /** Waits until nothing is loading and the renderer has gone to sleep for `quietMs`. */
  async function settle(timeoutMs = 120_000, quietMs = 1500) {
    const deadline = performance.now() + timeoutMs;
    let quietSince = null;
    while (performance.now() < deadline) {
      const s = status();
      const loading = Boolean(s?.immersionDetail?.loading) || s?.phase === "entering" || s?.phase === "exiting" || s?.phase === "preparing"
        || (s?.entries ?? []).some(entry => entry.preview === "loading");
      if (!loading && !runtime.isRendering()) {
        quietSince ??= performance.now();
        if (performance.now() - quietSince >= quietMs) return { settledMs: timeoutMs - (deadline - performance.now()) };
      } else quietSince = null;
      await sleep(100);
    }
    const s = status();
    return {
      settledMs: null, phase: s?.phase, loading: s?.immersionDetail?.loading ?? null, rendering: runtime.isRendering(),
      previewsLoading: (s?.entries ?? []).filter(entry => entry.preview === "loading").length, map: runtime.status?.mode ?? null,
    };
  }

  async function sceneReady(timeoutMs = 180_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const s = status();
      if (s && s.overview === "applied" && s.entries.length > 0 && s.entries.every(entry => entry.preview === "ready" || entry.preview === "failed" || !entry.supported)) return true;
      await sleep(250);
    }
    throw new Error(`The scene did not become ready: ${JSON.stringify(status() && { phase: status().phase, overview: status().overview, previews: status().entries.map(entry => entry.preview) })}`);
  }

  /** Sets parameter values together, then waits for any shader they switch to compile. */
  async function apply(values) {
    const result = settings.setMany(values);
    if (!result.ok) throw new Error(`Could not apply ${JSON.stringify(values)}: ${result.reason}`);
    // With the group on, every member is held on whatever its own value.
    const group = values["renderer.experiments.all"] === true;
    for (const [id, value] of Object.entries(values)) {
      const expected = group && id.startsWith("renderer.experiments.") ? true : value;
      if (settings.get(id) !== expected) throw new Error(`${id} is ${settings.get(id)}, not ${expected}`);
    }
    await frames(3);
    await scene.whenReadyAsync();
    await frames(5);
  }

  async function enter(id) {
    const s = status();
    if (s?.phase === "immersive" && s.active === id) return settle();
    const result = await handle().enter(id);
    if (result && result.ok === false) throw new Error(`Entering ${id}: ${JSON.stringify(result)}`);
    const settled = await settle();
    const after = status();
    if (after.phase !== "immersive" || after.active !== id) throw new Error(`Not immersive in ${id}: ${after.phase} ${after.active}`);
    return { ...settled, detail: after.immersionDetail };
  }

  async function overview() {
    if (status()?.phase === "immersive") {
      const result = await handle().exit();
      if (result && result.ok === false) throw new Error(`Exit: ${JSON.stringify(result)}`);
    }
    return settle();
  }

  /** Starts a measured stretch: a fresh profiler window and continuous frames, as while a finger drags. */
  let drawCallsAtBegin = 0;
  function begin() {
    runtime.frameProfile.profiler.reset();
    drawCallsAtBegin = engine._drawCalls?.current ?? 0;
    runtime.beginContinuous();
    return true;
  }

  /**
   * Ends it and returns each frame's interval and sections, milliseconds, and
   * counts that do not depend on load: the meshes Babylon was offered to
   * examine and the ones it drew in the last frame, draw calls per frame, and
   * the panorama renderer's retained draw records.
   */
  function end() {
    runtime.endContinuous();
    const trace = runtime.frameProfile.trace().frames;
    const counters = {
      meshesExamined: scene.getActiveMeshCandidates().length,
      activeMeshCount: scene.getActiveMeshes().length,
      // Babylon's counter only grows; per frame over the stretch.
      drawCalls: engine._drawCalls && trace.length ? Math.round((engine._drawCalls.current - drawCallsAtBegin) / trace.length) : null,
      panoramaRecords: T.renderer?.drawRecords().length ?? null,
    };
    const pick = (entry, name) => entry.sections[name] ?? 0;
    const frames = trace.map(entry => ({
      interval: entry.intervalMs,
      render: pick(entry, "render"),
      activeMeshes: pick(entry, "render/active meshes"),
      draw: pick(entry, "render/draw"),
      uniforms: pick(entry, "render/draw/panorama uniforms"),
      gpu: pick(entry, "gpu/globe"),
      measured: Object.entries(entry.sections).filter(([name]) => !name.includes("/") && name !== "gpu" && name !== "background").reduce((sum, [, value]) => sum + value, 0),
    }));
    return { frames, counters };
  }

  /** The canvas as drawn, read back in the frame that drew it. */
  function readCanvas() {
    return new Promise(resolve => {
      const observer = scene.onAfterRenderObservable.add(() => {
        scene.onAfterRenderObservable.remove(observer);
        const gl = engine._gl;
        const width = engine.getRenderWidth(), height = engine.getRenderHeight();
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        resolve({ width, height, pixels });
      });
      runtime.requestRender();
    });
  }

  /** RGBA rows as read back, bottom-up, as a top-down PNG in base64. */
  async function png(width, height, rgba) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    const flipped = new Uint8ClampedArray(rgba.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) flipped.set(rgba.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    context.putImageData(new ImageData(flipped, width, height), 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }

  const captures = new Map();
  /**
   * Keeps the canvas under `key`; with `against`, compares it with that
   * capture instead of keeping it. `save` also returns the frame as a PNG.
   */
  async function capture(key, against = null, save = false) {
    await frames(4);
    const shot = await readCanvas();
    const image = save ? await png(shot.width, shot.height, shot.pixels) : null;
    if (!against) {
      captures.set(key, shot);
      return { key, width: shot.width, height: shot.height, image };
    }
    const base = captures.get(against);
    if (!base || base.width !== shot.width || base.height !== shot.height) throw new Error(`No comparable capture ${against}`);
    const a = base.pixels, b = shot.pixels;
    let differing = 0, maxDiff = 0, over2 = 0, over8 = 0, sum = 0;
    const heat = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > 0) { differing++; sum += d; }
      if (d > 2) over2++;
      if (d > 8) over8++;
      if (d > maxDiff) maxDiff = d;
      const v = d === 0 ? 0 : Math.min(255, 64 + d * 16);
      heat[i] = v; heat[i + 1] = d > 8 ? 0 : v; heat[i + 2] = 0; heat[i + 3] = 255;
    }
    const pixels = a.length / 4;
    const heatmap = differing > 0 ? await png(shot.width, shot.height, heat) : null;
    return { key, against, pixels, differing, differingShare: differing / pixels, over2, over8, maxDiff, meanDiffWhereDifferent: differing ? sum / differing : 0, heatmap, image };
  }

  function info() {
    const gl = engine._gl;
    const debug = gl?.getExtension?.("WEBGL_debug_renderer_info");
    const caps = engine.getCaps();
    const s = status();
    return {
      rendererMode: runtime.renderer.mode,
      crossOriginIsolated: window.crossOriginIsolated === true,
      webGLVersion: engine.webGLVersion ?? null,
      glRenderer: gl ? (debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null,
      renderSize: [engine.getRenderWidth(), engine.getRenderHeight()],
      hardwareScaling: engine.getHardwareScalingLevel(),
      devicePixelRatio: window.devicePixelRatio,
      maxTextureSize: caps.maxTextureSize,
      gpuTimed: runtime.frameProfile.gpuTimed(),
      meshes: scene.meshes.length,
      materials: scene.materials.length,
      activeMeshes: scene.getActiveMeshes().length,
      phase: s?.phase ?? null,
      active: s?.active ?? null,
      immersionDetail: s?.immersionDetail ?? null,
      map: runtime.status,
    };
  }

  function stops() {
    const s = status();
    return { entries: s.entries.map(entry => entry.id), groups: s.groups.map(group => ({ id: group.id, members: group.members })) };
  }

  window.__sceneAb = { frames, settle, sceneReady, apply, enter, overview, begin, end, capture, info, stops, status };
  return true;
})();
