/**
 * The residual payload's arithmetic, shared by the encoder (Node) and the
 * decoder (the page), so both use one reconstructed-parent convention.
 *
 *   prediction = the parent's reconstructed stored tile, enlarged ×2 bilinearly
 *   residual   = clamp(target − prediction + 128, 0, 255)      (what the JPEG holds)
 *   child      = clamp(prediction + decoded residual − 128, 0, 255)
 *
 * Phase 1's scheme (lib/schemes.mjs `predictTile`), with three things pinned
 * down that a real client needs:
 *
 * - **Integers.** A ×2 enlargement only ever weights texels ¼ and ¾, so the
 *   prediction is `(Σ w·p + 8) >> 4` with weights 9, 3, 3, 1: the same bytes
 *   in every JavaScript engine, with no float rounding to disagree about.
 * - **Colour space and precision.** 8-bit sRGB-encoded bytes, each channel
 *   alone, not linear light: what the image decoder hands back.
 * - **Gutters.** A stored tile carries its gutter, and the parent's gutter is
 *   exactly what the child's needs: every tap for a child's stored texels,
 *   gutter included, lands inside the parent's stored tile. A child therefore
 *   depends on its own parent and on nothing beside it.
 *
 * A difference outside −128…127 is clipped, so a child can be wrong by up to
 * 127 where a hard edge appears that the parent does not have. tests/ measure
 * how often that happens and what it costs.
 *
 * Buffers are bytes with `channels` per texel (3 in Node, 4 in the page);
 * only the first three are touched, and a fourth is set opaque.
 */

/**
 * The prediction of a child's stored tile from its parent's.
 * `quadrantX`, `quadrantY` are the child's position inside the parent, 0 or 1.
 */
export function predictChild(parent, parentChannels, tile, gutter, quadrantX, quadrantY, out, outChannels) {
  const stored = tile + 2 * gutter;
  for (let cj = 0; cj < stored; cj++) {
    const my = quadrantY * tile + gutter + cj, oddY = my & 1;
    const j0 = oddY ? (my - 1) >> 1 : (my >> 1) - 1, wy0 = oddY ? 3 : 1, wy1 = 4 - wy0;
    const row0 = j0 * stored, row1 = row0 + stored;
    for (let ci = 0; ci < stored; ci++) {
      const mx = quadrantX * tile + gutter + ci, oddX = mx & 1;
      const i0 = oddX ? (mx - 1) >> 1 : (mx >> 1) - 1, wx0 = oddX ? 3 : 1, wx1 = 4 - wx0;
      const p00 = (row0 + i0) * parentChannels, p10 = p00 + parentChannels, p01 = (row1 + i0) * parentChannels, p11 = p01 + parentChannels;
      const o = (cj * stored + ci) * outChannels;
      for (let c = 0; c < 3; c++) {
        out[o + c] = (wy0 * (wx0 * parent[p00 + c] + wx1 * parent[p10 + c]) + wy1 * (wx0 * parent[p01 + c] + wx1 * parent[p11 + c]) + 8) >> 4;
      }
      if (outChannels === 4) out[o + 3] = 255;
    }
  }
  return out;
}

/** What the encoder stores: the target minus the prediction, offset to mid-grey and clipped. Returns how many values were clipped. */
export function encodeDifference(target, prediction, channels, out) {
  let clipped = 0;
  for (let i = 0; i < target.length; i += channels) for (let c = 0; c < 3; c++) {
    const d = target[i + c] - prediction[i + c] + 128;
    if (d < 0) { out[i + c] = 0; clipped++; } else if (d > 255) { out[i + c] = 255; clipped++; } else out[i + c] = d;
  }
  return clipped;
}

/** The child: prediction plus the decoded difference, in place in `prediction`. */
export function addDifference(prediction, predictionChannels, difference, differenceChannels) {
  const texels = prediction.length / predictionChannels;
  for (let t = 0; t < texels; t++) {
    const p = t * predictionChannels, d = t * differenceChannels;
    for (let c = 0; c < 3; c++) {
      const value = prediction[p + c] + difference[d + c] - 128;
      prediction[p + c] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
  }
  return prediction;
}
