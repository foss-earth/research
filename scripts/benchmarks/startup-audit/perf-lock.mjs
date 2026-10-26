// The machine-wide lock that every Chrome measurement takes first, so that one agent measures at a time and nobody
// builds or tests while Chrome runs.
//
//   node scripts/benchmarks/startup-audit/perf-lock.mjs status [--json] [--lock <dir>]
//   node scripts/benchmarks/startup-audit/perf-lock.mjs acquire --agent <name> --task "<what you will measure>"
//     [--lock <dir>]
//   node scripts/benchmarks/startup-audit/perf-lock.mjs release --agent <name> [--lock <dir>]
//
// The lock is a directory, taken with one mkdir: it either creates the directory or fails, so two agents can never
// both hold it. It is --lock, else PERF_LOCK, else ~/gh/0sfs/fly/build/perf-exclusive.lock, the path every earlier
// session used. acquire writes owner.txt into it: the agent, the task, when, the pid of the agent's long-lived session
// (the Claude Code process, not the shell that ran this, which exits at once) and the host. Nobody but its holder
// removes a lock: acquire never takes over a held one, even when the holder's pid is dead, and release refuses any
// agent but the one owner.txt names, and a lock directory that holds anything else.
//
// status prints the lock, its owner, its age and whether the holder's pid still runs, then the measurement processes
// running on this machine (headless Chrome, profile.mjs, run.mjs, pixels.mjs, ab.mjs, mutants.mjs, vite build,
// vitest), each as its pid, elapsed time, kind and a short summary with keys redacted, never its command line.
// ab.mjs and mutants.mjs import the same checks, and redact() for anything they echo from a process or a log.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync }
  from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const RESEARCH = fileURLToPath(new URL('../../../', import.meta.url));
const TOOL = 'node scripts/benchmarks/startup-audit/perf-lock.mjs';
const OWNER = 'owner.txt';
const USAGE = `Usage:
  ${TOOL} status [--json] [--lock <dir>]
  ${TOOL} acquire --agent <name> --task "<what you will measure>" [--lock <dir>]
  ${TOOL} release --agent <name> [--lock <dir>]
The lock is --lock, else PERF_LOCK, else ~/gh/0sfs/fly/build/perf-exclusive.lock.`;

const homeLock = home => path.join(home, 'gh', '0sfs', 'fly', 'build', 'perf-exclusive.lock');
/** The lock every session shares: PERF_LOCK, else the fly checkout's. */
export function defaultLockPath({ env = process.env, home = os.homedir() } = {}) {
  return env.PERF_LOCK ? path.resolve(env.PERF_LOCK) : homeLock(home);
}

// Keys and tokens in URLs, command lines and environment assignments, also quoted or URL-encoded; and anything shaped
// like a Google API key, wherever it appears.
const SECRET = /(gkey|key|token|GOOGLE_3D_TILES_KEY|FOSS_EARTH_GOOGLE_KEY)(=|%3D)(["']?)[^&\s"']*/gi;
const GOOGLE_KEY = /AIza[\w-]{35}/g;
/** The text with each key's value replaced by <redacted>. Anything echoed from a process or a log goes through it. */
export function redact(text) {
  return String(text ?? '').replace(SECRET, '$1$2$3<redacted>').replace(GOOGLE_KEY, '<redacted>');
}

/** The environment for a child process, with TMPDIR inside research build/ rather than the system's. */
function childEnv() {
  const tmp = path.join(RESEARCH, 'build', 'tmp');
  mkdirSync(tmp, { recursive: true });
  return { ...process.env, TMPDIR: tmp };
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+)(?:\s(.*))?$/;
/** `ps -axo pid=,ppid=,etime=,command=` output as rows of { pid, ppid, etime, command }. */
export function parsePs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const match = PS_ROW.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), etime: match[3], command: match[4] ?? '' });
    // An argument with a newline in it carries on its process's command line.
    else if (line.trim() && rows.length) rows.at(-1).command += ` ${line.trim()}`;
  }
  return rows;
}

/** Every process on this machine, each command line whole (ww: never cut to a terminal's width). */
export function listProcesses() {
  return parsePs(execFileSync('ps', ['-axwwo', 'pid=,ppid=,etime=,command='],
    { encoding: 'utf8', env: childEnv(), maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
}

/** One process's parent pid and command name, from ps, or null once it has gone. */
export function processInfo(pid) {
  try {
    const text = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)],
      { encoding: 'utf8', env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    const match = /^\s*(\d+)\s+(.+?)\s*$/m.exec(text);
    return match ? { ppid: Number(match[1]), comm: match[2] } : null;
  } catch {
    return null;
  }
}

/** Whether a pid runs. Signal 0 only checks; another user's process (EPERM) still runs. Never a group: pid > 0. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Links between rows: the ancestors of one pid, and every process under some pids (the pids included). */
export function processTree(rows) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const ancestorsOf = pid => {
    const found = new Set();
    for (let at = byPid.get(pid)?.ppid; at > 0 && !found.has(at); at = byPid.get(at)?.ppid) found.add(at);
    return found;
  };
  const descendantsOf = pids => {
    const found = new Set(), queue = [...pids];
    while (queue.length) {
      const at = queue.pop();
      if (found.has(at)) continue;
      found.add(at);
      queue.push(...(children.get(at) ?? []));
    }
    return found;
  };
  return { byPid, children, ancestorsOf, descendantsOf };
}

const SCRIPTS = new Set(['profile.mjs', 'run.mjs', 'pixels.mjs', 'ab.mjs', 'mutants.mjs']);
/**
 * The kind of measurement a command line runs: 'headless Chrome', the script's name ('profile.mjs', 'run.mjs',
 * 'pixels.mjs', 'ab.mjs', 'mutants.mjs'), 'vite build' or 'vitest'; or null.
 */
export function classifyCommand(command) {
  const text = String(command ?? '');
  const tokens = text.split(/\s+/).filter(Boolean);
  const names = tokens.map(token => token.slice(token.lastIndexOf('/') + 1));
  const runtime = names.findIndex(name => /^(?:node|nodejs|bun|deno)$/.test(name));
  // A script that node runs, not one an editor has open, nor an option's value (ab-summary.mjs --run arm=<dir>).
  const script = runtime < 0 ? undefined : names.find((name, at) => at > runtime && SCRIPTS.has(name)
    && !tokens[at].startsWith('-') && !tokens[at].includes('='));
  if (script) return script;
  if (names.some((name, at) => (name === 'vite' || name === 'vite.js') && tokens[at + 1] === 'build')) return 'vite build';
  if (names.includes('vitest') || names.includes('vitest.mjs') || /\/vitest\/(?:dist|bin)\//.test(text)) return 'vitest';
  // Chrome's own path has spaces in it, so the executable is everything before the first option; a node script
  // that takes --headless is not Chrome.
  const executable = text.split(/\s-/)[0];
  const headless = /(?:^|\s)--headless(?:[=\s]|$)/.test(text) || /headless.shell/i.test(executable);
  return /chrom(?:e|ium)/i.test(executable) && headless ? 'headless Chrome' : null;
}

// An app bundle's executable, such as /Applications/Google Chrome.app/Contents/MacOS/Google Chrome, spaces and all.
const BUNDLE = /^\/(?:(?! -| \/).)*?\.app\/Contents\/MacOS\//;
/**
 * A command line short enough to print: keys redacted, each URL cut to its origin, the executable to its name and
 * other paths to their last two parts, all within `width` characters.
 */
export function summarize(command, width = 100) {
  const text = redact(command).replace(BUNDLE, '').split(' ').map((token, at) => {
    if (token.includes('://')) return token.replace(/^(.*?:\/\/[^/?#]*)[/?#].*$/, '$1/…');
    const [, option = '', value] = /^([^/=]*=)?(.*)$/.exec(token);
    const parts = value.split('/').filter(Boolean);
    if (!value.includes('/') || parts.length <= (at ? 2 : 1)) return token;
    return option + (at ? `…/${parts.slice(-2).join('/')}` : parts.at(-1));
  }).join(' ');
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/**
 * The measurement processes running now: [{ pid, ppid, kind, elapsed (as ps prints it), summary }]. Leaves out
 * `self`, its ancestors and its descendants, and every process under a pid in `exclude` (a runner's own children).
 * A process under one of its own kind (Chrome's helpers, the wrapper that started a script) is folded into it.
 * `rows` is a process listing for tests; by default ps is read now.
 */
export function activeMeasurementProcesses({ exclude = [], self = process.pid, rows } = {}) {
  const all = rows ?? listProcesses();
  const tree = processTree(all);
  const roots = [self, ...(typeof exclude === 'number' ? [exclude] : exclude ?? [])].map(Number).filter(pid => pid > 1);
  const skip = new Set([...tree.ancestorsOf(self), ...tree.descendantsOf(roots)]);
  const found = new Map();
  for (const row of all) {
    const kind = skip.has(row.pid) ? null : classifyCommand(row.command);
    if (kind) found.set(row.pid, { ...row, kind });
  }
  return [...found.values()].filter(row => found.get(row.ppid)?.kind !== row.kind).map(row =>
    ({ pid: row.pid, ppid: row.ppid, kind: row.kind, elapsed: row.etime, summary: summarize(row.command) }));
}

/** owner.txt's fields { agent, task, started, pid, host, raw }; a legacy file's `shell pid:` stands in for `pid:`. */
export function parseOwner(text) {
  const owner = { agent: null, task: null, started: null, pid: null, host: null, raw: String(text) };
  let shellPid = null;
  for (const line of owner.raw.split(/\r?\n/)) {
    const match = /^\s*(agent|task|started|pid|shell pid|host)\s*:\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const name = match[1].toLowerCase(), value = match[2];
    const pid = /^\d+/.test(value) ? Number(/^\d+/.exec(value)[0]) : null;
    if (name === 'pid') owner.pid ??= pid;
    else if (name === 'shell pid') shellPid ??= pid;
    else owner[name] ??= value;
  }
  owner.pid ??= shellPid;
  return owner;
}

const OWNER_FIELDS = ['agent', 'task', 'started', 'pid', 'host'];
/**
 * The lock's state, read only: { lock, held, owner, agent, task, started, pid, host, ageSeconds, ageFrom, pidAlive,
 * legacyPid }. owner is owner.txt's fields (parseOwner), or null when the lock is free or has no owner.txt; its
 * fields are repeated at the top, null when free, for a caller that compares one. The age is from started's ISO time,
 * else the lock directory's mtime (ageFrom says which). legacyPid: the pid came from a legacy `shell pid:` line.
 */
export function readLock(lockDir = defaultLockPath(), { now = Date.now(), isAlive = isProcessAlive } = {}) {
  const lock = path.resolve(lockDir);
  const free = { lock, held: false, owner: null, ...Object.fromEntries(OWNER_FIELDS.map(name => [name, null])),
    ageSeconds: null, ageFrom: null, pidAlive: null, legacyPid: false };
  let stat;
  try {
    stat = statSync(lock);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return free;
    throw error;
  }
  let text = null;
  try {
    text = readFileSync(path.join(lock, OWNER), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  const owner = text === null ? null : parseOwner(text);
  const iso = owner?.started ? /\((\d{4}-\d{2}-\d{2}T[^)]+)\)/.exec(owner.started) : null;
  const started = iso ? Date.parse(iso[1]) : NaN;
  const since = Number.isNaN(started) ? stat.mtimeMs : started;
  return {
    ...free, held: true, owner, ...(owner && Object.fromEntries(OWNER_FIELDS.map(name => [name, owner[name]]))),
    ageSeconds: Math.max(0, Math.round((Number(now) - since) / 1000)), ageFrom: Number.isNaN(started) ? 'mtime' : 'started',
    pidAlive: owner?.pid ? isAlive(owner.pid) : null,
    legacyPid: Boolean(owner?.pid) && !/^\s*pid\s*:/im.test(owner.raw),
  };
}

// What an agent's shell runs inside without being the agent: the system, a login, a terminal, a multiplexer or an
// editor. Their lives say nothing about the agent's.
const SESSION_HOSTS = new RegExp('^(?:launchd|login|init|systemd|sshd(?:-session)?|tmux.*|screen'
  + '|Terminal|iTerm2?|Warp|stable|alacritty|kitty|wezterm-gui|WezTerm|Hyper|ghostty|xterm|gnome-terminal-server|konsole'
  + '|(?:Code|Cursor|Windsurf|Electron)(?: Helper.*)?)$', 'i');
/**
 * The process whose life stands for the agent's: the first ancestor named claude (the Claude Code session), else the
 * outermost ancestor below pid 1 that is not the system, a login or a terminal. The shell that ran this tool exits at
 * once, so its pid is useless for liveness. Returns { pid, name }.
 */
export function lockHolderProcess({ start = process.ppid, processInfo: info = processInfo } = {}) {
  const chain = [];
  for (let pid = start; pid > 1 && chain.length < 64 && !chain.some(each => each.pid === pid);) {
    const found = info(pid);
    if (!found) break;
    // The native installer's binary is named for its version: ~/.local/share/claude/versions/<version>.
    const name = path.basename(found.comm);
    if (name === 'claude' || /\/claude\/versions\/[^/]+$/.test(found.comm)) return { pid, name: 'claude' };
    chain.push({ pid, name });
    pid = found.ppid;
  }
  return chain.findLast(each => !SESSION_HOSTS.test(each.name)) ?? chain[0] ?? { pid: start, name: 'unknown' };
}

/** `date`'s local time (Sat Oct 24 15:55:09 CDT 2026), and ISO 8601 with the offset. */
function localTimes(now) {
  const pad = value => String(value).padStart(2, '0');
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(now)
    .find(part => part.type === 'timeZoneName')?.value ?? '';
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const offset = -now.getTimezoneOffset();
  const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${clock}`
    + `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const day = `${now.toLocaleString('en-US', { weekday: 'short' })} ${now.toLocaleString('en-US', { month: 'short' })}`;
  return { date: `${day} ${String(now.getDate()).padStart(2, ' ')} ${clock} ${zone} ${now.getFullYear()}`, iso };
}

const duration = seconds => seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${Math.floor(seconds / 60)} min`
  : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ${Math.floor(seconds / 60) % 60} min`
    : `${Math.floor(seconds / 86400)} d ${Math.floor(seconds / 3600) % 24} h`;
const quote = text => /^[\w.@:+/-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
// One line each: a newline in --task would let it forge an owner line.
const oneLine = value => (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

function describeLock(state) {
  if (!state.held) return [`Lock ${state.lock} is free.`];
  const lines = [`Lock ${state.lock} is held.`];
  if (!state.owner) {
    return [...lines, `It has no ${OWNER}: its holder is taking it this moment, or failed while taking it.`,
      `Held for ${duration(state.ageSeconds)}, by the lock directory's time.`];
  }
  lines.push(...state.owner.raw.split(/\r?\n/).filter(line => line.trim()).map(line => `  ${line.trim()}`));
  const byDirectory = state.ageFrom === 'mtime' ? `, by the lock directory's time (${OWNER} gives no ISO time)` : '';
  lines.push(`Held for ${duration(state.ageSeconds)}${byDirectory}.`);
  const { pid } = state.owner;
  if (!pid) lines.push(`${OWNER} records no pid.`);
  else if (state.legacyPid && state.pidAlive) {
    lines.push(`Its shell pid ${pid} still runs; a legacy lock records the shell that took it, so this says little.`);
  } else if (state.legacyPid) {
    lines.push(`Its shell pid ${pid} has exited, which says nothing: a legacy lock records the shell that took it, `
      + 'and that shell exits at once.');
  } else if (state.pidAlive) lines.push(`Its holder's pid ${pid} is running.`);
  else lines.push(`Its holder's pid ${pid} is not running: its session may have ended. Ask the user before removing `
    + 'a stale lock.');
  return lines;
}

function describeActive(active) {
  if (!active) return ["Could not list this machine's processes; check that ps works before measuring."];
  if (!active.length) return ['Measurement processes running: none.'];
  return ['Measurement processes running:',
    ...active.map(each => `  pid ${each.pid}, ${each.elapsed}, ${each.kind}: ${each.summary}`)];
}

function status({ lock, json, now, isAlive, rows, self }) {
  const state = readLock(lock, { now, isAlive });
  let active = null, failure = null;
  try {
    active = activeMeasurementProcesses({ self, rows: rows() });
  } catch (error) {
    failure = `Could not list this machine's processes (${error.message}), so nobody can tell whether it is quiet; `
      + 'check that ps works before measuring.';
  }
  if (json) {
    const owner = state.owner && Object.fromEntries(Object.entries(state.owner)
      .map(([name, value]) => [name, typeof value === 'string' ? redact(value) : value]));
    const report = { lock: redact(state.lock), held: state.held, owner, ageSeconds: state.ageSeconds,
      pidAlive: state.pidAlive, active };
    return { code: failure ? 1 : 0, json: report, lines: [], failure };
  }
  const take = state.held ? [] : [`Take it with: ${TOOL} acquire --agent <name> --task "<what you will measure>"`];
  const lines = [...describeLock(state), ...(active ? describeActive(active) : []), ...take];
  return { code: failure ? 1 : 0, lines, failure };
}

function acquire({ lock, home, agent, task, now, isAlive, rows, self, hostname, holder }) {
  const parent = path.dirname(lock), checkout = path.dirname(parent);
  if (!existsSync(parent)) {
    if (!existsSync(checkout)) {
      return { code: 1, lines: [`The lock's checkout ${checkout} does not exist on this machine, so the lock ${lock} `
        + 'cannot be made there. Set PERF_LOCK (or pass --lock) to a lock directory whose parent exists, the one every '
        + 'agent on this machine uses, and acquire again.'] };
    }
    try {
      mkdirSync(parent);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const session = holder();
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const state = readLock(lock, { now, isAlive });
    const mine = state.agent === agent ? [`It is held under the name you gave, ${agent}: if that is you, you hold it `
      + 'already, so measure and then release it; if not, two agents share that name, so choose another.'] : [];
    return { code: 1, lines: [...describeLock(state), ...mine, 'This agent did not take it. Wait for its holder to '
      + `release it (${TOOL} status shows when it is free). Never take over or remove another agent's lock, even when `
      + 'its pid is dead: ask the user before removing a stale lock.'] };
  }
  const times = localTimes(now);
  const text = [`agent: ${agent}`, `task: ${task}`, `started: ${times.date} (${times.iso})`,
    `pid: ${session.pid} (${session.name})`, `host: ${hostname}`, ''].join('\n');
  const ownerFile = path.join(lock, OWNER);
  try {
    writeFileSync(ownerFile, text, { flag: 'wx' });
  } catch (error) {
    // This run made the directory a moment ago, so it is this run's to undo.
    try { unlinkSync(ownerFile); } catch { /* Never written. */ }
    rmdirSync(lock);
    throw error;
  }
  let active = null;
  try {
    active = activeMeasurementProcesses({ self, rows: rows() });
  } catch { /* The lock is taken all the same; describeActive says to check ps. */ }
  const busy = active?.length ? ['Measure only once they have finished.'] : [];
  const where = lock === homeLock(home) ? '' : ` --lock ${quote(lock)}`;
  return { code: 0, lines: [`Took the lock ${lock}:`, ...text.trim().split('\n').map(line => `  ${line}`),
    ...describeActive(active), ...busy, `Release it when you are done: ${TOOL} release --agent ${quote(agent)}${where}`] };
}

function release({ lock, agent, now, isAlive }) {
  const state = readLock(lock, { now, isAlive });
  if (!state.held) {
    return { code: 1, lines: [`There is no lock at ${lock}, so there is nothing to release. Check the path you meant `
      + '(--lock or PERF_LOCK).'] };
  }
  if (state.agent !== agent) {
    return { code: 1, lines: [...describeLock(state), `It is not held by ${agent}, so it stays. Only its holder releases `
      + 'a lock, giving its agent line exactly as above; if that is you, release with that name. Otherwise leave it, and '
      + 'ask the user before removing a stale lock.'] };
  }
  const others = readdirSync(lock).filter(name => name !== OWNER);
  if (others.length) {
    return { code: 1, lines: [`The lock ${lock} holds ${others.join(', ')} besides ${OWNER}, so it stays: release `
      + `removes only its own ${OWNER}. If you put them there, move them out and release again; otherwise ask the user `
      + 'what they are.'] };
  }
  const ownerFile = path.join(lock, OWNER);
  const bytes = readFileSync(ownerFile);
  unlinkSync(ownerFile);
  try {
    rmdirSync(lock);
  } catch (error) {
    writeFileSync(ownerFile, bytes, { flag: 'wx' });
    return { code: 1, lines: [`Could not remove ${lock} (${error.code}): something appeared in it while releasing. `
      + `Its ${OWNER} is back, so it is still held; look at what is in it, and ask the user.`] };
  }
  return { code: 0, lines: [`Released the lock ${lock}.`] };
}

/**
 * The command line; returns its exit code. `ports` stand in for the machine in tests: env and home (the default
 * lock), stdout and stderr (text sinks), now (a Date), hostname, self (this pid), holder (the { pid, name } to record),
 * listProcesses (rows like parsePs's) and isAlive (pid → boolean).
 */
export function main(argv = process.argv.slice(2), ports = {}) {
  const stdout = ports.stdout ?? (text => process.stdout.write(text));
  const stderr = ports.stderr ?? (text => process.stderr.write(text));
  const print = (sink, lines) => { if (lines.length) sink(`${lines.map(redact).join('\n')}\n`); };
  const usage = problem => { print(stderr, [problem, USAGE]); return 2; };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      lock: { type: 'string' }, agent: { type: 'string' }, task: { type: 'string' },
      json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
    } });
  } catch (error) {
    return usage(error.message);
  }
  const { values: args, positionals: [command, ...extra] } = parsed;
  if (args.help) {
    print(stdout, [USAGE]);
    return 0;
  }
  if (!['status', 'acquire', 'release'].includes(command)) {
    return usage(command ? `Unknown command ${command}.` : 'Name a command.');
  }
  if (extra.length) return usage(`Unexpected ${extra.join(' ')}.`);
  if (args.json && command !== 'status') return usage('--json goes with status.');
  const agent = oneLine(args.agent), task = oneLine(args.task);
  if (command !== 'status' && !agent) return usage(`${command} needs --agent <name>.`);
  if (command === 'acquire' && !task) return usage('acquire needs --task "<what you will measure>".');
  const home = ports.home ?? os.homedir();
  const context = {
    lock: args.lock ? path.resolve(args.lock) : defaultLockPath({ env: ports.env ?? process.env, home }),
    home, agent, task, json: args.json, now: ports.now?.() ?? new Date(), isAlive: ports.isAlive ?? isProcessAlive,
    self: ports.self ?? process.pid, rows: ports.listProcesses ?? listProcesses, hostname: ports.hostname ?? os.hostname(),
    holder: ports.holder ?? (() => lockHolderProcess()),
  };
  try {
    const result = { status, acquire, release }[command](context);
    if (result.json) stdout(`${JSON.stringify(result.json, null, 2)}\n`);
    print(result.code === 0 || command === 'status' ? stdout : stderr, result.lines);
    if (result.failure) print(stderr, [result.failure]);
    return result.code;
  } catch (error) {
    print(stderr, [`perf-lock ${command} failed: ${error.message}. It never takes over or removes another agent's `
      + 'lock; run status to see where the lock stands.']);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main();
