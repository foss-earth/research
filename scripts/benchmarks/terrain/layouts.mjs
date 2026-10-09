// Standalone prototypes. No imports from, or changes to, the application.
export function sourceSample(data, size, x, y) {
  const px = Math.max(0, Math.min(size - 1, x * size - 0.5));
  const py = Math.max(0, Math.min(size - 1, y * size - 0.5));
  const i = Math.floor(px), j = Math.floor(py), u = px - i, v = py - j;
  const k = Math.min(i + 1, size - 1), l = Math.min(j + 1, size - 1);
  return (data[j * size + i] * (1 - u) + data[j * size + k] * u) * (1 - v)
    + (data[l * size + i] * (1 - u) + data[l * size + k] * u) * v;
}

// One uniform, padded rectangular patch. Hex centers form an equilateral
// triangular lattice locally. n targets the same interior sample density for
// every layout; actual allocated vertices/triangles are reported, never assumed.
export function createLayout(kind, n, sample) {
  const hex = kind.startsWith("hex"), rotated = kind === "hex90";
  const dx = hex ? Math.sqrt(2 / Math.sqrt(3)) / n : 1 / n;
  const dy = hex ? dx * Math.sqrt(3) / 2 : dx;
  const cols = Math.ceil(1 / dx) + 3, rows = Math.ceil(1 / dy) + 3;
  const heights = new Float32Array(cols * rows);
  const positions = new Float32Array(cols * rows * 3);
  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  const patch = { kind, n, hex, rotated, dx, dy, cols, rows, heights, positions, indices };
  let k = 0;
  for (let row = 0; row < rows; row++) {
    const offset = hex ? (row & 1) * 0.5 : 0;
    for (let col = 0; col < cols; col++) {
      const x = (col - 1 + offset) * dx, y = (row - 1) * dy;
      const i = row * cols + col;
      positions[i * 3] = rotated ? y : x;
      positions[i * 3 + 2] = rotated ? x : y;
      heights[i] = positions[i * 3 + 1] = sample(rotated ? y : x, rotated ? x : y);
      if (row === rows - 1 || col === cols - 1) continue;
      const a = i, b = i + 1, c = i + cols, d = c + 1;
      const backslash = hex ? Boolean(row & 1) : kind === "square-alternating" && Boolean((row + col) & 1);
      const six = backslash ? [a, d, b, a, c, d] : [a, c, b, b, c, d];
      for (const index of six) indices[k++] = index;
    }
  }
  return patch;
}

// Direct point-to-triangle addressing, allocation-free. Both layouts interpolate
// the same triangles recorded in their index buffer (not bilinear quads).
export function querySquare(p, x, y) {
  const gx = x / p.dx + 1, gy = y / p.dy + 1;
  const col = Math.floor(gx), row = Math.floor(gy), u = gx - col, v = gy - row;
  const a = row * p.cols + col, b = a + 1, c = a + p.cols, d = c + 1, h = p.heights;
  if (p.kind === "square-alternating" && ((row + col) & 1)) {
    return u >= v ? h[a] * (1 - u) + h[b] * (u - v) + h[d] * v
      : h[a] * (1 - v) + h[c] * (v - u) + h[d] * u;
  }
  return u + v <= 1 ? h[a] * (1 - u - v) + h[b] * u + h[c] * v
    : h[b] * (1 - v) + h[c] * (1 - u) + h[d] * (u + v - 1);
}

export function queryHex(p, inputX, inputY) {
  const x = p.rotated ? inputY : inputX, y = p.rotated ? inputX : inputY;
  const gy = y / p.dy + 1, row = Math.floor(gy), v = gy - row;
  const offset = (row & 1) * 0.5, shift = row & 1 ? -0.5 : 0.5;
  const gx = x / p.dx + 1 - offset - shift * v, col = Math.floor(gx), u = gx - col;
  const a = row * p.cols + col, b = a + 1, c = a + p.cols, d = c + 1, h = p.heights;
  if (row & 1) {
    return u >= v ? h[a] * (1 - u) + h[b] * (u - v) + h[d] * v
      : h[a] * (1 - v) + h[c] * (v - u) + h[d] * u;
  }
  return u + v <= 1 ? h[a] * (1 - u - v) + h[b] * u + h[c] * v
    : h[b] * (1 - v) + h[c] * (1 - u) + h[d] * (u + v - 1);
}

export const queryFor = p => p.hex ? queryHex : querySquare;

export function refill(p, sample) {
  for (let i = 0; i < p.heights.length; i++) {
    p.heights[i] = p.positions[i * 3 + 1] = sample(p.positions[i * 3], p.positions[i * 3 + 2]);
  }
  return p.heights[0];
}

export function randomPoints(count, seed = 12345) {
  const result = new Float64Array(count * 2);
  for (let i = 0; i < result.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    // Keep evaluation away from source edge clamping, including padded nodes.
    result[i] = 0.08 + (seed / 2 ** 32) * 0.84;
  }
  return result;
}

let sink = 0;
export function measure(fn, { rounds = 9, targetMs = 12 } = {}) {
  for (let i = 0; i < 12; i++) sink += Number(fn()) || 0;
  let repetitions = 1;
  for (;;) {
    const start = performance.now();
    for (let i = 0; i < repetitions; i++) sink += Number(fn()) || 0;
    if (performance.now() - start >= targetMs || repetitions >= 32768) break;
    repetitions *= 2;
  }
  const timings = [];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    for (let i = 0; i < repetitions; i++) sink += Number(fn()) || 0;
    timings.push((performance.now() - start) / repetitions);
  }
  timings.sort((a, b) => a - b);
  return { median_ms: timings[Math.floor(timings.length / 2)], p90_ms: timings[Math.floor(timings.length * 0.9)], repetitions, rounds };
}
