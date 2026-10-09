import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));

/**
 * Creates and returns a new folder for one run's output, under the gitignored
 * `build/` tree and named for the local time the run started:
 * `newOutputDirectory("validation", "panorama-campus")` →
 * `build/validation/panorama-campus/2026-09-26_174512/`. Two runs in the same
 * second get -2, -3…: every run is kept, none overwritten.
 */
export function newOutputDirectory(...where) {
  if (where.some(part => typeof part !== "string" || path.isAbsolute(part) || part.split(/[\\/]/).some(piece => piece === ".."))) throw new Error("Research output must remain inside this owner's build/.");
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // Inspect each existing component before creating the next. Recursive mkdir
  // would follow a pre-existing build/subpath symlink before we could reject it.
  const parts = ["build", ...where.flatMap(part => part.split(/[\\/]/)).filter(part => part && part !== ".")];
  let parent = root;
  for (const part of parts) {
    parent = path.join(parent, part);
    try {
      const entry = lstatSync(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error("Research output cannot follow a redirected directory.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(parent);
      if (realpathSync(parent) !== parent) throw new Error("Research output cannot follow a redirected directory.");
    }
  }
  for (let attempt = 1; ; attempt++) {
    const directory = path.join(parent, attempt === 1 ? stamp : `${stamp}-${attempt}`);
    try {
      mkdirSync(directory);
      if (realpathSync(directory) !== directory) throw new Error("Research output cannot follow a redirected directory.");
      return directory;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}
