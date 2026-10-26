// Tests for seat roles: a stable address (`--to role:<name>`) that survives a
// seat change, the claim helpers, the inject hook's role drain, `--who`, and
// the candidate list on a "no kitty window" error.
//
// Store mode throughout: AGENT_SWITCHBOARD_DB points at a temp db, beacons are
// written with recordPresence, and AGENT_MAILBOX_KITTY is a stub serving one
// canned window (109, the replacement seat).
//
// Run: node --test tests/seat-roles.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { recordPresence } from '../lib/presence.mjs';
import { recipientKey, resolveRecipient, readUnacked } from '../lib/agent-mailbox.mjs';

const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
const INJECT = fileURLToPath(new URL('../hooks/claude/mailbox-inject.mjs', import.meta.url));

let tmp, dbPath, kittyStub;
const roles = () => import('../lib/seat-roles.mjs');
const childEnv = (extra = {}) =>
  isolatedEnv({ AGENT_SWITCHBOARD_DB: dbPath, AGENT_MAILBOX_KITTY: kittyStub, ...extra });
const send = (args, extra = {}) =>
  spawnSync('node', [SEND, ...args], { encoding: 'utf-8', env: childEnv(extra), timeout: 30_000 });
const beacon = (sessionId, cwd, extra = {}) =>
  recordPresence({ sessionId, cwd, mailbox: true, ...extra });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seatroles-'));
  dbPath = path.join(tmp, 'state.db');
  process.env.AGENT_SWITCHBOARD_DB = dbPath;
  const ls = path.join(tmp, 'ls.json');
  fs.writeFileSync(ls, JSON.stringify([{ tabs: [{ title: 'tab', windows: [
    { id: 109, title: 'claude: lead seat', pid: 1, cwd: '/repo/proj' },
  ] }] }]));
  kittyStub = path.join(tmp, 'kitty');
  fs.writeFileSync(kittyStub, `#!/usr/bin/env bash\n[ "$1" = "@" ] && [ "$2" = "ls" ] && cat ${JSON.stringify(ls)}\nexit 0\n`, { mode: 0o755 });
  process.env.AGENT_MAILBOX_KITTY = kittyStub;
});
after(() => {
  delete process.env.AGENT_SWITCHBOARD_DB;
  delete process.env.AGENT_MAILBOX_KITTY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const withDb = async (fn) => {
  const { openStore } = await import('../lib/store.mjs');
  const db = openStore(dbPath);
  try { return await fn(db); } finally { db.close(); }
};

test('role names: lowercase alnum and dashes only, 1 to 64 chars', async () => {
  const { claimRole } = await roles();
  await withDb((db) => {
    for (const bad of ['', 'Lead', '-lead', 'a b', 'a_b', 'x'.repeat(65), 'role:lead']) {
      assert.throws(() => claimRole(db, { role: bad, sessionId: 's' }), /role name/, bad);
    }
    for (const good of ['lead', '0a', 'a-b-c', 'x'.repeat(64)]) {
      claimRole(db, { role: good, sessionId: 's' });
    }
  });
});

test('role:<name> resolves to the live holder exactly as its session key would', async () => {
  const { claimRole } = await roles();
  beacon('holder-1', '/repo/proj', { windowId: 77 });
  await withDb((db) => claimRole(db, { role: 'lead', sessionId: 'holder-1', cwd: '/repo/proj', windowId: 77 }));
  const r = resolveRecipient('role:lead');
  assert.equal(r.key, recipientKey({ cwd: '/repo/proj', sessionId: 'holder-1' }));
  assert.equal(r.hasConsumer, true);
  assert.equal(r.queuedForRole, undefined);
});

test('a later claim takes the role over', async () => {
  const { claimRole, roleHolder, rolesForSession } = await roles();
  beacon('holder-2', '/repo/proj', { windowId: 109 });
  await withDb((db) => claimRole(db, { role: 'lead', sessionId: 'holder-2', cwd: '/repo/proj', windowId: 109 }));
  await withDb((db) => {
    assert.equal(roleHolder(db, 'lead').session_id, 'holder-2');
    assert.deepEqual(rolesForSession(db, 'holder-1'), []);
    assert.deepEqual(rolesForSession(db, 'holder-2'), ['lead']);
  });
  assert.equal(resolveRecipient('role:lead').key, recipientKey({ cwd: '/repo/proj', sessionId: 'holder-2' }));
});

test('a send to a role with no holder is queued, then drained by the holder after it claims', async () => {
  const r = send(['--to', 'role:ghost', '--text', 'hello ghost'], { CLAUDE_CODE_SESSION_ID: 'sender-1' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /queued for role ghost; no live holder/);
  assert.equal(readUnacked('role:ghost', {}).length, 1);
  // The new seat starts with AGENT_SEAT_ROLE set; its first prompt claims and drains.
  const hook = spawnSync('node', [INJECT], {
    encoding: 'utf-8',
    input: JSON.stringify({ session_id: 'holder-3', cwd: '/repo/proj' }),
    env: childEnv({ AGENT_SEAT_ROLE: 'ghost' }),
    timeout: 30_000,
  });
  assert.equal(hook.status, 0);
  assert.match(hook.stdout, /hello ghost/);
  assert.equal(readUnacked('role:ghost', {}).length, 0);
  const { roleHolder } = await roles();
  await withDb((db) => assert.equal(roleHolder(db, 'ghost').session_id, 'holder-3'));
});

test('--who lists a live beacon with its role, as a table and as JSON', async () => {
  const { claimRole } = await roles();
  beacon('abcdef12-0000', '/repo/proj', { windowId: 109, branch: 'main', repo: 'proj' });
  await withDb((db) => claimRole(db, { role: 'scribe', sessionId: 'abcdef12-0000', cwd: '/repo/proj', windowId: 109 }));
  const json = send(['--who', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const seat = JSON.parse(json.stdout).find((s) => s.sessionId === 'abcdef12-0000');
  assert.equal(seat.windowId, 109);
  assert.deepEqual(seat.roles, ['scribe']);
  assert.equal(seat.repo, 'proj');
  assert.equal(seat.branch, 'main');
  assert.equal(seat.title, 'claude: lead seat');
  const table = send(['--who']);
  assert.match(table.stdout, /abcdef12\b.*\/repo\/proj.*proj.*main.*scribe.*claude: lead seat/);
});

test('--claim-role claims for the current session', async () => {
  const r = send(['--claim-role', 'night-shift'], { CLAUDE_CODE_SESSION_ID: 'claimer-1' });
  assert.equal(r.status, 0, r.stderr);
  const { roleHolder } = await roles();
  await withDb((db) => assert.equal(roleHolder(db, 'night-shift').session_id, 'claimer-1'));
  assert.notEqual(send(['--claim-role', 'Bad Name'], { CLAUDE_CODE_SESSION_ID: 'claimer-1' }).status, 0);
});

test('an unknown window id lists same-repo seats and role holders to use instead', () => {
  beacon('sender-2', '/repo/proj', { windowId: 5, repo: 'proj' });
  beacon('sibling-1', '/repo/proj-wt', { windowId: 109, repo: 'proj' });
  beacon('elsewhere-1', '/repo/other', { windowId: 200, repo: 'other' });
  const r = send(['--to', '77', '--text', 'x'], { CLAUDE_CODE_SESSION_ID: 'sender-2' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no kitty window with id 77/);
  assert.match(r.stderr, /--to 109\b/);
  assert.match(r.stderr, /--to role:lead\b/);
  assert.doesNotMatch(r.stderr, /--to 200\b/);
  const hintLines = r.stderr.trim().split('\n').length - 1;
  assert.ok(hintLines <= 8, `hint too long: ${hintLines}`);
});

test('the omp hook claims AGENT_SEAT_ROLE and drains the role queue', async () => {
  const { appendMessage } = await import('../lib/agent-mailbox.mjs');
  const { drainInbox } = await import('../hooks/omp/pre/mailbox.ts');
  const { roleHolder } = await roles();
  appendMessage({ to: 'role:omp-seat', from: 'tester', priority: 'queue', text: 'for the omp seat' });
  beacon('omp-1', '/repo/proj');
  process.env.AGENT_SEAT_ROLE = 'omp-seat';
  try {
    const delivered = drainInbox({ cwd: '/repo/proj', sessionId: 'omp-1' });
    assert.deepEqual(delivered.map((d) => d.row.text), ['for the omp seat']);
    assert.equal(delivered[0].deliveredAs, 'followUp');
  } finally {
    delete process.env.AGENT_SEAT_ROLE;
  }
  await withDb((db) => assert.equal(roleHolder(db, 'omp-seat').session_id, 'omp-1'));
});

test('a replaced seat does not take its role back from a live successor', async () => {
  const { claimRole, roleHolder } = await roles();
  const { claimRoleFromEnv } = await import('../lib/agent-mailbox.mjs');
  beacon('succ-new', '/repo/proj');
  await withDb((db) => claimRole(db, { role: 'relay', sessionId: 'succ-new' }));
  assert.equal(claimRoleFromEnv({ sessionId: 'succ-old', role: 'relay' }), null);
  await withDb((db) => assert.equal(roleHolder(db, 'relay').session_id, 'succ-new'));
});
