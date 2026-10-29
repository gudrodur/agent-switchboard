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

test('a send queued for a role names --cancel --id, and that withdraws it (agent-config#1379)', () => {
  const r = send(['--to', 'role:wrong-seat', '--text', 'misaddressed'], { CLAUDE_CODE_SESSION_ID: 'sender-c' });
  assert.equal(r.status, 3, r.stderr);
  const id = r.stderr.match(/--cancel --id (\S+?)\)/)?.[1];
  assert.ok(id, `no --cancel --id in: ${r.stderr}`);
  const c = send(['--cancel', '--to', 'role:wrong-seat', '--id', id]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stderr, /recipient role:wrong-seat/);
  assert.deepEqual(readUnacked('role:wrong-seat', {}), []);
  const again = send(['--cancel', '--id', id]);
  assert.equal(again.status, 13, again.stderr);
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

test('--release-role drops only a role this session holds', async () => {
  const { roleHolder, rolesForSession } = await roles();
  assert.equal(send(['--claim-role', 'spare-a'], { CLAUDE_CODE_SESSION_ID: 'releaser-1' }).status, 0);
  assert.equal(send(['--claim-role', 'keep-b'], { CLAUDE_CODE_SESSION_ID: 'releaser-1' }).status, 0);
  assert.equal(send(['--claim-role', 'other-c'], { CLAUDE_CODE_SESSION_ID: 'other-1' }).status, 0);

  const r = send(['--release-role', 'spare-a'], { CLAUDE_CODE_SESSION_ID: 'releaser-1' });
  assert.equal(r.status, 0, r.stderr);
  await withDb((db) => {
    assert.equal(roleHolder(db, 'spare-a'), null);
    assert.deepEqual(rolesForSession(db, 'releaser-1'), ['keep-b']);
  });

  // Not held at all: nothing to do, still a success.
  assert.equal(send(['--release-role', 'spare-a'], { CLAUDE_CODE_SESSION_ID: 'releaser-1' }).status, 0);

  // Held by another session: refused, the holder keeps it.
  const refused = send(['--release-role', 'other-c'], { CLAUDE_CODE_SESSION_ID: 'releaser-1' });
  assert.equal(refused.status, 12, refused.stderr);
  assert.match(refused.stderr, /held by session other-1/);
  await withDb((db) => assert.equal(roleHolder(db, 'other-c').session_id, 'other-1'));

  // Mail to a released role waits for its next holder.
  const after = send(['--to', 'role:spare-a', '--text', 'hello'], { CLAUDE_CODE_SESSION_ID: 'sender-1' });
  assert.equal(after.status, 3, after.stderr);
  assert.match(after.stderr, /queued for role spare-a; no live holder/);

  // Leave the shared store as found: later tests list role holders.
  assert.equal(send(['--release-role', 'keep-b'], { CLAUDE_CODE_SESSION_ID: 'releaser-1' }).status, 0);
  assert.equal(send(['--release-role', 'other-c'], { CLAUDE_CODE_SESSION_ID: 'other-1' }).status, 0);
  await withDb((db) => assert.deepEqual(rolesForSession(db, 'releaser-1'), []));
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

// ---- --who normalisation and the claim nudge ----

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf-8' });
const mkRepo = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, `${name}-`)));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
};

test('--who collapses a subdirectory beacon into its checkout root, one row per seat', () => {
  const repo = mkRepo('who-sub');
  fs.mkdirSync(path.join(repo, 'pkg', 'deep'), { recursive: true });
  beacon('sub-sess-1', repo, { windowId: 109, branch: 'main', repo: 'who-sub' });
  beacon('sub-sess-1', path.join(repo, 'pkg', 'deep'), { branch: 'main', repo: 'who-sub' });
  const rows = JSON.parse(send(['--who', '--json']).stdout).filter((s) => s.sessionId === 'sub-sess-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cwd, repo);
  assert.equal(rows[0].windowId, 109);
  const table = send(['--who']).stdout.split('\n').filter((l) => l.includes('sub-sess'));
  assert.equal(table.length, 1);
});

test('--who shows a detached HEAD as HEAD@<short sha>', () => {
  const repo = mkRepo('who-det');
  git(repo, 'checkout', '-q', '--detach');
  const sha = git(repo, 'rev-parse', '--short', 'HEAD').stdout.trim();
  beacon('det-sess-1', repo, { branch: 'HEAD', repo: 'who-det' });
  const rows = JSON.parse(send(['--who', '--json']).stdout).filter((s) => s.sessionId === 'det-sess-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].branch, `HEAD@${sha}`);
  assert.match(send(['--who']).stdout, new RegExp(`HEAD@${sha}`));
});

test('--who drops a beacon whose worktree was removed when the session has a live row', () => {
  const repo = mkRepo('who-home');
  const wt = mkRepo('who-wt');
  beacon('gone-sess-1', repo, { windowId: 109, branch: 'main', repo: 'who-home' });
  beacon('gone-sess-1', wt, { branch: 'fix/done', repo: 'who-home' });
  fs.rmSync(wt, { recursive: true, force: true });
  const rows = JSON.parse(send(['--who', '--json']).stdout).filter((s) => s.sessionId === 'gone-sess-1');
  assert.deepEqual(rows.map((r) => r.cwd), [repo]);
  assert.doesNotMatch(send(['--who']).stdout, /fix\/done/);
});

test('--who keeps a session whose only row is a removed directory', () => {
  const wt = mkRepo('who-only');
  beacon('gone-sess-2', wt, { windowId: 109, branch: 'fix/only', repo: 'who-only' });
  fs.rmSync(wt, { recursive: true, force: true });
  const rows = JSON.parse(send(['--who', '--json']).stdout).filter((s) => s.sessionId === 'gone-sess-2');
  assert.equal(rows.length, 1);
});

const prompt = (sessionId, extra = {}) => {
  const r = spawnSync('node', [INJECT], {
    encoding: 'utf-8',
    input: JSON.stringify({ session_id: sessionId, cwd: '/repo/proj' }),
    env: childEnv(extra),
    timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('the claude hook nudges a role-less seat once, on its first prompt only', () => {
  const first = prompt('nudge-1');
  assert.match(first, /holds no role/);
  assert.match(first, /agent-send\.mjs --claim-role proj-<purpose>|agent-send\.mjs --claim-role [a-z0-9-]+-<purpose>/);
  assert.match(first, /lost when the window closes/);
  assert.doesNotMatch(prompt('nudge-1'), /holds no role/);
});

test('the nudge still fires when another hook recorded presence first (parallel hooks)', () => {
  // A host's own presence hook runs beside mailbox-inject in the same prompt
  // and may write this session's beacon before it: that must not read as
  // "not the first prompt".
  beacon('nudge-race', '/repo/proj');
  assert.match(prompt('nudge-race'), /holds no role/);
  assert.doesNotMatch(prompt('nudge-race'), /holds no role/);
});

test('retention drops seat_nudges rows after 14 days', async () => {
  const { markNudged } = await roles();
  const { pruneRetention, RETENTION_MS } = await import('../lib/store.mjs');
  const now = Date.now();
  await withDb((db) => {
    assert.equal(markNudged(db, 'old-nudge', now - RETENTION_MS - 1000), true);
    assert.equal(markNudged(db, 'old-nudge', now), false);
    assert.equal(markNudged(db, 'new-nudge', now), true);
    pruneRetention(db, { now });
    const left = db.all('SELECT session_id FROM seat_nudges').map((r) => r.session_id);
    assert.ok(!left.includes('old-nudge'));
    assert.ok(left.includes('new-nudge'));
  });
});

test('no nudge for a seat that holds a role or launched with AGENT_SEAT_ROLE', async () => {
  const { claimRole } = await roles();
  await withDb((db) => claimRole(db, { role: 'nudge-held', sessionId: 'nudge-2', cwd: '/repo/proj' }));
  assert.doesNotMatch(prompt('nudge-2'), /holds no role/);
  assert.doesNotMatch(prompt('nudge-3', { AGENT_SEAT_ROLE: 'nudge-env' }), /holds no role/);
});

test('the omp hook nudges once per session, and not a role holder', async () => {
  const { default: hook } = await import('../hooks/omp/pre/mailbox.ts');
  const handlers = {};
  const sent = [];
  hook({ on: (ev, fn) => { handlers[ev] = fn; }, sendMessage: (m) => sent.push(m.content) });
  const ctx = (sid) => ({ cwd: '/repo/proj', sessionManager: { getSessionFile: () => `/x/${sid}.jsonl` }, isIdle: () => false });
  await handlers.turn_start({}, ctx('omp-nudge-1'));
  await handlers.turn_start({}, ctx('omp-nudge-1'));
  assert.equal(sent.filter((c) => /holds no role/.test(c)).length, 1);
  const { claimRole } = await roles();
  await withDb((db) => claimRole(db, { role: 'omp-held', sessionId: 'omp-nudge-2', cwd: '/repo/proj' }));
  await handlers.turn_start({}, ctx('omp-nudge-2'));
  assert.equal(sent.filter((c) => /holds no role/.test(c)).length, 1);
});
