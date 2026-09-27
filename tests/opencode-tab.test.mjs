// Tests for opencode-tab.sh: the argument gate, the kitty gate, and the
// three-part start proof (beacon, a new session row in --cwd, its model).
//
// Same method as omp-tab.test.mjs: a PATH stub for `kitty` records launch and
// close-window and serves one live window, `sleep` is a no-op, and the
// opencode store is a temp SQLite file whose `session` table has the columns
// the script reads. The presence command is a stub that prints a fixture.
//
// Run: node --test tests/opencode-tab.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/opencode-tab.sh', import.meta.url));
const WID = 992001;
const MODEL = 'opencode/muse-spark-1.3-contributor-free';

let binDir, stateDir, cwd, brief, db, launcher;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-state-'));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-cwd-'));
  brief = path.join(stateDir, 'brief.md');
  await fs.writeFile(brief, '# Brief\n');
  db = path.join(stateDir, 'opencode.db');
  launcher = path.join(stateDir, 'opencode-launch.sh');
  await fs.writeFile(launcher, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const lsJson = `[{"tabs":[{"windows":[{"id":${WID},"pid":${process.pid}}]}]}]`;
  await fs.writeFile(
    path.join(binDir, 'kitty'),
    [
      '#!/usr/bin/env bash',
      `state=${JSON.stringify(stateDir)}`,
      'case "$1/$2" in',
      '  @/ls) [ -f "$state/nokitty" ] && exit 1',
      '        if [ -f "$state/gone" ]; then echo "[]"; else printf \'%s\\n\' ' + JSON.stringify(lsJson) + '; fi ;;',
      '  @/launch) printf \'%s\\n\' "$@" > "$state/launch-args"; echo ' + WID + ' ;;',
      '  @/close-window) printf \'%s\\n\' "$*" > "$state/closed" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(
    path.join(binDir, 'presence'),
    `#!/usr/bin/env bash\ncat ${JSON.stringify(path.join(stateDir, 'presence.json'))} 2>/dev/null\n`,
    { mode: 0o755 },
  );
});

after(async () => {
  for (const d of [binDir, stateDir, cwd]) await fs.rm(d, { recursive: true, force: true });
});

// Fresh store and state for each test; `session` rows are what opencode
// writes when the TUI starts in a directory.
beforeEach(async () => {
  for (const f of ['launch-args', 'closed', 'nokitty', 'gone', 'presence.json', 'omp-tab-launched.' + os.userInfo().uid]) {
    await fs.rm(path.join(stateDir, f), { force: true });
  }
  await fs.rm(db, { force: true });
  const d = new DatabaseSync(db);
  d.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, parent_id TEXT, time_created INTEGER)');
  d.close();
});

const addSession = (id, model, { dir = cwd, parent = null, at = Date.now() + 60_000 } = {}) => {
  const [providerID, mid] = model.split('/');
  const d = new DatabaseSync(db);
  d.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(id, dir, JSON.stringify({ id: mid, providerID }), parent, at);
  d.close();
};
const beacon = (windowId) =>
  fs.writeFile(path.join(stateDir, 'presence.json'), JSON.stringify({ beacons: [{ sessionId: 'x', windowId }] }));

const tab = async (args) => {
  try {
    const r = await run('bash', [SCRIPT, ...args], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        XDG_RUNTIME_DIR: stateDir,
        CLAUDE_SESSION_ID: 'test-launcher',
        OPENCODE_TAB_LAUNCH: launcher,
        OPENCODE_TAB_DB: db,
        OPENCODE_TAB_PRESENCE: path.join(binDir, 'presence'),
        OMP_TAB_TASK_CLAIM: path.join(stateDir, 'no-claim-cli.mjs'),
      }),
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout, err: e.stderr };
  }
};
const exists = (f) => fs.access(path.join(stateDir, f)).then(() => true, () => false);
const full = () => ['--title', 'opencode: test', '--brief', brief, '--model', MODEL, '--cwd', cwd];

test('--help prints the usage block and nothing else', async () => {
  const r = await tab(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage:/);
  assert.doesNotMatch(r.out, /HELP-(BEGIN|END)/);
});

test('--model is required, and nothing is launched without it', async () => {
  const r = await tab(['--title', 't', '--brief', brief, '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--model is required/);
  assert.equal(await exists('launch-args'), false);
});

test('a relative --brief is refused', async () => {
  const r = await tab(['--title', 't', '--brief', 'brief.md', '--model', MODEL, '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--brief must be absolute/);
});

test('no kitty remote control exits 2', async () => {
  await fs.writeFile(path.join(stateDir, 'nokitty'), '');
  const r = await tab(full());
  assert.equal(r.code, 2);
  assert.equal(await exists('launch-args'), false);
});

test('beacon + a new session on the asked model: exit 0, SESSION printed, state row written', async () => {
  await beacon(WID);
  addSession('ses_other_dir', MODEL, { dir: '/elsewhere' });
  addSession('ses_child', MODEL, { parent: 'ses_new' });
  addSession('ses_new', MODEL);
  const r = await tab(full());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^WINDOW_ID=${WID}$`, 'm'));
  assert.match(r.out, /^SESSION=ses_new$/m);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^--model\nopencode\/muse-spark-1\.3-contributor-free$/m);
  assert.match(args, new RegExp(`^Read ${brief} and carry it out`, 'm'));
  const row = await fs.readFile(path.join(stateDir, 'omp-tab-launched.' + os.userInfo().uid), 'utf8');
  assert.equal(row, `${WID} ${process.pid} @test-launcher opencode: test\n`);
  assert.equal(await exists('closed'), false);
});

test('a session on another model closes the window and exits 3', async () => {
  await beacon(WID);
  addSession('ses_wrong', 'opencode/some-other-model');
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /is on model opencode\/some-other-model but was launched as/);
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${WID}`));
  const rows = await fs.readFile(path.join(stateDir, 'omp-tab-launched.' + os.userInfo().uid), 'utf8');
  assert.equal(rows, '');
});

test('no beacon for the window: exit 3, window left open for a look', async () => {
  await beacon(WID + 1);
  addSession('ses_new', MODEL);
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /not proven within 90 s \(beacon=0 session=ses_new\)/);
  assert.equal(await exists('closed'), false);
});

test('a session older than the launch is not taken as proof', async () => {
  await beacon(WID);
  addSession('ses_old', MODEL, { at: Date.now() - 600_000 });
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /session=none/);
});

test('--close closes a launched window and drops the beacons naming it', async () => {
  const sbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-sb-'));
  const env = isolatedEnv({ AGENT_SWITCHBOARD_DIR: sbDir });
  const lib = fileURLToPath(new URL('../lib/presence.mjs', import.meta.url));
  const node = (code) => run(process.execPath, ['--input-type=module', '-e', code, lib], { env });
  await node(`const p = await import(process.argv[1]);
    p.recordPresence({ cwd: '/a', sessionId: 'ses_tab', windowId: ${WID} });
    p.recordPresence({ cwd: '/b', sessionId: 'ses_other', windowId: ${WID + 5} });`);
  await fs.writeFile(path.join(stateDir, 'omp-tab-launched.' + os.userInfo().uid), `${WID} ${process.pid} @test-launcher opencode: test\n`);
  let r;
  try {
    r = await run('bash', [SCRIPT, '--close', String(WID)], {
      env: { ...env, PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir, CLAUDE_SESSION_ID: 'test-launcher' },
    });
  } catch (e) {
    assert.fail(`--close failed: ${e.stderr}`);
  }
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${WID}`));
  const left = await node(`const p = await import(process.argv[1]);
    console.log(p.readAllPresence().map((b) => b.sessionId).join(','));`);
  assert.equal(left.stdout.trim(), 'ses_other');
  await fs.rm(sbDir, { recursive: true, force: true });
});

test('--close of a window it did not launch is refused and drops nothing', async () => {
  const sbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-sb-'));
  const env = isolatedEnv({ AGENT_SWITCHBOARD_DIR: sbDir });
  const lib = fileURLToPath(new URL('../lib/presence.mjs', import.meta.url));
  const node = (code) => run(process.execPath, ['--input-type=module', '-e', code, lib], { env });
  await node(`const p = await import(process.argv[1]); p.recordPresence({ cwd: '/a', sessionId: 'ses_tab', windowId: ${WID} });`);
  const r = await run('bash', [SCRIPT, '--close', String(WID)], {
    env: { ...env, PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir },
  }).then(() => ({ code: 0 }), (e) => ({ code: e.code }));
  assert.notEqual(r.code, 0);
  assert.equal(await exists('closed'), false);
  const left = await node(`const p = await import(process.argv[1]); console.log(p.readAllPresence().length);`);
  assert.equal(left.stdout.trim(), '1');
  await fs.rm(sbDir, { recursive: true, force: true });
});
