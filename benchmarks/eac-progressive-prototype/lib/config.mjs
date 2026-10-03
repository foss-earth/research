/** Experiment configurations: config/default.json with one set's overrides on top. */
import { loadConfig } from "./paths.mjs";

/** Deep merge: objects merge key by key, anything else in `over` replaces `base`. */
export function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = merge(base?.[key], value);
  return out;
}

export const configWith = overrides => merge(loadConfig(), overrides ?? {});

/** The drawing buffer a configuration's viewport gives: CSS size times the device pixel ratio. */
export const viewportOf = config => ({ width: Math.round(config.viewport.cssWidth * config.viewport.devicePixelRatio), height: Math.round(config.viewport.cssHeight * config.viewport.devicePixelRatio), verticalFovDeg: config.viewport.verticalFovDeg });
