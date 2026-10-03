/**
 * Scripted camera motion. The four traces are Phase 1's, with their timing
 * unchanged (../../spherical-image-representation/lib/traces.mjs); a trace is
 * a function of elapsed seconds, so a slow frame does not slow the camera.
 *
 * A start orientation is added to a trace's yaw and pitch, so the same motion
 * can begin facing a cube edge, a cube corner, the sky or the floor instead
 * of the middle of a face. The same starts are used for every candidate.
 */
import { TRACES } from "../../spherical-image-representation/lib/traces.mjs";

export { TRACES };
export const STARTS = [
  { id: "face-centre", description: "the middle of a cube face, as in Phase 1", yaw: 0, pitch: 0 },
  { id: "face-edge", description: "the edge between two faces", yaw: 45, pitch: 0 },
  { id: "cube-corner", description: "a corner where three faces meet", yaw: 45, pitch: 35.264 },
  { id: "off-axis", description: "aligned with neither a face nor a tile", yaw: 17, pitch: 9 },
  { id: "up", description: "looking steeply upward", yaw: 20, pitch: 70 },
  { id: "down", description: "looking steeply downward", yaw: 200, pitch: -70 },
];
const find = (list, id, what) => list.find(item => item.id === id) ?? (() => { throw new Error(`unknown ${what} ${id}; known: ${list.map(item => item.id).join(", ")}`); })();

/** `{ id, duration, at(seconds) → { yaw, pitch, roll } }` for a trace begun at a start orientation. */
export function cameraPath(traceId, startId = "face-centre") {
  const trace = find(TRACES, traceId, "trace"), start = find(STARTS, startId, "start");
  return {
    id: `${trace.id}@${start.id}`, trace: trace.id, start: start.id, duration: trace.duration, description: `${trace.description}; starting at ${start.description}`,
    at(seconds) {
      const { yaw, pitch } = trace.at(seconds);
      return { yaw: start.yaw + yaw, pitch: Math.max(-89.9, Math.min(89.9, start.pitch + pitch)), roll: 0 };
    },
  };
}
