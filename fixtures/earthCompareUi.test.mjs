import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { earthPolicyReasons, earthRenderInfo, inspectEarthUi, prepareEarth } from "../scripts/benchmarks/earth-compare/earthUi.mjs";

const control = checked => ({ count: 1, states: [{ checked, disabled: false }] });
const good = () => ({ clean: control(true), satellite: control(true), buildings: control(true), clouds: control(false) });
const rectangle = (x = 0, y = 0, width = 30, height = 20) => ({ x, y, width, height });
const defaultStyle = { display: "block", visibility: "visible", opacity: "1", overflowX: "visible", overflowY: "visible", transform: "none", clipPath: "none",
  perspective: "none", maskImage: "none", webkitMaskImage: "none", filter: "none", backdropFilter: "none", zoom: "1", mixBlendMode: "normal" };

// A small public DOM fixture executes the actual browser expressions. Input
// state, label associations, clipping and public button actions are independent
// browser contracts, not canned CDP replies keyed to implementation strings.
function publicDom() {
  const elements = [], calls = [], document = { querySelectorAll: () => elements, getElementById: id => elements.find(node => node.getAttribute("id") === id) ?? null };
  function element(tag, options = {}) {
    const attrs = { ...(options.attrs ?? {}) };
    const node = { tagName: tag.toUpperCase(), parentElement: options.parent ?? null, type: options.type, checked: options.checked,
      labels: [], control: options.control, textContent: options.text ?? "", innerText: options.text ?? "", style: options.style ?? {}, bounds: options.rect ?? rectangle(),
      getAttribute: name => attrs[name] ?? null, setAttribute: (name, value) => { attrs[name] = String(value); },
      getRootNode: () => options.root ?? document, getBoundingClientRect() { return typeof this.bounds === "function" ? this.bounds() : this.bounds; },
      click() { calls.push({ kind: "click", tag: this.tagName, label: attrs["aria-label"] ?? this.innerText }); if (options.click) options.click(this); else if (this.control) this.control.click(); },
      scrollIntoView() { calls.push({ kind: "scroll", label: attrs["aria-label"] ?? this.innerText }); if (options.scroll) options.scroll(this); },
    };
    if (options.control) options.control.labels.push(node);
    if (!options.root) elements.push(node);
    return node;
  }
  const context = { document, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2,
    getComputedStyle: node => ({ ...defaultStyle, ...(typeof node.style === "function" ? node.style() : node.style) }) };
  const chrome = { send: async (method, parameters) => {
    if (method === "Runtime.evaluate") return { result: { value: vm.runInNewContext(parameters.expression, context) } };
    calls.push({ kind: "input", ...parameters });
    if (method === "Input.dispatchKeyEvent" && parameters.type === "keyDown") context.onKeyDown?.(parameters);
    return {};
  } };
  return { element, elements, document, chrome, context, calls };
}

function mapFixture({ disturbAfterClouds = false } = {}) {
  const dom = publicDom(), state = { panel: false, more: false, tooltip: true };
  const canvas = dom.element("canvas", { rect: rectangle(0, 0, 1280, 720) }); canvas.width = 2560; canvas.height = 1440;
  const mainStyle = () => ({ display: state.panel && !state.more ? "block" : "none" });
  const cloudStyle = () => ({ display: state.panel && state.more ? "block" : "none" });
  const toggles = {};
  let row = 0;
  for (const [name, checked] of [["Satellite", true], ["3D buildings", true], ["Clean", false], ["Animated clouds", true]]) {
    const style = name === "Animated clouds" ? cloudStyle : mainStyle;
    const bounds = rectangle(30, 80 + 40 * row++, 120, 30);
    const input = dom.element("input", { type: name === "Satellite" || name === "Clean" ? "radio" : "checkbox", checked, style, rect: bounds,
      attrs: { "aria-label": name }, click(node) { node.checked = !node.checked; if (name === "Animated clouds" && disturbAfterClouds) toggles.Satellite.checked = false; } });
    dom.element("label", { text: name, control: input, style, rect: bounds }); toggles[name] = input;
  }
  dom.element("button", { attrs: { "aria-label": "Basemap settings" }, rect: rectangle(10, 650, 120, 30), click() { state.panel = !state.panel; state.more = false; } });
  dom.element("button", { text: "More visuals", rect: rectangle(30, 300, 120, 30), style: () => ({ display: state.panel ? "block" : "none" }), click() { state.more = !state.more; } });
  dom.element("button", { text: "Dismiss", rect: rectangle(10, 10, 120, 30), style: () => ({ display: state.tooltip ? "block" : "none" }), click() { state.tooltip = false; } });
  dom.document.elementFromPoint = (x, y) => [...dom.elements].reverse().find(node => {
    const style = typeof node.style === "function" ? node.style() : node.style, r = node.getBoundingClientRect();
    return style.display !== "none" && x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
  }) ?? canvas;
  dom.context.onKeyDown = key => { if (key.key === "b" && key.modifiers === 2) { state.panel = !state.panel; state.more = false; } };
  return { ...dom, state, toggles };
}

test("a label alone or two independent checked controls cannot establish public policy", () => {
  assert.deepEqual(earthPolicyReasons(good()), []);
  for (const field of ["clean", "satellite", "buildings", "clouds"]) {
    const unknown = good(); unknown[field] = { count: 1, states: [{ checked: null }] }; assert.ok(earthPolicyReasons(unknown).length > 0);
    const missing = good(); delete missing[field]; assert.ok(earthPolicyReasons(missing).length > 0);
    const ambiguous = good(); ambiguous[field] = { count: 2, states: [control(true).states[0], control(true).states[0]] }; assert.ok(earthPolicyReasons(ambiguous).length > 0);
  }
});

test("native input and multiple visible labels deduplicate, while contradictory states reject", async () => {
  const dom = publicDom();
  const input = dom.element("input", { attrs: { "aria-label": "Clean" }, type: "radio", checked: true });
  dom.element("label", { text: "Clean", control: input }); dom.element("label", { text: "Clean", control: input });
  let evidence = await inspectEarthUi(dom.chrome, "test");
  assert.equal(evidence.clean.count, 1); assert.equal(evidence.clean.elementCount, 3); assert.equal(evidence.clean.states[0].checked, true);
  input.setAttribute("aria-checked", "false"); evidence = await inspectEarthUi(dom.chrome, "test");
  assert.equal(evidence.clean.states[0].stateConflict, true); assert.equal(evidence.clean.states[0].checked, null);
});

test("public preparation selects Clean, preserves 3D/Satellite, disables clouds, dismisses and closes", async () => {
  const dom = mapFixture();
  const result = await prepareEarth(dom.chrome, "test", { timeoutMs: 2000 });
  assert.equal(result.policyVerified, true, result.reasons.join("; "));
  assert.equal(dom.toggles.Clean.checked, true); assert.equal(dom.toggles.Satellite.checked, true); assert.equal(dom.toggles["3D buildings"].checked, true);
  assert.equal(dom.toggles["Animated clouds"].checked, false); assert.equal(dom.state.panel, false); assert.equal(dom.state.tooltip, false);
  assert.equal(dom.calls.filter(call => call.kind === "click" && call.label === "Clean").length, 1);
  assert.equal(result.requiresCameraAndMaskReview, true);
});

test("post-clouds verification detects another setting changing instead of reusing stale evidence", async () => {
  const dom = mapFixture({ disturbAfterClouds: true });
  const result = await prepareEarth(dom.chrome, "test", { timeoutMs: 2000 });
  assert.equal(result.policyVerified, false); assert.ok(result.reasons.some(reason => reason.includes("Satellite")));
  assert.equal(dom.state.panel, false);
});

test("preparation cannot click a known control through a visible obstruction", async () => {
  const dom = mapFixture(), hit = dom.document.elementFromPoint;
  dom.document.elementFromPoint = (x, y) => y >= 160 && y < 190 ? dom.elements[0] : hit(x, y);
  const result = await prepareEarth(dom.chrome, "test", { timeoutMs: 2000 });
  assert.equal(result.policyVerified, false); assert.equal(dom.toggles.Clean.checked, false);
  assert.ok(result.actions.some(action => action.action === "select-clean" && action.reason === "control-occluded-at-centre"));
  assert.equal(dom.state.panel, false);
});

test("canvas inspection traverses open shadows and distinguishes CSS clipping, backing and UI occlusion", async () => {
  const dom = publicDom();
  const parent = dom.element("div", { rect: rectangle(0, 84, 1280, 636), style: { overflowX: "hidden", overflowY: "hidden", transform: "matrix(1,0,0,1,0,0)", maskImage: "linear-gradient(black,black)" } });
  const host = dom.element("map-view", { parent, rect: rectangle(0, 0, 1280, 720) });
  const shadow = { host, querySelectorAll: () => [canvas] }; host.shadowRoot = shadow;
  const canvas = dom.element("canvas", { root: shadow, rect: rectangle(0, 0, 1280, 720) }); canvas.width = 2560; canvas.height = 1440;
  const overlay = dom.element("button", { attrs: { role: "button", "aria-label": "Dismiss" }, rect: rectangle(0, 84, 1280, 100) });
  dom.document.elementFromPoint = (x, y) => y < 184 ? overlay : host;
  shadow.elementFromPoint = () => canvas;
  const info = await earthRenderInfo(dom.chrome, "test");
  assert.equal(info.canvases.length, 1); const result = info.canvases[0];
  assert.equal(result.backingHeight, 1440); assert.equal(result.rect.height, 720); assert.equal(result.clippedRect.height, 636); assert.equal(result.clippedRect.y, 84);
  assert.ok(result.geometryWarnings.includes("ancestor:transform")); assert.ok(result.geometryWarnings.includes("ancestor:maskImage"));
  assert.equal(result.transform, "none"); assert.equal(result.clipPath, "none");
  assert.ok(result.occlusionSamples.some(sample => sample.status === "overlay")); assert.ok(result.occlusionSamples.some(sample => sample.status === "canvas"));
  assert.ok(info.uiRects.some(entry => entry.labels.includes("Dismiss") && entry.rect.y === 84));
  assert.equal(info.viewport.devicePixelRatio, 2);
});

test("a clipped or ancestor-hidden control is not treated as visible", async () => {
  const dom = publicDom(), clipped = dom.element("div", { rect: rectangle(0, 0, 100, 100), style: { overflowY: "hidden" } });
  dom.element("button", { parent: clipped, text: "Clean", attrs: { "aria-pressed": "true" }, rect: rectangle(0, 200, 50, 30) });
  const hidden = dom.element("div", { style: { opacity: "0" } });
  dom.element("button", { parent: hidden, text: "Satellite", attrs: { "aria-pressed": "true" } });
  const evidence = await inspectEarthUi(dom.chrome, "test");
  assert.equal(evidence.clean.count, 0); assert.equal(evidence.clean.availableCount, 1); assert.equal(evidence.satellite.availableCount, 0);
});

test("offscreen duplicates remain ambiguous, and aria-hidden canvases remain visual geometry", async () => {
  const dom = publicDom();
  dom.element("input", { type: "radio", checked: true, attrs: { "aria-label": "Clean" } });
  dom.element("input", { type: "radio", checked: true, attrs: { "aria-label": "Clean" }, rect: rectangle(0, 900, 100, 30) });
  const canvas = dom.element("canvas", { attrs: { "aria-hidden": "true" }, rect: rectangle(0, 0, 1280, 720) }); canvas.width = 2560; canvas.height = 1440;
  const evidence = await inspectEarthUi(dom.chrome, "test"); assert.equal(evidence.clean.count, 1); assert.equal(evidence.clean.availableCount, 2);
  assert.ok(earthPolicyReasons({ ...good(), clean: evidence.clean }).some(reason => reason.includes("Clean")));
  const render = await earthRenderInfo(dom.chrome, "test"); assert.equal(render.canvases[0].visible, true);
});

test("unknown public UI and transport failures remain unverified without sending input", async () => {
  const dom = publicDom(); const missing = await prepareEarth(dom.chrome, "test", { timeoutMs: 1 });
  assert.equal(missing.policyVerified, false); assert.ok(dom.calls.every(call => call.kind !== "input"));
  const calls = [], chrome = { send: async method => { calls.push(method); throw new Error("context unavailable"); } };
  const failed = await prepareEarth(chrome, "test", { timeoutMs: 1 });
  assert.equal(failed.policyVerified, false); assert.equal(failed.renderInfo, null); assert.ok(failed.reasons.some(reason => reason.includes("context unavailable")));
  assert.ok(calls.every(method => method === "Runtime.evaluate"));
  await assert.rejects(prepareEarth(chrome, "test", { timeoutMs: 0 }), /timeoutMs/); await assert.rejects(prepareEarth(chrome, "test", { timeoutMs: Infinity }), /timeoutMs/);
});
