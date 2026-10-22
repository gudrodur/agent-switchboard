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
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/omp-tab-state.sh', import.meta.url));
const WID = '991001';
const WCWD = path.join(os.tmpdir(), 'example-tab-state');

let binDir, sessDir;

// Every run points OPENCODE_TAB_DB at a path that does not exist, so no test
// can read the live opencode store by accident: a fixture that wants the
// opencode path passes its own. (An empty value would NOT disable it —
// ${OPENCODE_TAB_DB:-default} treats empty as unset.)
const NO_OPENCODE_DB = () => path.join(sessDir, 'no-such-opencode.db');

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
// Ambient custom_message rows: the harness keeps writing these (advisor
// commentary, coordination pings, mailbox deliveries recorded for context,
// todo nudges, ...) even while the tab's own turn is at rest. Measured
// 2026-09-27 in a real xj-greenfield session: 44 such rows (mostly
// customType:advisor) between the last assistant stopReason:stop message and
// session_exit. None of them mean work is in progress.
const advisorRow = (ts) =>
  JSON.stringify({ type: 'custom_message', customType: 'advisor', content: 'note', display: {}, details: {}, attribution: 'advisor', id: `adv-${ts}`, timestamp: ts });
const coordinationRow = (ts) =>
  JSON.stringify({ type: 'custom_message', customType: 'coordination', content: 'ping', id: `coord-${ts}`, timestamp: ts });
const mailboxRow = (ts) =>
  JSON.stringify({ type: 'custom_message', customType: 'mailbox', content: 'delivered', id: `mbx-${ts}`, timestamp: ts });
const todoNudgeRow = (ts) =>
  JSON.stringify({ type: 'custom_message', customType: 'mid-run-todo-nudge', content: 'nudge', id: `nudge-${ts}`, timestamp: ts });

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
    '  fg=\'[]\'',
    '  [ -f "$state/claude-pid" ] && fg=$(printf \'[{"pid":%s,"cmdline":["/usr/bin/claude"]}]\' "$(cat "$state/claude-pid")")',
    `  printf '[{"tabs":[{"title":"mock","windows":[{"id":${WID},"title":"mock","pid":%s,"cwd":${JSON.stringify(WCWD)},"created_at":%s,"foreground_processes":%s}]}]}]\\n' "$pid" "$created" "$fg"`,
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
    if (f.startsWith('kitty-') || f.startsWith('pts-') || f === 'no-window' || f === 'claude-pid') {
      await fs.rm(path.join(sessDir, f), { force: true });
    }
  }
};

const runScript = async (args, extraEnv = {}) => {
  try {
    const r = await run(SCRIPT, args, {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '', OPENCODE_TAB_DB: NO_OPENCODE_DB(),
        CLAUDE_SESSIONS_DIR: path.join(sessDir, 'claude-sessions'), CLAUDE_PROJECTS_DIR: path.join(sessDir, 'claude-projects'), ...extraEnv,
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

test('a READY tab buried under ambient rows still reports idle (regression, agent-config#914 row 1)', async () => {
  // Reproduces the measured shape: an assistant stop, then a pile of ambient
  // custom_message rows (advisor/coordination/mailbox/todo-nudge) that the
  // harness kept appending while the tab sat at rest. Measured in a real
  // xj-greenfield session: 44 such rows before session_exit; this fixture
  // uses 80 (more than the script's old fixed tail -60) to prove the fix,
  // not a coincidence of the window still being big enough by luck.
  await clearLinks();
  const t = nowMs();
  const ambient = [];
  for (let i = 0; i < 80; i++) {
    const ts = t - 4000 + i * 100;
    ambient.push([advisorRow(ts), coordinationRow(ts), mailboxRow(ts), todoNudgeRow(ts)][i % 4]);
  }
  await writeSession('ready-buried.jsonl', [
    titleRow(), sessionRow(WCWD, nowIso()),
    userRow('ship it', t - 9000), toolStartRow('bash'), toolResultRow('bash', t - 5000),
    assistantRow('stop', t - 4500),
    ...ambient,
  ]);
  await linkKitty('ready-buried.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=idle/);
});

test('ambient rows are skipped even inside a small tail window (not merely outrun by a big default)', async () => {
  // Proves the fix is a real skip-past, not just a bigger number: with a
  // tail window barely larger than the ambient run plus the stop row, the
  // old filter (last row of type message, in the raw tail) already found the
  // right row here too — the point of this fixture is the OTHER two tests
  // below, which show a decisive custom row anywhere in that same small
  // window is still caught (busy), so the skip is selective, not a blanket
  // "widen the window and hope".
  await clearLinks();
  const t = nowMs();
  await writeSession('small-window.jsonl', [
    titleRow(), sessionRow(WCWD, nowIso()),
    assistantRow('stop', t - 4000),
    advisorRow(t - 3000), coordinationRow(t - 2000), mailboxRow(t - 1000), todoNudgeRow(t - 500),
  ]);
  await linkKitty('small-window.jsonl');
  const r = await runScript([WID], { OMP_TAB_STATE_TAIL_LINES: '6' });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=idle/);
});

test('genuine work after ambient rows still reports busy (a real user message)', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('busy-after-ambient.jsonl', [
    titleRow(), sessionRow(WCWD, nowIso()),
    assistantRow('stop', t - 9000),
    advisorRow(t - 8000), coordinationRow(t - 7000), mailboxRow(t - 6000),
    userRow('one more thing', t - 1000),
  ]);
  await linkKitty('busy-after-ambient.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=busy/);
});

test('genuine work after ambient rows still reports busy (a bare tool_execution_start, no result yet)', async () => {
  await clearLinks();
  const t = nowMs();
  await writeSession('inflight-after-ambient.jsonl', [
    titleRow(), sessionRow(WCWD, nowIso()),
    assistantRow('stop', t - 9000),
    advisorRow(t - 8000), coordinationRow(t - 7000),
    assistantRow('toolUse', t - 2000, ['bash']),
    toolStartRow('bash'),
    mailboxRow(t - 1000),
  ]);
  await linkKitty('inflight-after-ambient.jsonl');
  const r = await runScript([WID]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /state=busy/);
  assert.match(r.out, /tool=bash/);
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
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '', OPENCODE_TAB_DB: NO_OPENCODE_DB() }),
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
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '', OPENCODE_TAB_DB: NO_OPENCODE_DB() }),
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
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '', OPENCODE_TAB_DB: NO_OPENCODE_DB() }),
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
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '', OPENCODE_TAB_DB: NO_OPENCODE_DB() }),
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

// ---- OpenCode V2 tabs: state from opencode.db, never a jsonl -------------------
//
// An OpenCode tab (v2.0.29+, the machine runs v2.0.32) writes no omp jsonl and
// no Claude transcript. Its session and turns are rows in opencode.db:
// `session_v2` (one per session, naming its `directory` and `time_created`)
// and `session_message` (one per turn element: `user`, `assistant`, `idle`,
// `shell`, ... with `seq` the counter a send proof watches grow). Shapes below
// are trimmed copies of the live store, 2026-10-22.
const OC_SID = 'ses_test0000000000000open';

// Writes a two-table opencode store; returns its path and directory.
const writeOpenCodeDb = async (rows, opts = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabstate-oc-'));
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT, model TEXT, parent_id TEXT,
    time_created INTEGER, time_updated INTEGER, time_idle INTEGER, idle_outcome TEXT)`);
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT)`);
  const created = opts.timeCreated ?? Date.now();
  db.prepare('INSERT INTO session_v2 (id, directory, model, parent_id, time_created, time_updated, time_idle, idle_outcome) VALUES (?,?,?,?,?,?,?,?)')
    .run(OC_SID, opts.directory ?? WCWD, '{"id":"m","providerID":"opencode"}', opts.parentId ?? null,
      created, created, opts.timeIdle ?? null, opts.idleOutcome ?? null);
  const ins = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)');
  rows.forEach((r, i) => ins.run(`m-${i}`, OC_SID, r.type, r.seq, r.ts, r.ts, JSON.stringify(r.data)));
  db.close();
  return { dir, file };
};
const ocUser = (text, seq, ts) => ({ type: 'user', seq, ts, data: { time: { created: ts }, text } });
const ocIdle = (seq, ts) => ({ type: 'idle', seq, ts, data: { time: { created: ts }, outcome: 'succeeded' } });
const ocAssistant = (seq, ts, tool) => ({
  type: 'assistant', seq, ts,
  data: { time: { created: ts }, content: [{ type: 'reasoning', text: 'thinking' }, { type: 'tool', name: tool, state: { status: 'running' } }] },
});

test('a trailing opencode assistant row with a tool call reports busy tool=shell source=opencode-db', async () => {
  await clearLinks();
  const t = nowMs();
  const { dir, file } = await writeOpenCodeDb([ocUser('carry it out', 4, t - 9000), ocAssistant(11, t - 1000, 'shell')]);
  try {
    // No kitty-/pts- link at all: this window is not an omp tab.
    const r = await runScript([WID], { OPENCODE_TAB_DB: file });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /state=busy/);
    assert.match(r.out, /tool=shell/);
    assert.match(r.out, new RegExp(`session=opencode:${OC_SID}`));
    assert.match(r.out, /lines=11/);
    const j = JSON.parse((await runScript([WID, '--json'], { OPENCODE_TAB_DB: file })).out);
    assert.equal(j.state, 'busy');
    assert.equal(j.tool, 'shell');
    assert.equal(j.source, 'opencode-db');
    assert.equal(j.session, `opencode:${OC_SID}`);
    assert.equal(j.lines, 11);
    assert.equal(j.pid, Number(process.pid));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a trailing opencode idle row reports idle tool=- jobs=0 source=opencode-db', async () => {
  await clearLinks();
  const t = nowMs();
  const { dir, file } = await writeOpenCodeDb([
    ocUser('carry it out', 4, t - 9000), ocAssistant(11, t - 5000, 'shell'), ocIdle(12, t - 1000),
  ], { timeIdle: t - 1000, idleOutcome: 'succeeded' });
  try {
    const r = await runScript([WID], { OPENCODE_TAB_DB: file });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /state=idle/);
    assert.match(r.out, /tool=-/);
    assert.match(r.out, /jobs=0/);
    assert.match(r.out, /lines=12/);
    assert.match(r.out, new RegExp(`session=opencode:${OC_SID}`));
    const j = JSON.parse((await runScript([WID, '--json'], { OPENCODE_TAB_DB: file })).out);
    assert.equal(j.state, 'idle');
    assert.equal(j.source, 'opencode-db');
    assert.deepEqual(j.jobs, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a live opencode session wins over a stale pts-N link from an old omp session (cwd-mismatch)', async () => {
  // The measured failure: /dev/pts/N numbers are reused, so a pts-N left behind
  // by an earlier omp tab in ANOTHER directory is still resolvable for this
  // window, and validate_link says cwd-mismatch. The window is really an
  // OpenCode tab, and its live row in opencode.db must decide the answer.
  await clearLinks();
  const t = nowMs();
  await writeSession('old-omp-elsewhere.jsonl', [
    titleRow(), sessionRow(path.join(os.tmpdir(), 'example-other-project'), nowIso()), assistantRow('stop', t - 1000),
  ]);
  await linkPts('7', 'old-omp-elsewhere.jsonl');
  const { dir, file } = await writeOpenCodeDb([ocUser('carry it out', 4, t - 9000), ocIdle(12, t - 1000)]);
  try {
    const env = { OMP_TAB_STATE_PTS_N: '7', OPENCODE_TAB_DB: file };
    const r = await runScript([WID], env);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /state=idle/);
    assert.doesNotMatch(r.out, /state=unknown/);
    assert.doesNotMatch(r.out, /reason=cwd-mismatch/);
    // And the same window mid-turn: the store's newest decisive row decides.
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
      .run('m-99', OC_SID, 'assistant', 20, t, t, JSON.stringify(ocAssistant(20, t, 'bash').data));
    db.close();
    const r2 = await runScript([WID], env);
    assert.equal(r2.code, 0, `${r2.out}${r2.err}`);
    assert.match(r2.out, /state=busy/);
    assert.match(r2.out, /tool=bash/);
    assert.match(r2.out, /lines=20/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--watch reports an opencode tab\'s transitions from opencode.db', async () => {
  // The watch loop has its own call site (resolve_candidates runs each tick, so
  // a tab that starts as a non-tab must be re-identified), and it is the mode a
  // supervisor actually leaves running.
  await clearLinks();
  const t = nowMs();
  const { dir, file } = await writeOpenCodeDb([ocUser('carry it out', 4, t - 9000), ocIdle(12, t - 1000)]);
  const child = spawn(SCRIPT, [WID, '--watch', '--interval=1'], {
    env: isolatedEnv({
      PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir,
      OMP_TAB_STATE_PTS_N: '', OPENCODE_TAB_DB: file,
    }),
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
      .run('m-99', OC_SID, 'assistant', 20, Date.now(), Date.now(), JSON.stringify(ocAssistant(20, Date.now(), 'shell').data));
    db.close();
    await new Promise((r) => setTimeout(r, 2500));
  } finally {
    child.kill();
    await new Promise((r) => child.on('close', r));
    await fs.rm(dir, { recursive: true, force: true });
  }
  const lines = out.trim().split('\n');
  assert.deepEqual(lines.map((l) => /state=([a-z]+)/.exec(l)?.[1]), ['idle', 'busy']);
  assert.match(lines[1], /tool=shell/);
  assert.match(lines[1], /lines=20/);
});

test('an opencode session for another directory is not this window\'s state', async () => {
  // The store holds every session on the machine: directory and the window's
  // own time_created are what make a row this window's, never recency alone.
  await clearLinks();
  const t = nowMs();
  const other = await writeOpenCodeDb([ocIdle(12, t - 1000)], { directory: path.join(os.tmpdir(), 'example-other-project') });
  const old = await writeOpenCodeDb([ocIdle(12, t - 1000)], { timeCreated: t - 3600_000 });
  try {
    const r = await runScript([WID], { OPENCODE_TAB_DB: other.file });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /state=unknown/);
    assert.match(r.out, /reason=no-session-file/);
    // A matching directory but a session older than the window (pty reuse) is
    // no proof either.
    const r2 = await runScript([WID], { OPENCODE_TAB_DB: old.file });
    assert.equal(r2.code, 0, `${r2.out}${r2.err}`);
    assert.match(r2.out, /state=unknown/);
  } finally {
    await fs.rm(other.dir, { recursive: true, force: true });
    await fs.rm(old.dir, { recursive: true, force: true });
  }
});

// CLAUDE CODE TABS. A window whose foreground process is `claude` has no omp
// link; its state is <sessions>/<pid>.json (status busy|idle, startedAt and
// statusUpdatedAt in epoch ms) and a transcript under <projects>/<cwd slug>/.
const CLAUDE_PID = 424242;
const CLAUDE_SID = '5e55-claude-test';
const claudeSlug = WCWD.replace(/[^A-Za-z0-9-]/g, '-');
const claudeTranscript = () => path.join(sessDir, 'claude-projects', claudeSlug, `${CLAUDE_SID}.jsonl`);
const setupClaude = async ({ status = 'idle', startedAt = nowMs(), transcript = true } = {}) => {
  await clearLinks();
  await fs.rm(path.join(sessDir, 'claude-sessions'), { recursive: true, force: true });
  await fs.rm(path.join(sessDir, 'claude-projects'), { recursive: true, force: true });
  await fs.mkdir(path.join(sessDir, 'claude-sessions'), { recursive: true });
  await fs.writeFile(path.join(sessDir, 'claude-pid'), String(CLAUDE_PID));
  await fs.writeFile(path.join(sessDir, 'claude-sessions', `${CLAUDE_PID}.json`), JSON.stringify({
    pid: CLAUDE_PID, sessionId: CLAUDE_SID, cwd: WCWD, startedAt, status, statusUpdatedAt: nowMs() - 7000,
  }));
  if (transcript) {
    await fs.mkdir(path.dirname(claudeTranscript()), { recursive: true });
    await fs.writeFile(claudeTranscript(), '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');
  }
};

test('a claude window with status busy reports busy from the sessions file', async () => {
  await setupClaude({ status: 'busy' });
  const r = await runScript([WID]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /state=busy/);
  assert.match(r.out, /age=[5-9]s/);
  assert.match(r.out, /lines=3/);
  assert.ok(r.out.includes(`session=${claudeTranscript()}`), r.out);
});

test('a claude window with status idle reports idle', async () => {
  await setupClaude({ status: 'idle' });
  const r = await runScript([WID]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /state=idle/);
});

test('claude --json carries the usual keys with source claude', async () => {
  await setupClaude({ status: 'idle' });
  const r = await runScript([WID, '--json']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j).sort(), ['age_s', 'jobs', 'lines', 'pid', 'reason', 'session', 'source', 'state', 'tool', 'window']);
  assert.equal(j.source, 'claude');
  assert.equal(j.state, 'idle');
  assert.equal(j.lines, 3);
  assert.equal(j.session, claudeTranscript());
  assert.equal(j.jobs, 'unknown');
});

test('a claude status that is neither busy nor idle reports unknown with the value', async () => {
  await setupClaude({ status: 'waiting' });
  const r = await runScript([WID]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /state=unknown reason=claude-status-waiting source=claude/);
});

test('a claude sessions file older than the window reports session-older-than-window', async () => {
  await setupClaude({ status: 'busy', startedAt: nowMs() - 3_600_000 });
  const r = await runScript([WID]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /state=unknown reason=session-older-than-window source=claude/);
});

test('a claude window without a transcript yet reports lines=0', async () => {
  await setupClaude({ status: 'idle', transcript: false });
  const r = await runScript([WID, '--json']);
  assert.equal(JSON.parse(r.out).lines, 0);
});

test('--watch reads a claude window through the same path', async () => {
  await setupClaude({ status: 'idle' });
  const sessFile = path.join(sessDir, 'claude-sessions', `${CLAUDE_PID}.json`);
  const child = spawn(SCRIPT, [WID, '--watch', '--interval=1'], {
    env: isolatedEnv({
      PATH: `${binDir}:${process.env.PATH}`, OMP_TAB_STATE_DIR: sessDir, OMP_TAB_STATE_PTS_N: '', OPENCODE_TAB_DB: NO_OPENCODE_DB(),
      CLAUDE_SESSIONS_DIR: path.join(sessDir, 'claude-sessions'), CLAUDE_PROJECTS_DIR: path.join(sessDir, 'claude-projects'),
    }),
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 2500));
  const j = JSON.parse(await fs.readFile(sessFile, 'utf8'));
  await fs.writeFile(sessFile, JSON.stringify({ ...j, status: 'busy' }));
  await new Promise((r) => setTimeout(r, 2500));
  child.kill();
  await new Promise((r) => child.on('close', r));
  const lines = out.trim().split('\n');
  assert.deepEqual(lines.map((l) => /state=([a-z]+)/.exec(l)?.[1]), ['idle', 'busy']);
  assert.ok(lines.every((l) => l.includes(claudeTranscript())), out);
});
