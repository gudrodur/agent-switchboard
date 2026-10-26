// A session's latest work tree (lastWorkCwd) outlives the prune of the row
// that worked there, so a reader can tell where the session's work went.
//
// Run: node --test tests/presence-last-work-cwd.test.mjs (or the full suite)

import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { recordPresence, readAllPresence } = await import('../lib/presence.mjs');

const MIN = 60_000;
const freshDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-lwc-'));
  process.env.AGENT_SWITCHBOARD_DB = path.join(dir, 'state.db');
};
const find = (cwd, opts) => readAllPresence(opts).find((b) => b.cwd === cwd);

test("a session's last work tree survives the worked row's prune", () => {
  freshDb();
  const t0 = Date.now();
  recordPresence({ cwd: '/w/A', sessionId: 'S', work: true, now: t0 });
  recordPresence({ cwd: '/w/B', sessionId: 'S', now: t0 + 25 * MIN });
  assert.equal(find('/w/A'), undefined);
  assert.equal(find('/w/B').lastWorkCwd, '/w/A');
});

test("a new row inherits the session's last work tree", () => {
  freshDb();
  recordPresence({ cwd: '/w/A', sessionId: 'S', work: true });
  recordPresence({ cwd: '/w/C', sessionId: 'S' });
  assert.equal(find('/w/C').lastWorkCwd, '/w/A');
});

test('work at B moves it on every row of the session', () => {
  freshDb();
  recordPresence({ cwd: '/w/A', sessionId: 'S', work: true });
  recordPresence({ cwd: '/w/B', sessionId: 'S', work: true });
  const rows = readAllPresence().filter((b) => b.sessionId === 'S');
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.lastWorkCwd, '/w/B');
});

test('another session is not touched, and no work leaves it null', () => {
  freshDb();
  recordPresence({ cwd: '/w/A', sessionId: 'S', work: true });
  recordPresence({ cwd: '/w/A2', sessionId: 'T' });
  assert.equal(find('/w/A2').lastWorkCwd, null);
});

test('a store created before the column gains it on open', () => {
  freshDb();
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const old = new DatabaseSync(process.env.AGENT_SWITCHBOARD_DB);
  old.exec(`CREATE TABLE presence_beacons (
    session_id TEXT NOT NULL, cwd TEXT NOT NULL, home_cwd TEXT, branch TEXT, repo TEXT,
    mailbox INTEGER, window_id INTEGER, pid INTEGER, last_work_tick TEXT,
    first_tick TEXT NOT NULL, last_tick TEXT NOT NULL, PRIMARY KEY (session_id, cwd))`);
  old.close();
  recordPresence({ cwd: '/w/A', sessionId: 'S', work: true });
  recordPresence({ cwd: '/w/B', sessionId: 'S' });
  assert.equal(find('/w/B').lastWorkCwd, '/w/A');
});

test('file backend: survives prune, inherits, and moves with work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-lwc-file-'));
  const file = path.join(dir, 'presence.json');
  const t0 = Date.now();
  recordPresence({ file, cwd: '/w/A', sessionId: 'S', work: true, now: t0 });
  recordPresence({ file, cwd: '/w/B', sessionId: 'S', now: t0 + 25 * MIN });
  assert.equal(find('/w/A', { file }), undefined);
  assert.equal(find('/w/B', { file }).lastWorkCwd, '/w/A');
  recordPresence({ file, cwd: '/w/C', sessionId: 'S', now: t0 + 26 * MIN });
  assert.equal(find('/w/C', { file }).lastWorkCwd, '/w/A');
  recordPresence({ file, cwd: '/w/C', sessionId: 'S', work: true, now: t0 + 27 * MIN });
  for (const b of readAllPresence({ file })) assert.equal(b.lastWorkCwd, '/w/C');
});
