/**
 * Judging what a client shows: the view at a moment against the source
 * (absolute quality) and against what the same scheme shows for that view
 * with everything arrived (the shortfall, which isolates delivery), as in
 * Phase 1. Views are drawn on the CPU (lib/render-cpu.mjs), one pixel in
 * `stride`² on a regular grid, which keeps the angular density of the viewport.
 *
 * Results are cached by camera pose and display table, since most moments of
 * a run show the same thing as the moment before.
 */
import { createHash } from "node:crypto";
import { meanSquaredError, psnrFromMse, ssim } from "../../spherical-image-representation/lib/metrics.mjs";
import { referenceView, renderView, viewSize } from "./render-cpu.mjs";

const poseKey = camera => `${camera.yaw.toFixed(3)}/${camera.pitch.toFixed(3)}/${(camera.roll ?? 0).toFixed(3)}`;
const tableKey = table => createHash("sha1").update(new Uint8Array(table.buffer, table.byteOffset, table.byteLength)).digest("hex");

export function createJudge({ source, viewport, stride = 2, supersample = 2, withSsim = true }) {
  const references = new Map(), scores = new Map(), size = viewSize(viewport, stride);
  const buffer = new Uint8Array(size.width * size.height * 3);
  const reference = camera => {
    const key = poseKey(camera);
    if (!references.has(key)) {
      if (references.size > 64) references.delete(references.keys().next().value);
      references.set(key, referenceView(source, camera, viewport, { stride, supersample }));
    }
    return references.get(key);
  };
  return {
    size, stride,
    /** `{ psnr, ssim }` of a display table seen from a camera, against the source. */
    score(dataset, table, camera, { bootstrap, payload }) {
      const key = `${dataset.directory}|${payload}|${bootstrap?.faceSize}|${poseKey(camera)}|${tableKey(table)}`;
      if (!scores.has(key)) {
        const pixels = renderView(dataset, table, camera, viewport, { stride, bootstrap, payload, out: buffer }), truth = reference(camera);
        scores.set(key, { psnr: psnrFromMse(meanSquaredError(pixels, truth)), ssim: withSsim ? ssim(pixels, truth, size.width, size.height) : null });
      }
      return scores.get(key);
    },
    reference,
  };
}
