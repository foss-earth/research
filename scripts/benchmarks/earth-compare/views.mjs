/** W0's authored camera targets. Heights and FOV must be measured, not guessed. */
export const VIEWS = Object.freeze([
  { id: "grand-canyon", latDeg: 36.1, lonDeg: -112.14, distanceMeters: 8000, tiltDeg: 55, headingDeg: 0 },
  { id: "umn-campus", latDeg: 44.976, lonDeg: -93.235, distanceMeters: 1500, tiltDeg: 60, headingDeg: 0 },
  { id: "manhattan", latDeg: 40.758, lonDeg: -73.9855, distanceMeters: 2000, tiltDeg: 65, headingDeg: 0 },
  { id: "ksfo-approach", latDeg: 37.61, lonDeg: -122.36, distanceMeters: 9000, tiltDeg: 80, headingDeg: 284 },
  // The public camera clamps to pitch89. Use the same supported 1deg tilt in both apps.
  { id: "orbit", latDeg: 30, lonDeg: -90, distanceMeters: 20000000, tiltDeg: 1, headingDeg: 0 },
].map(Object.freeze));

// Official web shortcuts, checked 2026-10-16. A documented shortcut does not
// prove the particular page accepted it; compare sampled camera paths too.
const source = "https://developers.google.com/maps/documentation/earth/use-keyboard-shortcuts";
export const MOTIONS = Object.freeze([
  { id: "pan", keys: [{ key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, modifiers: 0 }] },
  { id: "orbit", keys: [{ key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, modifiers: 8 }] },
  { id: "zoom", keys: [{ key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33, modifiers: 0 }] },
].map(motion => Object.freeze({
  ...motion, durationMs: 10000, shortcutVerified: true, shortcutSource: source,
  shortcutCheckedOn: "2026-10-16", keys: Object.freeze(motion.keys.map(Object.freeze)),
})));
