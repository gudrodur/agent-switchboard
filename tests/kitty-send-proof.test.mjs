// Tests for kitty-send.sh's DELIVERY-PROOF semantics for slash commands
//: a `/`-command sent to an omp prompt never echoes — the
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
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
      env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir, ...extraEnv }),
      timeout: 30_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

test('a slash command whose effect replaced its echo is confirmed by the changed screen', async () => {
  await reset();
  const r = await runScript(['--to', WID, '--text', '/mcp reauth Neon', '--timeout', '5']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
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

test('a plain message whose fragment newly appears still confirms', async () => {
  await reset('agent replies, having received: plain note without a slash\n');
  const r = await runScript(['--to', WID, '--text', 'plain note without a slash', '--timeout', '5']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
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

test('a bare window id works as --to', async () => {
  await reset('agent replies, having received: bare id note\n');
  const r = await runScript([WID, '--text', 'bare id note', '--timeout', '5']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /delivered to window 991001/);
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

test('an idle target that starts working after the send confirms with the weaker proof', async () => {
  await reset('agent is now working: tool calls streaming, prompt echo scrolled away\n', { busyAfter: true });
  const r = await runScript(['--to', WID, '--text', 'plain note without a slash', '--timeout', '5']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /started working after the send/);
  assert.match(r.err, /weaker proof/);
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
// ---- proof by state first: the session file, not the screen ----
//
// The stub window carries no cwd, so a fixture with cwd "" links to it
// (created_at is absent too, so the pts-reuse check is skipped). Nothing
// here touches the tests above: they run with no kitty-<id> file, so the
// state is unknown and the echo proof decides, exactly as before.

const stateEnv = () => ({ OMP_TAB_STATE_DIR: stateDir });
const stateFile = () => path.join(stateDir, 'tabstate.jsonl');
const sRow = (cwd, ts) => JSON.stringify({ type: 'session', version: 3, id: '01t', timestamp: ts, cwd });
const sUser = (ts) => JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'steer' }], timestamp: ts } });
const sAsst = (stop, ts) => JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: stop, timestamp: ts } });
const sExit = () => JSON.stringify({ type: 'custom', customType: 'session_exit', data: { reason: 'sighup', kind: 'signal', recordedAt: new Date().toISOString() }, id: 'e1', timestamp: new Date().toISOString() });
const linkState = async (lines) => {
  await fs.writeFile(stateFile(), lines.join('\n') + '\n');
  await fs.writeFile(path.join(stateDir, `kitty-${WID}`), `\n${stateFile()}\n`);
};
const unlinkState = async () => fs.rm(path.join(stateDir, `kitty-${WID}`), { force: true });

test('a new role:user row in the session file proves the send', async () => {
  await reset();
  const t = Date.now();
  await linkState([sRow('/tmp/kitty-proof-cwd', new Date().toISOString()), sAsst('stop', t - 5000)]);
  try {
    const p = run(SCRIPT, ['--to', WID, '--text', 'plain note for the tab', '--timeout', '8'], {
      env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir, ...stateEnv() }),
    });
    await new Promise((r) => setTimeout(r, 1500));
    await fs.appendFile(stateFile(), sUser(Date.now()) + '\n');
    const r = await p.then(
      (ok) => ({ code: 0, out: ok.stdout, err: ok.stderr }),
      (e) => ({ code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }),
    );
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.err, /proved by session row/);
  } finally {
    await unlinkState();
  }
});

test('an exited tab dies exit 1 naming it, nothing sent', async () => {
  await reset();
  const t = Date.now();
  await linkState([sRow('/tmp/kitty-proof-cwd', new Date().toISOString()), sAsst('stop', t - 5000), sExit()]);
  try {
    const r = await runScript(['--to', WID, '--text', 'plain note for the tab', '--timeout', '3'], stateEnv());
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    assert.match(r.err, /has exited/);
  } finally {
    await unlinkState();
  }
});
// ---- pending, not failure, for a --now send still mid-turn
//
// STATE_KNOWN=1 with the target seen mid-turn at the send (--now): the message
// sits in the steering queue and no role:user row can reach the session file
// until the tool boundary. A flat-timeout "not reached" (exit 3) was a timing
// artefact twice in production — the row landed at the next look both times.
// The truthful verdict is pending (exit 8), keeping the do-not-resend rule.

test('a --now send to a tab still mid-turn at the timeout reports pending, not failure', async () => {
  await reset(null, { busyBefore: true });
  const t = Date.now();
  await linkState([sRow('/tmp/kitty-proof-cwd', new Date().toISOString()), sAsst('stop', t - 5000)]);
  try {
    const r = await runScript(['--to', WID, '--text', 'plain note for the tab', '--timeout', '3', '--now'], stateEnv());
    assert.equal(r.code, 8, `${r.out}${r.err}`);
    assert.match(r.err, /pending in its steering queue/);
    assert.match(r.err, /Do NOT send it again blind/);
  } finally {
    await unlinkState();
  }
});

test('a --now send to a mid-turn tab still confirms when the row lands at the tool boundary', async () => {
  await reset(null, { busyBefore: true });
  const t = Date.now();
  await linkState([sRow('/tmp/kitty-proof-cwd', new Date().toISOString()), sAsst('stop', t - 5000)]);
  try {
    const p = run(SCRIPT, ['--to', WID, '--text', 'plain note for the tab', '--timeout', '8', '--now'], {
      env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir, ...stateEnv() }),
    });
    await new Promise((r) => setTimeout(r, 1500));
    await fs.appendFile(stateFile(), sUser(Date.now()) + '\n');
    const r = await p.then(
      (ok) => ({ code: 0, out: ok.stdout, err: ok.stderr }),
      (e) => ({ code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }),
    );
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.err, /proved by session row/);
  } finally {
    await unlinkState();
  }
});
