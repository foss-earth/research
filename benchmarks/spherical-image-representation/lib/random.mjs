/** A small seeded generator (mulberry32), so every random choice in the benchmark repeats exactly. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A direction uniform over the sphere. */
export function randomDirection(random, out) {
  const z = 2 * random() - 1, angle = 2 * Math.PI * random(), s = Math.sqrt(1 - z * z);
  out[0] = s * Math.cos(angle); out[1] = s * Math.sin(angle); out[2] = z;
  return out;
}
