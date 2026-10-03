#!/usr/bin/env node
/**
 * A static folder that runs the prototype on a phone: the page, a launcher of
 * ready-made runs, and the dataset of the chosen panoramas. Nothing in it needs
 * a server beyond plain files, so it can go to GitHub Pages or any static host
 * as it is. This script does not publish it anywhere.
 *
 *   node benchmarks/eac-progressive-prototype/export-package.mjs [--panoramas=northrop-mall] [--variants=eac-t192,cube-t192]
 *     [--out=build/benchmarks/eac-progressive-prototype/package]
 *
 * On a host without the results sink, each run ends by offering its results
 * as a file to save; README.md says how to bring them back.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArguments } from "../spherical-image-representation/lib/environment.mjs";
import { bundlePage, encodeSpec } from "./lib/browser.mjs";
import { configWith } from "./lib/config.mjs";
import { defaultDataset, repositoryRoot, scratchDirectory } from "./lib/paths.mjs";

const options = parseArguments({ panoramas: ["northrop-mall"], variants: ["eac-t192", "cube-t192"], out: path.join(scratchDirectory, "package"), tour: path.join(repositoryRoot, "../UMN-VR/UMN-VR.github.io/public/tour/twin-cities") });
rmSync(options.out, { recursive: true, force: true });
mkdirSync(options.out, { recursive: true });
const script = await bundlePage(path.join(scratchDirectory, "package-build"));
cpSync(script, path.join(options.out, "page.js"));
for (const panorama of options.panoramas) for (const variant of options.variants) cpSync(path.join(defaultDataset, panorama, variant), path.join(options.out, "data", panorama, variant), { recursive: true });
const TOUR_ASSET = { "northrop-mall": "northrop-mall", bookstore: "student-union-bookstore", superblock: "superblock" };
const scene = JSON.parse(readFileSync(path.join(options.tour, "scene.json"), "utf8"));

// Runs offered on the launcher: the same specs the desktop harness uses, minus the sink.
const links = [];
for (const panorama of options.panoramas) {
  const asset = scene.assets.find(item => item.id === TOUR_ASSET[panorama]), preview = asset.representations.find(item => item.id === "preview-64"), whole = asset.representations.filter(item => item.role === "immersion").sort((a, b) => b.width - a.width)[0];
  // The control's files, copied with the tour's own paths.
  for (const file of [...Object.values(preview.faces), whole.url]) { mkdirSync(path.dirname(path.join(options.out, "tour", file)), { recursive: true }); cpSync(path.join(options.tour, file), path.join(options.out, "tour", file)); }
  const control = { previewFaces: preview.faces, whole: whole.url, width: whole.width, height: whole.height, previewBytes: preview.encodedBytes, wholeBytes: whole.encodedBytes };
  for (const backend of ["webgl2", "webgl1", "webgpu"]) for (const [trace, start] of [["stationary", "off-axis"], ["quick-turn", "off-axis"], ["explore", "face-centre"]]) {
    for (const variant of [...options.variants.map(id => ({ id, data: `data/${panorama}/${id}/`, config: configWith({ dataset: { projection: id.split("-")[0], tile: Number(id.split("-t")[1]) } }) })), { id: "control", data: "tour/", config: configWith({}), control }]) {
      const spec = { mode: "run", backend, runId: `${variant.id}-${panorama}-${backend}-${trace}-${start}`, sink: null, data: variant.data, config: variant.config, trace, start, render: "ray", meshGrid: 32, control: variant.control ?? null };
      links.push({ label: `${panorama} · ${variant.id} · ${backend} · ${trace} from ${start}`, href: `index.html?spec=${encodeSpec(spec)}` });
    }
  }
  // Pages to look around in by hand: the picture as a person would see it, and the same with the tile overlay.
  const look = (variant, debug) => ({ mode: "interactive", backend: "webgl2", runId: `look-${panorama}-${variant}`, sink: null, data: `data/${panorama}/${variant}/`, config: configWith({ dataset: { projection: variant.split("-")[0], tile: Number(variant.split("-t")[1]) } }), render: "ray", meshGrid: 32, debug });
  links.unshift(
    ...options.variants.map(variant => ({ label: `${panorama} · look around · ${variant} (WebGL 2)`, href: `index.html?spec=${encodeSpec(look(variant, false))}` })),
    { label: `${panorama} · look around with the tile overlay · ${options.variants[0]} (WebGL 2)`, href: `index.html?spec=${encodeSpec(look(options.variants[0], true))}` },
  );
}
writeFileSync(path.join(options.out, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EAC prototype</title><body><script>if (!location.search) location.replace("launcher.html");</script><script src="page.js"></script>');
writeFileSync(path.join(options.out, "launcher.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EAC prototype runs</title>
<style>body{font:16px system-ui;margin:16px;max-width:720px}a{display:block;padding:10px 0;border-bottom:1px solid #ccc;color:inherit}</style>
<h1>Progressive 360° prototype</h1><p>Each link runs one camera trace and then offers its results as a file. Close other tabs, keep the phone awake and on the network you mean to test.</p>
${links.map(link => `<a href="${link.href}">${link.label}</a>`).join("\n")}`);
console.log(`${links.length} runs; package: ${options.out}`);
