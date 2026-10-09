import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originals = [];
const poison = (target, names, message) => {
  for (const name of names) if (typeof target[name] === "function") {
    originals.push({ target, name, value: target[name] });
    target[name] = () => { throw new Error(message); };
  }
};
const mutations = ["appendFile", "chmod", "chown", "copyFile", "cp", "createWriteStream", "fchmod", "fchown", "fdatasync", "fsync", "ftruncate", "futimes", "link", "lchmod", "lchown", "lutimes", "mkdir", "mkdtemp", "open", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "write", "writeFile", "writev"];
try {
  poison(childProcess, ["exec", "execSync", "execFile", "execFileSync", "fork", "spawn", "spawnSync"], "Import started a process.");
  poison(fs, mutations.flatMap(name => [name, name + "Sync"]), "Import mutated the filesystem.");
  poison(fs.promises, mutations, "Import mutated the filesystem.");
  syncBuiltinESMExports();
  // These controls prove that broader launch/write entry points are poisoned.
  assert.throws(() => childProcess.execSync("fixture-only"), /started a process/);
  assert.throws(() => fs.writeFileSync("fixture-only", "unused"), /mutated the filesystem/);
  assert.throws(() => fs.promises.mkdir("fixture-only"), /mutated the filesystem/);
  const headless = await import("@foss-earth/research/headless-chrome");
  const output = await import("@foss-earth/research/output-directory");
  for (const name of ["openHeadlessChrome", "connectHeadlessChrome", "evaluate", "waitForExpression"]) assert.equal(typeof headless[name], "function");
  assert.equal(typeof output.newOutputDirectory, "function");
  process.stdout.write("Installed public Research helpers import with process launch/filesystem mutation APIs blocked.\n");
} finally {
  for (const { target, name, value } of originals.reverse()) target[name] = value;
  syncBuiltinESMExports();
}
