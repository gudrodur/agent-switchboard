// Tests for scripts/agent-send.mjs and scripts/lib/agent-mailbox.mjs
//.
//
// Fixtures: AGENT_MAILBOX_DIR points at a temp dir, AGENT_MAILBOX_PRESENCE_FILE
// at a temp presence file with three live beacons (s1 on /repo/a WITH the
// mailbox consumer flag, s2 on /repo/a without it, s3 on /repo/b without it),
// and AGENT_MAILBOX_KITTY at a stub serving two canned windows (991001 on
// /repo/a titled "opencode: example-project review", 991002 on /repo/b titled
// "opencode: example-project review docs") that records every invocation. The
// no-consumer fallback is stubbed via AGENT_SEND_KITTY_SEND, which records
// its argv and exits 5 to prove exit-code passthrough. The withdraw-path
// tests use a second stub that runs the real kitty-send.sh's argument rules
//, so a flag pair kitty-send refuses fails here too.
//
// Run: node --test tests/agent-send.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ack,
  appendMessage,
  cancelQueued,
  findRow,
  DELIVERED_AS,
  findRecentTopicDelivery,
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
        { id: 991001, title: 'opencode: example-project review', pid: 111, cwd: '/repo/a' },
        { id: 991002, title: 'opencode: example-project review docs', pid: 112, cwd: '/repo/b' },
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
const childEnv = (extra = {}) => isolatedEnv({
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
  assert.deepEqual([...DELIVERED_AS], ['prompt', 'mcp', 'steer', 'followUp', 'nextTurn', 'typed']);
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

test('an idle recipient caps the ack wait instead of blocking the full default (row 58)', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const t0 = Date.now();
  const { code, stderr } = await runSend(
    ['--to', '991001', '--text', 'parked steer'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '10' }),
  );
  const elapsed = Date.now() - t0;
  // The kitty stub reports an idle title, so the 120 s default caps at 5 s;
  // exit 10 (typed, not proven submitted) passes through, never re-queued.
  assert.equal(code, 10, stderr);
  assert.match(stderr, /ack wait capped at 5s/);
  assert.match(stderr, /kitty-send exit 10 for 991001: typed, not proven submitted/);
  assert.ok(elapsed < 30_000, `idle recipient must not wait the full default (took ${elapsed}ms)`);
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), [], 'a typed message must not be queued a second time');
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
  assert.match(stderr, new RegExp(`withdraw it with --cancel --id ${left[0].id}`));
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
  assert.match(stderr, /kitty-send exit 7 sent nothing \(mid-turn without --now\/--queue\/--wait-idle\) for \S+; re-queued as \S+/);
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
  assert.match(stderr, /kitty-send exit 9 sent nothing \(composer holds unsubmitted text\) for \S+; re-queued as \S+/);
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1);
  assert.equal(left[0].text, 'dirty composer steer');
});

// agent-config#1310: the exit code is the delivery verdict. On the withdraw
// path kitty-send must run SYNCHRONOUSLY (--wait-idle, never --queue, whose
// detached waiter returns 0 at once), so a wait that runs out (exit 5) is seen
// and the row is re-queued instead of lost behind an exit 0.
test('withdraw path under --queue --deadline forwards --wait-idle, re-queues on exit 5, prints one verdict', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--queue', '--deadline', '1', '--text', 'queued steer'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '5' }),
  );
  const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(!argv.includes('--queue'), `--queue must not be forwarded: ${argv}`);
  assert.equal(argv[argv.indexOf('--wait-idle') + 1], '1', `argv: ${argv}`);
  assert.ok(!argv.includes('--deadline'));
  assert.equal(code, 3, stderr);
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1, 're-queued row exists');
  assert.equal(left[0].text, 'queued steer');
  assert.match(stderr, /kitty-send exit 5 sent nothing \(idle wait ran out\) for \S+; re-queued as \S+/);
  assert.doesNotMatch(stderr, /check the tab first/);
  assert.doesNotMatch(stderr, /nothing was sent/);
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

// agent-config#1355: one Claude Code session whose worktree subagent wrote a
// second presence beacon under the worktree cwd is ONE recipient: both
// beacons carry the same sessionId, and every consumer drains by session id.
const writePresenceTicks = (beacons) =>
  fs.writeFileSync(presFile, JSON.stringify({ beacons: beacons.map((b) => ({ firstTick: b.lastTick, ...b })) }));
const sameSessionBeacons = () => [
  { sessionId: 's1', cwd: '/repo/z', mailbox: true, lastTick: new Date(Date.now() - 60000).toISOString() },
  { sessionId: 'sx', cwd: '/repo/a', mailbox: true, windowId: 991001, lastTick: new Date(Date.now() - 30000).toISOString() },
  { sessionId: 'sx', cwd: '/repo/a/.claude/worktrees/agent-1', mailbox: true, windowId: 991001, lastTick: nowIso() },
];

test('two beacons of one session on one window are one recipient, the newest-tick key', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresenceTicks(sameSessionBeacons());
    const r = resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/z' });
    assert.equal(r.key, '-repo-a-.claude-worktrees-agent-1__sx');
    assert.equal(r.sessionId, 'sx');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a mailbox key whose session id matches two same-session beacons resolves to the newest', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresenceTicks(sameSessionBeacons());
    const r = resolveRecipient('-repo-gone__sx', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/z' });
    assert.equal(r.key, '-repo-a-.claude-worktrees-agent-1__sx');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('same-session collapse leaves two different session ids ambiguous', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresenceTicks([
      ...sameSessionBeacons(),
      { sessionId: 'sy', cwd: '/repo/a', mailbox: true, windowId: 991001, lastTick: nowIso() },
    ]);
    assert.throws(
      () => resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/z' }),
      /matches 2 live sessions/,
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

// 2026-09-11: a window with no mailbox consumer behind it (a
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
      ['--to', '991001', '--text', 'steer to a tab'],
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

// agent-config#1355: the two beacons carry one session id, so they are one
// recipient (the old expectation was mailbox-ambiguous, which refused a send
// to a session whose worktree subagent wrote a second beacon).
test('a pre-move key shared by two live beacons of one session resolves to one recipient', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/wt-a', mailbox: true },
      { sessionId: 's1', cwd: '/repo/wt-b' },
    ]);
    const r = resolveRecipient('-repo-a__s1', { presenceFile: presFile });
    assert.equal(r.sessionId, 's1');
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
    // Sender session id unknown (a caller without a session id), but its window is known.
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

// --cancel resolves the row by id and withdraws it under the row's OWN
// recipient key (agent-config#1379): a caller's --to is a hint, not the address.
const rowLines = (key) => {
  try {
    return fs.readFileSync(mailboxPath(key, { dir: mboxDir }), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const runCancel = (args) => {
  const r = spawnSync('node', [SEND, '--cancel', ...args], { env: childEnv(), encoding: 'utf-8' });
  return { code: r.status, stderr: r.stderr };
};

test('--cancel --to <wrong key> --id withdraws under the row\'s real key (file mode)', () => {
  const key = '-repo-a__realkey';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  const { code, stderr } = runCancel(['--to', 'role:some-role', '--id', row.id]);
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`withdrew ${row.id} \\(recipient ${key}\\)`));
  assert.match(stderr, /--to named role:some-role, the row's own recipient was used/);
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
  assert.equal(rowLines(key).filter((r) => r.withdraw === row.id).length, 1);
  assert.equal(rowLines('role:some-role').length, 0, 'nothing written under the literal --to');
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('--cancel --id alone withdraws (file mode)', () => {
  const key = '-repo-a__idonly';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  const { code, stderr } = runCancel(['--id', row.id]);
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /--to named/);
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('--cancel on a delivered row exits 13, names the ack, writes nothing (file mode)', () => {
  const key = '-repo-a__delivered';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  const a = ack({ key, id: row.id, deliveredAs: 'typed', ...libOpts() });
  const before = rowLines(key).length;
  const { code, stderr } = runCancel(['--to', key, '--id', row.id]);
  assert.equal(code, 13);
  assert.match(stderr, new RegExp(`not withdrawn: ${row.id} was already delivered at ${a.ts} as ${a.deliveredAs}`));
  assert.equal(rowLines(key).length, before);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('--cancel on an unknown id exits 14, writes nothing (file mode)', () => {
  // Every mailbox file's size, so an append to an existing file shows too.
  const snapshot = () => fs.readdirSync(mboxDir).map((f) => `${f}:${fs.statSync(path.join(mboxDir, f)).size}`).sort();
  const before = snapshot();
  const { code, stderr } = runCancel(['--to', '-repo-a__nobody', '--id', 'no-such-id']);
  assert.equal(code, 14);
  assert.match(stderr, /not withdrawn: no row no-such-id/);
  assert.deepEqual(snapshot(), before);
});

test('--cancel on an already-withdrawn row exits 13 and writes no second withdraw (file mode)', () => {
  const key = '-repo-a__twice';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  assert.equal(runCancel(['--id', row.id]).code, 0);
  const { code, stderr } = runCancel(['--id', row.id]);
  assert.equal(code, 13);
  assert.match(stderr, /was already withdrawn at \d{4}-/);
  assert.equal(rowLines(key).filter((r) => r.withdraw === row.id).length, 1);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('cancelQueued and findRow return the documented shapes (file mode)', () => {
  const key = '-repo-a__shapes';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  assert.equal(findRow({ id: row.id, dir: mboxDir }).state, 'queued');
  const w = cancelQueued({ key: '-other__key', id: row.id, ...libOpts() });
  assert.deepEqual(w, { withdrawn: true, key, keyCorrected: true });
  assert.equal(findRow({ id: row.id, dir: mboxDir }).state, 'withdrawn');
  const again = cancelQueued({ key, id: row.id, ...libOpts() });
  assert.equal(again.withdrawn, false);
  assert.equal(again.state, 'withdrawn');
  assert.ok(again.withdrawTs);
  const gone = cancelQueued({ key, id: 'nope', ...libOpts() });
  assert.deepEqual({ w: gone.withdrawn, s: gone.state }, { w: false, s: 'missing' });
  const k2 = '-repo-a__shapes2';
  const r2 = appendMessage({ to: k2, priority: 'now', text: 'x', ...libOpts() });
  const a = ack({ key: k2, id: r2.id, deliveredAs: 'typed', ...libOpts() });
  const d = cancelQueued({ key: k2, id: r2.id, ...libOpts() });
  assert.deepEqual({ w: d.withdrawn, s: d.state, k: d.key, t: d.ackTs, as: d.deliveredAs }, { w: false, s: 'delivered', k: k2, t: a.ts, as: 'typed' });
  for (const k of [key, k2]) fs.rmSync(mailboxPath(k, { dir: mboxDir }), { force: true });
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

test('agent-send --read drains mail queued for a role the session holds (#69)', async () => {
  const queued = appendMessage({ to: 'role:drain-probe', from: 's-peer', priority: 'queue', text: 'queued for the role', ...libOpts() });
  const claim = await runSend(['--claim-role', 'drain-probe', '--as', 'role-reader']);
  assert.equal(claim.code, 0);
  const runRead = () => new Promise((resolve) => {
    const child = spawn('node', [SEND, '--read', '--as', 'role-reader'], { env: childEnv() });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const first = await runRead();
  assert.equal(first.code, 0);
  assert.match(first.stdout, /queued for the role/);
  assert.match(first.stderr, /1 unacked/);
  assert.equal(readUnacked('role:drain-probe', libOpts()).some((r) => r.id === queued.id), false);
  assert.match((await runRead()).stderr, /0 unacked/);
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

test('a queued kitty fallback (exit 0 under --queue) is pending: exit 3, names the queue log', async () => {
  const queueDir = path.join(binDir, 'xdg-run');
  fs.mkdirSync(queueDir, { recursive: true });
  const queueStub = path.join(binDir, 'kitty-send-queued-stub.sh');
  fs.writeFileSync(queueStub, ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'), { mode: 0o755 });
  const { code, stderr } = await runSend(
    ['--to', '991002', '--text', 'queued steer', '--queue'],
    { ...childEnv(), AGENT_SEND_KITTY_SEND: queueStub, XDG_RUNTIME_DIR: queueDir },
  );
  // A started waiter is not a delivery (agent-config#1310): exit 3, not 0.
  assert.equal(code, 3, stderr);
  assert.match(stderr, new RegExp(`kitty-send queued for 991002; .*confirm it in ${queueDir}/kitty-send/queue-991002\\.log`));
  assert.match(stderr, /do not resend/);
});

// A supervisor idle ~30 min ages past the 20-min presence window. With its
// writer pid alive and its window open it is an IDLE seat (role-ownership.test.mjs);
// with a dead writer pid (these fixtures) it is stale. The fallback line must
// say WHY: no beacon, stale beacon since <time>, or live beacon with the flag off.
test('a steer to a window whose beacon went stale names the last tick', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    fs.writeFileSync(presFile, JSON.stringify({ beacons: [
      { sessionId: 's9', cwd: '/repo/b', mailbox: true, windowId: 991002, pid: spawnSync('node', ['-e', '0']).pid, firstTick: old, lastTick: old },
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

// 2026-10-26 (agent-config#1291): a multi-line --text was queued, the
// recipient stayed busy, and the withdraw path handed the text to kitty-send,
// which refuses an embedded newline (exit 1, nothing sent). The mailbox
// carries any text; only the kitty fallback needs one line, so the sender
// writes the text to a note and sends kitty-send the --file pointer.
const notesEnv = (notesDir, extra = {}) => childEnv({ AGENT_SWITCHBOARD_NOTES_DIR: notesDir, ...extra });

test('a multi-line --text reaches kitty-send as a --file note on the withdraw path', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-notes-'));
  try {
    // A note past the retention window is pruned when a new one is written.
    const stale = path.join(notesDir, 'old.md');
    fs.writeFileSync(stale, 'old');
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(stale, past, past);
    const text = 'line one\nline two\n\nline four';
    const { code, stderr } = await runSend(
      ['--to', '991001', '--text', text, '--deadline', '1'],
      notesEnv(notesDir, { CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub }),
    );
    assert.equal(code, 0, stderr);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(!argv.includes('--text'), `kitty-send got --text: ${argv.join(' ')}`);
    const note = argv[argv.indexOf('--file') + 1];
    assert.ok(note?.startsWith(notesDir + path.sep), `note outside the notes dir: ${note}`);
    const body = fs.readFileSync(note, 'utf-8');
    assert.ok(body.startsWith(text), 'the note carries the full text');
    assert.match(body, /act on it once/);
    assert.ok(!fs.existsSync(stale), 'a note past retention is pruned');
    assert.match(stderr, /multi-line text written to .* for kitty-send --file/);
    assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
  } finally {
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

test('a multi-line --text reaches kitty-send as a --file note on the no-consumer path', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-notes-'));
  try {
    const { code, stderr } = await runSend(
      ['--to', '991002', '--text', 'first\nsecond'],
      notesEnv(notesDir, { AGENT_SEND_KITTY_SEND: realRulesStub }),
    );
    assert.equal(code, 0, stderr);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(!argv.includes('--text'));
    assert.equal(fs.readFileSync(argv[argv.indexOf('--file') + 1], 'utf-8'), 'first\nsecond\n');
  } finally {
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

test('a one-line --text still goes to kitty-send inline', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-notes-'));
  try {
    const { code } = await runSend(['--to', '991002', '--text', 'one line'], notesEnv(notesDir, { AGENT_SEND_KITTY_SEND: realRulesStub }));
    assert.equal(code, 0);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--text') && argv.includes('one line'));
    assert.deepEqual(fs.readdirSync(notesDir), []);
  } finally {
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

// 2026-10-26 (agent-config#1291): another session's `pkill -f
// '[o]pencode.ai/docs/go'`, meant for its own curl, matched a waiting
// agent-send whose --text quoted that URL, and SIGTERM ended the send 53 s
// into its ack wait. The sender rewrites its process title once the argv is
// parsed, so the payload is not in /proc/<pid>/cmdline for any pattern kill.
test('the message text is not left in the waiting sender\'s command line', { skip: !fs.existsSync('/proc/self/cmdline') }, async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const marker = 'payload-marker-opencode.ai/docs/go';
  const child = spawn('node', [SEND, '--to', KEY_S1, '--text', `see ${marker}`, '--deadline', '10'], { env: childEnv() });
  const done = new Promise((resolve) => child.on('close', resolve));
  let rowId = null;
  const pollEnd = Date.now() + 8000;
  while (rowId == null && Date.now() < pollEnd) {
    await new Promise((r) => setTimeout(r, 100));
    rowId = readUnacked(KEY_S1, { dir: mboxDir })[0]?.id ?? null;
  }
  assert.ok(rowId, 'sender never queued the row');
  const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf-8').replace(/\0/g, ' ');
  ack({ key: KEY_S1, id: rowId, deliveredAs: 'mcp', dir: mboxDir });
  assert.equal(await done, 0);
  assert.ok(!cmdline.includes(marker), `payload visible in cmdline: ${cmdline.trim()}`);
  assert.match(cmdline, /^agent-send/);
});

// agent-config#1355 W5 (2026-10-27): window 327's own beacon had aged out
// while its seat sat in one long turn, and the cwd fallback delivered the
// note to the only live beacon on that cwd: seat 304's, whose beacon
// recorded window 304. A beacon that names another window is that window's
// session, never a candidate for this one.
test('the cwd fallback skips a beacon that recorded another window id', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(presFile, JSON.stringify({ beacons: [
      { sessionId: 'busy-seat', cwd: '/repo/a', mailbox: true, windowId: 991001, pid: spawnSync('node', ['-e', '0']).pid, firstTick: old, lastTick: old },
      { sessionId: 'other-seat', cwd: '/repo/a', mailbox: true, windowId: 991777, firstTick: nowIso(), lastTick: nowIso() },
    ] }));
    const err = (() => {
      try {
        resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 'sender', senderCwd: '/elsewhere' });
      } catch (e) {
        return e;
      }
      assert.fail('expected resolveRecipient to throw, not to deliver to the other window');
    })();
    assert.equal(err.code, 'mailbox-stale');
    assert.match(err.message, /window 991001 has no LIVE presence beacon/);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('the cwd fallback still resolves a beacon that recorded no window id', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 'legacy', cwd: '/repo/a', mailbox: true },
      { sessionId: 'other-seat', cwd: '/repo/a', mailbox: true, windowId: 991777 },
    ]);
    const r = resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 'sender', senderCwd: '/elsewhere' });
    assert.equal(r.sessionId, 'legacy');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

// agent-config#1379 W5: a typed fallback leaves an acked row, and a send whose
// topic was already delivered inside --topic-window sends nothing.
test('a typed fallback records an acked via:typed row; the same topic is then not sent again', async () => {
  const KEY_S3 = recipientKey({ cwd: '/repo/b', sessionId: 's3' });
  fs.rmSync(mailboxPath(KEY_S3, { dir: mboxDir }), { force: true });
  const okStub = path.join(binDir, 'kitty-send-ok.sh');
  fs.writeFileSync(okStub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(fallbackArgv)}\nexit 0\n`, { mode: 0o755 });
  fs.rmSync(fallbackArgv, { force: true });
  const env = childEnv({ AGENT_SEND_KITTY_SEND: okStub });
  const first = await runSend(['--to', '991002', '--text', 'RESUME', '--topic', 'resume'], env);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(fs.existsSync(fallbackArgv), 'first send typed');
  const rows = fs.readFileSync(mailboxPath(KEY_S3, { dir: mboxDir }), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const msg = rows.find((r) => r.topic === 'resume');
  assert.equal(msg.via, 'typed');
  assert.ok(rows.some((r) => r.ack === msg.id && r.deliveredAs === 'typed'), 'acked at once');
  assert.deepEqual(readUnacked(KEY_S3, { dir: mboxDir }), []);

  fs.rmSync(fallbackArgv, { force: true });
  const second = await runSend(['--to', '991002', '--text', 'RESUME again', '--topic', 'resume'], env);
  assert.equal(second.code, 0);
  assert.match(second.stderr, /already delivered: topic resume at \S+ from /);
  assert.ok(!fs.existsSync(fallbackArgv), 'second send typed nothing');

  const forced = await runSend(['--to', '991002', '--text', 'RESUME forced', '--topic', 'resume', '--force-topic'], env);
  assert.equal(forced.code, 0);
  assert.ok(fs.existsSync(fallbackArgv), '--force-topic sends anyway');
  fs.rmSync(fallbackArgv, { force: true });
  const zero = await runSend(['--to', '991002', '--text', 'RESUME w0', '--topic', 'resume', '--topic-window', '0'], env);
  assert.ok(fs.existsSync(fallbackArgv), 'window 0 sends anyway');
  assert.equal(zero.code, 0);
  fs.rmSync(fallbackArgv, { force: true });
  const other = await runSend(['--to', '991002', '--text', 'other', '--topic', 'different'], env);
  assert.equal(other.code, 0);
  assert.ok(fs.existsSync(fallbackArgv), 'a different topic is sent');
});

test('findRecentTopicDelivery honours the window and ignores unacked rows', () => {
  const key = '-repo-a__tw';
  const now = Date.now();
  const m = appendMessage({ to: key, from: 'x', priority: 'now', text: 't', topic: 'win', now: now - 2 * 3600_000, ...libOpts() });
  assert.equal(findRecentTopicDelivery({ key, topic: 'win', windowMs: 3600_000, now, dir: mboxDir }), null, 'unacked');
  ack({ key, id: m.id, deliveredAs: 'prompt', now: now - 2 * 3600_000, ...libOpts() });
  assert.equal(findRecentTopicDelivery({ key, topic: 'win', windowMs: 3600_000, now, dir: mboxDir }), null, 'outside the window');
  assert.equal(findRecentTopicDelivery({ key, topic: 'win', windowMs: 3 * 3600_000, now, dir: mboxDir }).from, 'x');
  assert.equal(findRecentTopicDelivery({ key, topic: 'win', windowMs: 0, now, dir: mboxDir }), null, 'window 0 disables');
});
