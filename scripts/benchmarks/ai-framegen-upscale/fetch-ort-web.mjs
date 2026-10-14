#!/usr/bin/env node
/**
 * Prepares the pinned ONNX Runtime Web build that the ai-framegen-upscale
 * browser harness serves: `npm pack` of the exact version named in
 * browser-dependencies.json, offline from the npm cache first, then the
 * tarball's sha512 is checked against the pinned integrity before anything is
 * extracted, the archive's entry list is checked (regular files and folders
 * under package/ only), it is extracted with tar, and the three files the page
 * loads are hashed and checked against their pins.
 *
 *   node scripts/benchmarks/ai-framegen-upscale/fetch-ort-web.mjs
 *     [--work=<research/build/...>] [--npm-cache=<research/build/...>]
 *     [--allow-network] [--record-pins]
 *
 * `--allow-network` lets npm fetch the tarball from registry.npmjs.org when the
 * offline pack fails (the integrity check still decides). `--record-pins` fills
 * file pins that are still null in browser-dependencies.json; it never replaces
 * a recorded pin, and a mismatch always fails.
 *
 * Writes <work>/ort-web/onnxruntime-web-<version>.tgz, the extraction in
 * <work>/ort-web/onnxruntime-web-<version>/package/ and
 * <work>/ort-web/receipt.json. A previous extraction is moved to
 * <work>/ort-web/superseded/<stamp>/, never deleted. Work folder: --work, else
 * $FOSS_EARTH_AI_FRAMEGEN_WORK, else research/build/benchmarks/ai-framegen-upscale/work.
 * npm runs with TMPDIR and caches under <work>/cache (lib/environment.mjs), except
 * npm_config_cache, which defaults to research/build/ai-framegen-upscale/cache/npm
 * (the cache that already holds the pinned tarball).
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRoot, insideBuild, repositoryRoot, scratchEnvironment, workDirectory } from "./lib/environment.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const pinsFile = path.join(here, "browser-dependencies.json");

function parseOptions(argv) {
  const options = {
    work: null,
    "npm-cache": path.join(buildRoot, "ai-framegen-upscale", "cache", "npm"),
    "allow-network": false, "record-pins": false,
  };
  for (const argument of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    if (!match || !(match[1] in options)) throw new Error(`unknown argument ${argument}; known: ${Object.keys(options).map(key => `--${key}`).join(" ")}`);
    options[match[1]] = typeof options[match[1]] === "boolean" ? (match[2] ?? "true") !== "false" : path.resolve(match[2] ?? "");
  }
  options.work = workDirectory(options.work);
  options["npm-cache"] = insideBuild(options["npm-cache"]);
  return options;
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sriSha512 = bytes => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const stamp = () => new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");

/** Child processes keep their caches and temporary files inside research/build/. */
function childEnvironment(work, npmCache) {
  const scratch = scratchEnvironment(work);
  mkdirSync(scratch.TMPDIR, { recursive: true });
  return {
    ...process.env, ...scratch, npm_config_cache: npmCache, npm_config_update_notifier: "false",
    npm_config_audit: "false", npm_config_fund: "false", npm_config_ignore_scripts: "true",
  };
}

/** `npm pack <name>@<version>` into an empty folder; returns the tarball path and how it was obtained. */
async function pack(pins, options, downloadDirectory, environment) {
  const spec = `${pins.package.name}@${pins.package.version}`;
  const attempts = [{ method: "npm pack --offline (npm cache)", args: ["--offline"] }];
  if (options["allow-network"]) attempts.push({ method: "npm pack (registry.npmjs.org, read-only fetch)", args: ["--prefer-online"] });
  const failures = [];
  for (const attempt of attempts) {
    try {
      // cwd is the empty download folder, so no project .npmrc or package.json is read.
      const { stdout } = await execFileAsync("npm", ["pack", spec, ...attempt.args, "--json", "--pack-destination", downloadDirectory],
        { cwd: downloadDirectory, env: environment, maxBuffer: 16 << 20 });
      const [report] = JSON.parse(stdout);
      return { file: path.join(downloadDirectory, report.filename), method: attempt.method, npmReport: { id: report.id, integrity: report.integrity, shasum: report.shasum, size: report.size, entryCount: report.entryCount } };
    } catch (error) {
      failures.push(`${attempt.method}: ${String(error.stderr || error.message).trim().split("\n").slice(-3).join(" | ")}`);
    }
  }
  throw new Error(`npm pack failed:\n  ${failures.join("\n  ")}${options["allow-network"] ? "" : "\n  (rerun with --allow-network to let npm fetch the pinned tarball from registry.npmjs.org)"}`);
}

/** Lists the archive and refuses anything but regular files and folders below package/. */
async function checkEntries(tarball) {
  const { stdout: names } = await execFileAsync("tar", ["-tzf", tarball], { maxBuffer: 64 << 20 });
  const { stdout: long } = await execFileAsync("tar", ["-tvzf", tarball], { maxBuffer: 64 << 20 });
  const entries = names.split("\n").filter(Boolean);
  const bad = entries.filter(name => !name.startsWith("package/") || path.isAbsolute(name) || name.split("/").includes(".."));
  const types = long.split("\n").filter(Boolean).map(line => line[0]);
  const special = types.filter(type => type !== "-" && type !== "d");
  if (bad.length || special.length || types.length !== entries.length) throw new Error(`refusing archive: ${bad.length} entries outside package/, ${special.length} links or special files`);
  return entries.length;
}

const options = parseOptions(process.argv.slice(2));
const pins = JSON.parse(readFileSync(pinsFile, "utf8"));
const root = path.join(options.work, "ort-web");
const name = `${pins.package.name}-${pins.package.version}`;
const tarball = path.join(root, `${name}.tgz`);
const extracted = path.join(root, name);
mkdirSync(root, { recursive: true });
const environment = childEnvironment(options.work, options["npm-cache"]);

let obtained;
if (existsSync(tarball) && sriSha512(readFileSync(tarball)) === pins.package.integrity) {
  obtained = { method: "existing tarball in work/ort-web (integrity re-checked)" };
} else {
  if (existsSync(tarball)) {
    const aside = path.join(root, "superseded", stamp());
    mkdirSync(aside, { recursive: true });
    renameSync(tarball, path.join(aside, path.basename(tarball)));
    console.log(`moved a tarball with the wrong integrity to ${path.relative(repositoryRoot, aside)}`);
  }
  const download = path.join(environment.TMPDIR, `ort-web-download-${stamp()}-${process.pid}`);
  mkdirSync(download);
  obtained = await pack(pins, options, download, environment);
  renameSync(obtained.file, tarball);
}
const bytes = readFileSync(tarball);
const integrity = sriSha512(bytes);
if (integrity !== pins.package.integrity) throw new Error(`integrity mismatch for ${tarball}: ${integrity} != pinned ${pins.package.integrity}`);
console.log(`${name}.tgz: integrity matches the pin (${bytes.length} bytes, ${obtained.method})`);

const entryCount = await checkEntries(tarball);
const hashServed = directory => pins.files.map(file => {
  const content = readFileSync(path.join(directory, file.path));
  return { ...file, bytes: content.length, sha256: sha256(content), pinned: file.sha256 };
});
const pinned = file => file.pinned !== null && file.pinned === file.sha256 && pins.files.find(pin => pin.path === file.path).bytes === file.bytes;
if (existsSync(extracted) && pins.files.every(file => existsSync(path.join(extracted, file.path))) && hashServed(extracted).every(pinned)) {
  console.log(`${path.relative(repositoryRoot, extracted)}: the three served files already match their pins; kept`);
  writeReceipt(hashServed(extracted), { reusedExtraction: true });
  process.exit(0);
}
const fresh = path.join(root, `extract-${stamp()}-${process.pid}`);
mkdirSync(fresh);
await execFileAsync("tar", ["-xzf", tarball, "-C", fresh, "--no-same-owner", "--no-same-permissions"], { maxBuffer: 16 << 20 });
const files = hashServed(fresh);
const mismatched = files.filter(file => file.pinned !== null && !pinned(file));
if (mismatched.length) throw new Error(`file pins differ: ${mismatched.map(file => `${file.path} ${file.sha256}`).join(", ")}`);
const unpinned = files.filter(file => file.pinned === null);
if (unpinned.length && !options["record-pins"]) throw new Error(`files without pins (rerun with --record-pins once): ${unpinned.map(file => file.path).join(", ")}`);
if (unpinned.length) {
  for (const pin of pins.files) {
    const file = files.find(entry => entry.path === pin.path);
    if (pin.sha256 === null) Object.assign(pin, { bytes: file.bytes, sha256: file.sha256 });
  }
  writeFileSync(pinsFile, `${JSON.stringify(pins, null, 2)}\n`);
  console.log(`recorded ${unpinned.length} file pins in ${path.relative(repositoryRoot, pinsFile)}`);
}
if (existsSync(extracted)) {
  const aside = path.join(root, "superseded", stamp());
  mkdirSync(aside, { recursive: true });
  renameSync(extracted, path.join(aside, name));
}
renameSync(fresh, extracted);
writeReceipt(files, { reusedExtraction: false });

function writeReceipt(served, extra) {
  let npmVersion = null;
  try { npmVersion = execFileSync("npm", ["--version"], { cwd: root, env: environment, encoding: "utf8" }).trim(); } catch { /* recorded as null */ }
  const script = fileURLToPath(import.meta.url);
  const receipt = {
    schema: 1, package: pins.package.name, version: pins.package.version,
    tarball: { file: path.relative(repositoryRoot, tarball), bytes: bytes.length, integrity, sha256: sha256(bytes), entryCount },
    obtained, ...extra, npm: npmVersion, node: process.version,
    extracted: path.relative(repositoryRoot, extracted),
    served: served.map(({ path: file, served: url, contentType, bytes: size, sha256: hash }) => ({ path: file, served: url, contentType, bytes: size, sha256: hash })),
    pins: { file: path.relative(repositoryRoot, pinsFile), sha256: sha256(readFileSync(pinsFile)) },
    script: { path: path.relative(repositoryRoot, script), sha256: sha256(readFileSync(script)) },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path.join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  for (const file of served) console.log(`  ${file.served}  ${file.bytes} B  sha256 ${file.sha256}`);
  console.log(`wrote ${path.relative(repositoryRoot, path.join(root, "receipt.json"))}`);
}
