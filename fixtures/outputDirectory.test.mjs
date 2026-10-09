import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { newOutputDirectory } from "../scripts/lib/outputDirectory.mjs";

const build = fileURLToPath(new URL("../build/", import.meta.url));

test("output refuses an existing redirected component before writing its target", () => {
  const fixture = newOutputDirectory("source-helper-cases", "redirect");
  const target = path.join(fixture, "target");
  mkdirSync(target);
  symlinkSync(target, path.join(fixture, "redirect"), "dir");
  assert.throws(() => newOutputDirectory(path.relative(build, fixture), "redirect", "must-not-exist"), /redirected directory/);
  assert.deepEqual(readdirSync(target), []);
  // Evidence, including the synthetic symlink, is retained under owner build.
});

test("dated output preserves earlier evidence and creates a distinct directory", () => {
  const fixture = newOutputDirectory("source-helper-cases", "collision");
  const relative = path.relative(build, fixture);
  const first = newOutputDirectory(relative, "runs");
  writeFileSync(path.join(first, "evidence.txt"), "retain these exact bytes\n");
  const second = newOutputDirectory(relative, "runs");
  assert.notEqual(second, first);
  assert.equal(readFileSync(path.join(first, "evidence.txt"), "utf8"), "retain these exact bytes\n");
  assert.deepEqual(readdirSync(second), []);
});

test("output rejects traversal and absolute paths before creating an output", () => {
  assert.throws(() => newOutputDirectory("../outside"), /inside this owner's build/);
  assert.throws(() => newOutputDirectory(path.resolve(build)), /inside this owner's build/);
});
