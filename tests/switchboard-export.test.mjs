// bin/switchboard-export.mjs dumps one store table as JSON. A store path with
// no file behind it is a wrong path, not an empty store: it must fail (exit 2)
// rather than print [] (2026-10-22: a shell without the host's DB pin read
// the default path and reported an empty mailbox while the live store held
// the rows).
//
// Run: node --test tests/switchboard-export.test.mjs (or the full suite)

import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';

const BIN = fileURLToPath(new URL('../bin/switchboard-export.mjs', import.meta.url));
const exportTable = (db, table) =>
  spawnSync(process.execPath, [BIN, table], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_SWITCHBOARD_DB: db },
  });

test('a store path with no file exits 2 and names the path, never []', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-export-'));
  const db = path.join(dir, 'missing', 'state.db');
  const r = exportTable(db, 'presence');
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no store at .*missing\/state\.db/);
  assert.equal(fs.existsSync(db), false, 'the export must not create a store');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an existing store with no rows dumps []', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-export-'));
  const db = path.join(dir, 'state.db');
  openStore(db).close();
  const r = exportTable(db, 'mailbox');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
