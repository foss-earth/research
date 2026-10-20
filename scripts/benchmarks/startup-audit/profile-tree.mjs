// The call tree under a function in a CPU profile that profile.mjs saved, mapped through the build's source maps.
//
//   node scripts/benchmarks/startup-audit/profile-tree.mjs --profile <file.cpuprofile> --root <dist> [--base /]
//     --focus "createFlightSimApp.ts:2472" [--depth 4] [--min 2]
//
// --focus matches the "name file:line" key profile.mjs prints, as a substring. Times are ms per second of the
// profile, inclusive, summed over every call of the focus (each sample counted once even under recursion).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SourceMapConsumer } from 'source-map-js';

const { values: args } = parseArgs({ options: {
  profile: { type: 'string' }, root: { type: 'string' }, base: { type: 'string', default: '/' },
  focus: { type: 'string' }, depth: { type: 'string', default: '4' }, min: { type: 'string', default: '2' },
} });
const profile = JSON.parse(await readFile(args.profile, 'utf8'));
const root = path.resolve(args.root);
const consumers = new Map();
async function consumerFor(scriptUrl) {
  if (consumers.has(scriptUrl)) return consumers.get(scriptUrl);
  let consumer = null;
  try {
    const { pathname } = new URL(scriptUrl);
    if (pathname.startsWith(args.base)) {
      const file = path.join(root, decodeURIComponent(pathname.slice(args.base.length)));
      if (existsSync(`${file}.map`)) consumer = new SourceMapConsumer(JSON.parse(await readFile(`${file}.map`, 'utf8')));
    }
  } catch { /* Not a page script. */ }
  consumers.set(scriptUrl, consumer);
  return consumer;
}
const shortSource = source => {
  const clean = source.replace(/^(\.\.\/)+/, '');
  const modules = clean.lastIndexOf('node_modules/');
  if (modules >= 0) return clean.slice(modules + 'node_modules/'.length);
  const gh = clean.indexOf('gh/');
  return gh >= 0 ? clean.slice(gh + 3) : clean;
};
async function keyOf(frame) {
  if (!frame.url) return `(${frame.functionName || 'native'})`;
  const consumer = await consumerFor(frame.url);
  if (!consumer) return `${frame.functionName || '(anonymous)'} ${frame.url.replace(/^https?:\/\/[^/]+/, '')}`;
  const position = consumer.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
  return `${position.name ?? frame.functionName ?? '(anonymous)'} ${position.source ? shortSource(position.source) : frame.url}:${position.line ?? '?'}`;
}
const keys = new Map();
for (const node of profile.nodes) keys.set(node.id, await keyOf(node.callFrame));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const seconds = (profile.endTime - profile.startTime) / 1e6;
// Each sample's stack, root first, as keys.
const tree = { key: args.focus, total: 0, children: new Map() };
for (let index = 0; index < profile.samples.length; index += 1) {
  const delta = (profile.timeDeltas[index + 1] ?? 0) / 1000;
  const stack = [];
  for (let at = profile.samples[index]; at !== undefined; at = parent.get(at)) stack.push(keys.get(at));
  stack.reverse();
  const start = stack.findIndex(key => key.includes(args.focus));
  if (start < 0) continue;
  tree.total += delta;
  let node = tree;
  const seen = new Set([stack[start]]);
  for (let at = start + 1; at < stack.length && at <= start + Number(args.depth); at += 1) {
    if (seen.has(stack[at]) && stack[at].includes(args.focus)) break;
    let child = node.children.get(stack[at]);
    if (!child) node.children.set(stack[at], child = { key: stack[at], total: 0, children: new Map() });
    child.total += delta;
    node = child;
  }
}
const min = Number(args.min);
const print = (node, indent) => {
  console.log(`${(node.total / seconds).toFixed(1).padStart(7)} ms/s  ${'  '.repeat(indent)}${node.key}`);
  for (const child of [...node.children.values()].sort((a, b) => b.total - a.total)) if (child.total / seconds >= min) print(child, indent + 1);
};
print(tree, 0);
