// Tests for role ownership and idle seats (agent-config#1364 workstream C):
// a live seat never loses a role silently (--claim-role exit 11, --take-over
// notifies), an idle seat (past the presence TTL, pid alive, kitty window
// open) stays listed and addressable, and the claim nudge states the
// <repo>-<purpose> convention.
//
// Run: node --test tests/role-ownership.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { recordPresence, PRESENCE_STALE_MS } from '../lib/presence.mjs';
import { recipientKey, readUnacked, claimNudge, idleBeacons, agentWindowIds } from '../lib/agent-mailbox.mjs';

const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));

let tmp, dbPath, kittyStub, kittySendStub, argvFile, procDir;
const childEnv = (extra = {}) =>
  isolatedEnv({
    AGENT_SWITCHBOARD_DB: dbPath,
    AGENT_MAILBOX_KITTY: kittyStub,
    AGENT_SEND_KITTY_SEND: kittySendStub,
    AGENT_MAILBOX_PROC_DIR: procDir,
    ...extra,
  });
const send = (args, extra = {}) =>
  spawnSync('node', [SEND, ...args], { encoding: 'utf-8', env: childEnv(extra), timeout: 30_000 });
const beacon = (sessionId, cwd, extra = {}) => recordPresence({ sessionId, cwd, mailbox: true, ...extra });
const idleBeacon = (sessionId, cwd, minutes, extra = {}) =>
  beacon(sessionId, cwd, { now: Date.now() - minutes * 60_000, pid: process.pid, ...extra });
const deadPid = () => spawnSync('node', ['-e', '0']).pid;
const roles = () => import('../lib/seat-roles.mjs');
const withDb = async (fn) => {
  const { openStore } = await import('../lib/store.mjs');
  const db = openStore(dbPath);
  try { return await fn(db); } finally { db.close(); }
};
const who = () => JSON.parse(send(['--who', '--json']).stdout);

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roleown-'));
  dbPath = path.join(tmp, 'state.db');
  process.env.AGENT_SWITCHBOARD_DB = dbPath;
  const ls = path.join(tmp, 'ls.json');
  // Windows 400-499 are open; 999 is deliberately absent (closed).
  fs.writeFileSync(ls, JSON.stringify([{ tabs: [{ title: 'tab', windows: [
    { id: 410, title: 'idle seat', pid: 1, cwd: '/r/idle' },
    { id: 411, title: 'dead pid seat', pid: 1, cwd: '/r/deadpid' },
    { id: 420, title: 'holder', pid: 1, cwd: '/r/holder' },
    { id: 430, title: 'claimer', pid: 1, cwd: '/r/claimer' },
  ] }] }]));
  kittyStub = path.join(tmp, 'kitty');
  fs.writeFileSync(kittyStub, `#!/usr/bin/env bash\n[ "$1" = "@" ] && [ "$2" = "ls" ] && cat ${JSON.stringify(ls)}\nexit 0\n`, { mode: 0o755 });
  argvFile = path.join(tmp, 'ks-argv');
  kittySendStub = path.join(tmp, 'kitty-send');
  fs.writeFileSync(kittySendStub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\nexit 0\n`, { mode: 0o755 });
  process.env.AGENT_MAILBOX_KITTY = kittyStub;
  // Fake /proc: windows 410, 420, 430 run an agent; 411 runs only a shell.
  procDir = path.join(tmp, 'proc');
  const proc = (pid, comm, win) => {
    fs.mkdirSync(path.join(procDir, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(procDir, String(pid), 'comm'), `${comm}\n`);
    fs.writeFileSync(path.join(procDir, String(pid), 'environ'), `HOME=/h\0KITTY_WINDOW_ID=${win}\0`);
  };
  proc(101, 'claude', 410);
  proc(102, 'bash', 411);
  proc(103, 'omp', 420);
  proc(104, 'claude', 430);
  proc(105, 'bash', 410);
  process.env.AGENT_MAILBOX_PROC_DIR = procDir;
});
after(() => {
  delete process.env.AGENT_SWITCHBOARD_DB;
  delete process.env.AGENT_MAILBOX_KITTY;
  delete process.env.AGENT_MAILBOX_PROC_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an idle seat (pid alive, window open) stays listed, marked idle <N>m', () => {
  idleBeacon('idle-1', '/r/idle', 45, { windowId: 410 });
  assert.ok(45 * 60_000 > PRESENCE_STALE_MS);
  const seat = who().find((s) => s.sessionId === 'idle-1');
  assert.ok(seat, 'idle seat listed');
  assert.equal(seat.idleMinutes, 45);
  assert.equal(seat.windowId, 410);
  assert.match(send(['--who']).stdout, /idle-1\b.*idle 45m/);
});

test('a dead writer pid or a closed window is not listed', () => {
  idleBeacon('deadpid-1', '/r/deadpid', 45, { windowId: 411, pid: deadPid() });
  idleBeacon('closed-1', '/r/closed', 45, { windowId: 999 });
  const ids = who().map((s) => s.sessionId);
  assert.ok(!ids.includes('deadpid-1'), 'dead pid');
  assert.ok(!ids.includes('closed-1'), 'closed window');
});

test('a window running only a shell is not an idle seat, even with pid alive and window open', () => {
  idleBeacon('shell-1', '/r/deadpid', 45, { windowId: 411 });
  assert.ok(!who().some((s) => s.sessionId === 'shell-1'));
});

test('agentWindowIds: agent windows found in one scan; unreadable procDir is null; idleBeacons treats null as not idle', () => {
  assert.deepEqual([...agentWindowIds({ procDir })].sort(), [410, 420, 430]);
  assert.equal(agentWindowIds({ procDir: path.join(tmp, 'no-such-proc') }), null);
  const wins = [{ id: 410 }, { id: 411 }];
  assert.ok(idleBeacons({ wins, agentWindows: new Set([410]) }).some((b) => b.sessionId === 'idle-1'));
  assert.deepEqual(idleBeacons({ wins, agentWindows: null }), []);
  assert.ok(!idleBeacons({ wins, agentWindows: new Set([420]) }).some((b) => b.sessionId === 'idle-1'));
});

test('an unreadable /proc lists no idle seat and a send to it is not typed as idle', () => {
  const r = send(['--who', '--json'], { AGENT_MAILBOX_PROC_DIR: path.join(tmp, 'no-such-proc') });
  assert.ok(!JSON.parse(r.stdout).some((s) => s.idleMinutes != null));
});

test('a live seat in the same window supersedes the idle beacon of its predecessor', () => {
  idleBeacon('old-occupant', '/r/claimer', 60, { windowId: 430 });
  beacon('new-occupant', '/r/claimer', { windowId: 430 });
  const ids = who().map((s) => s.sessionId);
  assert.ok(ids.includes('new-occupant'));
  assert.ok(!ids.includes('old-occupant'));
});

test('another seat writing presence does not delete an idle beacon', () => {
  beacon('writer-1', '/r/holder', { windowId: 420 });
  assert.ok(who().some((s) => s.sessionId === 'idle-1'), 'idle seat survives a neighbour write');
});

test('a send to an idle seat says so, types to wake it, and keeps kitty-send exit passthrough', () => {
  fs.rmSync(argvFile, { force: true });
  const r = send(['--to', '410', '--text', 'wake up']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /seat idle 45m, typing to wake it, falling back to kitty-send/);
  assert.doesNotMatch(r.stderr, /no mailbox consumer/);
  const argv = fs.readFileSync(argvFile, 'utf-8').split('\n');
  assert.ok(argv.includes('410') && argv.includes('wake up'));
});

test('a send to a role whose holder is idle wakes the holder window instead of queueing', async () => {
  const { claimRole } = await roles();
  await withDb((db) => claimRole(db, { role: 'idle-role', sessionId: 'idle-1', cwd: '/r/idle', windowId: 410 }));
  const r = send(['--to', 'role:idle-role', '--text', 'hello idle role']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /seat idle 45m, typing to wake it/);
  assert.equal(readUnacked('role:idle-role', {}).length, 0);
});

test('--claim-role refuses a live holder: exit 11, names the window, holder unchanged', async () => {
  const { claimRole, roleHolder } = await roles();
  beacon('holder-live', '/r/holder', { windowId: 420 });
  await withDb((db) => claimRole(db, { role: 'proj-lead', sessionId: 'holder-live', cwd: '/r/holder', windowId: 420 }));
  const r = send(['--claim-role', 'proj-lead'], { CLAUDE_CODE_SESSION_ID: 'claimer-9', KITTY_WINDOW_ID: '430' });
  assert.equal(r.status, 11, r.stderr);
  assert.match(r.stderr, /role proj-lead is held by live window 420/);
  assert.match(r.stderr, /--take-over/);
  await withDb((db) => assert.equal(roleHolder(db, 'proj-lead').session_id, 'holder-live'));
  assert.equal(readUnacked(recipientKey({ cwd: '/r/holder', sessionId: 'holder-live' }), {}).length, 0);
});

test('--take-over takes the role and queues a row to the displaced session', async () => {
  const { roleHolder } = await roles();
  const r = send(['--claim-role', 'proj-lead', '--take-over'], { CLAUDE_CODE_SESSION_ID: 'claimer-9', KITTY_WINDOW_ID: '430' });
  assert.equal(r.status, 0, r.stderr);
  await withDb((db) => assert.equal(roleHolder(db, 'proj-lead').session_id, 'claimer-9'));
  const rows = readUnacked(recipientKey({ cwd: '/r/holder', sessionId: 'holder-live' }), {});
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /role proj-lead was taken over by window 430 \(session claimer-9\)/);
});

test('a dead holder is taken without the flag and without notice', async () => {
  const { claimRole, roleHolder } = await roles();
  await withDb((db) => claimRole(db, { role: 'proj-ship', sessionId: 'gone-session', cwd: '/r/gone', windowId: 77 }));
  const r = send(['--claim-role', 'proj-ship'], { CLAUDE_CODE_SESSION_ID: 'claimer-9' });
  assert.equal(r.status, 0, r.stderr);
  await withDb((db) => assert.equal(roleHolder(db, 'proj-ship').session_id, 'claimer-9'));
  assert.equal(readUnacked(recipientKey({ cwd: '/r/gone', sessionId: 'gone-session' }), {}).length, 0);
});

test('re-claiming a role this session already holds needs no flag', () => {
  const r = send(['--claim-role', 'proj-ship'], { CLAUDE_CODE_SESSION_ID: 'claimer-9' });
  assert.equal(r.status, 0, r.stderr);
});

test('--take-over without --claim-role is a usage error', () => {
  assert.equal(send(['--take-over']).status, 1);
});

test('the nudge states the <repo>-<purpose> convention and that a seat may hold several roles', () => {
  const line = claimNudge({ sessionId: 'nudge-1', cwd: '/r/holder', role: '' });
  assert.match(line, /<repo>-<purpose>/);
  assert.match(line, /several roles/);
  assert.match(line, /--claim-role \S+-<purpose>/);
});
