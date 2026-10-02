/**
 * The spherical image representations under test, each as a set of rectangular
 * charts with a map both ways between a chart position and a direction.
 *
 * A representation is `{ id, label, family, charts, chartWidth(N), chartHeight(N),
 * toDir(chart, u, v, out), fromDir(x, y, z, out) }`. `u` and `v` run 0–1 across a
 * chart, v downward as an image row does. `toDir` writes a unit vector; `fromDir`
 * takes a unit vector and writes `[chart, u, v]`. Samples sit at cell centres:
 * cell (i, j) of a W × H chart is at u = (i + ½)/W, v = (j + ½)/H. `N` is the
 * resolution parameter and every chart is `chartWidth(N)` × `chartHeight(N)`.
 * `equalArea` marks the maps whose cells all have exactly the same solid angle.
 *
 * Directions use FOSS Earth's image-local axes (docs/proposals/panorama-scenes.md
 * §2): X right, Y forward, Z up.
 *
 * Nothing here is shared with production code. The cube face table and the
 * equirectangular convention are copied from scripts/lib/panoramaImage.mjs so a
 * face here is the same face there.
 */

const PI = Math.PI;
const TAU = 2 * Math.PI;
const clamp1 = value => (value > 1 ? 1 : value < -1 ? -1 : value);

// ─── Equirectangular ───────────────────────────────────────────────────

const equirect = {
  id: "equirect", label: "Equirectangular", family: "equirectangular", charts: 1,
  chartWidth: N => 2 * N, chartHeight: N => N,
  toDir(_chart, u, v, out) {
    const lon = (u - 0.5) * TAU, lat = (0.5 - v) * PI, c = Math.cos(lat);
    out[0] = c * Math.sin(lon); out[1] = c * Math.cos(lon); out[2] = Math.sin(lat);
  },
  fromDir(x, y, z, out) {
    out[0] = 0;
    out[1] = 0.5 + Math.atan2(x, y) / TAU;
    out[2] = 0.5 - Math.asin(clamp1(z)) / PI;
  },
};

// ─── Cubed spheres: one face table, three warps ────────────────────────

// Forward f, right r, top t for px, nx, py, ny, pz, nz: scripts/lib/panoramaImage.mjs CUBE_FACES.
const FACE_F = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_R = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [1, 0, 0], [1, 0, 0]];
const FACE_T = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, -1, 0], [0, 1, 0]];

const pair = [0, 0];

/** `toFace(s, t, pair)`: chart square −1…1 → gnomonic face coordinates; `fromFace` the reverse. */
function cubedSphere(id, label, toFace, fromFace) {
  return {
    id, label, family: "cube", charts: 6,
    chartWidth: N => N, chartHeight: N => N,
    toDir(chart, u, v, out) {
      toFace(2 * u - 1, 1 - 2 * v, pair);
      const a = pair[0], b = pair[1];
      const f = FACE_F[chart], r = FACE_R[chart], t = FACE_T[chart];
      const x = f[0] + a * r[0] + b * t[0], y = f[1] + a * r[1] + b * t[1], z = f[2] + a * r[2] + b * t[2];
      const n = 1 / Math.sqrt(x * x + y * y + z * z);
      out[0] = x * n; out[1] = y * n; out[2] = z * n;
    },
    fromDir(x, y, z, out) {
      const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
      const chart = ax >= ay && ax >= az ? (x > 0 ? 0 : 1) : ay >= az ? (y > 0 ? 2 : 3) : (z > 0 ? 4 : 5);
      const f = FACE_F[chart], r = FACE_R[chart], t = FACE_T[chart];
      const d = x * f[0] + y * f[1] + z * f[2];
      fromFace((x * r[0] + y * r[1] + z * r[2]) / d, (x * t[0] + y * t[1] + z * t[2]) / d, pair);
      out[0] = chart; out[1] = (pair[0] + 1) / 2; out[2] = (1 - pair[1]) / 2;
    },
  };
}

const identity = (a, b, out) => { out[0] = a; out[1] = b; };

/** Equi-angular cubemap: each axis is the angle from the face centre, so texels subtend equal angles along the axes. */
const eacToFace = (s, t, out) => { out[0] = Math.tan(s * PI / 4); out[1] = Math.tan(t * PI / 4); };
const eacFromFace = (a, b, out) => { out[0] = Math.atan(a) * 4 / PI; out[1] = Math.atan(b) * 4 / PI; };

/**
 * Quadrilateralized spherical cube (O'Neill & Laubscher 1976), in the closed
 * form of Calabretta & Greisen 2002 §5.6.3. Exactly equal-area; verify.mjs
 * checks the area and the round trip numerically rather than trusting this
 * transcription.
 */
const SQRT1_2 = Math.SQRT1_2;
function qscToFace(s, t, out) {
  // Chart square → unit vector (xi, eta, zeta) on the face, then gnomonic xi/zeta, eta/zeta.
  const swap = Math.abs(s) < Math.abs(t);
  const major = swap ? t : s, minor = swap ? s : t;
  if (major === 0) { out[0] = 0; out[1] = 0; return; }
  const angle = (PI / 12) * (minor / major);
  const omega = Math.sin(angle) / (Math.cos(angle) - SQRT1_2);
  const zeta = 1 - major * major * (1 - 1 / Math.sqrt(2 + omega * omega));
  const xi = Math.sign(major) * Math.sqrt(Math.max(0, (1 - zeta * zeta) / (1 + omega * omega)));
  const eta = omega * xi;
  out[0] = (swap ? eta : xi) / zeta; out[1] = (swap ? xi : eta) / zeta;
}
function qscFromFace(a, b, out) {
  const zeta = 1 / Math.sqrt(1 + a * a + b * b);
  const swap = Math.abs(a) < Math.abs(b);
  const xi = (swap ? b : a) * zeta, eta = (swap ? a : b) * zeta;
  if (xi === 0) { out[0] = 0; out[1] = 0; return; }
  const omega = eta / xi;
  const major = Math.sign(xi) * Math.sqrt(Math.max(0, (1 - zeta) / (1 - 1 / Math.sqrt(2 + omega * omega))));
  const minor = major * (12 / PI) * (Math.atan(omega) - Math.asin(omega / Math.sqrt(2 * (1 + omega * omega))));
  out[0] = swap ? minor : major; out[1] = swap ? major : minor;
}

const cube = cubedSphere("cube", "Cubemap (gnomonic)", identity, identity);
const eac = cubedSphere("eac", "Equi-angular cubemap", eacToFace, eacFromFace);
const qsc = { ...cubedSphere("qsc", "QSC equal-area cube", qscToFace, qscFromFace), equalArea: true };

// ─── Octahedral square: one chart, north pole at the centre, south pole at the corners ───

/** The graphics "octahedral map": project to the octahedron by the L1 norm, unfold. Not equal-area. */
const octLinear = {
  id: "oct", label: "Octahedral (L1)", family: "octahedral", charts: 1,
  chartWidth: N => N, chartHeight: N => N,
  toDir(_chart, u, v, out) {
    const px = 2 * u - 1, py = 1 - 2 * v;
    const z = 1 - Math.abs(px) - Math.abs(py);
    let x = px, y = py;
    if (z < 0) {
      x = (px >= 0 ? 1 : -1) * (1 - Math.abs(py));
      y = (py >= 0 ? 1 : -1) * (1 - Math.abs(px));
    }
    const n = 1 / Math.sqrt(x * x + y * y + z * z);
    out[0] = x * n; out[1] = y * n; out[2] = z * n;
  },
  fromDir(x, y, z, out) {
    const n = 1 / (Math.abs(x) + Math.abs(y) + Math.abs(z));
    let px = x * n, py = y * n;
    if (z < 0) {
      const fx = (x >= 0 ? 1 : -1) * (1 - Math.abs(py)), fy = (y >= 0 ? 1 : -1) * (1 - Math.abs(px));
      px = fx; py = fy;
    }
    out[0] = 0; out[1] = (px + 1) / 2; out[2] = (1 - py) / 2;
  },
};

/** Clarberg 2008, "Fast equal-area mapping of the (hemi)sphere using SIMD", as in pbrt-v4. Exactly equal-area. */
const octEqualArea = {
  id: "oct-ea", label: "Octahedral equal-area", family: "octahedral", charts: 1, equalArea: true,
  chartWidth: N => N, chartHeight: N => N,
  toDir(_chart, u, v, out) {
    const p = 2 * u - 1, q = 1 - 2 * v;
    const ap = Math.abs(p), aq = Math.abs(q);
    const signedDistance = 1 - (ap + aq);
    const r = 1 - Math.abs(signedDistance);
    const phi = (r === 0 ? 1 : (aq - ap) / r + 1) * PI / 4;
    const radial = r * Math.sqrt(Math.max(0, 2 - r * r));
    out[0] = (p >= 0 ? 1 : -1) * Math.cos(phi) * radial;
    out[1] = (q >= 0 ? 1 : -1) * Math.sin(phi) * radial;
    out[2] = (signedDistance >= 0 ? 1 : -1) * (1 - r * r);
  },
  fromDir(x, y, z, out) {
    const ax = Math.abs(x), ay = Math.abs(y);
    const r = Math.sqrt(Math.max(0, 1 - Math.abs(z)));
    const phi = (ax === 0 && ay === 0 ? 0 : Math.atan2(ay, ax)) * 2 / PI;
    let q = phi * r, p = r - q;
    if (z < 0) { const t = p; p = 1 - q; q = 1 - t; }
    if (x < 0) p = -p;
    if (y < 0) q = -q;
    out[0] = 0; out[1] = (p + 1) / 2; out[2] = (1 - q) / 2;
  },
};

// ─── HEALPix ───────────────────────────────────────────────────────────

/**
 * HEALPix (Górski et al. 2005) as twelve N × N charts, one per base pixel, with
 * u along the north-east axis and v along the north-west axis. This is the
 * projection of §4.4 written continuously, so positions inside a pixel are
 * defined; verify.mjs checks its pixel assignment and pixel centres against
 * the @hscmap/healpix package for the nested scheme.
 */
const healpix = {
  id: "healpix", label: "HEALPix", family: "healpix", charts: 12, equalArea: true,
  chartWidth: N => N, chartHeight: N => N,
  toDir(chart, u, v, out) {
    const row = chart >> 2;
    const t = (2 * (chart & 3) - (row & 1) + 1 + (u - v) + 8) * PI / 4;
    const w = PI / 2 - (row + 2 - u - v) * PI / 4;
    const aw = Math.abs(w);
    let z, a;
    if (aw <= PI / 4) {
      z = 8 / (3 * PI) * w; a = t;
    } else if (aw >= PI / 2) {
      z = w > 0 ? 1 : -1; a = 0;
    } else {
      const tt = t % (PI / 2);
      a = t - (aw - PI / 4) / (aw - PI / 2) * (tt - PI / 4);
      const k = 2 - 4 * aw / PI;
      z = (w > 0 ? 1 : -1) * (1 - k * k / 3);
    }
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    out[0] = s * Math.cos(a); out[1] = s * Math.sin(a); out[2] = z;
  },
  fromDir(x, y, z, out) {
    let a = Math.atan2(y, x);
    if (a < 0) a += TAU;
    let t, w;
    if (Math.abs(z) <= 2 / 3) {
      t = a; w = 3 * PI / 8 * z;
    } else {
      const sigma = (z > 0 ? 1 : -1) * (2 - Math.sqrt(3 * (1 - Math.abs(z))));
      t = a - (Math.abs(sigma) - 1) * (a % (PI / 2) - PI / 4);
      w = PI / 4 * sigma;
    }
    // The plane in units of π/4, shifted so the twelve base pixels are unit squares on a diagonal lattice.
    let tu = t / (PI / 4);
    tu = ((tu % 8) + 8) % 8 - 4;
    const wu = w / (PI / 4) + 5;
    const pp = Math.min(5, Math.max(0, (wu + tu) / 2));
    const PP = Math.min(4, Math.floor(pp));
    const qq = Math.min(6 - PP, Math.max(3 - PP, (wu - tu) / 2));
    const QQ = Math.min(5 - PP, Math.floor(qq));
    const V = 5 - (PP + QQ);
    const H = PP - QQ + 4;
    out[0] = 4 * V + ((H >> 1) & 3);
    out[1] = Math.min(1, pp - PP);
    out[2] = Math.min(1, qq - QQ);
  },
};

// ─── Recursive spherical triangles: TOAST and the icosahedron ─────────

function midpoint(a, b, out) {
  const x = a[0] + b[0], y = a[1] + b[1], z = a[2] + b[2];
  const n = 1 / Math.sqrt(x * x + y * y + z * z);
  out[0] = x * n; out[1] = y * n; out[2] = z * n;
}
const tripleProduct = (a, b, p0, p1, p2) =>
  (a[1] * b[2] - a[2] * b[1]) * p0 + (a[2] * b[0] - a[0] * b[2]) * p1 + (a[0] * b[1] - a[1] * b[0]) * p2;

/**
 * Charts built from root quads, each two spherical triangles that share the
 * diagonal P10–P01: the lower one (P00, P10, P01) where s + t ≤ 1, the upper
 * one (P11, P01, P10) elsewhere. A triangle divides into four by the
 * normalized midpoints of its edges, recursively, so every vertex is on the
 * unit sphere and a cell of a 2^L grid is exactly two depth-L triangles.
 * `depth` levels are followed, then the leaf is treated as flat.
 *
 * `roots` are `{ p00, p10, p11, p01 }`. `locate(chart, u, v, out)` writes
 * `[root, s, t]`, and `place(root, s, t, out)` writes `[chart, u, v]`.
 */
function recursiveCharts({ id, label, family, charts, roots, locate, place, depth = 16 }) {
  // Keep (P00, P10, P01) counter-clockwise from outside, mirroring s and t where a root is not.
  const quads = roots.map(root => {
    const flipped = tripleProduct(root.p00, root.p10, ...root.p01) < 0;
    return { p00: root.p00, p10: flipped ? root.p01 : root.p10, p01: flipped ? root.p10 : root.p01, p11: root.p11, flipped };
  });
  // Scratch triangles: three vertices and three edge midpoints.
  const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0], mAB = [0, 0, 0], mBC = [0, 0, 0], mCA = [0, 0, 0];
  const where = [0, 0, 0];
  const set = (target, source) => { target[0] = source[0]; target[1] = source[1]; target[2] = source[2]; };

  function toDir(chart, u, v, out, levels = depth) {
    locate(chart, u, v, where);
    const quad = quads[where[0]];
    const s = quad.flipped ? where[2] : where[1], t = quad.flipped ? where[1] : where[2];
    let a, b, c;
    if (s + t <= 1) { set(A, quad.p00); set(B, quad.p10); set(C, quad.p01); a = 1 - s - t; b = s; c = t; }
    else { set(A, quad.p11); set(B, quad.p01); set(C, quad.p10); a = s + t - 1; b = 1 - s; c = 1 - t; }
    for (let level = 0; level < levels; level++) {
      if (a >= 0.5) { midpoint(A, B, mAB); midpoint(C, A, mCA); set(B, mAB); set(C, mCA); a = 2 * a - 1; b *= 2; c *= 2; }
      else if (b >= 0.5) { midpoint(A, B, mAB); midpoint(B, C, mBC); set(A, mAB); set(C, mBC); a *= 2; b = 2 * b - 1; c *= 2; }
      else if (c >= 0.5) { midpoint(C, A, mCA); midpoint(B, C, mBC); set(A, mCA); set(B, mBC); a *= 2; b *= 2; c = 2 * c - 1; }
      else {
        midpoint(A, B, mAB); midpoint(B, C, mBC); midpoint(C, A, mCA);
        set(A, mBC); set(B, mCA); set(C, mAB); a = 1 - 2 * a; b = 1 - 2 * b; c = 1 - 2 * c;
      }
    }
    const x = a * A[0] + b * B[0] + c * C[0], y = a * A[1] + b * B[1] + c * C[1], z = a * A[2] + b * B[2] + c * C[2];
    const n = 1 / Math.sqrt(x * x + y * y + z * z);
    out[0] = x * n; out[1] = y * n; out[2] = z * n;
  }

  function fromDir(x, y, z, out, levels = depth) {
    // The root triangle the direction is deepest inside.
    let best = -Infinity, rootIndex = 0, upper = false;
    for (let index = 0; index < quads.length; index++) {
      const quad = quads[index];
      const lower = Math.min(tripleProduct(quad.p00, quad.p10, x, y, z), tripleProduct(quad.p10, quad.p01, x, y, z), tripleProduct(quad.p01, quad.p00, x, y, z));
      if (lower > best) { best = lower; rootIndex = index; upper = false; }
      const high = Math.min(tripleProduct(quad.p11, quad.p01, x, y, z), tripleProduct(quad.p01, quad.p10, x, y, z), tripleProduct(quad.p10, quad.p11, x, y, z));
      if (high > best) { best = high; rootIndex = index; upper = true; }
    }
    const quad = quads[rootIndex];
    // Corner positions in the root's (s, t).
    let sA, tA, sB, tB, sC, tC;
    if (!upper) { set(A, quad.p00); set(B, quad.p10); set(C, quad.p01); sA = 0; tA = 0; sB = 1; tB = 0; sC = 0; tC = 1; }
    else { set(A, quad.p11); set(B, quad.p01); set(C, quad.p10); sA = 1; tA = 1; sB = 0; tB = 1; sC = 1; tC = 0; }
    for (let level = 0; level < levels; level++) {
      midpoint(A, B, mAB); midpoint(B, C, mBC); midpoint(C, A, mCA);
      const sAB = (sA + sB) / 2, tAB = (tA + tB) / 2, sBC = (sB + sC) / 2, tBC = (tB + tC) / 2, sCA = (sC + sA) / 2, tCA = (tC + tA) / 2;
      if (tripleProduct(mAB, mCA, x, y, z) >= 0) { set(B, mAB); set(C, mCA); sB = sAB; tB = tAB; sC = sCA; tC = tCA; }
      else if (tripleProduct(mBC, mAB, x, y, z) >= 0) { set(A, mAB); set(C, mBC); sA = sAB; tA = tAB; sC = sBC; tC = tBC; }
      else if (tripleProduct(mCA, mBC, x, y, z) >= 0) { set(A, mCA); set(B, mBC); sA = sCA; tA = tCA; sB = sBC; tB = tBC; }
      else { set(A, mBC); set(B, mCA); set(C, mAB); sA = sBC; tA = tBC; sB = sCA; tB = tCA; sC = sAB; tC = tAB; }
    }
    let wa = Math.max(0, tripleProduct(B, C, x, y, z)), wb = Math.max(0, tripleProduct(C, A, x, y, z)), wc = Math.max(0, tripleProduct(A, B, x, y, z));
    const sum = wa + wb + wc;
    if (sum > 0) { wa /= sum; wb /= sum; wc /= sum; } else { wa = wb = wc = 1 / 3; }
    const s = wa * sA + wb * sB + wc * sC, t = wa * tA + wb * tB + wc * tC;
    place(rootIndex, quad.flipped ? t : s, quad.flipped ? s : t, out);
  }

  return { id, label, family, charts, chartWidth: N => N, chartHeight: N => N, toDir, fromDir, recursive: true, roots: quads };
}

// TOAST: the octahedron unfolded to one square. The north pole is the centre, the south pole the
// four corners, and the equator's four axis points the middles of the sides. Each quadrant is a
// root quad split along its equator edge, as in WorldWide Telescope's TOAST.
const NORTH = [0, 0, 1], SOUTH = [0, 0, -1];
const toast = recursiveCharts({
  id: "toast", label: "TOAST (recursive octahedral)", family: "octahedral", charts: 1,
  // Quadrant index: bit 0 set where u ≥ ½ (the +X side), bit 1 set where v < ½ (the +Y side, the image top).
  roots: [0, 1, 2, 3].map(quadrant => ({
    p00: NORTH, p11: SOUTH,
    p10: [quadrant & 1 ? 1 : -1, 0, 0],
    p01: [0, quadrant & 2 ? 1 : -1, 0],
  })),
  locate(_chart, u, v, out) {
    const px = 2 * u - 1, py = 1 - 2 * v;
    out[0] = (px >= 0 ? 1 : 0) | (py >= 0 ? 2 : 0);
    out[1] = Math.abs(px); out[2] = Math.abs(py);
  },
  place(root, s, t, out) {
    const px = root & 1 ? s : -s, py = root & 2 ? t : -t;
    out[0] = 0; out[1] = (px + 1) / 2; out[2] = (1 - py) / 2;
  },
});

// The icosahedron with a vertex at each pole, as ten rhombi of two faces each: five touching the
// north pole and five the south. Chart k is root k, and (u, v) is the root's (s, t).
function icosahedronRoots() {
  const latitude = Math.atan(0.5);
  const ring = (lat, lonDeg) => {
    const lon = lonDeg * PI / 180;
    return [Math.cos(lat) * Math.sin(lon), Math.cos(lat) * Math.cos(lon), Math.sin(lat)];
  };
  const upper = Array.from({ length: 5 }, (_, k) => ring(latitude, 72 * k));
  const lower = Array.from({ length: 5 }, (_, k) => ring(-latitude, 36 + 72 * k));
  const roots = [];
  for (let k = 0; k < 5; k++) roots.push({ p00: NORTH, p10: upper[k], p01: upper[(k + 1) % 5], p11: lower[k] });
  for (let k = 0; k < 5; k++) roots.push({ p00: SOUTH, p10: lower[(k + 1) % 5], p01: lower[k], p11: upper[(k + 1) % 5] });
  return roots;
}
const icoCharts = {
  charts: 10, roots: icosahedronRoots(),
  locate(chart, u, v, out) { out[0] = chart; out[1] = u; out[2] = v; },
  place(root, s, t, out) { out[0] = root; out[1] = s; out[2] = t; },
};
/** One sample per rhombus cell, at its centre: a triangular lattice of samples, stored as ten square images. */
const icoRhombus = recursiveCharts({ id: "ico-rhombus", label: "Icosahedral, rhombus cells", family: "icosahedral", ...icoCharts });
/**
 * One sample per triangle, at its centroid: the hierarchy addressed as root face + child digits.
 * Two samples for each rhombus cell, the lower triangle's then the upper's.
 */
const icoTriangle = { ...recursiveCharts({ id: "ico-tri", label: "Icosahedral, triangle cells", family: "icosahedral", ...icoCharts }), triangleCells: true };

/**
 * The same sample positions as the rhombus cells, used as the triangular lattice they are: each
 * sample is the mean of the hexagon nearer to it than to any other sample, and reconstruction is
 * barycentric between the three nearest samples. The best this lattice can do for an image, at
 * the price of cells that no longer nest: a hexagon's four children are not inside it.
 */
const icoHexagon = { ...icoRhombus, id: "ico-hex", label: "Icosahedral, hexagon cells", hexagonCells: true };

export const REPRESENTATIONS = [equirect, cube, eac, qsc, octLinear, octEqualArea, toast, healpix, icoRhombus, icoHexagon, icoTriangle];
export const representation = id => {
  const found = REPRESENTATIONS.find(item => item.id === id);
  if (!found) throw new Error(`unknown representation ${id}; known: ${REPRESENTATIONS.map(item => item.id).join(", ")}`);
  return found;
};

/** Samples in a representation at resolution N. */
export function sampleCount(rep, N) {
  return rep.charts * rep.chartWidth(N) * rep.chartHeight(N) * (rep.triangleCells ? 2 : 1);
}

/** The resolution whose sample count is nearest `target`; a power of two for the recursive representations. */
export function resolutionFor(rep, target) {
  const perUnit = sampleCount(rep, 1);
  const exact = Math.sqrt(target / perUnit);
  if (rep.recursive) return 2 ** Math.max(1, Math.round(Math.log2(exact)));
  return Math.max(2, Math.round(exact));
}
