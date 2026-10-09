import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const owner = "research", required = {"@foss-earth/research": "0.1.0", "typescript": "5.9.3", "@types/node": "24.12.4"};
const closureName = process.env.RESEARCH_CONSUMER_ARCHIVES;
assert.ok(closureName, "RESEARCH_CONSUMER_ARCHIVES must name the exact archive closure JSON; this harness packs no source or ancestor dependency.");
const closureFile = path.resolve(closureName), closure = JSON.parse(readFileSync(closureFile, "utf8"));
assert.equal(closure.version, 1); assert.ok(Array.isArray(closure.packages) && closure.packages.length > 0);
const supplied = new Map(), archives = {}, dependencies = {}, sealedArchives = [];
for (const record of closure.packages) {
  assert.match(record.name ?? "", /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
  assert.ok(!supplied.has(record.name), `Duplicate closure package: ${record.name}`);
  assert.match(record.version ?? "", /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  assert.match(record.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0);
  assert.equal(typeof record.archive, "string");
  const archive = realpathSync(path.resolve(path.dirname(closureFile), record.archive));
  const bytes = readFileSync(archive); assert.equal(bytes.length, record.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256, `Archive pin: ${record.name}`);
  supplied.set(record.name, record); sealedArchives.push({ record, bytes });
  archives[record.name] = { version: record.version, sha256: record.sha256, bytes: record.bytes };
}
for (const [name, version] of Object.entries(required)) assert.equal(supplied.get(name)?.version, version, `Required exact fixture prerequisite: ${name}`);
const build = path.join(root, "build"); mkdirSync(build, { recursive: true });
assert.equal(realpathSync(build), build, "Owner build cannot redirect to another tree.");
const parent = path.join(build, "consumer"), cache = path.join(build, "npm-cache");
for (const directory of [parent, cache]) { mkdirSync(directory, { recursive: true }); assert.equal(realpathSync(directory), directory, "Owner output/cache cannot redirect to another tree."); }
const output = path.join(parent, new Date().toISOString().replace(/[:.]/g, "-"));
assert.ok(!existsSync(output), "Each consumer run needs a fresh retained output."); mkdirSync(output);
const workspace = path.join(output, "workspace"), temp = path.join(output, "tmp");
mkdirSync(workspace); mkdirSync(temp);
const artifactRoot = path.join(output, "artifacts"); mkdirSync(artifactRoot);
for (const [index, { record, bytes }] of sealedArchives.entries()) {
  const snapshot = path.join(artifactRoot, `${String(index).padStart(2, "0")}.tgz`);
  writeFileSync(snapshot, bytes, { flag: "wx" });
  dependencies[record.name] = `file:${snapshot}`;
  archives[record.name].archive = path.relative(output, snapshot);
}
writeFileSync(path.join(output, "input-closure.json"), JSON.stringify(closure, null, 2) + "\n");
writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: `${owner}-installed-fixture`, version: "1.0.0", private: true, type: "module", dependencies }, null, 2));
const run = (command, argv, log, extraEnv = {}) => {
  const env = { ...process.env, TMPDIR: temp }; delete env.NODE_PATH; delete env.NODE_OPTIONS; delete env.CONSUMER_FORBID_PEERS;
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
  Object.assign(env, extraEnv);
  const filename = path.join(output, log), fd = openSync(filename, "wx"); let result;
  try { result = spawnSync(command, argv, { cwd: workspace, env, stdio: ["ignore", fd, fd] }); } finally { closeSync(fd); }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Installed consumer failed; inspect ${filename}`);
  return readFileSync(filename, "utf8");
};
for (const [index, { record }] of sealedArchives.entries()) {
  const snapshot = path.join(output, archives[record.name].archive);
  const metadata = JSON.parse(run("tar", ["-xOf", snapshot, "package/package.json"], `archive-${String(index).padStart(2, "0")}.log`));
  assert.equal(metadata.name, record.name, `Pinned archive identity: ${record.name}`);
  assert.equal(metadata.version, record.version, `Pinned archive version: ${record.name}`);
  assert.ok(![metadata.bundleDependencies, metadata.bundledDependencies].some(value => value === true || Array.isArray(value) && value.length > 0), `Bundled archive closure is unqualified: ${record.name}`);
  for (const group of [metadata.dependencies, metadata.optionalDependencies, metadata.peerDependencies]) for (const [name, version] of Object.entries(group ?? {})) {
    assert.equal(typeof version, "string");
    assert.ok(!/^(?:file:|link:|workspace:|npm:|git(?:\+|:)|https?:|ssh:|\/|\.\.?[/\\])/.test(version), `External or aliased dependency source is unqualified: ${record.name}/${name}`);
  }
}
run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache, "--prefix", workspace], "install.log");
const workspaceReal = realpathSync(workspace) + path.sep, installedNames = new Set();
function inventory(directory, scope = "") {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (item.name.startsWith(".")) continue;
    const candidate = path.join(directory, item.name);
    if (item.name.startsWith("@")) { inventory(candidate, item.name); continue; }
    const manifestFile = path.join(candidate, "package.json");
    if (!existsSync(manifestFile)) continue;
    assert.ok(realpathSync(candidate).startsWith(workspaceReal), "Installed package cannot link to old source.");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const requestedName = scope ? `${scope}/${item.name}` : item.name;
    assert.equal(manifest.name, requestedName, `Archive identity must match its requested installation name: ${requestedName}`);
    const expected = supplied.get(requestedName);
    assert.ok(expected, `Unpinned transitive dependency: ${manifest.name}`);
    assert.equal(manifest.version, expected.version, `Installed exact version: ${manifest.name}`); installedNames.add(manifest.name);
    assert.ok(![manifest.bundleDependencies, manifest.bundledDependencies].some(value => value === true || Array.isArray(value) && value.length > 0), `Bundled package closure is unqualified: ${manifest.name}`);
    const nested = path.join(candidate, "node_modules");
    assert.ok(!existsSync(nested), `Nested package locations are unqualified; supply a flat exact one-version closure: ${manifest.name}`);
  }
}
inventory(path.join(workspace, "node_modules"));
for (const name of supplied.keys()) assert.ok(installedNames.has(name), `Declared archive not installed: ${name}`);
writeFileSync(path.join(workspace, "guard.mjs"), `import { registerHooks } from "node:module";import { realpathSync } from "node:fs";import { fileURLToPath } from "node:url";import path from "node:path";
const root=realpathSync(process.cwd())+path.sep;
registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(result.url.startsWith("node:"))return result;if(!result.url.startsWith("file:"))throw new Error("UNSUPPORTED_MODULE_PROTOCOL");const resolved=realpathSync(fileURLToPath(result.url));if(!resolved.startsWith(root))throw new Error("OUTSIDE_ISOLATED_WORKSPACE");if(process.env.CONSUMER_FORBID_PEERS==="1"&&/[/\\\\]node_modules[/\\\\](?:@foss-earth[/\\\\](?:ui|engine|renderer|sky|scenes|360)|react(?:-dom)?)(?:[/\\\\]|$)/.test(resolved))throw new Error("PURE_IMPORTED_PEER");return result;}});`);
for (const fixture of ["minimal.mjs", "output.mjs"]) {
  writeFileSync(path.join(workspace, fixture), readFileSync(path.join(root, "fixtures", "consumer", fixture)));
  run(process.execPath, ["--import", "./guard.mjs", fixture], fixture.replace(/\.mjs$/, "") + ".log", fixture === "minimal.mjs" ? { CONSUMER_FORBID_PEERS: "1" } : {});
}
writeFileSync(path.join(output, "outside.mjs"), "export const outside=true;\n");
writeFileSync(path.join(workspace, "negative.mjs"), `import assert from "node:assert/strict";await assert.rejects(import(${JSON.stringify(path.join(output, "outside.mjs"))}), /OUTSIDE_ISOLATED_WORKSPACE/);`);
run(process.execPath, ["--import", "./guard.mjs", "negative.mjs"], "isolation-negative.log");
// A synthetic feature-shaped path proves that the pure-peer guard rejects it;
// it is fixture data under control/, not an installed or supplied package.
const peerControl = path.join(workspace, "control", "node_modules", "@foss-earth", "engine");
mkdirSync(peerControl, { recursive: true });
writeFileSync(path.join(peerControl, "probe.mjs"), "export const fixture=true;\n");
writeFileSync(path.join(workspace, "peer-negative.mjs"), `import assert from "node:assert/strict";await assert.rejects(import(${JSON.stringify(path.join(peerControl,"probe.mjs"))}), /PURE_IMPORTED_PEER/);`);
run(process.execPath, ["--import", "./guard.mjs", "peer-negative.mjs"], "peer-negative.log", { CONSUMER_FORBID_PEERS: "1" });
writeFileSync(path.join(workspace, "public.ts"), readFileSync(path.join(root, "fixtures", "consumer", "minimal.ts")));
writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: false, target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2023", "DOM", "DOM.Iterable"], types: ["node"], incremental: true, tsBuildInfoFile: "node_modules/.tmp/consumer.tsbuildinfo" }, files: ["public.ts"] }, null, 2));
const trace = run(process.execPath, ["--import", "./guard.mjs", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--traceResolution"], "public-types.log");
for (const match of trace.matchAll(/successfully resolved to '([^']+)'/g)) assert.ok(realpathSync(match[1]).startsWith(workspaceReal), `Declaration resolution escaped: ${match[1]}`);
writeFileSync(path.join(workspace, "declarations.mjs"), `import ts from "typescript";import assert from "node:assert/strict";import {realpathSync} from "node:fs";import path from "node:path";const root=realpathSync(process.cwd())+path.sep;const config=ts.readConfigFile("tsconfig.json",ts.sys.readFile);assert(!config.error);const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd());assert.equal(parsed.errors.length,0);const program=ts.createProgram(parsed.fileNames,parsed.options);for(const file of program.getSourceFiles())assert(realpathSync(file.fileName).startsWith(root),"DECLARATION_OUTSIDE_WORKSPACE");`);
run(process.execPath, ["--import", "./guard.mjs", "declarations.mjs"], "declaration-closure.log");
writeFileSync(path.join(output, "outside-types.d.ts"), "declare const outsideFixture: unique symbol;\n");
writeFileSync(path.join(workspace, "negative-public.ts"), '/// <reference path="../outside-types.d.ts" />\n');
writeFileSync(path.join(workspace, "negative-declarations.mjs"), `import ts from "typescript";import assert from "node:assert/strict";import {realpathSync} from "node:fs";import path from "node:path";const root=realpathSync(process.cwd())+path.sep;const program=ts.createProgram(["negative-public.ts"],{noEmit:true,types:[]});assert.throws(()=>{for(const file of program.getSourceFiles())assert(realpathSync(file.fileName).startsWith(root),"DECLARATION_OUTSIDE_WORKSPACE");},/DECLARATION_OUTSIDE_WORKSPACE/);`);
run(process.execPath, ["--import", "./guard.mjs", "negative-declarations.mjs"], "declaration-negative.log");
const manifest = JSON.parse(readFileSync(path.join(workspace, "node_modules", "@foss-earth", owner, "package.json"), "utf8"));
assert.equal(manifest.name, "@foss-earth/research");
assert.equal(manifest.version, required["@foss-earth/research"]);
function exportFiles(value) { if (typeof value === "string") { assert.ok(value.startsWith("./")); const filename = path.join(workspace, "node_modules", "@foss-earth", owner, value); assert.ok(realpathSync(filename).startsWith(workspaceReal)); assert.ok(readFileSync(filename).length); } else if (value && typeof value === "object") for (const child of Object.values(value)) exportFiles(child); }
exportFiles(manifest.exports);
const receipt = { status: "isolated-installed-consumer-passed", package: manifest.name, version: manifest.version, archives, exports: Object.keys(manifest.exports), checks: ["exact complete retained archive snapshots and requested manifest identity", "offline no source packing", "exact installed transitive versions", "realpath runtime/declaration isolation", "outside runtime/declaration and synthetic pure peer negative controls", "public development helpers import with process launch/filesystem mutation APIs blocked", "public output helper redirected-path and retained-output cases", "strict positional public helper declaration check"], environment: { node: process.version, platform: process.platform, architecture: process.arch }, limitations: ["No browser/GPU/hardware qualification", "Lineage/shared conformance/full intended refs/actual app adoption/remote admission remain separate"] };
writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify({ output, receipt }) + "\n");
