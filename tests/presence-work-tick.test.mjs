// A beacon's work tick: `work: true` stamps lastWorkTick (the session ran a
// mutating command in that tree); a plain prompt tick leaves it unchanged,
// and a store created before the column gains it on open.
//
// Run: node --test tests/presence-work-tick.test.mjs (or the full suite)

import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { recordPresence, readAllPresence } = await import('../lib/presence.mjs');

const freshDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-work-'));
  process.env.AGENT_SWITCHBOARD_DB = path.join(dir, 'state.db');
  return dir;
};
const find = (cwd) => readAllPresence().find((b) => b.cwd === cwd);

test('store: work stamps lastWorkTick, an omitted work leaves it unchanged', () => {
  freshDb();
  recordPresence({ cwd: '/w/a', sessionId: 's1', now: Date.now() - 5000 });
  assert.equal(find('/w/a').lastWorkTick, undefined);
  recordPresence({ cwd: '/w/a', sessionId: 's1', work: true, now: Date.now() - 3000 });
  const stamped = find('/w/a').lastWorkTick;
  assert.ok(stamped);
  recordPresence({ cwd: '/w/a', sessionId: 's1' });
  assert.equal(find('/w/a').lastWorkTick, stamped);
  assert.ok(find('/w/a').lastTick > stamped);
});

test('store: a new beacon written with work carries the tick', () => {
  freshDb();
  recordPresence({ cwd: '/w/b', sessionId: 's2', work: true });
  assert.ok(find('/w/b').lastWorkTick);
});

test('file backend: same merge-only rule', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-work-file-'));
  const file = path.join(dir, 'presence.json');
  recordPresence({ file, cwd: '/w/a', sessionId: 's1' });
  assert.equal(readAllPresence({ file })[0].lastWorkTick, undefined);
  recordPresence({ file, cwd: '/w/a', sessionId: 's1', work: true });
  const stamped = readAllPresence({ file })[0].lastWorkTick;
  assert.ok(stamped);
  recordPresence({ file, cwd: '/w/a', sessionId: 's1' });
  assert.equal(readAllPresence({ file })[0].lastWorkTick, stamped);
});

test('a store created before the column gains it on open', () => {
  freshDb();
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const old = new DatabaseSync(process.env.AGENT_SWITCHBOARD_DB);
  old.exec(`CREATE TABLE presence_beacons (
    session_id TEXT NOT NULL, cwd TEXT NOT NULL, home_cwd TEXT, branch TEXT, repo TEXT,
    mailbox INTEGER, window_id INTEGER, first_tick TEXT NOT NULL, last_tick TEXT NOT NULL,
    PRIMARY KEY (session_id, cwd))`);
  const now = new Date().toISOString();
  old.prepare('INSERT INTO presence_beacons (session_id, cwd, first_tick, last_tick) VALUES (?, ?, ?, ?)').run('old', '/w/o', now, now);
  old.close();
  assert.equal(find('/w/o').lastWorkTick, undefined);
  recordPresence({ cwd: '/w/o', sessionId: 'old', work: true });
  assert.ok(find('/w/o').lastWorkTick);
});
