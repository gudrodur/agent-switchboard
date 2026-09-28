// A beacon's writer pid (agent-config#979): a beacon whose recorded pid is
// dead reads as absent at once, while a live pid and a beacon with no pid
// keep the TTL rule. Also: a store created before the pid column gains it on
// open, and its old rows read as before.
//
// Run: node --test tests/presence-pid.test.mjs (or the full suite)

import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { recordPresence, readAllPresence, pidAlive } = await import('../lib/presence.mjs');
const { readPresenceBeacons } = await import('../lib/agent-mailbox.mjs');
const { openStore } = await import('../lib/store.mjs');

// A pid that existed and has exited: a child we already reaped.
const deadPid = () => spawnSync('true').pid;

const freshDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-pid-'));
  process.env.AGENT_SWITCHBOARD_DB = path.join(dir, 'state.db');
  return dir;
};

test('pidAlive: no pid is alive, this process is alive, a reaped child is not', () => {
  assert.equal(pidAlive(null), true);
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
});

test('store: a dead writer pid hides the beacon from every reader and the next write deletes it', () => {
  freshDb();
  const dead = deadPid();
  recordPresence({ cwd: '/w/a', sessionId: 'gone', pid: dead, windowId: 11 });
  recordPresence({ cwd: '/w/b', sessionId: 'live', pid: process.pid, windowId: 12 });
  recordPresence({ cwd: '/w/c', sessionId: 'nopid' });
  const ids = (list) => list.map((b) => b.sessionId).sort();
  assert.deepEqual(ids(readAllPresence()), ['live', 'nopid']);
  assert.deepEqual(ids(readPresenceBeacons()), ['live', 'nopid']);
  const others = recordPresence({ cwd: '/w/c', sessionId: 'nopid' });
  assert.deepEqual(ids(others), ['live']);
  assert.deepEqual(ids(readPresenceBeacons({ includeStale: true })), ['live', 'nopid']);
  assert.equal(readAllPresence().find((b) => b.sessionId === 'live').pid, process.pid);
});

test('file backend: a dead writer pid is pruned like a stale tick', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-pid-file-'));
  const file = path.join(dir, 'presence.json');
  recordPresence({ file, cwd: '/w/a', sessionId: 'gone', pid: deadPid() });
  recordPresence({ file, cwd: '/w/b', sessionId: 'live', pid: process.pid });
  assert.deepEqual(readAllPresence({ file }).map((b) => b.sessionId), ['live']);
});

test('an omitted pid never clears a recorded one', () => {
  freshDb();
  recordPresence({ cwd: '/w/b', sessionId: 'live', pid: process.pid });
  recordPresence({ cwd: '/w/b', sessionId: 'live' });
  assert.equal(readAllPresence()[0].pid, process.pid);
});

test('a store created before the pid column gains it on open, old rows intact', () => {
  freshDb();
  const db = process.env.AGENT_SWITCHBOARD_DB;
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const old = new DatabaseSync(db);
  old.exec(`CREATE TABLE presence_beacons (
    session_id TEXT NOT NULL, cwd TEXT NOT NULL, home_cwd TEXT, branch TEXT, repo TEXT,
    mailbox INTEGER, window_id INTEGER, first_tick TEXT NOT NULL, last_tick TEXT NOT NULL,
    PRIMARY KEY (session_id, cwd));`);
  const now = new Date().toISOString();
  old.prepare('INSERT INTO presence_beacons (session_id, cwd, first_tick, last_tick) VALUES (?, ?, ?, ?)').run('old', '/w/o', now, now);
  old.close();
  const store = openStore(db);
  const cols = store.all('PRAGMA table_info(presence_beacons)').map((c) => c.name);
  store.close();
  assert.ok(cols.includes('pid'));
  assert.deepEqual(readAllPresence().map((b) => b.sessionId), ['old']);
});
