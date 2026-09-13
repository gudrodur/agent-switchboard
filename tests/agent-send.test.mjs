// Tests for scripts/agent-send.mjs and scripts/lib/agent-mailbox.mjs
//.
//
// Fixtures: AGENT_MAILBOX_DIR points at a temp dir, AGENT_MAILBOX_PRESENCE_FILE
// at a temp presence file with three live beacons (s1 on /repo/a WITH the
// mailbox consumer flag, s2 on /repo/a without it, s3 on /repo/b without it),
// and AGENT_MAILBOX_KITTY at a stub serving two canned windows (991001 on
// /repo/a titled "omp: example-project review", 991002 on /repo/b titled
// "omp: example-project review docs") that records every invocation. The
// no-consumer fallback is stubbed via AGENT_SEND_KITTY_SEND, which records
// its argv and exits 5 to prove exit-code passthrough. The withdraw-path
// tests use a second stub that runs the real kitty-send.sh's argument rules
//, so a flag pair kitty-send refuses fails here too.
//
// Run: node --test tests/agent-send.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ack,
  appendMessage,
  cancelQueued,
  DELIVERED_AS,
  mailboxPath,
  pruneStale,
  readUnacked,
  readUnackedBySession,
  recipientKey,
  resolveRecipient,
} from '../lib/agent-mailbox.mjs';

const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
const REAL_KITTY_SEND = fileURLToPath(new URL('../bin/kitty-send.sh', import.meta.url));
const KEY_S1 = '-repo-a__s1';

let binDir, mboxDir, presFile, kittyStub, kittyLog, kittyLs, fallbackStub, fallbackArgv, realRulesStub;

const nowIso = () => new Date().toISOString();

const writePresence = (beacons) =>
  fs.writeFileSync(presFile, JSON.stringify({ beacons: beacons.map((b) => ({ ...b, firstTick: nowIso(), lastTick: nowIso() })) }));

before(async () => {
  binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentsend-bin-'));
  mboxDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentsend-mbox-'));
  presFile = path.join(binDir, 'presence.json');
  kittyLog = path.join(binDir, 'kitty-calls.log');
  kittyLs = path.join(binDir, 'kitty-ls.json');
  fallbackArgv = path.join(binDir, 'fallback-argv.log');
  fs.writeFileSync(kittyLs, JSON.stringify([{
    tabs: [{
      title: 'tab-one',
      windows: [
        { id: 991001, title: 'omp: example-project review', pid: 111, cwd: '/repo/a' },
        { id: 991002, title: 'omp: example-project review docs', pid: 112, cwd: '/repo/b' },
      ],
    }],
  }]));
  kittyStub = path.join(binDir, 'kitty');
  fs.writeFileSync(kittyStub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(kittyLog)}`,
    'if [ "$1/$2" = "@ /ls" ] || [ "$1" = "@" -a "$2" = "ls" ]; then',
    `  cat ${JSON.stringify(kittyLs)}`,
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  fallbackStub = path.join(binDir, 'kitty-send-stub.sh');
  fs.writeFileSync(fallbackStub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$@" > ${JSON.stringify(fallbackArgv)}`,
    'exit 5',
    '',
  ].join('\n'), { mode: 0o755 });
  // kitty-send.sh's own argument rules, not a stub's idea of them (the
  // accept-anything stub above let `--now --deadline` through, which the real
  // script refuses). This wrapper runs the real script against a kitty that
  // always fails: kitty_up runs after every flag check, so "remote control
  // unavailable" means the real script accepted the flags. Then it records the
  // argv and exits $KITTY_SEND_STUB_EXIT (default 0, delivered); a refusal
  // passes through with the real message and code.
  const failKittyDir = path.join(binDir, 'fail-kitty');
  fs.mkdirSync(failKittyDir);
  fs.writeFileSync(path.join(failKittyDir, 'kitty'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  realRulesStub = path.join(binDir, 'kitty-send-real-rules.sh');
  fs.writeFileSync(realRulesStub, [
    '#!/usr/bin/env bash',
    `err=$(PATH=${JSON.stringify(failKittyDir)}:"$PATH" bash ${JSON.stringify(REAL_KITTY_SEND)} "$@" 2>&1 >/dev/null)`,
    'rc=$?',
    'if [ "$rc" = 1 ] && printf \'%s\' "$err" | grep -q "remote control unavailable"; then',
    `  printf '%s\\n' "$@" > ${JSON.stringify(fallbackArgv)}`,
    '  exit "${KITTY_SEND_STUB_EXIT:-0}"',
    'fi',
    'printf \'%s\\n\' "$err" >&2',
    'exit "$rc"',
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.AGENT_MAILBOX_KITTY = kittyStub;
  writePresence([
    { sessionId: 's1', cwd: '/repo/a', mailbox: true },
    { sessionId: 's2', cwd: '/repo/a' },
    { sessionId: 's3', cwd: '/repo/b' },
  ]);
});

after(async () => {
  delete process.env.AGENT_MAILBOX_KITTY;
  await fs.promises.rm(binDir, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(mboxDir, { recursive: true, force: true }).catch(() => {});
});

const libOpts = () => ({ dir: mboxDir, presenceFile: presFile });
const childEnv = (extra = {}) => ({
  ...process.env,
  AGENT_MAILBOX_DIR: mboxDir,
  AGENT_MAILBOX_PRESENCE_FILE: presFile,
  AGENT_MAILBOX_KITTY: kittyStub,
  AGENT_SEND_KITTY_SEND: fallbackStub,
  ...extra,
});

const runSend = (args, env) =>
  new Promise((resolve) => {
    const child = spawn('node', [SEND, ...args], { env: env ?? childEnv() });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stderr }));
  });

test('recipientKey is deterministic and filesystem-safe', () => {
  const a = recipientKey({ cwd: '/repo/a', sessionId: 's1' });
  assert.equal(a, recipientKey({ cwd: '/repo/a', sessionId: 's1' }));
  assert.match(a, /^[A-Za-z0-9._-]+$/);
  assert.notEqual(a, recipientKey({ cwd: '/repo/a', sessionId: 's2' }));
  assert.notEqual(a, recipientKey({ cwd: '/repo/b', sessionId: 's1' }));
});

test('resolveRecipient accepts a mailbox key with the consumer flag', () => {
  const r = resolveRecipient(KEY_S1, { presenceFile: presFile });
  assert.equal(r.key, KEY_S1);
  assert.equal(r.cwd, '/repo/a');
  assert.equal(r.sessionId, 's1');
  assert.equal(r.hasConsumer, true);
});

test('resolveRecipient maps a window id to the other beacon on a shared cwd', () => {
  const r = resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's2', senderCwd: '/repo/a' });
  assert.equal(r.key, KEY_S1);
  assert.equal(r.windowId, 991001);
  assert.equal(r.hasConsumer, true);
});

test('resolveRecipient without a sender stays ambiguous on a shared cwd', () => {
  assert.throws(() => resolveRecipient('991001', { presenceFile: presFile }), /2 live sessions/);
});

test('resolveRecipient reports a window with no consumer', () => {
  const r = resolveRecipient('991002', { presenceFile: presFile });
  assert.equal(r.hasConsumer, false);
  assert.equal(r.windowId, 991002);
});

test('resolveRecipient refuses a title that matches two windows', () => {
  assert.throws(() => resolveRecipient('review', { presenceFile: presFile }), /ambiguous/);
});

test('resolveRecipient throws on an unknown window id', () => {
  assert.throws(() => resolveRecipient('123456', { presenceFile: presFile }), /no kitty window/);
});

test('each priority lands as its own value in the row', () => {
  for (const priority of ['now', 'stop', 'idle', 'queue']) {
    const row = appendMessage({ to: KEY_S1, from: 'test', priority, text: `prio ${priority}`, ...libOpts() });
    assert.equal(row.priority, priority);
    assert.match(row.id, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(row.ts)));
  }
});

test('appendMessage rejects an unknown priority', () => {
  assert.throws(() => appendMessage({ to: KEY_S1, priority: 'urgent', text: 'x', ...libOpts() }), /priority/);
});

test('readUnacked returns only messages without an ack row', () => {
  const key = '-repo-a__unack';
  const first = appendMessage({ to: key, priority: 'now', text: 'one', ...libOpts() });
  const second = appendMessage({ to: key, priority: 'now', text: 'two', ...libOpts() });
  ack({ key, id: first.id, deliveredAs: 'prompt', ...libOpts() });
  const unacked = readUnacked(key, { dir: mboxDir });
  assert.deepEqual(unacked.map((r) => r.id), [second.id]);
});

test('DELIVERED_AS is the closed delivery-label set', () => {
  assert.deepEqual([...DELIVERED_AS], ['prompt', 'mcp', 'steer', 'followUp', 'nextTurn']);
});
test('ack stays fail-open on an unknown label: the message still clears', () => {
  const key = '-repo-a__failopen';
  const row = appendMessage({ to: key, priority: 'now', text: 'x', ...libOpts() });
  ack({ key, id: row.id, deliveredAs: 'carrier-pigeon', ...libOpts() });
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
});
test('pruneStale removes only files whose recipient left presence', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentsend-prune-'));
  try {
    const staleKey = '-gone__s9';
    fs.writeFileSync(mailboxPath(staleKey, { dir }), '{"id":"x"}\n');
    fs.writeFileSync(mailboxPath(KEY_S1, { dir }), '');
    const removed = pruneStale({ dir, presenceFile: presFile });
    assert.deepEqual(removed, [staleKey]);
    assert.ok(!fs.existsSync(mailboxPath(staleKey, { dir })));
    assert.ok(fs.existsSync(mailboxPath(KEY_S1, { dir })));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('ack within deadline exits 0', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const child = spawn('node', [SEND, '--to', KEY_S1, '--text', 'hello within deadline', '--deadline', '10'], { env: childEnv() });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', resolve));
  let rowId = null;
  const pollEnd = Date.now() + 8000;
  while (rowId == null && Date.now() < pollEnd) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const lines = fs.readFileSync(mailboxPath(KEY_S1, { dir: mboxDir }), 'utf-8').split('\n').filter(Boolean);
      const row = lines.map((l) => JSON.parse(l)).find((r) => r.id);
      if (row) rowId = row.id;
    } catch { /* mailbox not written yet */ }
  }
  assert.ok(rowId, 'sender never queued the row');
  const queued = readUnacked(KEY_S1, { dir: mboxDir }).find((r) => r.id === rowId);
  assert.equal(queued.from, recipientKey({ cwd: process.cwd(), sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null }));
  ack({ key: KEY_S1, id: rowId, deliveredAs: 'mcp', dir: mboxDir });
  const code = await done;
  assert.equal(code, 0);
  assert.match(stderr, new RegExp(rowId));
  assert.match(stderr, new RegExp(mailboxPath(KEY_S1, { dir: mboxDir }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the real-rules stub measures kitty-send: it refuses --now with --deadline and accepts --now alone', () => {
  // Without this, a stub that accepted everything would pass the tests
  // below for the reason the accept-anything stub did.
  const refused = spawnSync(realRulesStub, ['--to', '1', '--text', 'x', '--now', '--deadline', '5'], { encoding: 'utf-8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--now and --wait-idle\/--deadline are mutually exclusive/);
  const accepted = spawnSync(realRulesStub, ['--to', '1', '--text', 'x', '--now'], { encoding: 'utf-8' });
  assert.equal(accepted.status, 0, accepted.stderr);
});

test('no ack in the wait window withdraws the row and falls through to kitty-send', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--text', 'parked recipient', '--deadline', '1'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub }),
  );
  assert.equal(code, 0, stderr);
  assert.match(stderr, /withdrew the mailbox row, next: kitty-send to 991001/);
  assert.equal(stderr.match(/queued, recipient busy\/parked for \S+ in /g)?.length, 1, 'the busy/parked line prints once');
  assert.doesNotMatch(stderr, /delivers it now/);
  const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(argv.includes('--to') && argv.includes('991001'));
  // The withdrawn mailbox copy must not deliver later on top of the kitty copy.
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
});

// First path, the quoted moment: `--to 39 --now --deadline 60` withdrew the
// row, then kitty-send refused `--now --deadline` with exit 1 and nothing was
// delivered. The deadline bounded agent-send's ack wait; it is not forwarded
// with --now, on the withdraw path and on the no-consumer path alike.
test('--now --deadline falls back without --deadline, and kitty-send accepts it ', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const env = childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub });
  const parked = await runSend(['--to', '991001', '--now', '--deadline', '1', '--text', 'urgent steer'], env);
  assert.equal(parked.code, 0, parked.stderr);
  let argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(argv.includes('--now'));
  assert.ok(!argv.includes('--deadline'));
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
  fs.rmSync(fallbackArgv, { force: true });
  const noConsumer = await runSend(['--to', '991002', '--stop', '--deadline', '5', '--text', 'stop now'], env);
  assert.equal(noConsumer.code, 0, noConsumer.stderr);
  argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(argv.includes('--now') && !argv.includes('--deadline'));
});

// Second path: a mailbox key whose beacon carries no window id. The row used
// to be withdrawn before the window lookup, which then died; now the lookup
// comes first and the row stays queued for the consumer.
test('an unacked mailbox key with no known window keeps its row queued and exits 3 ', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(['--to', KEY_S1, '--text', 'parked recipient', '--deadline', '1']);
  assert.equal(code, 3);
  assert.match(stderr, /no kitty window for .*stays queued.*do not resend/);
  assert.ok(!fs.existsSync(fallbackArgv), 'no window means no kitty call');
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1, 'the row is still there for the consumer');
  assert.equal(left[0].text, 'parked recipient');
  assert.match(stderr, new RegExp(`--cancel --to ${KEY_S1} --id ${left[0].id}`));
});

// A withdrawn row whose kitty fallback sends NOTHING (exit 7: mid-turn with
// none of --now/--queue/--wait-idle) goes back in the mailbox, carrying the
// original text rather than the act-once kitty copy.
test('a fallback that sends nothing puts the message back in the mailbox ', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--text', 'bare steer', '--deadline', '1'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '7' }),
  );
  assert.equal(code, 3);
  assert.match(stderr, /kitty-send exit 7 sent nothing for \S+; re-queued as \S+/);
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1);
  assert.equal(left[0].text, 'bare steer');
});

// Exit 9 (a dirty composer holding a chip kitty-send does not own) also sends
// nothing, so the withdrawn row must go back too, or the message is lost.
test('a fallback refused at a dirty composer (exit 9) puts the message back in the mailbox', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--text', 'dirty composer steer', '--deadline', '1'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '9' }),
  );
  assert.equal(code, 3);
  assert.match(stderr, /kitty-send exit 9 sent nothing for \S+; re-queued as \S+/);
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1);
  assert.equal(left[0].text, 'dirty composer steer');
});

test('a fallback that sent but could not prove it (exit 3) is not re-queued', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code } = await runSend(
    ['--to', '991001', '--text', 'sent unproven', '--deadline', '1'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '3' }),
  );
  assert.equal(code, 3);
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), [], 'a sent message must not be queued a second time');
});

test('no consumer falls through to the stub kitty-send with the argv', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  const { code, stderr } = await runSend(['--to', '991002', '--text', 'hello fallback']);
  assert.equal(code, 5);
  assert.match(stderr, /agent-send: no mailbox consumer flag for 991002 \(live beacon, flag off\), falling back to kitty-send/);
  const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(argv.includes('--to') && argv.includes('991002'));
  assert.ok(argv.includes('--text') && argv.includes('hello fallback'));
});

// 2026-09-11 mailbox key-resolution fix: two sessions sharing one cwd, one
// addressing the other by window id or title. Before the fix the window's cwd
// picked the most-recent/consumer beacon, which could be the SENDER itself
// (peer's reply to "Stjórnir í einingar" landed in its own inbox).
test('a window id shared by two sessions resolves to the OTHER session, never the sender', () => {
  const r = resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' });
  assert.equal(r.key, '-repo-a__s2');
  assert.equal(r.windowId, 991001);
});

test('a window shared by three sessions is ambiguous even after excluding the sender', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's2', cwd: '/repo/a' },
      { sessionId: 's2b', cwd: '/repo/a' },
      { sessionId: 's3', cwd: '/repo/b' },
    ]);
    assert.throws(
      () => resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' }),
      /-repo-a__s2.*-repo-a__s2b|-repo-a__s2b.*-repo-a__s2/,
    );
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a window whose only live beacon is the sender is an error, never a self-send', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's3', cwd: '/repo/b' },
    ]);
    assert.throws(
      () => resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' }),
      /sender itself/,
    );
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a mailbox key may still address the sender itself', () => {
  const r = resolveRecipient(KEY_S1, { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' });
  assert.equal(r.key, KEY_S1);
});

test('a title naming one window resolves to the other session on the shared cwd', () => {
  const savedLs = fs.readFileSync(kittyLs, 'utf-8');
  const savedPres = fs.readFileSync(presFile, 'utf-8');
  try {
    fs.writeFileSync(kittyLs, JSON.stringify([{ tabs: [
      { title: 'Stjórnir í einingar', windows: [{ id: 991101, title: 'x', pid: 111, cwd: '/repo/a' }] },
      { title: 'kennitala-encryption-cleanup', windows: [{ id: 991102, title: 'y', pid: 112, cwd: '/repo/a' }] },
    ] }]));
    writePresence([
      { sessionId: 's-overseer', cwd: '/repo/a', mailbox: true },
      { sessionId: 's-peer', cwd: '/repo/a', mailbox: true },
    ]);
    const r = resolveRecipient('Stjórnir í einingar', { presenceFile: presFile, senderSessionId: 's-peer', senderCwd: '/repo/a' });
    assert.equal(r.key, '-repo-a__s-overseer');
  } finally {
    fs.writeFileSync(kittyLs, savedLs);
    fs.writeFileSync(presFile, savedPres);
  }
});

test('pruneStale keeps a pre-move key while its session is live under another cwd', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const key = '-repo-a__s-peer';
  try {
    writePresence([{ sessionId: 's-peer', cwd: '/repo/wt-a', mailbox: true }]);
    appendMessage({ to: key, from: 'test', priority: 'now', text: 'pre-move row', ...libOpts() });
    const removed = pruneStale({ ...libOpts(), presenceFile: presFile });
    assert.ok(!removed.includes(key));
    assert.ok(fs.existsSync(mailboxPath(key, { dir: mboxDir })));
  } finally {
    fs.writeFileSync(presFile, saved);
    fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
  }
});

// 2026-09-11: a window with no mailbox consumer behind it (an omp
// tab, a plain shell, a sender-only cwd) falls back to kitty-send — the
// supervisor steer path — while ambiguity stays fatal.
test('agent-send to a sender-only window falls back to kitty-send, never self-sends', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const ownFile = mailboxPath('-repo-a__s1', { dir: mboxDir });
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's3', cwd: '/repo/b' },
    ]);
    fs.rmSync(ownFile, { force: true });
    fs.rmSync(fallbackArgv, { force: true });
    const { code, stderr } = await runSend(
      ['--to', '991001', '--text', 'steer to omp tab'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(code, 5);
    assert.match(stderr, /no mailbox consumer at 991001, falling back to kitty-send/);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--to') && argv.includes('991001'));
    assert.ok(!fs.existsSync(ownFile), 'no row may land in the sender\'s own file');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('agent-send to a window with no beacon at all falls back to kitty-send', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true }]);
    fs.rmSync(fallbackArgv, { force: true });
    const { code, stderr } = await runSend(
      ['--to', '991002', '--text', 'plain shell hello'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(code, 5);
    assert.match(stderr, /no mailbox consumer at 991002, falling back to kitty-send/);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--to') && argv.includes('991002'));
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('an ambiguous window stays fatal in agent-send, no kitty call', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's2', cwd: '/repo/a' },
      { sessionId: 's2b', cwd: '/repo/a' },
    ]);
    fs.rmSync(kittyLog, { force: true });
    fs.rmSync(fallbackArgv, { force: true });
    const { code, stderr } = await runSend(
      ['--to', '991001', '--text', 'must not guess'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(code, 1);
    assert.match(stderr, /matches 2 live sessions \(-repo-a__s2, -repo-a__s2b\)/);
    assert.ok(!fs.existsSync(fallbackArgv), 'ambiguity must not reach kitty-send');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('priority flags reach kitty-send unchanged on the fallback path', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true }]);
    fs.rmSync(fallbackArgv, { force: true });
    const idle = await runSend(
      ['--to', '991002', '--idle-when', '5m', '--text', 'idle steer'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(idle.code, 5);
    let argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--idle-when') && argv.includes('5m'));
    assert.ok(!argv.includes('--now'));
    fs.rmSync(fallbackArgv, { force: true });
    const queued = await runSend(
      ['--to', '991002', '--queue', '--text', 'queued steer'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(queued.code, 5);
    argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--queue'));
    fs.rmSync(fallbackArgv, { force: true });
    const now = await runSend(
      ['--to', '991002', '--now', '--text', 'urgent steer'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(now.code, 5);
    argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--now'));
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});
test('resolution errors carry codes; no-consumer messages name kitty-send', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const capture = (fn) => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    assert.fail('expected resolveRecipient to throw');
  };
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true }]);
    const opts = { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' };
    // What send_message switches its agent-send hint on (index.mjs cannot run
    // here — no MCP SDK on the box — so the codes and message text are pinned
    // at the lib boundary instead).
    const self = capture(() => resolveRecipient('991001', opts));
    assert.equal(self.code, 'mailbox-self');
    assert.match(self.message, /kitty-send\.sh/);
    const none = capture(() => resolveRecipient('991002', opts));
    assert.equal(none.code, 'mailbox-no-beacon');
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's2', cwd: '/repo/a' },
    ]);
    const amb = capture(() => resolveRecipient('991001', {
      presenceFile: presFile, senderSessionId: 'nobody', senderCwd: '/elsewhere',
    }));
    assert.equal(amb.code, 'mailbox-ambiguous');
    assert.match(amb.message, /2 live sessions/);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

// 2026-09-11: a sender addressing the PRE-move key after the move.
// The exact-key lookup misses (no beacon carries the old cwd), but the
// session id never moves, so the `__<sid>` suffix resolves to the beacon's
// current key.
test('a pre-move key resolves to the moved session\'s current key', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/wt-a', mailbox: true }]);
    const r = resolveRecipient('-repo-a__s1', { presenceFile: presFile });
    assert.equal(r.key, '-repo-wt-a__s1');
    assert.equal(r.cwd, '/repo/wt-a');
    assert.equal(r.sessionId, 's1');
    assert.equal(r.hasConsumer, true);
    assert.equal(r.windowId, null);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a stale key whose session id has no live beacon keeps the no-live-session error', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's2', cwd: '/repo/a', mailbox: true }]);
    assert.throws(
      () => resolveRecipient('-repo-a__s1', { presenceFile: presFile }),
      /no live session for mailbox key '-repo-a__s1'/,
    );
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a pre-move key shared by two live beacons is ambiguous, never a guess', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/wt-a', mailbox: true },
      { sessionId: 's1', cwd: '/repo/wt-b' },
    ]);
    const err = (() => {
      try {
        resolveRecipient('-repo-a__s1', { presenceFile: presFile });
      } catch (e) {
        return e;
      }
      assert.fail('expected resolveRecipient to throw');
    })();
    assert.equal(err.code, 'mailbox-ambiguous');
    assert.match(err.message, /2 live sessions/);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('agent-send to a pre-move key queues in the current key file and is acked', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const currentFile = mailboxPath('-repo-wt-a__s9', { dir: mboxDir });
  try {
    writePresence([{ sessionId: 's9', cwd: '/repo/wt-a', mailbox: true }]);
    fs.rmSync(currentFile, { force: true });
    const child = spawn('node', [SEND, '--to', '-repo-a__s9', '--text', 'hello after the move', '--deadline', '10'], { env: childEnv() });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const done = new Promise((resolve) => child.on('close', resolve));
    const pollEnd = Date.now() + 8000;
    let rowId = null;
    while (rowId == null && Date.now() < pollEnd) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const lines = fs.readFileSync(currentFile, 'utf-8').split('\n').filter(Boolean);
        const row = lines.map((l) => JSON.parse(l)).find((r) => r.id);
        if (row) rowId = row.id;
      } catch { /* mailbox not written yet */ }
    }
    assert.ok(rowId, 'sender never queued the row in the current key file');
    ack({ key: '-repo-wt-a__s9', id: rowId, deliveredAs: 'mcp', dir: mboxDir });
    const code = await done;
    assert.equal(code, 0);
    assert.match(stderr, new RegExp(rowId));
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

// 2026-09-12: a window id resolves by the window id the recipient recorded
// in its beacon, not by cwd. Two sessions sharing one cwd in different
// windows are addressable by window id (2026-09-12 00:00:03Z: window 35
// matched 2 live sessions on one cwd).
test('a window id resolves by recorded window id on a shared cwd', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const savedLs = fs.readFileSync(kittyLs, 'utf-8');
  try {
    fs.writeFileSync(kittyLs, JSON.stringify([{ tabs: [
      { title: 'supervisor', windows: [{ id: 35, title: 'sup', pid: 111, cwd: '/repo/shared' }] },
      { title: 'pkg-a', windows: [{ id: 36, title: 'a', pid: 112, cwd: '/repo/shared' }] },
    ] }]));
    writePresence([
      { sessionId: 's-sup', cwd: '/repo/shared', mailbox: true, windowId: 35 },
      { sessionId: 's-a', cwd: '/repo/shared', mailbox: true, windowId: 36 },
    ]);
    const toA = resolveRecipient('36', { presenceFile: presFile, senderSessionId: 's-elsewhere', senderCwd: '/other' });
    assert.equal(toA.key, '-repo-shared__s-a');
    assert.equal(toA.windowId, 36);
    const toSup = resolveRecipient('35', { presenceFile: presFile, senderSessionId: 's-elsewhere', senderCwd: '/other' });
    assert.equal(toSup.key, '-repo-shared__s-sup');
  } finally {
    fs.writeFileSync(kittyLs, savedLs);
    fs.writeFileSync(presFile, saved);
  }
});

test('targeting the sender window by id never delivers to the cwd-sharer', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const savedLs = fs.readFileSync(kittyLs, 'utf-8');
  try {
    fs.writeFileSync(kittyLs, JSON.stringify([{ tabs: [
      { title: 'supervisor', windows: [{ id: 35, title: 'sup', pid: 111, cwd: '/repo/shared' }] },
      { title: 'pkg-a', windows: [{ id: 36, title: 'a', pid: 112, cwd: '/repo/shared' }] },
    ] }]));
    writePresence([
      { sessionId: 's-sup', cwd: '/repo/shared', mailbox: true, windowId: 35 },
      { sessionId: 's-a', cwd: '/repo/shared', mailbox: true, windowId: 36 },
    ]);
    // Sender session id unknown (an omp caller), but its window is known.
    const err = (() => {
      try {
        resolveRecipient('35', { presenceFile: presFile, senderWindowId: 35 });
      } catch (e) {
        return e;
      }
      assert.fail('expected resolveRecipient to throw');
    })();
    assert.equal(err.code, 'mailbox-self');
  } finally {
    fs.writeFileSync(kittyLs, savedLs);
    fs.writeFileSync(presFile, saved);
  }
});

test('cancelQueued withdraws a row: no later drain delivers it', () => {
  const key = '-repo-a__withdrawn';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  cancelQueued({ key, id: row.id, ...libOpts() });
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
  assert.deepEqual(readUnackedBySession('withdrawn', { dir: mboxDir }), []);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('agent-send --cancel withdraws one row by id', async () => {
  const key = '-repo-a__cancelcli';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  const child = spawn('node', [SEND, '--cancel', '--to', key, '--id', row.id], { env: childEnv() });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.match(stderr, new RegExp(row.id));
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('agent-send --read prints and acks this session inbox rows', async () => {
  const key = '-repo-a__reader';
  appendMessage({ to: key, from: 's-peer', priority: 'now', text: 'hello reader', ...libOpts() });
  const runRead = () => new Promise((resolve) => {
    const child = spawn('node', [SEND, '--read', '--as', 'reader'], { env: childEnv() });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const first = await runRead();
  assert.equal(first.code, 0);
  assert.match(first.stdout, /hello reader/);
  assert.match(first.stderr, /1 unacked/);
  const second = await runRead();
  assert.equal(second.code, 0);
  assert.match(second.stderr, /0 unacked/);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('agent-send --help names the inbox read verb', async () => {
  const out = await new Promise((resolve) => {
    const child = spawn('node', [SEND, '--help'], { env: childEnv() });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
  assert.equal(out.code, 0);
  assert.match(out.stdout, /--read/);
  assert.match(out.stdout, /inbox/i);
});

// kitty-send exit 8 means sent under
// --now while mid-turn and still mid-turn at the deadline — pending in the
// steering queue, not lost. agent-send passes the code through and names it
// as pending instead of a failure.
test('a kitty-send exit 8 passes through as pending, never a failure', async () => {
  const pendingStub = path.join(binDir, 'kitty-send-pending-stub.sh');
  fs.writeFileSync(pendingStub, [
    '#!/usr/bin/env bash',
    'echo "sent to window $2 while it was mid-turn (--now); still mid-turn" >&2',
    'exit 8',
    '',
  ].join('\n'), { mode: 0o755 });
  const { code, stderr } = await runSend(
    ['--to', '991002', '--now', '--text', 'mid-turn steer'],
    { ...childEnv(), AGENT_SEND_KITTY_SEND: pendingStub },
  );
  assert.equal(code, 8);
  assert.match(stderr, /kitty-send exit 8 for 991002: pending in the steering queue until the tool boundary, not lost; do not resend/);
});

// A kitty fallback that ends in exit 9 (composer held unsubmitted text,
// nothing sent) must report non-zero plus one stderr line naming the queue
// log; a fallback the target queues (exit 0 under --queue) must name the
// queue log to confirm, since the verdict arrives later and asynchronously.
test('a no-consumer fallback refused at a dirty composer (exit 9) names the queue log and stays non-zero', async () => {
  const queueDir = path.join(binDir, 'xdg-run');
  fs.mkdirSync(queueDir, { recursive: true });
  const { code, stderr } = await runSend(
    ['--to', '991002', '--text', 'dirty composer direct'],
    childEnv({ AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '9', XDG_RUNTIME_DIR: queueDir }),
  );
  assert.notEqual(code, 0, 'exit 9 must reach the caller as a failure');
  assert.match(stderr, /kitty-send exit 9 for 991002: nothing was sent \(composer holds unsubmitted text\)/);
  assert.match(stderr, new RegExp(`kitty queue log: ${queueDir}/kitty-send/queue-991002\\.log`));
});

test('a queued kitty fallback (exit 0 under --queue) names the queue log to confirm', async () => {
  const queueDir = path.join(binDir, 'xdg-run');
  fs.mkdirSync(queueDir, { recursive: true });
  const queueStub = path.join(binDir, 'kitty-send-queued-stub.sh');
  fs.writeFileSync(queueStub, ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'), { mode: 0o755 });
  const { code, stderr } = await runSend(
    ['--to', '991002', '--text', 'queued steer', '--queue'],
    { ...childEnv(), AGENT_SEND_KITTY_SEND: queueStub, XDG_RUNTIME_DIR: queueDir },
  );
  assert.equal(code, 0);
  assert.match(stderr, new RegExp(`kitty-send queued for 991002; .*confirm it in ${queueDir}/kitty-send/queue-991002\\.log`));
});

// A supervisor idle ~30 min ages past the 20-min presence window, so its
// beacon (mailbox flag and all) is pruned. The fallback line must say WHY:
// no beacon, stale beacon since <time>, or live beacon with the flag off.
test('a steer to a window whose beacon went stale names the last tick', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    fs.writeFileSync(presFile, JSON.stringify({ beacons: [
      { sessionId: 's9', cwd: '/repo/b', mailbox: true, windowId: 991002, firstTick: old, lastTick: old },
    ] }));
    const { code, stderr } = await runSend(
      ['--to', '991002', '--text', 'stale steer'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's3' }),
    );
    assert.equal(code, 5);
    assert.match(stderr, /stale mailbox beacon for 991002.*last tick .* past the presence window/);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a live beacon without the flag says flag off', async () => {
  const { code, stderr } = await runSend(['--to', '991002', '--text', 'flag off steer']);
  assert.equal(code, 5);
  assert.match(stderr, /no mailbox consumer flag for 991002 \(live beacon, flag off\)/);
});
