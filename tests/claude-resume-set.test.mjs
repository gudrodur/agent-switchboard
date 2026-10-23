// Tests for claude-resume-set.sh: the snapshot of live sessions (registry pid
// alive with the same procStart, interactive only) and the replay through
// claude-tab.sh --resume, which skips a session that is live already.
//
// Live processes are real: a `node` sleeper whose argv carries the flags the
// snapshot reads off /proc/<pid>/cmdline. `kitty` is a PATH stub serving the
// tab titles; the launcher is a stub that records its args (CLAUDE_RESUME_SET_TAB).
//
// Run: node --test tests/claude-resume-set.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/claude-resume-set.sh', import.meta.url));
const LIVE = '11111111-1111-4111-8111-111111111111';
const BRIDGED = '22222222-2222-4222-8222-222222222222';
const DEAD = '33333333-3333-4333-8333-333333333333';
const RECYCLED = '44444444-4444-4444-8444-444444444444';
const SDK = '55555555-5555-4555-8555-555555555555';

let root, binDir, sessions, projects, snapDir, cwd, flagged, plain;

const sleeper = (...argv) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', '--', ...argv], { stdio: 'ignore' });
const procStart = async (pid) => {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};
const record = (pid, sessionId, extra = {}) =>
  fs.writeFile(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, kind: 'interactive', ...extra }));

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crs-'));
  binDir = path.join(root, 'bin');
  sessions = path.join(root, 'sessions');
  projects = path.join(root, 'projects');
  snapDir = path.join(root, 'snap');
  cwd = path.join(root, 'work', 'samtak-spjall');
  await fs.mkdir(binDir);
  await fs.mkdir(cwd, { recursive: true });
  flagged = sleeper('--model', 'sonnet', '--remote-control', 'fedora', '--resume', LIVE, 'hello');
  plain = sleeper();
  await new Promise((r) => setTimeout(r, 200));
  const ls = [{ tabs: [{ title: 'claude: fedora', windows: [{ id: 7, foreground_processes: [{ pid: flagged.pid }] }] }] }];
  await fs.writeFile(
    path.join(binDir, 'kitty'),
    `#!/usr/bin/env bash\n[ -f ${JSON.stringify(path.join(root, 'nokitty'))} ] && exit 1\nprintf '%s\\n' ${JSON.stringify(JSON.stringify(ls))}\n`,
    { mode: 0o755 },
  );
  // The launcher stub: records its args, exits with $root/tab-code (default 0).
  await fs.writeFile(
    path.join(binDir, 'tab'),
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(path.join(root, 'tab-calls'))}`,
      'echo WINDOW_ID=4242',
      `exit "$(cat ${JSON.stringify(path.join(root, 'tab-code'))} 2>/dev/null || echo 0)"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
});

after(async () => {
  flagged.kill();
  plain.kill();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const d of [sessions, projects, snapDir]) await fs.rm(d, { recursive: true, force: true });
  for (const f of ['tab-calls', 'tab-code', 'nokitty']) await fs.rm(path.join(root, f), { force: true });
  await fs.mkdir(sessions, { recursive: true });
});

const set = async (args) => {
  try {
    const r = await run('bash', [SCRIPT, ...args], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        CLAUDE_SESSIONS_DIR: sessions,
        CLAUDE_PROJECTS_DIR: projects,
        CLAUDE_RESUME_SET_DIR: snapDir,
        CLAUDE_RESUME_SET_TAB: path.join(binDir, 'tab'),
      }),
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout, err: e.stderr };
  }
};
const latest = async () => JSON.parse(await fs.readFile(path.join(snapDir, 'latest.json'), 'utf8'));
const transcript = async (sessionId, model) => {
  const dir = path.join(projects, cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'assistant', cwd, message: { model } }) + '\n');
};

test('--snapshot keeps only live interactive sessions: a dead pid, a recycled pid and an sdk session are left out', async () => {
  await record(flagged.pid, LIVE, { procStart: await procStart(flagged.pid) });
  await record(4194300, DEAD, { procStart: '1' });
  await record(plain.pid, RECYCLED, { procStart: '1' });
  await fs.writeFile(
    path.join(sessions, 'sdk.json'),
    JSON.stringify({ pid: plain.pid, sessionId: SDK, cwd, kind: 'sdk-cli', procStart: await procStart(plain.pid) }),
  );
  const r = await set(['--snapshot']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^SNAPSHOT=${snapDir}/latest\\.json$`, 'm'));
  const snap = await latest();
  assert.deepEqual(snap.sessions, [
    { sessionId: LIVE, cwd, model: 'sonnet', rc: true, rcName: 'fedora', title: 'claude: fedora', pid: flagged.pid },
  ]);
  const md = await fs.readFile(path.join(snapDir, 'latest.md'), 'utf8');
  assert.match(md, new RegExp(`--remote-control 'fedora' --resume ${LIVE}`));
  assert.equal((await fs.readdir(snapDir)).filter((f) => /^snapshot-.*\.json$/.test(f)).length, 1);
});

test('--snapshot takes the model from the transcript and turns RC on from a bridge id, named after the cwd', async () => {
  await record(plain.pid, BRIDGED, { procStart: await procStart(plain.pid), bridgeSessionId: 'session_01X' });
  await transcript(BRIDGED, 'claude-opus-5-5');
  const r = await set(['--snapshot']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual((await latest()).sessions, [
    { sessionId: BRIDGED, cwd, model: 'claude-opus-5-5', rc: true, rcName: 'samtak-spjall', title: 'claude: samtak-spjall', pid: plain.pid },
  ]);
});

test('--snapshot leaves out a session with no model to resume on, and says so', async () => {
  await record(plain.pid, BRIDGED, { procStart: await procStart(plain.pid) });
  const r = await set(['--snapshot']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /no --model and no assistant turn — left out/);
  assert.deepEqual((await latest()).sessions, []);
});

const snapshotFile = async (rows) => {
  await fs.mkdir(snapDir, { recursive: true });
  const f = path.join(snapDir, 'latest.json');
  await fs.writeFile(f, JSON.stringify({ snapshotAt: 'x', sessions: rows }));
  return f;
};
const row = (sessionId, extra = {}) => ({ sessionId, cwd, model: 'opus', rc: false, rcName: null, title: 'claude: t', pid: 1, ...extra });

test('--replay resumes each row through claude-tab.sh and skips one that is live already', async () => {
  await record(flagged.pid, LIVE, { procStart: await procStart(flagged.pid) });
  await snapshotFile([row(LIVE), row(DEAD, { rc: true, rcName: 'xj greenfield' })]);
  const r = await set(['--replay']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^SKIP ${LIVE} live in pid ${flagged.pid}$`, 'm'));
  assert.match(r.out, new RegExp(`^OK ${DEAD} WINDOW_ID=4242$`, 'm'));
  const calls = await fs.readFile(path.join(root, 'tab-calls'), 'utf8');
  assert.equal(calls, `--resume ${DEAD} --title claude: t --model opus --rc xj greenfield\n`);
});

test('--replay exits 3 when a row is launched but not proven', async () => {
  await snapshotFile([row(DEAD)]);
  await fs.writeFile(path.join(root, 'tab-code'), '3');
  const r = await set(['--replay']);
  assert.equal(r.code, 3);
  assert.match(r.out, new RegExp(`^UNPROVEN ${DEAD} WINDOW_ID=4242$`, 'm'));
});

test('--replay stops at once when kitty is down (exit 2)', async () => {
  await snapshotFile([row(DEAD), row(RECYCLED)]);
  await fs.writeFile(path.join(root, 'tab-code'), '2');
  const r = await set(['--replay']);
  assert.equal(r.code, 2);
  assert.equal((await fs.readFile(path.join(root, 'tab-calls'), 'utf8')).split('\n').filter(Boolean).length, 1);
});

test('--replay --dry-run prints the commands and launches nothing', async () => {
  await snapshotFile([row(DEAD)]);
  const r = await set(['--replay', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^WOULD .*/tab --resume ${DEAD} --title claude:\\\\ t --model opus$`, 'm'));
  await assert.rejects(fs.access(path.join(root, 'tab-calls')));
});

test('--replay with no snapshot is refused', async () => {
  const r = await set(['--replay']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no snapshot at/);
});

test('--help prints the usage block and nothing else', async () => {
  const r = await set(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage:/);
  assert.doesNotMatch(r.out, /HELP-(BEGIN|END)/);
});
