#!/usr/bin/env node
/**
 * The packaged datasets compared at a matched view quality: does Phase 1's
 * byte advantage of the equi-angular cube over the ordinary cubemap survive
 * full-resolution faces, gutters, real tiles and the phone viewport? And what
 * do a bootstrap of each size, the residual chain and the current whole image
 * look like on the same views?
 *
 *   node benchmarks/eac-progressive-prototype/run-representation.mjs [--panoramas=…] [--qualities=60,70,80,90]
 *   node benchmarks/eac-progressive-prototype/run-representation.mjs --face=2048 --qualities=60,70,80 --name=representation-face2048
 *
 * `--face=2048` judges faces of 2048 texels (256-texel tiles) instead: more
 * texels than the source has at the horizon, to see whether 1536 left detail
 * behind that the source does have elsewhere.
 *
 * Views are Phase 1's twelve evaluation views (horizon, mid and steep pitches,
 * both poles, random orientations with roll) drawn at the phone viewport of
 * config/default.json, judged on every second pixel each way against the
 * source. Each dataset is shown with every cell at its finest level, as a
 * view-first client shows it once a view is complete.
 *
 * Bytes are counted three ways: the finest level alone (what "direct" fetches
 * for the whole sphere), the whole replacement pyramid, and the residual chain.
 * The current path's image is the tour's published immersion-6144.jpg, drawn
 * on the CPU with a bilinear tap and no mipmaps, so at the poles, where the
 * equirectangular image is squeezed, it aliases more here than on a GPU.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { CORPUS, defaultCorpusRoot, loadSource } from "../spherical-image-representation/lib/source.mjs";
import { evaluationViews } from "../spherical-image-representation/lib/evaluation.mjs";
import { parseArguments } from "../spherical-image-representation/lib/environment.mjs";
import { decodeJpeg } from "../spherical-image-representation/lib/codecs.mjs";
import { meanSquaredError, psnrFromMse, ssim } from "../spherical-image-representation/lib/metrics.mjs";
import { openDataset, renderView, uniformTable, judgedRays, viewSize } from "./lib/render-cpu.mjs";
import { createJudge } from "./lib/judge.mjs";
import { viewportOf } from "./lib/config.mjs";
import { defaultDataset, loadConfig, repositoryRoot, scratchDirectory, writeCsv, writeResults } from "./lib/paths.mjs";

const options = parseArguments({ panoramas: ["northrop-mall", "bookstore", "superblock"], qualities: ["60", "70", "80", "90"], face: 1536, name: "representation", "corpus-root": defaultCorpusRoot, tour: path.join(repositoryRoot, "../UMN-VR/UMN-VR.github.io/public/tour/twin-cities") });
const config = loadConfig(), viewport = viewportOf(config), stride = 2;
const TOUR_ASSET = { "northrop-mall": "northrop-mall", bookstore: "student-union-bookstore", superblock: "superblock" };
const views = evaluationViews();
const rows = [];
const wide = options.face !== 1536, tileOf = wide ? 256 : 192;
const datasetDirectory = (quality, panorama, variant) => (wide ? path.join(scratchDirectory, `dataset-face${options.face}-q${quality}`, panorama, variant) : quality === 80 ? path.join(defaultDataset, panorama, variant) : path.join(scratchDirectory, `dataset-q${quality}`, panorama, variant));

/** Mean PSNR and SSIM over the views of a function that draws one view. */
function score(judge, draw) {
  let psnr = 0, structure = 0;
  for (const view of views) {
    const camera = { yaw: view.yaw, pitch: view.pitch, roll: view.roll }, pixels = draw(camera), truth = judge.reference(camera);
    psnr += psnrFromMse(meanSquaredError(pixels, truth)); structure += ssim(pixels, truth, judge.size.width, judge.size.height);
  }
  return { psnr: psnr / views.length, ssim: structure / views.length };
}

for (const panorama of options.panoramas) {
  const source = loadSource(CORPUS.find(entry => entry.id === panorama), options["corpus-root"]);
  const judge = createJudge({ source, viewport, stride });
  for (const projection of ["eac", "cube"]) for (const quality of options.qualities.map(Number)) {
    const dataset = openDataset(datasetDirectory(quality, panorama, `${projection}-t${tileOf}`)), { manifest, tiling } = dataset;
    const finest = manifest.levels.at(-1);
    const quality80 = quality === 80 && !wide;
    const replacement = score(judge, camera => renderView(dataset, uniformTable(tiling, tiling.maxLevel), camera, viewport, { stride }));
    rows.push({ kind: "tiles", panorama, projection, tile: tiling.tile, jpegQuality: quality, payload: "replacement", samples: 6 * finest.faceSize ** 2, finestLevelBytes: finest.replacementBytes, pyramidBytes: manifest.totals.replacementBytes, finestLevelBytesWithoutGutter: finest.replacementBytesWithoutGutter, viewPsnr: replacement.psnr, viewSsim: replacement.ssim });
    if (quality80) {
      // The residual chain's final picture: every level's error is its own, or it builds up; and what it costs.
      const residual = score(judge, camera => renderView(dataset, uniformTable(tiling, tiling.maxLevel), camera, viewport, { stride, payload: "residual" }));
      rows.push({ kind: "tiles", panorama, projection, tile: tiling.tile, jpegQuality: quality, payload: "residual", samples: 6 * finest.faceSize ** 2, finestLevelBytes: finest.residualBytes, pyramidBytes: manifest.totals.residualBytes, viewPsnr: residual.psnr, viewSsim: residual.ssim, clippedShare: manifest.residual.clippedShare });
      for (const level of [0, 1, 2]) {
        const coarse = score(judge, camera => renderView(dataset, uniformTable(tiling, level), camera, viewport, { stride }));
        rows.push({ kind: "level", panorama, projection, tile: tiling.tile, jpegQuality: quality, level, faceSize: tiling.faceSize(level), levelBytes: manifest.levels[level].replacementBytes, viewPsnr: coarse.psnr, viewSsim: coarse.ssim });
      }
      for (const boot of manifest.bootstrap) {
        const bootstrap = dataset.bootstrap(boot.faceSize);
        const shown = score(judge, camera => renderView(dataset, uniformTable(tiling, -1), camera, viewport, { stride, bootstrap }));
        rows.push({ kind: "bootstrap", panorama, projection, faceSize: boot.faceSize, bytes: boot.bytes, width: boot.width, height: boot.height, viewPsnr: shown.psnr, viewSsim: shown.ssim });
      }
      // The other tile sizes, at the same face size: what the gutter and the tile boundaries cost.
      for (const tile of [96, 384]) {
        const other = openDataset(path.join(defaultDataset, panorama, `${projection}-t${tile}`)), level = other.manifest.levels.at(-1);
        const shown = score(judge, camera => renderView(other, uniformTable(other.tiling, other.tiling.maxLevel), camera, viewport, { stride }));
        rows.push({ kind: "tiles", panorama, projection, tile, jpegQuality: quality, payload: "replacement", samples: 6 * level.faceSize ** 2, finestLevelBytes: level.replacementBytes, pyramidBytes: other.manifest.totals.replacementBytes, finestLevelBytesWithoutGutter: level.replacementBytesWithoutGutter, viewPsnr: shown.psnr, viewSsim: shown.ssim });
        other.forget();
      }
    }
    dataset.forget();
    console.log(`${panorama} ${projection} q${quality}: ${replacement.psnr.toFixed(2)} dB, ${(finest.replacementBytes / 1024).toFixed(0)} KiB at the finest level`);
  }
  if (wide) continue;
  // The current path's whole image, as published.
  const asset = JSON.parse(readFileSync(path.join(options.tour, "scene.json"), "utf8")).assets.find(item => item.id === TOUR_ASSET[panorama]);
  for (const representation of asset.representations.filter(item => item.role === "immersion")) {
    const file = path.join(options.tour, representation.url), image = decodeJpeg(readFileSync(file));
    const level = { width: image.width, height: image.height, rgb: image.rgb };
    const shown = score(judge, camera => {
      const rays = judgedRays(camera, viewport, stride, 1), size = viewSize(viewport, stride), out = new Uint8Array(size.width * size.height * 3);
      for (let r = 0, at = 0; r < rays.length; r += 3, at += 3) {
        // Bilinear in the bytes, as the WebGL path samples its encoded texture at full size.
        const u = 0.5 + Math.atan2(rays[r], rays[r + 1]) / (2 * Math.PI), v = 0.5 - Math.asin(Math.max(-1, Math.min(1, rays[r + 2]))) / Math.PI;
        const fx = u * level.width - 0.5, fy = Math.min(level.height - 1, Math.max(0, v * level.height - 0.5)), x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const xa = (x0 % level.width + level.width) % level.width, xb = (xa + 1) % level.width, y1 = Math.min(level.height - 1, y0 + 1);
        for (let c = 0; c < 3; c++) {
          const p = channel => level.rgb[channel + c];
          out[at + c] = (p((y0 * level.width + xa) * 3) * (1 - tx) + p((y0 * level.width + xb) * 3) * tx) * (1 - ty) + (p((y1 * level.width + xa) * 3) * (1 - tx) + p((y1 * level.width + xb) * 3) * tx) * ty + 0.5;
        }
      }
      return out;
    });
    rows.push({ kind: "control", panorama, projection: "equirectangular", width: representation.width, bytes: representation.encodedBytes, samples: representation.width * representation.height, viewPsnr: shown.psnr, viewSsim: shown.ssim, encoder: "jpeg-js quality 80, no chroma subsampling (scripts/prepare-panorama.mjs)" });
  }
  console.log(`${panorama}: done`);
}
console.log(writeResults(options.name, import.meta.url, { face: options.face, viewport, stride, views: views.map(view => view.id), qualities: options.qualities, note: "every cell at the finest level; the control drawn bilinearly without mipmaps" }, {}));
console.log(writeCsv(options.name, rows));
