import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newOutputDirectory } from '../scripts/lib/outputDirectory.mjs';
import {
  activeMeasurementProcesses, classifyCommand, defaultLockPath, isProcessAlive, lockHolderProcess, main, parseOwner,
  parsePs, processTree, readLock, redact, summarize,
} from '../scripts/benchmarks/startup-audit/perf-lock.mjs';

const tool = fileURLToPath(new URL('../scripts/benchmarks/startup-audit/perf-lock.mjs', import.meta.url));
const research = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.join(research, 'build', 'tmp');
const fixture = () => newOutputDirectory('source-helper-cases', 'perf-lock');
// A home with no fly checkout: a test that forgot --lock could never reach a real lock.
const nowhere = path.join(research, 'build', 'source-helper-cases', 'perf-lock-no-home');
const NOW = new Date('2026-10-24T20:00:00Z');

/** The command line in this process, with the machine faked: no ps, no real pids, a fixed clock. */
function run(argv, ports = {}) {
  let stdout = '', stderr = '';
  const code = main(argv, {
    env: {}, home: nowhere, stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
    now: () => NOW, hostname: 'test-host', self: 5000, holder: () => ({ pid: 4242, name: 'claude' }),
    isAlive: pid => pid === 4242, listProcesses: () => [], ...ports,
  });
  return { code, stdout, stderr, output: stdout + stderr };
}

const LEGACY = 'agent: perf-oct24 (Claude Code session resuming 0SFS/FOSS Earth performance work)\n'
  + 'task: fresh baseline profiles and exact-output optimization A/Bs\n'
  + 'started: Sat Oct 24 15:55:09 CDT 2026\n'
  + 'shell pid: 69184\n';

// One machine's process table: this status process (5000) under an ab.mjs run (4000) in a Claude session (3000);
// another agent's profile.mjs under caffeinate with its headless Chrome and a renderer; a vite build; a third
// agent's ab.mjs run (9000) with its own profile.mjs and Chrome; the user's own Chrome; an editor on profile.mjs.
// The key gkey=abc123 must never reach any output.
const HOME = '/Users/someone';
const PROFILE = `${HOME}/gh/foss-earth/research/scripts/benchmarks/startup-audit/profile.mjs`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RENDERER = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/130.0.6723.117'
  + '/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)';
const PS = [
  '    1     0 10-16:05:52 /sbin/launchd',
  ` 3000     1    01:43:09 ${HOME}/.vscode/extensions/anthropic.claude-code-2.1.299-darwin-arm64/resources/native-binary/claude`,
  ` 4000  3000       12:00 /opt/homebrew/bin/node ${HOME}/gh/foss-earth/research/scripts/benchmarks/startup-audit/ab.mjs --label mine`,
  ' 5000  4000       00:01 /opt/homebrew/bin/node scripts/benchmarks/startup-audit/perf-lock.mjs status',
  ' 5001  5000       00:00 ps -axwwo pid=,ppid=,etime=,command=',
  ` 7000  3000       02:10 caffeinate -i node ${PROFILE} --target fly --root ${HOME}/gh/0sfs/fly/build/perf/oct24-pk`
    + ' --query set.tiles.gkey=abc123',
  ` 7001  7000       02:10 /opt/homebrew/bin/node ${PROFILE} --target fly --root ${HOME}/gh/0sfs/fly/build/perf/oct24-pk`
    + ' --query set.tiles.gkey=abc123',
  ` 7002  7001       02:05 ${CHROME} --headless=new --remote-debugging-pipe --user-data-dir=${HOME}/gh/foss-earth/research/build`
    + '/benchmarks/startup-audit/profile-fly/2026-10-24_182422/chrome-profile https://tile.googleapis.com/v1/3dtiles/root.json?gkey=abc123',
  ` 7003  7002       02:04 ${RENDERER} --type=renderer --headless --lang=en-US --renderer-client-id=7`,
  ` 7100     1  1-02:03:04 ${CHROME}`,
  ` 7200  3000       00:30 vim ${PROFILE}`,
  ` 8000  3000       00:42 /opt/homebrew/bin/node ${HOME}/gh/0sfs/fly/node_modules/.bin/vite build --sourcemap --outDir build/perf/x`,
  ` 9000  3000       05:00 /opt/homebrew/bin/node ${HOME}/gh/foss-earth/research/scripts/benchmarks/startup-audit/ab.mjs --label theirs`,
  ` 9001  9000       01:00 caffeinate -i node ${PROFILE} --target app`,
  ` 9002  9001       00:59 ${CHROME} --headless=new --remote-debugging-pipe`,
].join('\n');

test('acquire, status and release a temporary lock', () => {
  const lock = path.join(fixture(), 'test.lock');
  const taken = run(['acquire', '--agent', 'tester', '--task', 'fly 4x A/B', '--lock', lock]);
  assert.equal(taken.code, 0, taken.output);
  const lines = readFileSync(path.join(lock, 'owner.txt'), 'utf8').split('\n');
  assert.equal(lines[0], 'agent: tester');
  assert.equal(lines[1], 'task: fly 4x A/B');
  // `date`'s form, then the same instant in ISO 8601 with this machine's offset.
  const started = /^started: ([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \S+ \d{4}) \((.+)\)$/.exec(lines[1 + 1]);
  assert.ok(started, lines[2]);
  assert.match(started[2], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(started[2]), NOW.getTime());
  assert.deepEqual(lines.slice(3), ['pid: 4242 (claude)', 'host: test-host', '']);
  assert.match(taken.stdout, /Took the lock/);
  assert.match(taken.stdout, new RegExp(`release --agent tester --lock ${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

  const later = () => new Date(NOW.getTime() + 90000);
  const shown = run(['status', '--lock', lock], { now: later });
  assert.equal(shown.code, 0, shown.output);
  assert.match(shown.stdout, /is held\.\n {2}agent: tester\n {2}task: fly 4x A\/B\n/);
  assert.match(shown.stdout, /Held for 1 min\./);
  assert.match(shown.stdout, /holder's pid 4242 is running/);
  assert.match(shown.stdout, /Measurement processes running: none\./);

  const report = JSON.parse(run(['status', '--json', '--lock', lock], { now: later }).stdout);
  assert.deepEqual(Object.keys(report), ['lock', 'held', 'owner', 'ageSeconds', 'pidAlive', 'active']);
  assert.deepEqual(report.owner, { agent: 'tester', task: 'fly 4x A/B', started: `${started[1]} (${started[2]})`, pid: 4242,
    host: 'test-host', raw: lines.join('\n') });
  assert.equal(report.lock, lock);
  assert.equal(report.held, true);
  assert.equal(report.ageSeconds, 90);
  assert.equal(report.pidAlive, true);
  assert.deepEqual(report.active, []);

  const released = run(['release', '--agent', 'tester', '--lock', lock]);
  assert.equal(released.code, 0, released.output);
  assert.equal(existsSync(lock), false);
  const free = JSON.parse(run(['status', '--json', '--lock', lock]).stdout);
  assert.deepEqual(free, { lock, held: false, owner: null, ageSeconds: null, pidAlive: null, active: [] });
  assert.match(run(['status', '--lock', lock]).stdout, /is free\.[^]*Take it with: node scripts\/benchmarks\/startup-audit\/perf-lock\.mjs acquire/);
});

test('a second acquire is refused and leaves the holder\'s lock as it was, even when the holder\'s pid is dead', () => {
  const lock = path.join(fixture(), 'test.lock');
  assert.equal(run(['acquire', '--agent', 'first', '--task', 'one', '--lock', lock]).code, 0);
  const before = readFileSync(path.join(lock, 'owner.txt'));
  for (const alive of [true, false]) {
    const second = run(['acquire', '--agent', 'second', '--task', 'two', '--lock', lock], { isAlive: () => alive });
    assert.equal(second.code, 1, second.output);
    assert.match(second.stderr, /is held\.\n {2}agent: first\n/);
    assert.match(second.stderr, alive ? /pid 4242 is running/ : /pid 4242 is not running/);
    assert.match(second.stderr, /ask the user before removing a stale lock/);
    assert.deepEqual(readFileSync(path.join(lock, 'owner.txt')), before);
    assert.deepEqual(readdirSync(lock), ['owner.txt']);
  }
  const again = run(['acquire', '--agent', 'first', '--task', 'one again', '--lock', lock]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /held under the name you gave, first/);
  assert.deepEqual(readFileSync(path.join(lock, 'owner.txt')), before);
});

test('release is refused for another agent, for a lock holding another file, and with nothing to release', () => {
  const lock = path.join(fixture(), 'test.lock');
  const ownerFile = path.join(lock, 'owner.txt');
  assert.equal(run(['acquire', '--agent', 'holder', '--task', 'one', '--lock', lock]).code, 0);
  const before = readFileSync(ownerFile);

  const other = run(['release', '--agent', 'someone-else', '--lock', lock]);
  assert.equal(other.code, 1, other.output);
  assert.match(other.stderr, /not held by someone-else, so it stays/);
  assert.deepEqual(readFileSync(ownerFile), before);

  writeFileSync(path.join(lock, 'notes.txt'), 'someone keeps notes here\n');
  const crowded = run(['release', '--agent', 'holder', '--lock', lock]);
  assert.equal(crowded.code, 1, crowded.output);
  assert.match(crowded.stderr, /holds notes\.txt besides owner\.txt, so it stays/);
  assert.deepEqual(readdirSync(lock).sort(), ['notes.txt', 'owner.txt']);
  assert.deepEqual(readFileSync(ownerFile), before);
  assert.equal(readFileSync(path.join(lock, 'notes.txt'), 'utf8'), 'someone keeps notes here\n');

  const nothing = run(['release', '--agent', 'holder', '--lock', path.join(path.dirname(lock), 'never-taken.lock')]);
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /nothing to release/);
});

test('a legacy owner file is read: its shell pid, its date-only start, aged by the directory\'s time', () => {
  const lock = path.join(fixture(), 'test.lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner.txt'), LEGACY);
  const taken = new Date('2026-10-24T20:55:09Z');
  utimesSync(lock, taken, taken);
  const now = taken.getTime() + (3 * 3600 + 42 * 60) * 1000;
  const state = readLock(lock, { now, isAlive: () => false });
  const owner = { agent: 'perf-oct24 (Claude Code session resuming 0SFS/FOSS Earth performance work)',
    task: 'fresh baseline profiles and exact-output optimization A/Bs', started: 'Sat Oct 24 15:55:09 CDT 2026', pid: 69184,
    host: null, raw: LEGACY };
  assert.deepEqual(state, { lock, held: true, owner, ...owner, raw: undefined, ageSeconds: 3 * 3600 + 42 * 60, ageFrom: 'mtime',
    pidAlive: false, legacyPid: true }.raw === undefined ? { lock, held: true, owner, agent: owner.agent, task: owner.task,
    started: owner.started, pid: 69184, host: null, ageSeconds: 3 * 3600 + 42 * 60, ageFrom: 'mtime', pidAlive: false,
    legacyPid: true } : null);

  const shown = run(['status', '--lock', lock], { now: () => new Date(now), isAlive: () => false });
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /\n {2}shell pid: 69184\n/);
  assert.match(shown.stdout, /Held for 3 h 42 min, by the lock directory's time \(owner\.txt gives no ISO time\)\./);
  assert.match(shown.stdout, /shell pid 69184 has exited, which says nothing/);
  const report = JSON.parse(run(['status', '--json', '--lock', lock], { now: () => new Date(now), isAlive: () => false }).stdout);
  assert.deepEqual(report.owner, owner);
  assert.equal(report.ageSeconds, 3 * 3600 + 42 * 60);
  assert.equal(report.pidAlive, false);

  // The agent line must match exactly: its first word is not enough.
  assert.equal(run(['release', '--agent', 'perf-oct24', '--lock', lock]).code, 1);
  assert.equal(readFileSync(path.join(lock, 'owner.txt'), 'utf8'), LEGACY);
  assert.equal(run(['release', '--agent', owner.agent, '--lock', lock]).code, 0);
  assert.equal(existsSync(lock), false);
});

test('owner files: pid: wins over a legacy shell pid:, an ISO start sets the age, and a lock without one is held', () => {
  assert.deepEqual(parseOwner('agent: a\nshell pid: 1\npid: 2409 (claude)\nhost: h\n'),
    { agent: 'a', task: null, started: null, pid: 2409, host: 'h', raw: 'agent: a\nshell pid: 1\npid: 2409 (claude)\nhost: h\n' });
  assert.equal(parseOwner('pid: none\n').pid, null);

  const lock = path.join(fixture(), 'test.lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner.txt'), 'agent: a\nstarted: Sat Oct 24 15:55:09 CDT 2026 (2026-10-24T15:55:09-05:00)\npid: 7 (claude)\n');
  utimesSync(lock, new Date(0), new Date(0));
  const state = readLock(lock, { now: Date.parse('2026-10-24T20:55:19Z'), isAlive: () => true });
  assert.equal(state.ageSeconds, 10);
  assert.equal(state.ageFrom, 'started');
  assert.equal(state.legacyPid, false);
  assert.equal(state.pidAlive, true);

  const bare = path.join(fixture(), 'test.lock');
  mkdirSync(bare);
  const shown = run(['status', '--lock', bare]);
  assert.match(shown.stdout, /is held\.\nIt has no owner\.txt/);
  assert.equal(readLock(bare).agent, null);
  assert.equal(run(['release', '--agent', 'anyone', '--lock', bare]).code, 1);
  assert.equal(existsSync(bare), true);
});

test('acquire makes the lock\'s build/ only inside an existing checkout, else says to set PERF_LOCK', () => {
  const base = fixture();
  mkdirSync(path.join(base, 'fly'));
  const lock = path.join(base, 'fly', 'build', 'test.lock');
  assert.equal(run(['acquire', '--agent', 'a', '--task', 't', '--lock', lock]).code, 0);
  assert.deepEqual(readdirSync(lock), ['owner.txt']);

  const missing = path.join(base, 'no-checkout', 'build', 'test.lock');
  const refused = run(['acquire', '--agent', 'a', '--task', 't', '--lock', missing]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /does not exist on this machine[^]*Set PERF_LOCK/);
  assert.equal(existsSync(path.join(base, 'no-checkout')), false);
});

test('the lock is --lock, else PERF_LOCK, else the fly checkout\'s', () => {
  assert.equal(defaultLockPath({ env: {}, home: '/home/someone' }), '/home/someone/gh/0sfs/fly/build/perf-exclusive.lock');
  assert.equal(defaultLockPath({ env: { PERF_LOCK: '' }, home: '/home/someone' }), '/home/someone/gh/0sfs/fly/build/perf-exclusive.lock');
  assert.equal(defaultLockPath({ env: { PERF_LOCK: 'build/x.lock' }, home: '/h' }), path.resolve('build/x.lock'));

  const base = fixture();
  const viaEnv = path.join(base, 'env.lock'), viaFlag = path.join(base, 'flag.lock');
  assert.equal(run(['acquire', '--agent', 'a', '--task', 't', '--lock', viaFlag], { env: { PERF_LOCK: viaEnv } }).code, 0);
  assert.deepEqual([existsSync(viaFlag), existsSync(viaEnv)], [true, false]);
  const byEnv = run(['acquire', '--agent', 'a', '--task', 't'], { env: { PERF_LOCK: viaEnv } });
  assert.equal(byEnv.code, 0, byEnv.output);
  assert.equal(existsSync(viaEnv), true);
  assert.equal(run(['release', '--agent', 'a'], { env: { PERF_LOCK: viaEnv } }).code, 0);
  assert.equal(run(['release', '--agent', 'a', '--lock', viaFlag]).code, 0);
  assert.deepEqual(readdirSync(base), []);
  // Without either, the fly checkout's lock, which this fake home lacks: nothing is made.
  const home = run(['acquire', '--agent', 'a', '--task', 't']);
  assert.equal(home.code, 1);
  assert.match(home.stderr, /perf-lock-no-home\/gh\/0sfs\/fly does not exist/);
  assert.equal(existsSync(nowhere), false);
});

test('the holder pid is the Claude Code session, else the outermost ancestor that is not a terminal', () => {
  const walk = (start, table) => lockHolderProcess({ start, processInfo: pid => table[pid] ?? null });
  const vscode = {
    30729: { ppid: 2409, comm: '/bin/zsh' },
    2409: { ppid: 524, comm: '/Users/x/.vscode/extensions/anthropic.claude-code-2.1.299-darwin-arm64/resources/native-binary/claude' },
    524: { ppid: 491, comm: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)' },
    491: { ppid: 1, comm: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
  };
  assert.deepEqual(walk(30729, vscode), { pid: 2409, name: 'claude' });
  assert.deepEqual(walk(30729, { ...vscode, 2409: { ppid: 524, comm: '/Users/x/.local/share/claude/versions/2.1.270' } }),
    { pid: 2409, name: 'claude' });
  // The same editor without Claude Code: the integrated terminal's shell, not the editor.
  assert.deepEqual(walk(30729, { ...vscode, 2409: { ppid: 524, comm: '/bin/zsh' } }), { pid: 2409, name: 'zsh' });
  const terminal = {
    800: { ppid: 700, comm: '/bin/zsh' }, 700: { ppid: 600, comm: '-zsh' }, 600: { ppid: 500, comm: 'login' },
    500: { ppid: 1, comm: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
  };
  assert.deepEqual(walk(800, terminal), { pid: 700, name: '-zsh' });
  assert.deepEqual(walk(800, { 800: { ppid: 750, comm: 'bash' }, 750: { ppid: 1, comm: 'tmux' } }), { pid: 800, name: 'bash' });
  assert.deepEqual(walk(600, terminal), { pid: 600, name: 'login' });
  assert.deepEqual(walk(4321, {}), { pid: 4321, name: 'unknown' });
});

test('sample ps lines are classified: measurements by kind, everything else null', () => {
  const rows = parsePs(`${PS}\n`);
  assert.equal(rows.length, 15);
  assert.deepEqual(rows[3], { pid: 5000, ppid: 4000, etime: '00:01', command: '/opt/homebrew/bin/node scripts/benchmarks/startup-audit/perf-lock.mjs status' });
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.pid, classifyCommand(row.command)])), {
    1: null, 3000: null, 4000: 'ab.mjs', 5000: null, 5001: null, 7000: 'profile.mjs', 7001: 'profile.mjs',
    7002: 'headless Chrome', 7003: 'headless Chrome', 7100: null, 7200: null, 8000: 'vite build', 9000: 'ab.mjs',
    9001: 'profile.mjs', 9002: 'headless Chrome',
  });
  const kinds = {
    'node scripts/benchmarks/startup-audit/run.mjs --serve --runs 3': 'run.mjs',
    'node /x/startup-audit/pixels.mjs /x/dist build/pixels/x setting=renderer.experiments.all': 'pixels.mjs',
    'node /x/scripts/exactness/mutants.mjs build/x/spec.json --only slot': 'mutants.mjs',
    'sh -c vite build': 'vite build',
    'node /repo/node_modules/vite/bin/vite.js build --configLoader native': 'vite build',
    'npm exec vitest run tests/terrainHeightPixels.test.ts': 'vitest',
    'node /repo/node_modules/vitest/vitest.mjs run': 'vitest',
    'node /repo/node_modules/vitest/dist/workers/forks.js': 'vitest',
    '/usr/bin/chromium --headless --disable-gpu': 'headless Chrome',
    '/opt/chrome-headless-shell/chrome-headless-shell --remote-debugging-pipe': 'headless Chrome',
    'node /repo/node_modules/.bin/vite --port 5173': null,
    'node /x/startup-audit/ab-summary.mjs --label x --run before=/x/run.mjs': null,
    'node /x/startup-audit/profile-tree.mjs --profile x.cpuprofile': null,
    'node --test --test-concurrency=1 fixtures/perfLock.test.mjs': null,
    'node earth-compare/harness.mjs --headless --browser chrome': null,
    'cat vitest.config.ts': null,
    '': null,
  };
  for (const [command, kind] of Object.entries(kinds)) assert.equal(classifyCommand(command), kind, command);
});

test('redaction hides keys and tokens in URLs, assignments, quotes, encodings and Google key shapes', () => {
  const googleShape = `AIza${'x'.repeat(35)}`;
  const cases = {
    'http://localhost:4185/fly/?gkey=abc123&set.x=1': 'http://localhost:4185/fly/?gkey=<redacted>&set.x=1',
    'KEY=abc token=def Token=ghi': 'KEY=<redacted> token=<redacted> Token=<redacted>',
    'GOOGLE_3D_TILES_KEY=abc FOSS_EARTH_GOOGLE_KEY="def" x': 'GOOGLE_3D_TILES_KEY=<redacted> FOSS_EARTH_GOOGLE_KEY="<redacted>" x',
    "--query 'set.tiles.key=abc'": "--query 'set.tiles.key=<redacted>'",
    'u=https%3A%2F%2Ft.example%2Fr%3Fkey%3Dabc': 'u=https%3A%2F%2Ft.example%2Fr%3Fkey%3D<redacted>',
    [`{"key":"${googleShape}"}`]: '{"key":"<redacted>"}',
    'nothing secret: monkey business': 'nothing secret: monkey business',
  };
  for (const [text, redacted] of Object.entries(cases)) assert.equal(redact(text), redacted);
  assert.equal(redact(null), '');
});

test('status shows measurement processes outside its own tree as pid, time, kind and a short redacted summary', () => {
  const rows = parsePs(PS);
  const listProcesses = () => rows;
  const shown = run(['status', '--lock', path.join(fixture(), 'test.lock')], { listProcesses });
  const report = JSON.parse(run(['status', '--json', '--lock', path.join(fixture(), 'test.lock')], { listProcesses }).stdout);
  const lock = path.join(fixture(), 'test.lock');
  const taken = run(['acquire', '--agent', 'a', '--task', 'with gkey=abc123 in it', '--lock', lock], { listProcesses });
  const held = run(['status', '--lock', lock], { listProcesses });
  const heldReport = run(['status', '--json', '--lock', lock], { listProcesses });
  const refused = run(['acquire', '--agent', 'b', '--task', 't', '--lock', lock], { listProcesses });
  for (const output of [shown.output, JSON.stringify(report), taken.output, held.output, heldReport.output, refused.output]) {
    assert.doesNotMatch(output, /abc123/);
    assert.doesNotMatch(output, /tile\.googleapis\.com\/v1/);
    assert.doesNotMatch(output, /foss-earth\/research\/scripts/);
  }
  assert.match(held.output, /task: with gkey=<redacted> in it/);
  assert.equal(JSON.parse(heldReport.stdout).owner.task, 'with gkey=<redacted> in it');

  // Itself (5000), its ancestors (4000 and up) and its child (5001) are left out; helpers and wrapped scripts are
  // folded into the process above them of the same kind; the user's Chrome and the editor are not measurements.
  assert.deepEqual(report.active.map(each => [each.pid, each.ppid, each.kind, each.elapsed]), [
    [7000, 3000, 'profile.mjs', '02:10'], [7002, 7001, 'headless Chrome', '02:05'], [8000, 3000, 'vite build', '00:42'],
    [9000, 3000, 'ab.mjs', '05:00'], [9001, 9000, 'profile.mjs', '01:00'], [9002, 9001, 'headless Chrome', '00:59'],
  ]);
  for (const each of report.active) {
    assert.deepEqual(Object.keys(each), ['pid', 'ppid', 'kind', 'elapsed', 'summary']);
    assert.ok(each.summary.length <= 100, each.summary);
  }
  assert.equal(report.active[0].summary, 'caffeinate -i node …/startup-audit/profile.mjs --target fly --root …/perf/oct24-pk '
    + '--query set.tiles.gkey=<redacted>');
  assert.match(report.active[1].summary, /^Google Chrome --headless=new --remote-debugging-pipe --user-data-dir=…\/2026-10-24_182422\/chrome-pro/);
  assert.equal(report.active[2].summary, 'node …/.bin/vite build --sourcemap --outDir …/perf/x');
  assert.match(shown.stdout, /\n {2}pid 7000, 02:10, profile\.mjs: caffeinate -i node …\/startup-audit\/profile\.mjs --target fly/);
  assert.match(taken.stdout, /Measurement processes running:\n {2}pid 7000[^]*Measure only once they have finished\./);
});

test('activeMeasurementProcesses leaves out the trees under excluded pids, and processTree links rows', () => {
  const rows = parsePs(PS);
  const tree = processTree(rows);
  assert.deepEqual([...tree.ancestorsOf(5000)], [4000, 3000, 1]);
  assert.deepEqual([...tree.descendantsOf([9000])].sort(), [9000, 9001, 9002]);
  assert.deepEqual(activeMeasurementProcesses({ self: 5000, rows, exclude: new Set([9000]) }).map(each => each.pid), [7000, 7002, 8000]);
  assert.deepEqual(activeMeasurementProcesses({ self: 5000, rows, exclude: [9000, 7000] }).map(each => each.pid), [8000]);
  // A runner sees neither itself nor its own children, but does see its ancestors' other children.
  assert.deepEqual(activeMeasurementProcesses({ self: 9000, rows }).map(each => each.pid), [4000, 7000, 7002, 8000]);
  // pid 1 is never a root to exclude: everything descends from it.
  assert.deepEqual(activeMeasurementProcesses({ self: 5000, rows, exclude: [1, 0] }).length, 6);
  assert.equal(summarize('/opt/homebrew/bin/node /a/b/c/d.mjs --url=https://example.org/a/b?key=1 about:blank'),
    'node …/c/d.mjs --url=https://example.org/… about:blank');
  assert.equal(summarize(`node ${'x'.repeat(200)}`).length, 100);
});

test('a pid is alive while its process runs, and nothing but a positive pid is ever checked', () => {
  assert.equal(isProcessAlive(process.pid), true);
  const ended = spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, TMPDIR: tmp } });
  assert.equal(isProcessAlive(ended.pid), false);
  for (const pid of [0, -1, 1.5, Number.NaN, null, undefined, '123']) assert.equal(isProcessAlive(pid), false);
});

test('usage errors exit 2', () => {
  for (const argv of [[], ['frobnicate'], ['status', 'extra'], ['status', '--bogus'], ['acquire', '--task', 't'],
    ['acquire', '--agent', 'a'], ['acquire', '--agent', ' ', '--task', 't'], ['release'], ['release', '--agent', 'a', '--json']]) {
    const result = run(argv);
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.stderr, /Usage:/);
  }
  assert.equal(run(['--help']).code, 0);
});

test('the command line takes, reports and releases a lock under build/, recording a live session pid', () => {
  const lock = path.join(fixture(), 'test.lock');
  const env = { ...process.env, TMPDIR: tmp, PERF_LOCK: lock };
  const cli = (...args) => spawnSync(process.execPath, [tool, ...args], { env, encoding: 'utf8' });
  const taken = cli('acquire', '--agent', 'cli-test', '--task', 'nothing; a test of the lock');
  assert.equal(taken.status, 0, taken.stderr);
  const shown = cli('status', '--json');
  assert.equal(shown.status, 0, shown.stderr);
  const report = JSON.parse(shown.stdout);
  assert.equal(report.lock, lock);
  assert.equal(report.held, true);
  assert.equal(report.owner.agent, 'cli-test');
  assert.equal(report.owner.host, os.hostname());
  assert.match(report.owner.raw, /^pid: \d+ \(.+\)$/m);
  // An ancestor of the tool that outlives it: alive now, and neither the tool itself nor this test process.
  assert.equal(report.pidAlive, true);
  assert.notEqual(report.owner.pid, taken.pid);
  assert.ok(Array.isArray(report.active));
  assert.equal(cli('release', '--agent', 'someone-else').status, 1);
  assert.equal(existsSync(lock), true);
  const released = cli('release', '--agent', 'cli-test');
  assert.equal(released.status, 0, released.stderr);
  assert.equal(existsSync(lock), false);
  assert.equal(cli('frobnicate').status, 2);
});

test('two agents acquiring at once: exactly one takes the lock', async () => {
  const lock = path.join(fixture(), 'test.lock');
  const env = { ...process.env, TMPDIR: tmp, PERF_LOCK: lock };
  const attempt = agent => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tool, 'acquire', '--agent', agent, '--task', 'race'], { env, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  const codes = await Promise.all([attempt('one'), attempt('two')]);
  assert.deepEqual([...codes].sort(), [0, 1]);
  const winner = codes[0] === 0 ? 'one' : 'two';
  assert.equal(readLock(lock).agent, winner);
  assert.equal(spawnSync(process.execPath, [tool, 'release', '--agent', winner], { env }).status, 0);
  assert.equal(existsSync(lock), false);
});
