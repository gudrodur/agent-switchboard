// Tests for kitty-send.sh's WAIT semantics: --queue is unbounded
// by default (with a heartbeat), --deadline N caps the wait, and the two bound
// spellings (--wait-idle/--deadline) refuse to be passed together.
// Also --idle-when: a spinning target whose screen says it is parked is
// steerable, a dialog still is not, and --queue forwards the flag.
//
// The delivery-proof half of the script (cases 1-14 in kitty-send.test.sh)
// needs REAL kitty windows — a fixture reproduces none of the rendering bugs.
// These cases need none: parsing and deadline/heartbeat math run before any
// real keystroke, so `kitty` is a PATH stand-in that reports ONE window whose
// title never stops spinning and whose screen is always empty. That is enough
// for the script to parse, spawn its detached waiter, and let the waiter run
// against the deadline, without a real kitty or a real target. This file runs
// in CI (node --test); kitty-send.test.sh cannot (no kitty remote control on
// a hosted runner) and exits 2 there.
//
// Run: node --test tests/kitty-send-wait.test.mjs (or the full suite)
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
// A numeric id: the script resolves numeric --to directly, no title matching.
const WID = '991001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let binDir, queueDir;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-mock-'));
  // The mock: `@ ls` reports one window whose title carries a braille spinner
  // (omp's "busy" marker, U+2839) and whose pid is alive, so the waiter never
  // sees it go idle and never sees it die. get-text/send-text succeed quietly.
  // KITTY_MOCK_SCREEN is what `@ get-text` returns, so a test can put the
  // target in a state ("parked", "showing a dialog") without a real kitty.
  // Empty by default, which is what every earlier case assumed.
  await fs.writeFile(path.join(binDir, 'kitty'), `#!/usr/bin/env bash
if [ "\${1:-}" = "@" ] && [ "\${2:-}" = "ls" ]; then
  printf '%s\\n' '[{"tabs":[{"title":"mock-tab","windows":[{"id":${WID},"title":"π ⠹ mock busy (never idle)","pid":424242,"cwd":"/tmp/kitty-wait-cwd"}]}]}]'
fi
if [ "\${1:-}" = "@" ] && [ "\${2:-}" = "get-text" ]; then
  printf '%s\\n' "\${KITTY_MOCK_SCREEN:-}"
fi
exit 0
`, { mode: 0o755 });
  queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-queue-'));
});

after(async () => {
  // A leftover unbounded waiter must not survive a failed test: cancel by the
  // recorded pid, then drop the whole per-test runtime dir.
  try {
    await fs.rm(queueDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
});

const runScript = async (args, extraEnv = {}) => {
  try {
    const r = await run(SCRIPT, args, {
      env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: queueDir, ...extraEnv }),
      timeout: 20_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

const logPath = () => path.join(queueDir, 'kitty-send', `queue-${WID}.log`);
const pidPath = () => path.join(queueDir, 'kitty-send', `queue-${WID}.pid`);
const readLog = async () => fs.readFile(logPath(), 'utf-8').catch(() => '');
const pidGone = async () => fs.access(pidPath()).then(() => false, () => true);

// Wait until a predicate holds, polling every 200 ms.
const until = async (pred, what, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await sleep(200);
  }
  assert.fail(`timed out waiting for: ${what}`);
};

// ---- argument parsing (no kitty behaviour involved) --------------------------

test('--deadline rejects a non-number', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--deadline', 'soon']);
  assert.equal(code, 1);
  assert.match(err, /--deadline must be a number of seconds/);
});

test('--wait-idle and --deadline are the same bound; both given is refused', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--wait-idle', '30', '--deadline', '60']);
  assert.equal(code, 1);
  assert.match(err, /--wait-idle and --deadline both bound the wait/);
});

test('--now with --deadline is refused like --now with --wait-idle', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--now', '--deadline', '60']);
  assert.equal(code, 1);
  assert.match(err, /mutually exclusive/);
});

// ---- deadline math: a capped queue dies AT the cap, nothing sent -------------

test('--queue --deadline N dies at N with exit 5 semantics, nothing sent', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--queue', '--deadline', '2']);
  assert.equal(code, 0);
  assert.match(err, /queued for window 991001: waits up to 2s for it to go idle/);
  // The detached waiter must hit the 2 s deadline on a never-idle target.
  await until(async () => (await readLog()).includes('target still busy after 2s (nothing was sent)'), 'deadline message in the log');
  await until(pidGone, 'the waiter removed its pid file on exit');
  const log = await readLog();
  assert.doesNotMatch(log, /delivered/);
});

// ---- unbounded default: waits indefinitely, refuses a second queue -----------

test('--queue with no bound waits indefinitely (no 600 s default) and --cancel stops it', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--queue']);
  assert.equal(code, 0);
  assert.match(err, /queued for window 991001: waits until it goes idle \(no deadline; heartbeat every 300s\)/);
  assert.doesNotMatch(err, /waits up to 600s/);
  // Still held after a few seconds: the old fixed default would already be gone.
  await sleep(2500);
  assert.equal(await pidGone(), false, 'the unbounded waiter must still be alive');
  const { code: c2, err: e2 } = await runScript(['--to', WID, '--text', 'hi', '--queue']);
  assert.equal(c2, 6);
  assert.match(e2, /already queued/);
  const { code: c3, err: e3 } = await runScript(['--cancel', '--to', WID]);
  assert.equal(c3, 0);
  assert.match(e3, /cancelled the queued send/);
  await until(pidGone, 'cancel removed the pid file');
  const { code: c4 } = await runScript(['--cancel', '--to', WID]);
  assert.equal(c4, 1);
});

// ---- heartbeat: an unbounded wait logs a line every KITTY_SEND_HEARTBEAT_S ---

test('an unbounded waiter logs a heartbeat so a long wait reads as alive', async () => {
  const { code } = await runScript(['--to', WID, '--text', 'hi', '--queue'], { KITTY_SEND_HEARTBEAT_S: '1' });
  assert.equal(code, 0);
  await until(async () => (await readLog()).includes('still waiting for window 991001'), 'heartbeat line in the log');
  const log = await readLog();
  assert.match(log, /still waiting for window 991001 to go idle after \d+s \(nothing sent yet\)/);
  await runScript(['--cancel', '--to', WID]);
  await until(pidGone, 'cancel removed the pid file');
});

// ---- --idle-when: a spinner is not always work  ------------------

const PARKED = 'Bíð eftir næsta skilaboði.';

test('a spinning target with no --idle-when is exit 7, nothing sent', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi'], { KITTY_MOCK_SCREEN: PARKED });
  assert.equal(code, 7);
  assert.match(err, /refusing to send into a mid-turn target/);
});

test('--idle-when matching the screen makes a spinning target steerable', async () => {
  const { code, err } = await runScript(
    // --timeout 2: the send is attempted and the proof then fails on a mock
    // screen that never echoes it. Waiting the default 20 s proves nothing more.
    ['--to', WID, '--text', 'hi', '--idle-when', 'Bíð eftir næsta', '--timeout', '2'],
    { KITTY_MOCK_SCREEN: PARKED },
  );
  // It must get PAST the busy refusal. It cannot reach exit 0 against a mock
  // whose screen never echoes the message, so the proof fails at exit 3 — the
  // point is only that exit 7 is gone and the send was attempted.
  assert.notEqual(code, 7);
  assert.doesNotMatch(err, /refusing to send into a mid-turn target/);
  assert.match(err, /screen matches --idle-when: treating it as parked, not working/);
});

test('--idle-when that does not match leaves the target busy', async () => {
  const { code, err } = await runScript(
    ['--to', WID, '--text', 'hi', '--idle-when', 'waiting for the next message'],
    { KITTY_MOCK_SCREEN: PARKED },
  );
  assert.equal(code, 7);
  assert.match(err, /refusing to send into a mid-turn target/);
});

test('a dialog still wins over --idle-when: it is the human\'s to answer', async () => {
  const { code, err } = await runScript(
    ['--to', WID, '--text', 'hi', '--idle-when', 'Bíð eftir næsta'],
    { KITTY_MOCK_SCREEN: `${PARKED}\n  ↑/↓ move   Enter select   Esc cancel` },
  );
  assert.equal(code, 4);
  assert.match(err, /refusing to type into a dialog/);
});

test('--queue forwards --idle-when to its detached waiter', async () => {
  const { code } = await runScript(
    ['--to', WID, '--text', 'hi', '--queue', '--deadline', '4', '--idle-when', 'Bíð eftir næsta'],
    { KITTY_MOCK_SCREEN: PARKED },
  );
  assert.equal(code, 0);
  // The waiter must break out of the wait loop on the parked screen instead of
  // burning the 4 s deadline: without the forward it would time out at exit 5.
  await until(async () => (await readLog()).includes('--idle-when'), 'the waiter saw the parked screen');
  const log = await readLog();
  assert.doesNotMatch(log, /target still busy after 4s/);
  await runScript(['--cancel', '--to', WID]).catch(() => {});
});
// ---- proof by state first: the state file decides, the spinner does not ----
//
// The mock window spins forever, so on the spinner alone every send below is
// exit 7. A linked session file says otherwise, and the file wins — except
// --idle-when, which is the caller's own parked proof and wins over busy.
// Nothing here touches the tests above: they run with no kitty-<id> file,
// so the state is unknown and the spinner decides, exactly as before.

const wStateDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'kitty-wait-state-'));
const wRow = (cwd, ts) => JSON.stringify({ type: 'session', version: 3, id: '01t', timestamp: ts, cwd });
const wUser = (ts) => JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'steer' }], timestamp: ts } });
const wAsst = (stop, ts) => JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: stop, timestamp: ts } });
const wLink = (dir, lines) => fs.writeFile(path.join(dir, 'wtab.jsonl'), lines.join('\n') + '\n')
  .then((fp) => fs.writeFile(path.join(dir, `kitty-${WID}`), `\n${path.join(dir, 'wtab.jsonl')}\n`));
const wSend = (args, dir, extraEnv = {}) => {
  const p = run(SCRIPT, args, {
    env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: queueDir, OMP_TAB_STATE_DIR: dir, ...extraEnv }),
  });
  return p.then(
    (ok) => ({ code: 0, out: ok.stdout, err: ok.stderr }),
    (e) => ({ code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }),
  );
};

test('state=idle sends past a spinner title with no flag', async () => {
  const dir = await wStateDir();
  try {
    const t = Date.now();
    await wLink(dir, [wRow('/tmp/kitty-wait-cwd', new Date().toISOString()), wAsst('stop', t - 5000)]);
    const p = wSend(['--to', WID, '--text', 'hi from the state test', '--timeout', '8'], dir);
    await sleep(1500);
    await fs.appendFile(path.join(dir, 'wtab.jsonl'), wUser(Date.now()) + '\n');
    const { code, err } = await p;
    assert.equal(code, 0, err);
    assert.match(err, /proved by session row/);
    assert.doesNotMatch(err, /refusing to send into a mid-turn target/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--idle-when still wins over state=busy', async () => {
  const dir = await wStateDir();
  try {
    const t = Date.now();
    await wLink(dir, [wRow('/tmp/kitty-wait-cwd', new Date().toISOString()), wAsst('toolUse', t - 1000)]);
    const p = wSend(['--to', WID, '--text', 'hi from the state test', '--idle-when', 'Bíð eftir næsta', '--timeout', '8'], dir, { KITTY_MOCK_SCREEN: PARKED });
    await sleep(1500);
    await fs.appendFile(path.join(dir, 'wtab.jsonl'), wUser(Date.now()) + '\n');
    const { code, err } = await p;
    assert.equal(code, 0, err);
    assert.match(err, /proved by session row/);
    assert.doesNotMatch(err, /refusing to send into a mid-turn target/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
