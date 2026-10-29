// bun transactions must take the write lock up front (agent-config#1379 W2c).
// bun:sqlite's db.transaction(fn)() is DEFERRED: a read-then-write inside it
// fails SQLITE_BUSY_SNAPSHOT when another connection commits between the read
// and the write, and busy_timeout cannot help. The node path uses BEGIN
// IMMEDIATE, so the lib must call .immediate() under bun.
//
// Deterministic shape, one bun process, two connections on one WAL file:
// connection A opens a transaction and reads; connection B (busy_timeout 0)
// then tries to write. Under IMMEDIATE, A already holds the write lock, so B
// is refused and A commits. Under DEFERRED, B commits in the gap and A's own
// write then fails.
//
// Run: node --test tests/store-bun-immediate.test.mjs (needs bun on PATH)

import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'store.mjs');

const script = (db) => `
import { openStore } from ${JSON.stringify(STORE)};
const a = openStore(${JSON.stringify(db)});
const b = openStore(${JSON.stringify(db)});
b.run('PRAGMA busy_timeout = 0');
const ins = (s, tag) => s.run(
  'INSERT INTO mailbox_rows (recipient_key, kind, msg_id, ts, row_json) VALUES (?, ?, ?, ?, ?)',
  'k', 'message', tag, '2026-01-01T00:00:00.000Z', '{}');
const out = { aCommitted: false, bWrote: false };
try {
  a.transaction(() => {
    a.get('SELECT count(*) AS n FROM mailbox_rows');
    try { ins(b, 'b'); out.bWrote = true; } catch (e) { out.bErr = String(e.message ?? e); }
    ins(a, 'a');
  });
  out.aCommitted = true;
} catch (e) { out.aErr = String(e.message ?? e); }
console.log(JSON.stringify(out));
`;

test('bun store.transaction is IMMEDIATE: the read-then-write transaction commits, the interloper is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-imm-'));
  try {
    const db = path.join(dir, 's.db');
    const env = isolatedEnv({ AGENT_SWITCHBOARD_DB: db, AGENT_SWITCHBOARD_DIR: path.join(dir, 'sb') });
    const r = spawnSync('bun', ['--input-type=module', '-e', script(db)], { env, encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual({ aCommitted: out.aCommitted, bWrote: out.bWrote }, { aCommitted: true, bWrote: false }, JSON.stringify(out));
    assert.match(out.bErr, /locked|busy/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
