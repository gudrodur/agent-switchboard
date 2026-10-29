// Readers tolerate rows the retired omp runtime left in the store.
//
// The omp runtime is gone from this repo, but its beacons, mailbox rows and
// role claims stay in state.db until retention drops them. Nothing in the
// readers names the runtime: a historical row is an ordinary row whose
// session id happens to be timestamp-shaped (or a worker's task name) and
// whose sender is "omp-session". This pins that no reader throws on them and
// that an `omp` process is no longer counted as a running agent.
//
// Run: node --test tests/historical-omp-rows.test.mjs (or the full suite)
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp, dbPath;
const OMP_SID = '2026-09-26T03-02-52-288Z_01a0dbaa-6480-72c4-b3a5-cdcbe61c62c2';

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'histomp-'));
  dbPath = path.join(tmp, 'state.db');
  process.env.AGENT_SWITCHBOARD_DB = dbPath;
});
after(() => {
  delete process.env.AGENT_SWITCHBOARD_DB;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('beacons, mailbox rows and role claims written by omp read back without throwing', async () => {
  const { recordPresence, readAllPresence } = await import('../lib/presence.mjs');
  const { appendMessage, readUnackedBySession, resolveRecipient, listSeats } = await import('../lib/agent-mailbox.mjs');
  const { openStore } = await import('../lib/store.mjs');
  const { claimRole, allRoleHolders } = await import('../lib/seat-roles.mjs');

  recordPresence({ sessionId: OMP_SID, cwd: '/repo/old', mailbox: true, windowId: 77 });
  recordPresence({ sessionId: 'P2LocalAgents', cwd: '/repo/old', mailbox: true, windowId: 77 });
  appendMessage({ to: 'role:omp-seat', from: 'omp-session', priority: 'queue', text: 'left by omp' });
  const db = openStore(dbPath);
  try {
    claimRole(db, { role: 'omp-seat', sessionId: OMP_SID, cwd: '/repo/old', windowId: 77 });
    assert.equal(allRoleHolders(db).length, 1);
  } finally {
    db.close();
  }

  assert.equal(readAllPresence({}).length, 2);
  const r = resolveRecipient('role:omp-seat', { senderSessionId: 'someone-else', senderCwd: '/repo/new' });
  assert.equal(r.sessionId, OMP_SID, 'the role resolves to the historical holder');
  assert.ok(Array.isArray(readUnackedBySession(OMP_SID)));
  const seats = listSeats({ wins: [{ id: 77, title: 'old tab', pid: 1, cwd: '/repo/old' }], agentWindows: new Set([77]) });
  assert.ok(Array.isArray(seats));
});

test('a process named omp no longer counts as a running agent', async () => {
  const { agentWindowIds, AGENT_COMM_NAMES } = await import('../lib/agent-mailbox.mjs');
  assert.ok(!AGENT_COMM_NAMES.includes('omp'));
  const procDir = path.join(tmp, 'proc');
  const proc = (pid, comm, win) => {
    fs.mkdirSync(path.join(procDir, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(procDir, String(pid), 'comm'), `${comm}\n`);
    fs.writeFileSync(path.join(procDir, String(pid), 'environ'), `HOME=/h\0KITTY_WINDOW_ID=${win}\0`);
  };
  proc(1, 'omp', 501);
  proc(2, 'claude', 502);
  const ids = agentWindowIds({ procDir });
  assert.ok(!ids.has(501), 'the omp process is ignored, not an error');
  assert.ok(ids.has(502));
});
