// Tests for tab-state.sh: proof by STATE for a delegated Claude Code or
// OpenCode tab (busy, idle or unknown, and which session).
//
// The kitty stub serves one canned window (id 991001, the test process pid,
// a fixed cwd, created_at now in ns). A Claude tab is a sessions/<pid>.json
// record plus a transcript; an OpenCode tab is rows in a fixture opencode.db.
//
// Run: node --test tests/tab-state.test.mjs
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
const SCRIPT = fileURLToPath(new URL('../bin/tab-state.sh', import.meta.url));
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

const clearLinks = async () => {
  for (const f of await fs.readdir(sessDir)) {
    if (f === 'no-window' || f === 'claude-pid') await fs.rm(path.join(sessDir, f), { force: true });
  }
};

const runScript = async (args, extraEnv = {}) => {
  try {
    const r = await run(SCRIPT, args, {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        OPENCODE_TAB_DB: NO_OPENCODE_DB(),
        CLAUDE_SESSIONS_DIR: path.join(sessDir, 'claude-sessions'), CLAUDE_PROJECTS_DIR: path.join(sessDir, 'claude-projects'), ...extraEnv,
      }),
      timeout: 30_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};
test('an absent window exits 1', async () => {
  await clearLinks();
  await fs.writeFile(path.join(sessDir, 'no-window'), '');
  const r = await runScript([WID]);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, new RegExp(`no such window: ${WID}`));
});

test('--watch on a gone window ends with state=gone, never waits forever', async () => {
  await clearLinks();
  await fs.writeFile(path.join(sessDir, 'no-window'), '');
  const child = spawn(SCRIPT, [WID, '--watch', '--interval=1'], {
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, OPENCODE_TAB_DB: NO_OPENCODE_DB() }),
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  assert.match(out, /state=gone reason=no-such-window/);
});

test('--watch reports gone when the window closes mid-watch', async () => {
  await clearLinks();
  await setupClaude({ status: 'idle' });
  const child = spawn(SCRIPT, [WID, '--watch', '--interval=1'], {
    env: isolatedEnv({
      PATH: `${binDir}:${process.env.PATH}`, OPENCODE_TAB_DB: NO_OPENCODE_DB(),
      CLAUDE_SESSIONS_DIR: path.join(sessDir, 'claude-sessions'), CLAUDE_PROJECTS_DIR: path.join(sessDir, 'claude-projects'),
    }),
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

// An OpenCode tab has no per-tab file. Its session and turns are rows in
// opencode.db: `session_v2` (one per session, naming its `directory` and
// `time_created`) and `session_message` (one per turn element: `user`,
// `assistant`, `idle`, `shell`, ... with `seq` the counter a send proof
// watches grow). Shapes below are trimmed copies of the live store, 2026-10-22.

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


test('--watch reports an opencode tab\'s transitions from opencode.db', async () => {
  // The watch loop has its own call site (resolve_candidates runs each tick, so
  // a tab that starts as a non-tab must be re-identified), and it is the mode a
  // supervisor actually leaves running.
  await clearLinks();
  const t = nowMs();
  const { dir, file } = await writeOpenCodeDb([ocUser('carry it out', 4, t - 9000), ocIdle(12, t - 1000)]);
  const child = spawn(SCRIPT, [WID, '--watch', '--interval=1'], {
    env: isolatedEnv({
      PATH: `${binDir}:${process.env.PATH}`,
      OPENCODE_TAB_DB: file,
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

// CLAUDE CODE TABS. A window whose foreground process is `claude` has no
// other link; its state is <sessions>/<pid>.json (status busy|idle, startedAt and
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
      PATH: `${binDir}:${process.env.PATH}`, OPENCODE_TAB_DB: NO_OPENCODE_DB(),
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