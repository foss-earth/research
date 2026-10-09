/** Image quality between two 8-bit sRGB RGB images of the same size. */

/** Mean squared error over all three channels, in squared byte units. */
export function meanSquaredError(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return sum / a.length;
}

/** PSNR in dB for 8-bit data; identical images give 100 rather than infinity so means stay finite. */
export const psnrFromMse = mse => (mse <= 0 ? 100 : Math.min(100, 10 * Math.log10(255 * 255 / mse)));
export const psnr = (a, b) => psnrFromMse(meanSquaredError(a, b));

/**
 * SSIM on luma (BT.601, as JPEG's Y), in 8 × 8 windows every 4 pixels with
 * uniform weights: the variant x264 and ffmpeg's `ssim` filter compute, not
 * the 11 × 11 Gaussian of the original paper. Written here because no
 * implementation was installed; verify.mjs checks the identities it must obey.
 */
export function ssim(a, b, width, height) {
  const ya = new Float32Array(width * height), yb = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    ya[i] = 0.299 * a[i * 3] + 0.587 * a[i * 3 + 1] + 0.114 * a[i * 3 + 2];
    yb[i] = 0.299 * b[i * 3] + 0.587 * b[i * 3 + 1] + 0.114 * b[i * 3 + 2];
  }
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  let total = 0, windows = 0;
  for (let y = 0; y + 8 <= height; y += 4) for (let x = 0; x + 8 <= width; x += 4) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let j = 0; j < 8; j++) {
      const row = (y + j) * width + x;
      for (let i = 0; i < 8; i++) { const p = ya[row + i], q = yb[row + i]; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q; }
    }
    const ma = sa / 64, mb = sb / 64;
    const va = saa / 64 - ma * ma, vb = sbb / 64 - mb * mb, cov = sab / 64 - ma * mb;
    total += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
    windows++;
  }
  return total / windows;
}
