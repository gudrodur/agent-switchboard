// --cancel in store (SQLite) mode: a role-addressed send stores its row under
// the holder's SESSION key, so a withdraw written under `role:<name>` was read
// by no drain. The row's own key decides (agent-config#1379).
//
// Run: node --test tests/agent-send-cancel-store.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { openStore } from '../lib/store.mjs';
import { ack, appendMessage, cancelQueued, findRow, readUnacked, recipientKey } from '../lib/agent-mailbox.mjs';

const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
let tmp, dbPath;
const cancel = (args) => {
  const r = spawnSync('node', [SEND, '--cancel', ...args], { encoding: 'utf-8', env: isolatedEnv({ AGENT_SWITCHBOARD_DB: dbPath }), timeout: 30_000 });
  return { code: r.status, stderr: r.stderr };
};
const count = (id, kind) => {
  const s = openStore(dbPath);
  try { return s.get('SELECT COUNT(*) AS n FROM mailbox_rows WHERE msg_id = ? AND kind = ?', id, kind).n; } finally { s.close(); }
};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sendcancel-'));
  dbPath = path.join(tmp, 'state.db');
  process.env.AGENT_SWITCHBOARD_DB = dbPath;
});
after(() => {
  delete process.env.AGENT_SWITCHBOARD_DB;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('--cancel --to role:<r> withdraws a row stored under the holder session key', () => {
  const key = recipientKey({ cwd: '/repo/proj', sessionId: 'holder-1' });
  const row = appendMessage({ to: key, from: 'x', priority: 'now', text: 'for the role' });
  const { code, stderr } = cancel(['--to', 'role:xj-greenfield-ship', '--id', row.id]);
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`recipient ${key}`));
  assert.equal(readUnacked(key).find((r) => r.id === row.id), undefined, 'a later drain must not return it');
  assert.equal(count(row.id, 'withdraw'), 1);
});

test('--cancel --id alone withdraws', () => {
  const key = recipientKey({ cwd: '/repo/proj', sessionId: 'holder-2' });
  const row = appendMessage({ to: key, priority: 'now', text: 'x' });
  assert.equal(cancel(['--id', row.id]).code, 0);
  assert.deepEqual(readUnacked(key), []);
});

test('--cancel on a delivered row: exit 13, names ack and deliveredAs, no withdraw row', () => {
  const key = recipientKey({ cwd: '/repo/proj', sessionId: 'holder-3' });
  const row = appendMessage({ to: key, priority: 'now', text: 'x' });
  const a = ack({ key, id: row.id, deliveredAs: 'mailbox' });
  const { code, stderr } = cancel(['--to', key, '--id', row.id]);
  assert.equal(code, 13);
  assert.match(stderr, new RegExp(`already delivered at ${a.ts} as mailbox`));
  assert.equal(count(row.id, 'withdraw'), 0);
});

test('--cancel on an unknown id: exit 14, nothing written', () => {
  const { code, stderr } = cancel(['--id', 'ghost-id']);
  assert.equal(code, 14);
  assert.match(stderr, /no row ghost-id/);
  assert.equal(count('ghost-id', 'withdraw'), 0);
});

test('--cancel on an already-withdrawn row: exit 13, no second withdraw row', () => {
  const key = recipientKey({ cwd: '/repo/proj', sessionId: 'holder-4' });
  const row = appendMessage({ to: key, priority: 'now', text: 'x' });
  assert.equal(cancel(['--id', row.id]).code, 0);
  const { code, stderr } = cancel(['--id', row.id]);
  assert.equal(code, 13);
  assert.match(stderr, /already withdrawn at/);
  assert.equal(count(row.id, 'withdraw'), 1);
});

test('library: cancelQueued corrects the key in store mode; topic supersede still withdraws', () => {
  const key = recipientKey({ cwd: '/repo/proj', sessionId: 'holder-5' });
  const row = appendMessage({ to: key, priority: 'now', text: 'x' });
  assert.deepEqual(cancelQueued({ key: 'role:r', id: row.id }), { withdrawn: true, key, keyCorrected: true });
  assert.equal(findRow({ id: row.id }).state, 'withdrawn');
  const first = appendMessage({ to: key, priority: 'now', text: 'one', topic: 't' });
  const second = appendMessage({ to: key, priority: 'now', text: 'two', topic: 't' });
  assert.deepEqual(readUnacked(key).map((r) => r.id), [second.id]);
  assert.equal(findRow({ id: first.id }).state, 'withdrawn');
});
