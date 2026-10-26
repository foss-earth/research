// Per-pair numbers for an interleaved A/B of profile.mjs runs, recomputed from each stretch's saved CPU profile instead
// of read from summary.md, so a function outside summary.md's top 45 still has a number, and one that did not run is
// "absent", never 0.
//
//   node scripts/benchmarks/startup-audit/ab-summary.mjs --label <name> [--runs <research>/build/ab/runs.jsonl]
//   node scripts/benchmarks/startup-audit/ab-summary.mjs --legacy <runs.txt> --label <name>   # lines "<label> <arm> <dir>"
//   node scripts/benchmarks/startup-audit/ab-summary.mjs --run <arm>=<dir> --run <arm>=<dir> ...   # in run order
//     [--metric <kind>:<matcher>]... [--rates 1,4] [--skip <seq>,...] [--include-contaminated] [--movers 12]
//     [--basis wall|profile] [--json]
//
// The runs come from ab.mjs's build/ab/runs.jsonl, paired by its pair numbers, or from an earlier runs.txt or the
// command line, where consecutive runs pair up (1–2, 3–4, …). A is the first run's arm. A pair is dropped, with a note,
// when either run is invalid, ran alongside another measurement process (unless --include-contaminated) or is named by
// --skip. For each CPU rate, each row gives both arms' values pair by pair, the change B − A, both ranges and a verdict:
// "B lower in every pair" or "B higher in every pair", with ", ranges disjoint" when no value of one arm reaches the
// other's; otherwise "mixed".
//
// Functions and files are named exactly as profile.mjs names them, through the source maps under the run's root, which
// summary.md's header gives with the target. --basis wall (the default) is profile.mjs's arithmetic: each sample owns
// the interval to the next, per second of the stretch's wall time. --basis profile is profile-tree.mjs's: the last
// sample owns nothing, per second of the profile's own span. Inclusive time counts a sample once however often its
// stack holds the function, and profiled busy time is every sample but V8's idle.
//
// --metric adds a row. Kinds: self and inc (a function's self and inclusive time), file and incfile (a file's).
// Matchers: name@file (that name exactly, in a file whose path contains the text, any line), name@file:line, /regex/
// (on the key, or on the file for the file kinds) and plain text (a substring of the key or file). When several keys
// match, self and file add them up and inc and incfile count each sample once; a name@file that matches two functions
// is an error. --movers lists the functions that changed most between the arms, grouped by name and file without the
// line, so a function whose line moved still pairs up.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SourceMapConsumer } from 'source-map-js';
import { redact } from './perf-lock.mjs';

const RESEARCH = fileURLToPath(new URL('../../../', import.meta.url));
export const DEFAULT_RUNS = path.join(RESEARCH, 'build', 'ab', 'runs.jsonl');
// Where profile.mjs serves each target (its TARGETS), so that a script URL maps to a file under the run's root.
export const TARGET_BASES = { tour: '/tour/', app: '/app/', fly: '/' };
// V8's idle and root nodes as profile.mjs names them: a frame without a URL has its name in parentheses.
const IDLE = '((idle))', ROOT = '((root))';
const KINDS = ['self', 'inc', 'file', 'incfile'];
const USAGE = `Usage:
  node scripts/benchmarks/startup-audit/ab-summary.mjs --label <name> [--runs <runs.jsonl>]
  node scripts/benchmarks/startup-audit/ab-summary.mjs --legacy <runs.txt> --label <name>
  node scripts/benchmarks/startup-audit/ab-summary.mjs --run <arm>=<dir> --run <arm>=<dir> ...
    [--metric <kind>:<matcher>]... [--rates 1,4] [--skip <seq>,...] [--include-contaminated] [--movers 12]
    [--basis wall|profile] [--json]`;

/** A refused or failed operation (exit 1) or a usage error (exit 2); the message says what to do next. */
export class SummaryError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
const usage = message => new SummaryError(message, 2);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const ticked = keys => keys.map(key => `\`${key}\``).join(', ');

/** A readable source path: node_modules/<package>/… or the checkout's path from ~/gh (profile.mjs's shortSource). */
export const shortSource = source => {
  if (!source) return null;
  const clean = source.replace(/^(\.\.\/)+/, '').replace(/^webpack:\/\//, '');
  const modules = clean.lastIndexOf('node_modules/');
  if (modules >= 0) return clean.slice(modules + 'node_modules/'.length);
  const gh = clean.indexOf('gh/');
  return gh >= 0 ? clean.slice(gh + 3) : clean;
};

/**
 * profile.mjs's consumerFor and describe for one run root: each script URL under the target's base maps to a file under
 * root, whose .map sits beside it. Each description adds to profile.mjs's key and file the key's name, its line and its
 * group (the key without the line). `unmapped` and `missing` collect the page's own scripts that had no map beside them
 * or were not under the root at all (a root rebuilt or moved since the run).
 */
export function describer(root, base, origin = null) {
  const consumers = new Map(), unmapped = new Set(), missing = new Set();
  async function consumerFor(scriptUrl) {
    if (consumers.has(scriptUrl)) return consumers.get(scriptUrl);
    let consumer = null;
    try {
      const { pathname, origin: from } = new URL(scriptUrl);
      if (pathname.startsWith(base)) {
        const file = path.join(root, decodeURIComponent(pathname.slice(base.length)));
        if (existsSync(`${file}.map`)) consumer = new SourceMapConsumer(JSON.parse(await readFile(`${file}.map`, 'utf8')));
        else if (/\.m?js$/.test(file) && (origin === null || from === origin)) (existsSync(file) ? unmapped : missing).add(file);
      }
    } catch { /* Not a page script. */ }
    consumers.set(scriptUrl, consumer);
    return consumer;
  }
  async function describe(frame) {
    if (!frame.url) {
      const key = `(${frame.functionName || 'native'})`;
      return { key, file: key, name: key, line: null, group: key };
    }
    const consumer = await consumerFor(frame.url);
    if (!consumer) {
      const file = frame.url.replace(/^https?:\/\/[^/]+/, ''), name = frame.functionName || '(anonymous)';
      return { key: `${name} ${file}`, file, name, line: null, group: `${name} ${file}` };
    }
    const position = consumer.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
    const file = shortSource(position.source) ?? frame.url;
    const name = position.name ?? frame.functionName ?? '(anonymous)';
    const line = String(position.line ?? '?');
    return { key: `${name} ${file}:${line}`, file, name, line, group: `${name} ${file}` };
  }
  return { describe, unmapped, missing };
}

/** Adds a sample's time to `name` unless this sample already counted it. */
const once = (seen, totals, name, delta) => {
  if (seen.has(name)) return;
  seen.add(name);
  totals.set(name, (totals.get(name) ?? 0) + delta);
};

/**
 * One profile's time in ms by key, file and group, self and inclusive, accumulated in profile.mjs's order. On the wall
 * basis a sample owns `(timeDeltas[i + 1] ?? timeDeltas[i] ?? 0) / 1000` ms and `seconds` is the stretch's wall time
 * (profile.mjs); on the profile basis it owns `(timeDeltas[i + 1] ?? 0) / 1000` and `seconds` is the profile's span
 * (profile-tree.mjs). `busy` is every sample but V8's idle node. `union(hit)` is the time of the samples whose stack
 * holds a frame whose description `hit` accepts, each sample counted once.
 */
export async function attribute(profile, describe, { basis = 'wall', wall } = {}) {
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const described = new Map(), entries = new Map();
  for (const node of profile.nodes) {
    const each = await describe(node.callFrame);
    described.set(node.id, each);
    if (!entries.has(each.key)) entries.set(each.key, each);
  }
  const self = new Map(), selfFile = new Map(), selfGroup = new Map();
  const inclusive = new Map(), inclusiveFile = new Map(), inclusiveGroup = new Map();
  const deltas = new Float64Array(profile.samples.length);
  let total = 0, idle = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = basis === 'profile' ? (profile.timeDeltas[index + 1] ?? 0) / 1000
      : (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000;
    deltas[index] = delta;
    const id = profile.samples[index];
    const { key, file, group } = described.get(id);
    total += delta;
    if (key === IDLE) idle += delta;
    self.set(key, (self.get(key) ?? 0) + delta);
    selfFile.set(file, (selfFile.get(file) ?? 0) + delta);
    selfGroup.set(group, (selfGroup.get(group) ?? 0) + delta);
    const seenKeys = new Set(), seenFiles = new Set(), seenGroups = new Set();
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const each = described.get(at);
      once(seenKeys, inclusive, each.key, delta);
      once(seenFiles, inclusiveFile, each.file, delta);
      once(seenGroups, inclusiveGroup, each.group, delta);
    }
  }
  const union = hit => {
    // Whether a node's stack holds a hit, remembered for every node walked on the way to the answer.
    const covered = new Map();
    let sum = 0;
    for (let index = 0; index < profile.samples.length; index += 1) {
      const walked = [];
      let value = false;
      for (let at = profile.samples[index]; at !== undefined; at = parent.get(at)) {
        if (covered.has(at)) { value = covered.get(at); break; }
        walked.push(at);
        if (hit(described.get(at))) { value = true; break; }
      }
      for (const at of walked) covered.set(at, value);
      if (value) sum += deltas[index];
    }
    return sum;
  };
  const seconds = basis === 'profile' ? (profile.endTime - profile.startTime) / 1e6 : wall;
  return { basis, seconds, total, idle, busy: total - idle, entries, self, selfFile, selfGroup, inclusive, inclusiveFile,
    inclusiveGroup, union };
}

/** A --metric value, `<kind>:<matcher>`. */
export function parseMetric(text) {
  const colon = text.indexOf(':');
  const kind = text.slice(0, colon), pattern = text.slice(colon + 1);
  if (colon < 0 || !KINDS.includes(kind) || !pattern) {
    throw usage(`--metric ${text}: expected <kind>:<matcher>, with kind ${KINDS.join(', ')}.`);
  }
  const fileKind = kind === 'file' || kind === 'incfile';
  const regex = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (regex) {
    let compiled;
    // Without g or y, test() keeps no state from one subject to the next.
    try { compiled = new RegExp(regex[1], regex[2].replace(/[gy]/g, '')); } catch (error) {
      throw usage(`--metric ${text}: ${error.message}.`);
    }
    return { text, kind, fileKind, form: 'regex', test: subject => compiled.test(subject) };
  }
  // A file kind matches paths, and a scoped package's path starts with @, so only the function kinds read name@file.
  const named = !fileKind && /^([^\s@]+)@(.+)$/.exec(pattern);
  if (!named) return { text, kind, fileKind, form: 'text', needle: pattern };
  const lined = /^(.+):(\d+|\?)$/.exec(named[2]);
  return lined ? { text, kind, fileKind, form: 'line', name: named[1], file: lined[1], line: lined[2] }
    : { text, kind, fileKind, form: 'name', name: named[1], file: named[2] };
}

const matches = (metric, each) => {
  const subject = metric.fileKind ? each.file : each.key;
  if (metric.form === 'regex') return metric.test(subject);
  if (metric.form === 'text') return subject.includes(metric.needle);
  return each.name === metric.name && each.file.includes(metric.file) && (metric.form === 'name' || each.line === metric.line);
};

/**
 * One metric in one attributed profile: `value` in ms/s, or null when nothing on any sample's stack matches (absent,
 * never 0), and the keys or files it matched. A function on a stack that was never sampled itself has self time 0.
 */
export function measure(attribution, metric) {
  const domain = metric.fileKind ? [...attribution.inclusiveFile.keys()].map(file => ({ file, key: file }))
    : [...attribution.inclusive.keys()].map(key => attribution.entries.get(key));
  const keys = domain.filter(each => matches(metric, each)).map(each => metric.fileKind ? each.file : each.key);
  if (!keys.length) return { value: null, keys };
  let ms = 0;
  if (metric.kind === 'self') for (const key of keys) ms += attribution.self.get(key) ?? 0;
  else if (metric.kind === 'file') for (const file of keys) ms += attribution.selfFile.get(file) ?? 0;
  else {
    const wanted = new Set(keys);
    ms = attribution.union(each => wanted.has(metric.fileKind ? each.file : each.key));
  }
  return { value: ms / attribution.seconds, keys };
}

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * A profile.mjs run directory: the target, base, root and page origin from summary.md's header, and each stretch from
 * stretches.json, its profile found by its recorded path or else by that path's basename in the directory.
 */
export async function readRunDirectory(dir) {
  const summary = await readFile(path.join(dir, 'summary.md'), 'utf8').catch(() => null);
  if (summary === null) throw new SummaryError(`${dir} has no readable summary.md, so it is not a profile.mjs run directory.`);
  const target = /^# CPU profile: ([^,\n]+),/.exec(summary)?.[1];
  const [, page, root] = /^Page (.+?), root (.+)\.$/m.exec(summary) ?? [];
  if (!target || !root) {
    throw new SummaryError(`${dir}/summary.md lacks the header lines "# CPU profile: <target>, …" and "Page <url>, root <root>.".`);
  }
  const base = TARGET_BASES[target];
  if (!base) throw new SummaryError(`${dir}/summary.md names target ${target}; profile.mjs serves ${Object.keys(TARGET_BASES).join(', ')}.`);
  let stretches;
  try { stretches = JSON.parse(await readFile(path.join(dir, 'stretches.json'), 'utf8')); } catch {
    throw new SummaryError(`${dir} has no readable stretches.json.`);
  }
  if (!Array.isArray(stretches) || !stretches.length) throw new SummaryError(`${dir}/stretches.json holds no stretches.`);
  let origin = null;
  try { origin = new URL(page).origin; } catch { /* Only the note on missing scripts uses it. */ }
  return { dir, target, base, root, origin, stretches: stretches.map(stretch => {
    const recorded = typeof stretch.file === 'string' && stretch.file ? stretch.file : null;
    // The run directory may have moved since profile.mjs wrote the absolute path.
    const file = recorded && !existsSync(recorded) ? path.join(dir, path.basename(recorded)) : recorded;
    return { ...stretch, file };
  }) };
}

/** ab.mjs's records of one label, in seq order; a seq that was run again (--resume) counts its last record. */
export async function loadRunsJsonl(file, label) {
  const text = await readFile(file, 'utf8').catch(error => {
    throw new SummaryError(`Cannot read ${file} (${error.code}). Pass --runs <runs.jsonl>, or for runs ab.mjs did not record, `
      + '--legacy <runs.txt> or --run <arm>=<dir>.');
  });
  const notes = [], bySeq = new Map();
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch { notes.push(`Line ${index + 1} of ${file} is not JSON and was ignored.`); return; }
    if (record?.label !== label) return;
    if (record.schema !== 1 || !Number.isInteger(record.seq) || !Number.isInteger(record.pair) || typeof record.arm !== 'string') {
      throw new SummaryError(`Line ${index + 1} of ${file} is not an ab.mjs schema 1 record with a seq, pair and arm. `
        + 'Check which tool wrote it.');
    }
    if (bySeq.has(record.seq)) notes.push(`Seq ${record.seq} was recorded more than once; its last record counts.`);
    bySeq.set(record.seq, record);
  });
  if (!bySeq.size) throw new SummaryError(`${file} records no runs of label ${label}. Check the label, or pass --runs, --legacy or --run.`);
  const runs = [...bySeq.values()].sort((x, y) => x.seq - y.seq).map(record => ({ seq: record.seq, pair: record.pair,
    arm: record.arm, dir: record.dir ?? null, valid: record.valid === true, reason: record.reason ?? null,
    interference: Array.isArray(record.interference) ? record.interference : [] }));
  return { runs, notes };
}

// A run listed in order, paired with its neighbour.
const listed = (arm, dir, seq) => ({ seq, pair: Math.ceil(seq / 2), arm, dir, valid: true, reason: null, interference: [] });

/** An earlier session's runs.txt, lines "<label> <arm> <dir>": the label's runs in file order. */
export async function loadLegacy(file, label) {
  const text = await readFile(file, 'utf8').catch(error => {
    throw new SummaryError(`Cannot read ${file} (${error.code}). Check the --legacy path.`);
  });
  const runs = [];
  text.split('\n').forEach((line, index) => {
    if (line.split(' ')[0] !== label) return;
    const match = /^\S+ (\S+) (.+)$/.exec(line.trimEnd());
    if (!match) throw new SummaryError(`Line ${index + 1} of ${file} is not "<label> <arm> <dir>". Correct or remove it.`);
    runs.push(listed(match[1], match[2], runs.length + 1));
  });
  if (!runs.length) throw new SummaryError(`${file} lists no runs of label ${label}. Check the label.`);
  return { runs, notes: [] };
}

/** --run <arm>=<dir> values, in run order. */
export function parseRunList(values) {
  return values.map((value, index) => {
    const at = value.indexOf('=');
    if (at <= 0 || at === value.length - 1) throw usage(`--run ${value}: expected <arm>=<run directory>.`);
    return listed(value.slice(0, at), path.resolve(value.slice(at + 1)), index + 1);
  });
}

/**
 * The pairs to compare, each one A run and one B run, in pair order; A is the first run's arm. A pair holding an
 * excluded run is dropped with a note; any other pair that is not one run of each arm is a usage error.
 */
export function pairRuns(runs, { skip = new Set(), includeContaminated = false } = {}) {
  const arms = [...new Set(runs.map(run => run.arm))];
  if (arms.length !== 2) throw usage(`An A/B summary needs runs of exactly two arms; these have ${arms.length}: ${arms.join(', ')}.`);
  for (const seq of skip) if (!runs.some(run => run.seq === seq)) throw usage(`--skip ${seq}: no run has that seq.`);
  const [a, b] = arms, notes = [], pairs = [];
  const named = run => `seq ${run.seq} (${run.arm})`;
  for (const number of [...new Set(runs.map(run => run.pair))].sort((x, y) => x - y)) {
    const members = runs.filter(run => run.pair === number), excluded = [];
    for (const run of members) {
      const alongside = `${named(run)} ran alongside another measurement process `
        + `(${[...new Set(run.interference.map(each => each?.kind ?? 'unknown'))].join(', ')})`;
      if (!run.valid) excluded.push(`${named(run)} is invalid${run.reason ? ` (${run.reason})` : ''}`);
      else if (run.interference.length && !includeContaminated) excluded.push(alongside);
      else if (skip.has(run.seq)) excluded.push(`${named(run)} is skipped by --skip`);
      else if (run.interference.length) notes.push(`${alongside}; kept by --include-contaminated.`);
    }
    if (excluded.length) {
      notes.push(`Pair ${number} is dropped: ${excluded.join('; ')}.`);
      continue;
    }
    const first = members.find(run => run.arm === a), second = members.find(run => run.arm === b);
    if (members.length !== 2 || !first || !second) {
      throw usage(`Pair ${number} holds ${members.map(named).join(' and ')}; each pair needs one run of ${a} and one of ${b}.`);
    }
    pairs.push({ pair: number, a: first, b: second });
  }
  if (!pairs.length) {
    throw new SummaryError('Every pair was dropped, so nothing is left to compare. Complete the pairs (ab.mjs --resume), '
      + 'or pass --include-contaminated to keep runs that ran alongside another measurement.');
  }
  return { arms, pairs, notes };
}

/** "B lower in every pair" or "B higher in every pair", with ", ranges disjoint" when the arms never meet; else "mixed". */
export function verdict(a, b) {
  const all = [...a, ...b];
  if (all.every(value => value === null)) return 'absent';
  if (all.some(value => value === null)) return 'absent in some runs';
  const deltas = a.map((value, index) => b[index] - value);
  const lower = deltas.every(delta => delta < 0), higher = deltas.every(delta => delta > 0);
  if (!lower && !higher) return 'mixed';
  const disjoint = lower ? Math.max(...b) < Math.min(...a) : Math.min(...b) > Math.max(...a);
  return `B ${lower ? 'lower' : 'higher'} in every pair${disjoint ? ', ranges disjoint' : ''}`;
}

const range = values => {
  const present = values.filter(value => value !== null);
  return present.length ? [Math.min(...present), Math.max(...present)] : null;
};
const row = (metric, a, b, extra = {}) => ({ metric, ...extra, a, b,
  delta: a.map((value, index) => value === null || b[index] === null ? null : b[index] - value),
  rangeA: range(a), rangeB: range(b), verdict: verdict(a, b) });

const FRAME_ROWS = [['fps', 'Frames/s'], ['p95', 'p95 frame, ms'], ['over25', 'Frames over 25 ms, %'],
  ['mainThread', 'Main thread, % of a core'], ['busy', 'Profiled busy, ms/s'], ['busyPerFrame', 'Busy per frame, ms'],
  ['load', 'Load average, 1 min']];

/** One run's stretch at one rate: its frame and CPU values, each metric's result and the movers' groups in ms/s. */
async function measureStretch(run, info, rate, { metrics, movers, basis, describeFor }) {
  const where = `Seq ${run.seq} (${run.arm}, ${info.dir})`, leaveOut = `or leave the run out with --skip ${run.seq}`;
  const found = info.stretches.filter(stretch => stretch.rate === rate);
  if (!found.length) throw new SummaryError(`${where} has no ${rate}x stretch. Pass --rates with rates every run has, ${leaveOut}.`);
  if (found.length > 1) {
    throw new SummaryError(`${where} has ${found.length} ${rate}x stretches, which wrote one profile file. Profile it again, ${leaveOut}.`);
  }
  const [stretch] = found;
  if (!(finite(stretch.wall) > 0)) throw new SummaryError(`${where}: its ${rate}x stretch records no wall time. Check stretches.json, ${leaveOut}.`);
  let profile = null;
  try { profile = JSON.parse(await readFile(stretch.file, 'utf8')); } catch { /* Reported below. */ }
  if (!Array.isArray(profile?.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas)) {
    throw new SummaryError(`${where}: its ${rate}x profile ${stretch.file ?? '(not named in stretches.json)'} is missing or is not a `
      + `CPU profile. Check the run directory, ${leaveOut}.`);
  }
  const attribution = await attribute(profile, describeFor(info), { basis, wall: stretch.wall });
  if (!(attribution.seconds > 0)) throw new SummaryError(`${where}: its ${rate}x profile spans no time. Use --basis wall, ${leaveOut}.`);
  const perSecond = ms => ms / attribution.seconds;
  const fps = finite(stretch.fps), frames = finite(stretch.frames), slow = finite(stretch.slow), busy = perSecond(attribution.busy);
  const values = { fps, p95: finite(stretch.p95), over25: slow === null || frames === null ? null : 100 * slow / Math.max(1, frames),
    mainThread: finite(stretch.mainThread) === null ? null : 100 * stretch.mainThread, busy, busyPerFrame: fps ? busy / fps : null,
    load: finite(stretch.loadAverage) };
  const results = metrics.map(metric => {
    const result = measure(attribution, metric);
    if ((metric.form === 'name' || metric.form === 'line') && result.keys.length > 1) {
      throw usage(`--metric ${metric.text} matches ${result.keys.length} functions in seq ${run.seq}'s ${rate}x stretch `
        + `(${run.arm}): ${ticked(result.keys)}. Name one with name@file:line, or combine them on purpose with a /regex/.`);
    }
    return result;
  });
  // V8's idle and root nodes are not functions, and the busy row already shows the idle time's change.
  const groups = totals => new Map([...totals].filter(([group]) => group !== IDLE && group !== ROOT)
    .map(([group, ms]) => [group, perSecond(ms)]));
  return { motion: stretch.motion, values, results, present: attribution.inclusiveGroup,
    self: movers ? groups(attribution.selfGroup) : null, inclusive: movers ? groups(attribution.inclusiveGroup) : null };
}

/** One rate's tables from every run's measurement. */
function rateSection(rate, plan, runs, measured, { metrics, movers }) {
  const [a, b] = plan.arms, notes = [];
  const motions = [...new Set(runs.map(run => measured.get(run).motion))];
  if (motions.length > 1) notes.push(`The runs' ${rate}x stretches differ in motion (${motions.join(', ')}).`);
  const byPair = pick => [plan.pairs.map(pair => pick(measured.get(pair.a))), plan.pairs.map(pair => pick(measured.get(pair.b)))];
  const groups = [{ title: 'Frames and CPU', rows: FRAME_ROWS.map(([id, label]) => row(label, ...byPair(each => each.values[id]), { id })) }];
  if (metrics.length) {
    const rowNotes = [];
    const rows = metrics.map((metric, index) => {
      const keysOf = arm => [...new Set(runs.filter(run => run.arm === arm).flatMap(run => measured.get(run).results[index].keys))];
      const keys = { a: keysOf(a), b: keysOf(b) };
      if (metric.form === 'text' && runs.some(run => measured.get(run).results[index].keys.length > 1)) {
        const combined = metric.kind === 'self' || metric.kind === 'file' ? 'added up' : 'each sample counted once';
        rowNotes.push(`Warning: plain text \`${metric.text}\` matched more than one key in a stretch (${combined}): `
          + `${ticked([...new Set([...keys.a, ...keys.b])])}.`);
      }
      for (const [arm, armKeys] of [[a, keys.a], [b, keys.b]]) {
        rowNotes.push(armKeys.length ? `\`${metric.text}\` matched ${ticked(armKeys)} in ${arm}.`
          : `\`${metric.text}\` is absent from every ${arm} run: check the matcher; the function may be renamed or inlined.`);
      }
      return row(`\`${metric.text}\` ms/s`, ...byPair(each => each.results[index].value), { kind: metric.kind, matcher: metric.text, keys });
    });
    groups.push({ title: 'Chosen functions and files', rows, notes: rowNotes });
  }
  for (const [field, title] of movers ? [['self', 'Movers, self time by function, ms/s'], ['inclusive', 'Movers, inclusive time by function, ms/s']] : []) {
    // A function absent from a run is ranked as if it took 0 there, and shown as absent.
    const value = (each, group) => each[field].get(group) ?? (each.present.has(group) ? 0 : null);
    const ranked = [...new Set(runs.flatMap(run => [...measured.get(run)[field].keys()]))].map(group => {
      const [av, bv] = byPair(each => value(each, group));
      return { group, av, bv, change: bv.reduce((sum, v, i) => sum + (v ?? 0) - (av[i] ?? 0), 0) / plan.pairs.length };
    }).sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || (x.group < y.group ? -1 : x.group > y.group ? 1 : 0));
    groups.push({ title, rows: ranked.slice(0, movers).map(each => row(`\`${each.group}\``, each.av, each.bv, { group: each.group, change: each.change })) });
  }
  return { rate, motion: motions.join(', '), notes, groups };
}

/**
 * The tables for a plan from pairRuns: per rate, the frame and CPU rows, one row per metric and the movers. Every run of
 * one root shares its source-map consumers.
 */
export async function summarize(plan, { metrics = [], rates = null, movers = 12, basis = 'wall' } = {}) {
  const runs = plan.pairs.flatMap(pair => [pair.a, pair.b]).sort((x, y) => x.seq - y.seq);
  const notes = [...plan.notes], read = new Map(), describers = new Map();
  for (const run of runs) {
    if (!run.dir) throw new SummaryError(`Seq ${run.seq} (${run.arm}) records no run directory. Leave it out with --skip ${run.seq}.`);
    try { read.set(run, await readRunDirectory(run.dir)); } catch (error) {
      if (!(error instanceof SummaryError)) throw error;
      throw new SummaryError(`Seq ${run.seq} (${run.arm}): ${error.message} Check the run, or leave it out with --skip ${run.seq}.`);
    }
  }
  const targets = [...new Set(runs.map(run => read.get(run).target))];
  if (targets.length > 1) notes.push(`The runs profiled different targets (${targets.join(', ')}).`);
  const describeFor = info => {
    const key = `${info.base}\0${info.root}`;
    if (!describers.has(key)) describers.set(key, { root: info.root, ...describer(info.root, info.base, info.origin) });
    return describers.get(key).describe;
  };
  const sections = [];
  for (const rate of rates ?? [...new Set(read.get(runs[0]).stretches.map(stretch => stretch.rate))]) {
    const measured = new Map();
    for (const run of runs) measured.set(run, await measureStretch(run, read.get(run), rate, { metrics, movers, basis, describeFor }));
    sections.push(rateSection(rate, plan, runs, measured, { metrics, movers }));
  }
  for (const { root, unmapped, missing } of describers.values()) {
    if (missing.size) {
      notes.push(`${plural(missing.size, 'script', 'scripts')} the profiles ran ${missing.size === 1 ? 'is' : 'are'} missing from root ${root} `
        + '(rebuilt or moved since the run?), so their functions are named by URL.');
    }
    if (unmapped.size) notes.push(`${plural(unmapped.size, 'script', 'scripts')} under root ${root} had no source map, so their functions are named by URL.`);
  }
  return { schema: 1, basis, arms: plan.arms, notes, rates: sections,
    pairs: plan.pairs.map(pair => ({ pair: pair.pair, a: { seq: pair.a.seq, dir: pair.a.dir }, b: { seq: pair.b.seq, dir: pair.b.dir } })) };
}

const BASIS = {
  wall: 'Times are ms per second of each stretch\'s wall time, each sample owning the interval to the next (profile.mjs).',
  profile: 'Times are ms per second of each profile\'s own span, the last sample owning nothing (profile-tree.mjs).',
};
const fixed = value => value === null ? 'absent' : value.toFixed(1);
// The sign is the unrounded change's, so a change too small to show is still +0.0 or -0.0.
const signed = value => value === null ? 'absent' : value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
const span = values => values ? `${values[0].toFixed(1)}–${values[1].toFixed(1)}` : 'absent';
const cell = text => String(text).replace(/\|/g, '\\|');

/** The summary as markdown: the pairs and notes, then for each rate one table per group. */
export function renderMarkdown(result) {
  const [a, b] = result.arms;
  const lines = [`# A/B summary${result.title ? `: ${result.title}` : ''}`, '',
    `${result.source}. A is \`${a}\` and B is \`${b}\`, ${plural(result.pairs.length, 'pair', 'pairs')} in run order. ${BASIS[result.basis]}`, '',
    '| Pair | A run | B run |', '| ---: | --- | --- |',
    ...result.pairs.map(pair => `| ${pair.pair} | ${pair.a.seq}: ${cell(pair.a.dir)} | ${pair.b.seq}: ${cell(pair.b.dir)} |`), ''];
  if (result.notes.length) lines.push(...result.notes.map(note => `- ${note}`), '');
  for (const section of result.rates) {
    lines.push(`## ${section.rate}x CPU, ${section.motion}`, '');
    if (section.notes.length) lines.push(...section.notes.map(note => `- ${note}`), '');
    for (const group of section.groups) {
      lines.push(`### ${group.title}`, '', `| Metric | ${cell(a)} by pair | ${cell(b)} by pair | Δ by pair (B − A) | A range | B range | Verdict |`,
        '| --- | ---: | ---: | ---: | ---: | ---: | --- |', ...group.rows.map(each => `| ${cell(each.metric)} | ${each.a.map(fixed).join(', ')} | `
          + `${each.b.map(fixed).join(', ')} | ${each.delta.map(signed).join(', ')} | ${span(each.rangeA)} | ${span(each.rangeB)} | ${each.verdict} |`), '');
      if (group.notes?.length) lines.push(...group.notes.map(note => `- ${note}`), '');
    }
  }
  return lines.join('\n');
}

const OPTIONS = {
  label: { type: 'string' }, runs: { type: 'string' }, legacy: { type: 'string' }, run: { type: 'string', multiple: true },
  metric: { type: 'string', multiple: true }, rates: { type: 'string' }, skip: { type: 'string' },
  'include-contaminated': { type: 'boolean', default: false }, movers: { type: 'string', default: '12' },
  basis: { type: 'string', default: 'wall' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
};

/** The command line's options, checked; a usage error throws SummaryError with exit code 2. */
export function parseOptions(argv) {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false })); } catch (error) {
    throw usage(error.message);
  }
  if (values.help) return { help: true };
  const runList = values.run ?? [];
  if (runList.length && (values.legacy || values.runs)) throw usage('--run lists the runs itself; leave out --runs and --legacy.');
  if (values.legacy && values.runs) throw usage('Pass --legacy <runs.txt> or --runs <runs.jsonl>, not both.');
  if (!runList.length && !values.label) throw usage('Name the runs: --label <name> (with --runs or --legacy), or --run <arm>=<dir> for each run.');
  const rates = values.rates === undefined ? null : values.rates.split(',').map(part => {
    if (!part.trim() || !(Number(part) > 0) || !Number.isFinite(Number(part))) throw usage(`--rates ${values.rates}: expected CPU rates such as 1,4.`);
    return Number(part);
  });
  const skip = values.skip === undefined ? [] : values.skip.split(',').map(part => {
    if (!/^\s*\d+\s*$/.test(part) || Number(part) < 1) throw usage(`--skip ${values.skip}: expected run seqs such as 3,4.`);
    return Number(part);
  });
  if (!/^\d+$/.test(values.movers)) throw usage(`--movers ${values.movers}: expected a whole number (0 leaves the movers out).`);
  if (!['wall', 'profile'].includes(values.basis)) throw usage(`--basis ${values.basis}: expected wall or profile.`);
  return { label: values.label ?? null, runsFile: values.runs ? path.resolve(values.runs) : DEFAULT_RUNS,
    legacy: values.legacy ? path.resolve(values.legacy) : null, runList, metrics: (values.metric ?? []).map(parseMetric), rates,
    skip: new Set(skip), includeContaminated: values['include-contaminated'], movers: Number(values.movers), basis: values.basis,
    json: values.json };
}

/** The command: parse, load, pair, summarize and print, everything printed redacted. Resolves to the exit code. */
export async function main(argv = process.argv.slice(2), io = { out: text => process.stdout.write(text), err: text => process.stderr.write(text) }) {
  try {
    const options = parseOptions(argv);
    if (options.help) {
      io.out(`${USAGE}\n`);
      return 0;
    }
    const loaded = options.runList.length ? { runs: parseRunList(options.runList), notes: [] }
      : options.legacy ? await loadLegacy(options.legacy, options.label) : await loadRunsJsonl(options.runsFile, options.label);
    const source = options.runList.length ? 'Runs from the command line'
      : `Runs of \`${options.label}\` from ${options.legacy ? `the legacy list ${options.legacy}` : options.runsFile}`;
    const plan = pairRuns(loaded.runs, options);
    plan.notes.unshift(...loaded.notes);
    const result = { title: options.label, source, ...await summarize(plan, options) };
    io.out(redact(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderMarkdown(result)}\n`));
    return 0;
  } catch (error) {
    if (!(error instanceof SummaryError)) throw error;
    io.err(redact(`${error.message}\n${error.exitCode === 2 ? `\n${USAGE}\n` : ''}`));
    return error.exitCode;
  }
}

if (import.meta.main) process.exitCode = await main();
