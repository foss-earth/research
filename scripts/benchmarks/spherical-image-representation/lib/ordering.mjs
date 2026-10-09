/**
 * Orders in which a client could be sent a scheme's units, and what it holds
 * after a given number of bytes. A unit counts only when it has arrived whole,
 * and, in a residual scheme, only once every unit it refines has arrived too.
 */
import { toRgb } from "./hierarchy.mjs";

/**
 * How much each unit improves the picture: the squared error against the
 * exact level that showing the unit removes, compared with showing its
 * parent's cells enlarged, summed over the unit's cells and scaled to
 * full-resolution samples and to the cells' true area. Computed the same way
 * for every scheme, from decoded images, so it can be precomputed by whoever
 * prepares the files and listed in a manifest.
 */
export function unitGains(hierarchy, scheme, analysis) {
  const { levels, finest, base } = hierarchy;
  const gains = new Float64Array(scheme.units.length);
  gains[0] = Infinity;
  for (let l = base + 1; l <= finest; l++) {
    const level = levels[l], parent = levels[l - 1], exact = toRgb(analysis.values[l], level.count);
    const image = scheme.images[l], coarse = scheme.images[l - 1];
    const weight = 4 ** (finest - l), meanArea = 4 * Math.PI / level.count;
    for (const unit of scheme.units) {
      if (unit.level !== l) continue;
      let gain = 0;
      for (let y = unit.y0; y < unit.y1; y++) for (let x = unit.x0; x < unit.x1; x++) {
        const cell = (unit.chart * level.H + y) * level.W + x, p = cell * 3;
        const q = ((unit.chart * parent.H + (y >> 1)) * parent.W + (x >> 1)) * 3;
        let before = 0, after = 0;
        for (let c = 0; c < 3; c++) { before += (exact[p + c] - coarse[q + c]) ** 2; after += (exact[p + c] - image[p + c]) ** 2; }
        gain += (before - after) * level.areas[cell] / meanArea;
      }
      gains[unit.index] = gain * weight;
    }
  }
  return gains;
}

/** Coarse sphere first, then every level in turn, each in the order the units are stored. */
export function levelOrder(scheme) {
  return scheme.units.map(unit => unit.index).sort((a, b) => scheme.units[a].level - scheme.units[b].level || a - b);
}

/**
 * Greedy by error removed per byte. A unit becomes eligible when its parent
 * has been sent: required for a residual scheme, and kept for a replacement
 * scheme too, so the two differ in bytes, not in permitted orders.
 */
export function gainOrder(scheme, gains) {
  const children = scheme.units.map(() => []);
  for (const unit of scheme.units) if (unit.parent >= 0) children[unit.parent].push(unit.index);
  const order = [0], eligible = [...children[0]];
  while (eligible.length) {
    let best = 0;
    for (let k = 1; k < eligible.length; k++) {
      if (gains[eligible[k]] / scheme.units[eligible[k]].bytes > gains[eligible[best]] / scheme.units[eligible[best]].bytes) best = k;
    }
    const [unit] = eligible.splice(best, 1);
    order.push(unit);
    eligible.push(...children[unit]);
  }
  return order;
}

/**
 * For one view: the coarse sphere, then the units under the view level by
 * level, most-covered first, then everything else in level order. `touched`
 * is `unitsUnderRays` of the view. With `direct`, a replacement scheme skips
 * the levels between the coarse sphere and the finest under the view.
 */
export function viewOrder(scheme, touched, { direct = false, finest } = {}) {
  const inView = [...touched.keys()].filter(unit => !direct || scheme.units[unit].level === finest);
  inView.sort((a, b) => scheme.units[a].level - scheme.units[b].level || touched.get(b) - touched.get(a) || a - b);
  const seen = new Set([0, ...inView]);
  return [0, ...inView, ...levelOrder(scheme).filter(unit => !seen.has(unit))];
}

/**
 * The units held after each of `budgets` bytes of an order, as a byte per
 * unit, with the bytes actually used. Requests carry `overhead` bytes each.
 */
export function availabilityAt(scheme, order, budgets, overhead = 0) {
  const results = [];
  let sent = 0, next = 0;
  const arrived = new Uint8Array(scheme.units.length);
  for (const budget of budgets) {
    while (next < order.length && sent + scheme.units[order[next]].bytes + overhead <= budget) {
      sent += scheme.units[order[next]].bytes + overhead; arrived[order[next]] = 1; next++;
    }
    results.push({ budget, bytes: sent, units: next, available: usable(scheme, arrived) });
  }
  return results;
}

/** Arrived units a client can draw: in a residual scheme, those whose whole chain of parents has arrived. */
export function usable(scheme, arrived) {
  if (!scheme.residual) return Uint8Array.from(arrived);
  const available = new Uint8Array(arrived.length);
  // Units are stored coarse to fine, so a parent is settled before its children.
  for (const unit of scheme.units) available[unit.index] = arrived[unit.index] && (unit.parent < 0 || available[unit.parent]) ? 1 : 0;
  return available;
}

/** Decoded texture bytes a client holds for a set of units: four bytes a sample. */
export function residentBytes(hierarchy, scheme, available) {
  let samples = 0;
  for (const unit of scheme.units) {
    if (available[unit.index]) samples += (unit.chart < 0 ? hierarchy.charts : 1) * (unit.x1 - unit.x0) * (unit.y1 - unit.y0);
  }
  return samples * 4;
}
