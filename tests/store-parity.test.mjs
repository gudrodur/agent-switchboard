// Runtime parity for the shared store (step 1): one file that a node writer
// and a bun writer share, through the lib on both sides — bun writes, node
// reads, then node writes and bun reads. New behaviour: no shared store
// existed before.
//
// Run: node --test tests/store-parity.test.mjs (or the full suite)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

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

const run = (bin, script, env) => {
  const r = spawnSync(bin, ['--input-type=module', '-e', script], { env, encoding: 'utf-8' });
  assert.equal(r.status, 0, `${bin} failed: ${r.stderr}`);
  return r.stdout;
};

const bunAppend = (text) => `
import { appendMessage } from ${JSON.stringify(path.join(LIB, 'agent-mailbox.mjs'))};
appendMessage({ to: 'parity__s', from: 'bun', priority: 'now', text: ${JSON.stringify(text)} });
`;

const bunRead = `
import { readUnacked } from ${JSON.stringify(path.join(LIB, 'agent-mailbox.mjs'))};
process.stdout.write(JSON.stringify(readUnacked('parity__s', {}).map((r) => r.text).sort()));
`;

const SWAPPED_KEYS = [
  'AGENT_SWITCHBOARD_DB',
  'AGENT_SWITCHBOARD_MAILBOX_DIR',
  'AGENT_MAILBOX_DIR',
  'AGENT_SWITCHBOARD_PRESENCE_FILE',
];

test('bun writes, node reads, and the reverse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-parity-'));
  const saved = Object.fromEntries(SWAPPED_KEYS.map((k) => [k, process.env[k]]));
  try {
    const db = path.join(dir, 'parity.db');
    const env = childEnv(db, dir);
    process.env.AGENT_SWITCHBOARD_DB = db;
    delete process.env.AGENT_SWITCHBOARD_MAILBOX_DIR;
    delete process.env.AGENT_MAILBOX_DIR;
    delete process.env.AGENT_SWITCHBOARD_PRESENCE_FILE;
    const { appendMessage, readUnacked } = await import('../lib/agent-mailbox.mjs');

    run('bun', bunAppend('from-bun'), env);
    const nodeSeen = readUnacked('parity__s', {}).map((r) => r.text);
    assert.ok(nodeSeen.includes('from-bun'), 'node reads the bun row');

    appendMessage({ to: 'parity__s', from: 'node', priority: 'now', text: 'from-node' });
    const bunSeen = JSON.parse(run('bun', bunRead, env));
    assert.ok(bunSeen.includes('from-node'), 'bun reads the node row');
    assert.ok(bunSeen.includes('from-bun'), 'bun reads its own row too');
  } finally {
    for (const k of SWAPPED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
