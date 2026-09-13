// Concurrency proof for the SQLite mailbox (step 1): two child processes
// append 1,000 rows each to one temp db at the same time; all 2,000 rows are
// there, none twice. New behaviour: the JSONL backend has no equivalent test.
//
// Run: node --test tests/store-concurrency.test.mjs (or the full suite)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const N = 1000;

const childEnv = (db, dir) => {
  const env = {
    ...process.env,
    AGENT_SWITCHBOARD_DB: db,
    AGENT_SWITCHBOARD_DIR: path.join(dir, 'switchboard'),
  };
  delete env.AGENT_SWITCHBOARD_MAILBOX_DIR;
  delete env.AGENT_MAILBOX_DIR;
  delete env.AGENT_SWITCHBOARD_PRESENCE_FILE;
  return env;
};

const writer = (tag) => `
import { appendMessage } from ${JSON.stringify(path.join(LIB, 'agent-mailbox.mjs'))};
for (let i = 0; i < ${N}; i++) {
  appendMessage({ to: 'conc__s', from: ${JSON.stringify(tag)}, priority: 'queue', text: ${JSON.stringify(tag)} + '-' + i });
}
`;

const runWriter = (tag, env) =>
  new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', writer(tag)], { env });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}: ${stderr}`))));
  });

test('two concurrent writers append 2000 rows, none twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-conc-'));
  try {
    const db = path.join(dir, 'conc.db');
    const env = childEnv(db, dir);
    await Promise.all([runWriter('a', env), runWriter('b', env)]);
    const { openStore } = await import('../lib/store.mjs');
    const store = openStore(db);
    try {
      const rows = store.all('SELECT row_json FROM mailbox_rows ORDER BY rowid');
      assert.equal(rows.length, 2 * N);
      const ids = rows.map((r) => JSON.parse(r.row_json).id);
      assert.equal(new Set(ids).size, 2 * N, 'every row id is unique');
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
