/**
 * Perspective views of a panorama: the camera, its rays, and the fixed test
 * set. Yaw 0 looks along +Y (the image's forward); positive yaw turns right,
 * positive pitch looks up, roll turns the camera about its own axis.
 */
import { mulberry32, randomDirection } from "./random.mjs";
import { TO_LINEAR, tapLinear } from "./source.mjs";

const RAD = Math.PI / 180;
const TAU = 2 * Math.PI;

export function viewBasis({ yaw, pitch, roll = 0 }) {
  const cy = Math.cos(yaw * RAD), sy = Math.sin(yaw * RAD), cp = Math.cos(pitch * RAD), sp = Math.sin(pitch * RAD);
  const forward = [cp * sy, cp * cy, sp];
  const right0 = [cy, -sy, 0], up0 = [-sy * sp, -cy * sp, cp];
  const cr = Math.cos(roll * RAD), sr = Math.sin(roll * RAD);
  return {
    forward,
    right: right0.map((value, i) => value * cr + up0[i] * sr),
    up: up0.map((value, i) => value * cr - right0[i] * sr),
  };
}

/**
 * Unit rays of a `size` × `size` view with the given full field of view,
 * `supersample`² rays per pixel on a regular sub-grid, as Float32 triples in
 * pixel order (rows down, then the sub-grid).
 */
export function viewRays(view, size, fovDeg, supersample) {
  const { forward, right, up } = viewBasis(view);
  const half = Math.tan(fovDeg * RAD / 2), n = supersample;
  const rays = new Float32Array(size * size * n * n * 3);
  let at = 0;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
    const a = (2 * (px + (sx + 0.5) / n) / size - 1) * half, b = (1 - 2 * (py + (sy + 0.5) / n) / size) * half;
    const x = forward[0] + a * right[0] + b * up[0], y = forward[1] + a * right[1] + b * up[1], z = forward[2] + a * right[2] + b * up[2];
    const length = 1 / Math.sqrt(x * x + y * y + z * z);
    rays[at++] = x * length; rays[at++] = y * length; rays[at++] = z * length;
  }
  return rays;
}

/**
 * The view test set shared by every panorama: the horizon at six azimuths,
 * moderate looks up and down, steep looks, both poles, and twelve
 * orientations uniform over the sphere with random roll (seeded).
 */
export function standardViews(seed = 20261001) {
  const views = [];
  for (let k = 0; k < 6; k++) views.push({ id: `horizon-${k * 60}`, group: "horizon", yaw: k * 60, pitch: 0, roll: 0 });
  for (const pitch of [35, -35]) for (const yaw of [30, 150, 270]) views.push({ id: `mid-${pitch}-${yaw}`, group: "mid", yaw, pitch, roll: 0 });
  for (const pitch of [65, -65]) for (const yaw of [0, 180]) views.push({ id: `steep-${pitch}-${yaw}`, group: "steep", yaw, pitch, roll: 0 });
  for (const [pitch, yaw] of [[90, 0], [-90, 0], [80, 90], [-80, 270]]) views.push({ id: `pole-${pitch}-${yaw}`, group: "pole", yaw, pitch, roll: 0 });
  const random = mulberry32(seed), direction = [0, 0, 0];
  for (let k = 0; k < 12; k++) {
    randomDirection(random, direction);
    views.push({
      id: `random-${k}`, group: "random",
      yaw: Math.atan2(direction[0], direction[1]) / RAD, pitch: Math.asin(direction[2]) / RAD, roll: random() * 360,
    });
  }
  return views;
}

/**
 * Two views chosen from the panorama itself: where the picture is busiest and
 * where it is smoothest, by mean gradient of luma over the view, searched over
 * azimuths every 15° and pitches −45°…45°.
 */
export function contentViews(source, fovDeg) {
  const level = source.levels.find(candidate => candidate.width <= 768) ?? source.levels.at(-1);
  const { width, height, rgb } = level;
  const luma = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) luma[i] = 0.2126 * TO_LINEAR[rgb[i * 3]] + 0.7152 * TO_LINEAR[rgb[i * 3 + 1]] + 0.0722 * TO_LINEAR[rgb[i * 3 + 2]];
  const gradient = (u, v) => {
    const x = ((Math.floor(u * width) % width) + width) % width, y = Math.min(height - 2, Math.max(0, Math.floor(v * height)));
    const here = luma[y * width + x];
    return Math.abs(luma[y * width + (x + 1) % width] - here) + Math.abs(luma[(y + 1) * width + x] - here);
  };
  let busiest = null, smoothest = null;
  for (let pitch = -45; pitch <= 45; pitch += 15) for (let yaw = 0; yaw < 360; yaw += 15) {
    const rays = viewRays({ yaw, pitch }, 24, fovDeg, 1);
    let sum = 0;
    for (let r = 0; r < rays.length; r += 3) sum += gradient(0.5 + Math.atan2(rays[r], rays[r + 1]) / TAU, 0.5 - Math.asin(rays[r + 2]) / Math.PI);
    if (!busiest || sum > busiest.sum) busiest = { sum, yaw, pitch };
    if (!smoothest || sum < smoothest.sum) smoothest = { sum, yaw, pitch };
  }
  return [
    { id: "busiest", group: "busiest", yaw: busiest.yaw, pitch: busiest.pitch, roll: 0 },
    { id: "smoothest", group: "smoothest", yaw: smoothest.yaw, pitch: smoothest.pitch, roll: 0 },
  ];
}

/** Linear-light colours along rays, read straight from the source's full-resolution level. */
export function sampleSource(source, rays, out) {
  const level = source.levels[0];
  out.fill(0);
  for (let r = 0; r < rays.length; r += 3) {
    tapLinear(level, 0.5 + Math.atan2(rays[r], rays[r + 1]) / TAU, 0.5 - Math.asin(Math.max(-1, Math.min(1, rays[r + 2]))) / Math.PI, out, r);
  }
  return out;
}
