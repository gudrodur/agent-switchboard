// Tests for kitty-send.sh's DELIVERY-PROOF semantics for slash commands
//: a `/`-command sent to an agent prompt never echoes — the
// command's effect replaces its echo — so the tail/head fragment proof is
// structurally unavailable and the old script reported exit 3 for a delivery
// that landed (the /mcp reauth case, 2026-09-07). For text starting with `/`
// and no explicit --expect, the proof is the screen CHANGING after the send;
// a plain message still needs a NEW fragment (the changed screen alone does
// not confirm it), and an unchanged screen stays exit 3.
//
// kitty-send.test.sh (real kitty) cannot run in CI; this file uses a stateful
// PATH stub: `get-text` reports an idle prompt before the send and a
// configured payload after the send marker is touched.
//
// Run: node --test tests/kitty-send-proof.test.mjs  (or the full suite)
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/kitty-send.sh', import.meta.url));
const WID = '991001';

let binDir, stateDir;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-proof-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-proof-state-'));
  // The stub's pid must be alive for the post-send liveness check: the test
  // process itself is, for the duration of the run.
  await fs.writeFile(path.join(stateDir, 'pid'), String(process.pid));
  const lsJson =
    '[{"tabs":[{"title":"mock","windows":[{"id":' +
    WID +
    ',"title":TITLEHERE,"pid":PIDHERE,"cwd":"/tmp/kitty-proof-cwd"}]}]}]';
  const stub = [
    '#!/usr/bin/env bash',
    `state=${JSON.stringify(stateDir)}`,
    'case "$1/$2" in',
    '  @/ls)',
    '    pid=$(cat "$state/pid")',
    '    title="idle"',
    '    if [ -f "$state/busy_before" ]; then title="π ⠹ mock busy before"; fi',
    '    if [ -f "$state/sent" ] && [ -f "$state/busy_after" ]; then title="π ⠹ mock working"; fi',
    "    printf '%s\\n' " + JSON.stringify(lsJson.replace('TITLEHERE', '"$title"').replace('PIDHERE', '"$pid"')),
    '    ;;',
    '  @/send-text)',
    '    touch "$state/sent"',
    '    ;;',
    '  @/get-text)',
    '    ext="all"; prev=""',
    '    for a in "$@"; do [ "$prev" = "--extent" ] && ext="$a"; prev="$a"; done',
    '    [ "$ext" = "screen" ] && exit 0   # no dialog on screen',
    '    if [ -f "$state/sent" ]; then',
    '      if [ -f "$state/after" ]; then cat "$state/after"; else printf \'%s\\n\' \'Waiting for browser authentication ...\'; fi',
    '    else',
    "      printf '%s\\n' 'idle prompt before the send'",
    '    fi',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'kitty'), stub, { mode: 0o755 });
});

after(async () => {
  await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
});

const reset = async (after = null, opts = {}) => {
  for (const f of ['sent', 'after', 'busy_after', 'busy_before']) await fs.rm(path.join(stateDir, f), { force: true });
  if (after) await fs.writeFile(path.join(stateDir, 'after'), after);
  if (opts.busyAfter) await fs.writeFile(path.join(stateDir, 'busy_after'), '');
  if (opts.busyBefore) await fs.writeFile(path.join(stateDir, 'busy_before'), '');
};

const runScript = async (args, extraEnv = {}) => {
  try {
    const r = await run(SCRIPT, args, {
      env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir, OPENCODE_TAB_DB: path.join(stateDir, 'no-such-opencode.db'), ...extraEnv }),
      timeout: 30_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

test('a slash command whose effect replaced its echo is typed, not proven submitted', async () => {
  await reset();
  const r = await runScript(['--to', WID, '--text', '/mcp reauth Neon', '--timeout', '5']);
  assert.equal(r.code, 10, `${r.out}${r.err}`);
  assert.match(r.err, /typed, not proven submitted/);
  assert.match(r.err, /screen changed after the send/);
});

test('a slash command on an unchanged screen still reports exit 3', async () => {
  // The stub only changes content when `sent` exists and no `after` file
  // overrides it. Simulate a screen that does NOT change: make the after
  // payload identical to the before payload.
  await reset('idle prompt before the send\n');
  const r = await runScript(['--to', WID, '--text', '/mcp reauth Neon', '--timeout', '3']);
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  // A slash command's failure note says to look at the screen for its effect,
  // since it writes no session row, not the generic echo note.
  assert.match(r.err, /screen did not change/);
  assert.match(r.err, /look at the/);
});

test('a plain message is NOT confirmed by a changed screen alone', async () => {
  await reset();
  const r = await runScript(['--to', WID, '--text', 'plain note without a slash', '--timeout', '3']);
  assert.equal(r.code, 3, `${r.out}${r.err}`);
});

test('a plain message whose fragment newly appears is typed, not proven submitted (no session file)', async () => {
  await reset('agent replies, having received: plain note without a slash\n');
  const r = await runScript(['--to', WID, '--text', 'plain note without a slash', '--timeout', '5']);
  assert.equal(r.code, 10, `${r.out}${r.err}`);
  assert.match(r.err, /typed, not proven submitted/);
  assert.match(r.err, /echoed at the prompt|queued as steering/);
});

// ---- the usage block is printable, and a bare id is --to

test('--help and -h print the usage and exit 0', async () => {
  await reset();
  for (const flag of ['--help', '-h']) {
    const r = await runScript([flag]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /Usage:/);
    assert.match(r.out, /--to <window-id\|title-substring>/);
    assert.match(r.out, /a bare id is --to/);
  }
});

test('an unknown argument names itself and points at --help', async () => {
  await reset();
  const r = await runScript(['--to', WID, '--text', 'hi', '--bogus']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown argument: --bogus/);
  assert.match(r.err, /try --help/);
});
test('a bare window id works as --to, typed not proven without a session file', async () => {
  await reset('agent replies, having received: bare id note\n');
  const r = await runScript([WID, '--text', 'bare id note', '--timeout', '5']);
  assert.equal(r.code, 10, `${r.out}${r.err}`);
  assert.match(r.err, /typed, not proven submitted in window 991001/);
});

test('a bare non-id first argument stays an error', async () => {
  await reset();
  const r = await runScript(['notawindow', '--text', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown argument: notawindow/);
});

// ---- the busy-transition weaker proof
//
// The 2026-09-09 case: the send landed and the target began executing the
// brief, but the echo had left the readable screen inside the timeout, so the
// fragment match failed for a delivery that worked. The stub models it: the
// after payload shares no fragment with the message, and the title flips
// idle -> busy at the send.

test('an idle target that starts working after the send is typed, not proven submitted', async () => {
  await reset('agent is now working: tool calls streaming, prompt echo scrolled away\n', { busyAfter: true });
  const r = await runScript(['--to', WID, '--text', 'plain note without a slash', '--timeout', '5']);
  assert.equal(r.code, 10, `${r.out}${r.err}`);
  assert.match(r.err, /typed, not proven submitted/);
  assert.match(r.err, /started working after the send/);
});

test('busy-after with an unchanged screen stays exit 3', async () => {
  await reset('idle prompt before the send\n', { busyAfter: true });
  const r = await runScript(['--to', WID, '--text', 'plain note without a slash', '--timeout', '3']);
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /could not observe it on screen/);
});

test('a target busy before the send (--now) gets no weaker proof', async () => {
  await reset('agent is now working: tool calls streaming, prompt echo scrolled away\n', { busyBefore: true });
  const r = await runScript(['--to', WID, '--text', 'plain note without a slash', '--timeout', '3', '--now']);
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /could not observe it on screen/);
});
// ---- an OpenCode tab: its receipt is a row in opencode.db ---------------------
//
// No jsonl, no Claude transcript: opencode (v2.0.29+) writes session_v2 and
// session_message into its own SQLite store, and tab-state.sh reports
// session=opencode:<sid> with lines=MAX(seq). The proof is a NEW type:user row
// past that seq whose text carries the message's start — the tab's own receipt,
// and the same do-not-resend discipline as every other proof here.
const OC_SID = 'ses_proof000000000000opencode';
const ocDir = () => path.join(stateDir, 'opencode-fixture');
const ocDb = () => path.join(ocDir(), 'opencode.db');
const writeOcStore = async (rows) => {
  await fs.mkdir(ocDir(), { recursive: true });
  await fs.rm(ocDb(), { force: true });
  const db = new DatabaseSync(ocDb());
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT, model TEXT, parent_id TEXT,
    time_created INTEGER, time_updated INTEGER, time_idle INTEGER, idle_outcome TEXT)`);
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT)`);
  const now = Date.now();
  // The stub window carries no created_at, so tab-state.sh's pty-reuse
  // check is skipped and this row is this window's by directory alone.
  db.prepare('INSERT INTO session_v2 (id, directory, model, parent_id, time_created, time_updated, time_idle, idle_outcome) VALUES (?,?,?,?,?,?,?,?)')
    .run(OC_SID, '/tmp/kitty-proof-cwd', '{"id":"m","providerID":"opencode"}', null, now, now, now, 'succeeded');
  const ins = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)');
  rows.forEach((r, i) => ins.run(`m-${i}`, OC_SID, r.type, r.seq, now, now, JSON.stringify(r.data)));
  db.close();
};
const ocAppendUser = async (text, seq) => {
  const now = Date.now();
  const db = new DatabaseSync(ocDb());
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run(`m-${seq}`, OC_SID, 'user', seq, now, now, JSON.stringify({ time: { created: now }, text }));
  db.close();
};
const ocIdleRow = { type: 'idle', seq: 12, data: { time: { created: Date.now() }, outcome: 'succeeded' } };

test('a new type:user row in opencode.db proves the send', async () => {
  await reset();
  await writeOcStore([ocIdleRow]);
  try {
    const p = run(SCRIPT, ['--to', WID, '--text', 'plain note for the opencode tab', '--timeout', '8'], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir,
        OPENCODE_TAB_DB: ocDb(),
      }),
    });
    await new Promise((r) => setTimeout(r, 2500));
    await ocAppendUser('plain note for the opencode tab', 20);
    const r = await p.then(
      (ok) => ({ code: 0, out: ok.stdout, err: ok.stderr }),
      (e) => ({ code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }),
    );
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.err, /proved by opencode\.db session_message row/);
    assert.match(r.err, new RegExp(OC_SID));
  } finally {
    await fs.rm(ocDir(), { recursive: true, force: true });
  }
});

test('an opencode tab whose store gains no matching row is exit 3, not delivered', async () => {
  await reset();
  await writeOcStore([ocIdleRow]);
  try {
    // A row DOES land, but it is another prompt: without the text match it
    // would be a false green, which is the one wrong answer here.
    const p = run(SCRIPT, ['--to', WID, '--text', 'plain note for the opencode tab', '--timeout', '5'], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir,
        OPENCODE_TAB_DB: ocDb(),
      }),
    });
    await new Promise((r) => setTimeout(r, 2000));
    await ocAppendUser('a completely different prompt', 20);
    const r = await p.then(
      (ok) => ({ code: 0, out: ok.stdout, err: ok.stderr }),
      (e) => ({ code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }),
    );
    assert.equal(r.code, 3, `${r.out}${r.err}`);
    assert.match(r.err, /no new type:user row with this text/);
    assert.match(r.err, /Do NOT send it again blind/);
  } finally {
    await fs.rm(ocDir(), { recursive: true, force: true });
  }
});
