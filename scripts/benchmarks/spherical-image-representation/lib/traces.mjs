/** Scripted camera motion: where the person looks at each moment after entering a panorama. */

const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export const TRACES = [
  { id: "stationary", description: "enters and looks forward", duration: 10, at: () => ({ yaw: 0, pitch: 0 }) },
  { id: "slow-turn", description: "a full turn along the horizon in 20 s", duration: 20, at: t => ({ yaw: 18 * t, pitch: 0 }) },
  { id: "quick-turn", description: "looks forward for 2 s, turns 180° in 0.6 s, stays", duration: 10, at: t => ({ yaw: 180 * smooth((t - 2) / 0.6), pitch: 0 }) },
  { id: "explore", description: "turns steadily while looking up and down", duration: 16, at: t => ({ yaw: 22 * t + 30 * Math.sin(2 * Math.PI * t / 7), pitch: 40 * Math.sin(2 * Math.PI * t / 9) }) },
];
export const trace = id => TRACES.find(item => item.id === id);
