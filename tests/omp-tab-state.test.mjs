// Tests for omp-tab-state.sh: proof by STATE for a delegated omp tab.
// Fixtures copy the real session file's row shapes
// (2026-09-10 tab, session.../2026-09-10T09-13-32-324Z_01a08a97.jsonl):
// one JSON object per line, row 1 type:title, row 2 type:session with cwd
// and timestamp, then type:message rows (role user/assistant/toolResult,
// assistant rows carrying stopReason toolUse/stop) and type:custom rows
// (tool_execution_start with data.toolName, one session_exit with
// data.reason). Content is trimmed; the shapes are what the script reads.
//
// The kitty stub serves one canned window (id 991001, the test process pid,
// a fixed cwd, created_at now in ns); OMP_TAB_STATE_DIR points at a temp
// terminal-sessions dir; OMP_TAB_STATE_PTS_N overrides the /proc readlink.
//
// Run: node --test tests/omp-tab-state.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/omp-tab-state.sh', import.meta.url));
const WID = '991001';
const WCWD = path.join(os.tmpdir(), 'example-tab-state');

let binDir, sessDir;

const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();
const createdNs = () => String(Date.now() * 1e6);

// Row builders: the shapes the script reads, content trimmed.
const sessionRow = (cwd, ts) =>
  JSON.stringify({ type: 'session', version: 3, id: '01test', timestamp: ts, cwd });
const userRow = (text, ts) =>
  JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text }], timestamp: ts } });
const assistantRow = (stop, ts, calls = []) =>
  JSON.stringify({
    type: 'message', id: `a-${ts}`, message: {
      role: 'assistant',
      content: [...calls.map((n) => ({ type: 'toolCall', name: n })), { type: 'text', text: 'done' }],
      stopReason: stop, timestamp: ts,
    },
  });
const toolResultRow = (tool, ts) =>
  JSON.stringify({ type: 'message', id: `t-${ts}`, message: { role: 'toolResult', toolCallId: 'c1', toolName: tool, content: [{ type: 'text', text: 'ok' }] } });
const toolStartRow = (tool) =>
  JSON.stringify({ type: 'custom', customType: 'tool_execution_start', data: { toolCallId: 'c1', toolName: tool, startedAt: nowIso(), args: {}, intent: 'test' }, id: 's1', timestamp: nowIso() });
const exitRow = (reason = 'sighup') =>
  JSON.stringify({ type: 'custom', customType: 'session_exit', data: { reason, kind: 'signal', recordedAt: nowIso() }, id: 'e1', timestamp: nowIso() });
const titleRow = () =>
  JSON.stringify({ type: 'title', v: 1, title: 'test', source: 'auto', updatedAt: nowIso() });

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabstate-bin-'));
  sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabstate-sess-'));
  await fs.writeFile(path.join(sessDir, 'pid'), String(process.pid));
  const stub = [
    '#!/usr/bin/env bash',
    `state=${JSON.stringify(sessDir)}`,
    'if [ "$1/$2" = "@ /ls" ] || [ "$1" = "@" -a "$2" = "ls" ]; then',
    '  if [ -f "$state/no-window" ]; then printf \'[]\\n\'; exit 0; fi',
    '  pid=$(cat "$state/pid")',
    '  created=$(cat "$state/created" 2>/dev/null || date +%s%N)',
    `  printf '[{"tabs":[{"title":"mock","windows":[{"id":${WID},"title":"mock","pid":%s,"cwd":${JSON.stringify(WCWD)},"created_at":%s}]}]}]\\n' "$pid" "$created"`,
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'kitty'), stub, { mode: 0o755 });
  await fs.writeFile(path.join(sessDir, 'created'), createdNs());
});

after(async () => {
  await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(sessDir, { recursive: true, force: true }).catch(() => {});
});

const writeSession = (name, lines) =>
  fs.writeFile(path.join(sessDir, name), lines.join('\n') + '\n');
const linkKitty = (name) =>
  fs.writeFile(path.join(sessDir, `kitty-${WID}`), `${WCWD}\n${path.join(sessDir, name)}\n`);
const linkPts = (n, name) =>
  fs.writeFile(path.join(sessDir, `pts-${n}`), `${WCWD}\n${path.join(sessDir, name)}\n`);
const clearLinks = async () => {
  for (const f of await fs.readdir(sessDir)) {
    if (f.startsWith('kitty-') || f.startsWith('pts-') || f === 'no-window') {
      await fs.rm(path.join(sessDir, f), { force: true });
    }
  }
};

const runScript = async (args, extraEnv = {}) => {
  try {
    const r = await run(SCRIPT, args, {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '', ...extraEnv,
      }),
      timeout: 30_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

test('an assistant stop row at the tail reports idle', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('idle.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('do it', t - 9000), toolStartRow('bash'), toolResultRow('bash', t - 5000), assistantRow('stop', t - 1000)]);
  await linkKitty('idle.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=idle/);
});

test('a mid-turn tail reports busy with the tool name', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('busy.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('do it', t - 9000), toolStartRow('bash'), assistantRow('toolUse', t - 1000, ['bash'])]);
  await linkKitty('busy.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=busy/);
  assert.match(r.out, /tool=bash/);
});

test('a trailing user row reports busy', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('user.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), assistantRow('stop', t - 9000), userRow('one more thing', t - 1000)]);
  await linkKitty('user.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=busy/);
});

test('a session_exit tail reports exited', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('exit.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), assistantRow('stop', t - 9000), exitRow('sighup')]);
  await linkKitty('exit.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=exited/);
});

test('a cwd mismatch reports unknown, never another tab state', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('other.jsonl', [titleRow(), sessionRow(path.join(os.tmpdir(), 'example-project'), nowIso()), assistantRow('stop', t - 1000)]);
  await linkKitty('other.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=unknown/);
  assert.match(r.out, /reason=cwd-mismatch/);
});

test('a session older than the window reports unknown (pts reuse)', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('stale.jsonl', [titleRow(), sessionRow(WCWD, '2020-01-01T00:00:00.000Z'), assistantRow('stop', t - 1000)]);
  await linkKitty('stale.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=unknown/);
  assert.match(r.out, /reason=session-older-than-window/);
});

test('the kitty-<id> file wins over the pts file', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('kitty.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), assistantRow('stop', t - 1000)]);
  await writeSession('pts.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('steer me', t - 500)]);
  await linkKitty('kitty.jsonl');
  await linkPts('9', 'pts.jsonl');
  const r = await runScript([WID], { OMP_TAB_STATE_PTS_N: '9' });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=idle/);
  // And the pts file alone resolves when no kitty file exists.
  await fs.rm(path.join(sessDir, `kitty-${WID}`));
  const r2 = await runScript([WID], { OMP_TAB_STATE_PTS_N: '9' });
  assert.equal(r2.code, 0, `${r2.out}${r2.err}`);
  assert.match(r2.out, /state=busy/);
});

test('a kitty-<id> probe overwrite loses to the live pts file ', async () => {
  // The 2026-09-10 shape: the tab runs a nested `omp -p` probe on its own
  // pty, the child rewrites kitty-<id> to its own session file in a
  // --session-dir elsewhere, and that file ends in session_exit while the
  // tab's own file (still linked from pts-N) is mid-turn. The script must
  // report the parent's state and say why.
  await clearLinks();
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabstate-probe-'));
  try {
    const t = nowMs();
    await writeSession('parent.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), assistantRow('toolUse', t - 14000, ['bash'])]);
    await fs.writeFile(path.join(probeDir, 'probe.jsonl'),
      [titleRow(), sessionRow(WCWD, nowIso()), userRow('say ok', t - 10000), exitRow('done')].join('\n') + '\n');
    await fs.writeFile(path.join(sessDir, `kitty-${WID}`), `${WCWD}\n${path.join(probeDir, 'probe.jsonl')}\n`);
    await linkPts('9', 'parent.jsonl');
    const r = await runScript([WID], { OMP_TAB_STATE_PTS_N: '9', OMP_TAB_STATE_SESSIONS_DIR: sessDir });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /state=busy/);
    assert.match(r.out, /reason=link-disagreement/);
    assert.match(r.out, /parent\.jsonl/);
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true });
  }
});

test('two live files disagreeing prefers the canonical sessions dir ', async () => {
  // Neither file has ended; the kitty-<id> one points outside the canonical
  // sessions dir (a stale --session-dir path) while pts-N points inside.
  await clearLinks();
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabstate-probe-'));
  try {
    const t = nowMs();
    await writeSession('parent.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('steer me', t - 500)]);
    await fs.writeFile(path.join(probeDir, 'other.jsonl'),
      [titleRow(), sessionRow(WCWD, nowIso()), assistantRow('stop', t - 1000)].join('\n') + '\n');
    await fs.writeFile(path.join(sessDir, `kitty-${WID}`), `${WCWD}\n${path.join(probeDir, 'other.jsonl')}\n`);
    await linkPts('9', 'parent.jsonl');
    const r = await runScript([WID], { OMP_TAB_STATE_PTS_N: '9', OMP_TAB_STATE_SESSIONS_DIR: sessDir });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /state=busy/);
    assert.match(r.out, /reason=link-disagreement/);
    assert.match(r.out, /parent\.jsonl/);
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true });
  }
});

test('an absent window exits 1', async () => {
  await clearLinks();
  await fs.writeFile(path.join(sessDir, 'no-window'), '');
  const r = await runScript([WID]);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, new RegExp(`no such window: ${WID}`));
});

test('a session file with no session row exits 2', async () => {
  await clearLinks();
  await writeSession('garbage.jsonl', ['not json at all', '{"type":"message"}']);
  await linkKitty('garbage.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 2, `${r.out}${r.err}`);
  assert.match(r.out, /state=unknown/);
  assert.match(r.out, /reason=unreadable-session-file/);
});

test('--json reports the full shape', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('j.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), toolStartRow('read'), assistantRow('toolUse', t - 1000, ['read'])]);
  await linkKitty('j.jsonl');
  const r = await runScript([WID, '--json']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const o = JSON.parse(r.out);
  assert.equal(o.window, Number(WID));
  assert.equal(o.state, 'busy');
  assert.equal(o.tool, 'read');
  assert.equal(o.source, `kitty-${WID}`);
  assert.ok(o.session.endsWith('j.jsonl'));
  assert.ok(o.lines > 0);
});

test('--watch emits exactly the transitions', async () => {
  await clearLinks();
  const t = nowMs();
  const name = 'watch.jsonl';
  await writeSession(name, [titleRow(), sessionRow(WCWD, nowIso()), assistantRow('stop', t - 9000)]);
  await linkKitty(name);
  const child = spawn(SCRIPT, [WID, '--watch', '--interval=1'], {
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '' }),
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 2500));
  // The tab picks up work: user steer, tool start, mid-turn assistant row.
  await fs.appendFile(path.join(sessDir, name), userRow('go again', nowMs()) + '\n' + toolStartRow('bash') + '\n' + assistantRow('toolUse', nowMs(), ['bash']) + '\n');
  await new Promise((r) => setTimeout(r, 2500));
  // The tab parks again.
  await fs.appendFile(path.join(sessDir, name), toolResultRow('bash', nowMs()) + '\n' + assistantRow('stop', nowMs()) + '\n');
  await new Promise((r) => setTimeout(r, 2500));
  child.kill();
  await new Promise((r) => child.on('close', r));
  const states = out.trim().split('\n').map((l) => /state=([a-z]+)/.exec(l)?.[1]);
  assert.deepEqual(states, ['idle', 'busy', 'idle']);
});

test('--watch survives tab startup: unknown until the session file appears ', async () => {
  await clearLinks();
  const child = spawn(SCRIPT, [WID, '--watch', '--interval=1'], {
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '' }),
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  // The watcher must still be alive after two intervals with no session file.
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(child.exitCode, null, `watcher exited early: ${out}`);
  assert.match(out, /state=unknown reason=no-session-file/);
  // The tab starts up: session file and link appear.
  const t = nowMs();
  const name = 'late-start.jsonl';
  await writeSession(name, [titleRow(), sessionRow(WCWD, nowIso()), assistantRow('stop', t)]);
  await linkKitty(name);
  await new Promise((r) => setTimeout(r, 2500));
  child.kill();
  await new Promise((r) => child.on('close', r));
  const states = out.trim().split('\n').map((l) => /state=([a-z]+)/.exec(l)?.[1]);
  assert.deepEqual(states, ['unknown', 'idle']);
});

test('--watch on a gone window ends with state=gone, never waits forever', async () => {
  await clearLinks();
  await fs.writeFile(path.join(sessDir, 'no-window'), '');
  const child = spawn(SCRIPT, [WID, '--watch', '--interval=1'], {
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '' }),
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  assert.match(out, /state=gone reason=no-such-window/);
});

test('--watch reports gone when the window closes mid-watch', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('closing.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), assistantRow('stop', t)]);
  await linkKitty('closing.jsonl');
  const child = spawn(SCRIPT, [WID, '--watch', '--interval=1'], {
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '' }),
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 2500));
  await fs.writeFile(path.join(sessDir, 'no-window'), '');
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  const states = out.trim().split('\n').map((l) => /state=([a-z]+)/.exec(l)?.[1]);
  assert.deepEqual(states, ['idle', 'gone']);
});

// Row builders for a backgrounded bash job: the shapes omp-idle-audit.mjs
// walks (toolCall id indexed to its command, then a bash toolResult row
// carrying the harness's own Backgrounded line).
const bgCallRow = (callId, command, ts) =>
  JSON.stringify({ type: 'message', id: `a-${ts}`, message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: { command } }], stopReason: 'toolUse', timestamp: ts } });
const bgStartRow = (callId, jobId, ts) =>
  JSON.stringify({ type: 'message', id: `t-${ts}`, message: { role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text: `Backgrounded as job ${jobId}; result will be delivered automatically.` }] } });

test('idle with one job alive prints jobs=1', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('alive.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('do it', t - 9000), bgCallRow('c-1', 'sleep 300; echo poll-done', t - 5000), bgStartRow('c-1', 'bg_11', t - 4000), assistantRow('stop', t - 1000)]);
  await linkKitty('alive.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=idle/);
  assert.match(r.out, /jobs=1/);
});

test('idle with none alive prints jobs=0', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('nojob.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('do it', t - 9000), toolStartRow('bash'), toolResultRow('bash', t - 5000), assistantRow('stop', t - 1000)]);
  await linkKitty('nojob.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=idle/);
  assert.match(r.out, /jobs=0/);
});

test('a PATH without node prints jobs=unknown, never 0', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('nonode.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('do it', t - 9000), toolStartRow('bash'), toolResultRow('bash', t - 5000), assistantRow('stop', t - 1000)]);
  await linkKitty('nonode.jsonl');
  const noNodeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'tabstate-nonode-'));
  try {
    for (const dir of ['/usr/bin', '/bin']) {
      for (const f of await fs.readdir(dir)) {
        if (f.startsWith('node') || f === 'kitty') continue;
        const dest = path.join(noNodeBin, f);
        try { await fs.symlink(path.join(dir, f), dest); } catch { /* name already linked */ }
      }
    }
    await fs.writeFile(path.join(noNodeBin, 'kitty'), await fs.readFile(path.join(binDir, 'kitty'), 'utf8'), { mode: 0o755 });
    const r = await runScript([WID], { PATH: noNodeBin });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /state=idle/);
    assert.match(r.out, /jobs=unknown/);
  } finally {
    await fs.rm(noNodeBin, { recursive: true, force: true }).catch(() => {});
  }
});

test('--json carries the alive job ids', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('jids.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('do it', t - 9000), bgCallRow('c-1', 'sleep 300; echo poll-done', t - 5000), bgStartRow('c-1', 'bg_11', t - 4000), assistantRow('stop', t - 1000)]);
  await linkKitty('jids.jsonl');
  const r = await runScript([WID, '--json']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const o = JSON.parse(r.out);
  assert.equal(o.state, 'idle');
  assert.deepEqual(o.jobs, ['bg_11']);
});

test('exited with one job alive prints jobs=1', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('exitalive.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('do it', t - 9000), bgCallRow('c-1', 'sleep 300; echo poll-done', t - 5000), bgStartRow('c-1', 'bg_11', t - 4000), assistantRow('stop', t - 3000), exitRow('sighup')]);
  await linkKitty('exitalive.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=exited/);
  assert.match(r.out, /jobs=1/);
});

test('with no seams set, the link files are read from omp\'s own directory under $HOME', async () => {
  // terminal-sessions/ and sessions/ are written by omp itself, so the default
  // must be where omp writes them, whatever AGENT_SWITCHBOARD_DIR says.
  await clearLinks();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'example-tab-state-home-'));
  const linkDir = path.join(home, '.omp', 'agent', 'terminal-sessions');
  await fs.mkdir(linkDir, { recursive: true });
  const t = nowMs();
  await writeSession('home-default.jsonl', [titleRow(), sessionRow(WCWD, nowIso()), userRow('do it', t - 9000), assistantRow('stop', t - 1000)]);
  await fs.writeFile(path.join(linkDir, `kitty-${WID}`), `${WCWD}\n${path.join(sessDir, 'home-default.jsonl')}\n`);
  const r = await runScript([WID], {
    HOME: home, OMP_TAB_STATE_DIR: '', OMP_TAB_STATE_SESSIONS_DIR: '',
    AGENT_SWITCHBOARD_DIR: path.join(home, 'switchboard'), XDG_STATE_HOME: '',
  });
  await fs.rm(home, { recursive: true, force: true });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=idle/);
});
